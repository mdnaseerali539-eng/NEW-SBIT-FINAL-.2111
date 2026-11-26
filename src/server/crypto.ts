import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const BIOMETRIC_SECRET_INPUT =
  process.env.BIOMETRIC_ENCRYPTION_KEY ||
  `${process.env.SQL_PASSWORD || 'sbit-fallback'}:${firebaseConfig.projectId}:biometric-v1`;

const SESSION_SECRET_INPUT =
  process.env.SESSION_SECRET ||
  `${process.env.SQL_PASSWORD || 'sbit-fallback'}:${firebaseConfig.projectId}:session-v1`;

const BIOMETRIC_KEY = crypto.createHash('sha256').update(BIOMETRIC_SECRET_INPUT).digest();
const SESSION_KEY = crypto.createHash('sha256').update(SESSION_SECRET_INPUT).digest();

export const CURRENT_BIOMETRIC_ALGORITHM = 'face-api-ssd-128d-v2';

export function deriveFaceIdCode(studentId: string, authTag: string): string {
  const digest = crypto
    .createHmac('sha256', BIOMETRIC_KEY)
    .update(`${studentId}:${authTag}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `FID-${digest}`;
}

function roundVector(vec: number[]): number[] {
  return vec.map((v) => Math.round(v * 1_000_000) / 1_000_000);
}

export function encryptBiometricDescriptor(descriptor: number[]): {
  encryptedDescriptor: string;
  iv: string;
  authTag: string;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', BIOMETRIC_KEY, iv);
  const payload = JSON.stringify(descriptor);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedDescriptor: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function encryptBiometricTemplateV2(descriptors: number[][]): {
  encryptedDescriptor: string;
  iv: string;
  authTag: string;
} {
  const normalizedSamples = descriptors.map((d) =>
    roundVector(averageAndNormalizeDescriptors([d]))
  );
  const centroid = roundVector(averageAndNormalizeDescriptors(normalizedSamples));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', BIOMETRIC_KEY, iv);
  const payload = JSON.stringify({
    v: 2,
    centroid,
    samples: normalizedSamples,
  });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedDescriptor: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptBiometricDescriptor(
  encryptedDescriptor: string,
  iv: string,
  authTag: string
): number[] {
  const tmpl = decryptBiometricTemplate(encryptedDescriptor, iv, authTag);
  return tmpl.centroid;
}

export function decryptBiometricTemplate(
  encryptedDescriptor: string,
  iv: string,
  authTag: string
): { centroid: number[]; samples: number[][] } {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    BIOMETRIC_KEY,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedDescriptor, 'base64')),
    decipher.final(),
  ]);
  const parsed = JSON.parse(decrypted.toString('utf8'));
  if (Array.isArray(parsed) && parsed.length === 128) {
    const centroid = averageAndNormalizeDescriptors([parsed as number[]]);
    return { centroid, samples: [centroid] };
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.v === 2 &&
    Array.isArray(parsed.centroid) &&
    parsed.centroid.length === 128 &&
    Array.isArray(parsed.samples) &&
    parsed.samples.length >= 1
  ) {
    const validSamples = (parsed.samples as unknown[]).filter(
      (s): s is number[] => Array.isArray(s) && s.length === 128
    );
    if (validSamples.length === 0) {
      throw new Error('Corrupted biometric template samples');
    }
    return {
      centroid: averageAndNormalizeDescriptors([parsed.centroid as number[]]),
      samples: validSamples.map((s) => averageAndNormalizeDescriptors([s])),
    };
  }
  throw new Error('Corrupted biometric template');
}

export function computeFaceDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error('Descriptor dimension mismatch');
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function averageAndNormalizeDescriptors(descriptors: number[][]): number[] {
  if (descriptors.length === 0) {
    throw new Error('At least one descriptor is required');
  }
  const dim = descriptors[0].length;
  const avg = new Array<number>(dim).fill(0);
  for (const vec of descriptors) {
    if (vec.length !== dim) {
      throw new Error('Descriptor length mismatch');
    }
    for (let i = 0; i < dim; i++) {
      avg[i] += vec[i] / descriptors.length;
    }
  }
  const norm = Math.sqrt(avg.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return avg;
  return avg.map((v) => v / norm);
}

export function areEnrollmentSamplesConsistent(
  descriptors: number[][],
  maxPairwiseDistance = 0.26
): boolean {
  if (descriptors.length < 2) return false;
  const normalized = descriptors.map((d) => averageAndNormalizeDescriptors([d]));
  for (const vec of normalized) {
    const normSq = vec.reduce((acc, v) => acc + v * v, 0);
    if (normSq < 0.5) return false;
  }
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (computeFaceDistance(normalized[i], normalized[j]) > maxPairwiseDistance) {
        return false;
      }
    }
  }
  return true;
}

export function verifyLiveFaceDescriptors(params: {
  enrolledVector: number[];
  enrolledSamples?: number[][];
  liveDescriptors: number[][];
  threshold: number;
}): {
  matched: boolean;
  distance: number;
  maxFrameDistance: number;
  confidence: number;
  inconsistentFrames: boolean;
} {
  const { enrolledVector, enrolledSamples, liveDescriptors, threshold } = params;
  const normalizedEnrolled = averageAndNormalizeDescriptors([enrolledVector]);
  const normalizedFrames = liveDescriptors.map((d) => averageAndNormalizeDescriptors([d]));
  for (const vec of normalizedFrames) {
    const normSq = vec.reduce((acc, v) => acc + v * v, 0);
    if (normSq < 0.5) {
      return {
        matched: false,
        distance: 2,
        maxFrameDistance: 2,
        confidence: 0,
        inconsistentFrames: true,
      };
    }
  }

  for (let i = 0; i < normalizedFrames.length; i++) {
    for (let j = i + 1; j < normalizedFrames.length; j++) {
      if (computeFaceDistance(normalizedFrames[i], normalizedFrames[j]) > 0.22) {
        return {
          matched: false,
          distance: 1,
          maxFrameDistance: 1,
          confidence: 0,
          inconsistentFrames: true,
        };
      }
    }
  }

  const avgLive = averageAndNormalizeDescriptors(normalizedFrames);
  const avgDistance = computeFaceDistance(avgLive, normalizedEnrolled);
  const frameDistances = normalizedFrames.map((f) => computeFaceDistance(f, normalizedEnrolled));
  const maxFrameDistance = Math.max(...frameDistances);

  let perSampleMatched = true;
  if (enrolledSamples && enrolledSamples.length >= 2) {
    const normalizedEnrolledSamples = enrolledSamples.map((s) =>
      averageAndNormalizeDescriptors([s])
    );
    const avgSampleDistances = normalizedEnrolledSamples.map((s) =>
      computeFaceDistance(avgLive, s)
    );
    const meanSampleDistance =
      avgSampleDistances.reduce((a, b) => a + b, 0) / avgSampleDistances.length;
    const minNeededMatches = Math.ceil(normalizedEnrolledSamples.length * 0.66);

    const everyFrameConsistentWithSamples = normalizedFrames.every((frame) => {
      const withinLimit = normalizedEnrolledSamples.filter(
        (s) => computeFaceDistance(frame, s) <= threshold + 0.015
      ).length;
      return withinLimit >= minNeededMatches;
    });

    perSampleMatched =
      meanSampleDistance <= threshold + 0.01 && everyFrameConsistentWithSamples;
  }

  const matched =
    avgDistance <= threshold && maxFrameDistance <= threshold && perSampleMatched;
  const confidence = Math.max(0, Math.min(1, Math.round((1 - avgDistance) * 1000) / 1000));
  return {
    matched,
    distance: avgDistance,
    maxFrameDistance,
    confidence,
    inconsistentFrames: false,
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, originalHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export interface SessionTokenPayload {
  profileId: string;
  email: string;
  role: string;
  exp: number;
}

export function signSessionToken(payload: Omit<SessionTokenPayload, 'exp'>, ttlHours = 12): string {
  const fullPayload: SessionTokenPayload = {
    ...payload,
    exp: Date.now() + ttlHours * 3600 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url');
  return `sbit.${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionTokenPayload | null {
  if (!token.startsWith('sbit.') && !token.startsWith('sbist.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionTokenPayload;
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function signAccountSetupToken(profileId: string, email: string, ttlHours = 48): string {
  const payload = {
    purpose: 'account_setup',
    profileId,
    email: email.toLowerCase(),
    exp: Date.now() + ttlHours * 3600 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAccountSetupToken(token: string): { profileId: string; email: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_KEY).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (parsed.purpose !== 'account_setup' || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return { profileId: parsed.profileId, email: parsed.email };
  } catch {
    return null;
  }
}

export function computeGeofenceDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export function getISTDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getISTTimeString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatISTTimestamp(date = new Date()): string {
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date) + ' IST'
  );
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function deterministicUuid(namespaceKey: string): string {
  const hash = crypto.createHash('sha256').update(namespaceKey).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

