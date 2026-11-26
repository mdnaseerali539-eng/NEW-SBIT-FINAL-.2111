import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { db } from '../db/index.ts';
import { profiles, roles, staffAssignments } from '../db/schema.ts';
import { verifySessionToken } from '../server/crypto.ts';
import {
  hydrateAllFromFirestore,
  hydrateUserFromFirestore,
  syncProfileAndEnrollmentToFirestore,
} from '../server/firestoreRestSync.ts';
import { ensureBaselineSeeded, INITIAL_SUPER_ADMIN_EMAIL } from '../server/seed.ts';

const firebaseTokenCache = new Map<
  string,
  { uid: string; email: string; emailVerified: boolean; expiresAtMs: number }
>();

function getCachedFirebaseToken(token: string) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const entry = firebaseTokenCache.get(key);
  if (!entry) return { key, decoded: null as null };
  if (Date.now() >= entry.expiresAtMs) {
    firebaseTokenCache.delete(key);
    return { key, decoded: null as null };
  }
  return { key, decoded: entry };
}

function setCachedFirebaseToken(
  key: string,
  val: { uid: string; email: string; emailVerified: boolean; expiresAtMs: number }
) {
  if (firebaseTokenCache.size >= 500) {
    const firstKey = firebaseTokenCache.keys().next().value;
    if (firstKey) firebaseTokenCache.delete(firstKey);
  }
  firebaseTokenCache.set(key, val);
}

export function invalidateFirebaseCacheForEmail(email: string): void {
  const normalized = email.toLowerCase().trim();
  for (const [key, entry] of firebaseTokenCache.entries()) {
    if (entry.email === normalized) {
      firebaseTokenCache.delete(key);
    }
  }
}

export type PortalRole = 'super_admin' | 'staff' | 'student';

export interface AuthProfile {
  id: string;
  firebaseUid: string | null;
  email: string;
  fullName: string;
  phone: string | null;
  rollNumber: string | null;
  employeeId: string | null;
  role: PortalRole;
  permissions: string[];
  status: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface AuthRequest extends Request {
  authProfile?: AuthProfile;
  firebaseIdToken?: string;
  clientIp?: string;
}

export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

async function enforceSinglePermanentAdmin(p: {
  id: string;
  email: string;
  roleName: string;
  permissions: unknown;
}): Promise<{ roleName: PortalRole; permissions: string[] }> {
  const normalized = p.email.toLowerCase().trim();
  if (p.roleName !== 'super_admin' || normalized === INITIAL_SUPER_ADMIN_EMAIL) {
    return {
      roleName: p.roleName as PortalRole,
      permissions: (p.permissions as string[]) ?? [],
    };
  }

  const [hasStaffScope] = await db
    .select({ id: staffAssignments.id })
    .from(staffAssignments)
    .where(and(eq(staffAssignments.staffId, p.id), eq(staffAssignments.isActive, true)))
    .limit(1);

  const fallbackRoleName: PortalRole = hasStaffScope ? 'staff' : 'student';
  const [fallbackRole] = await db
    .select()
    .from(roles)
    .where(eq(roles.name, fallbackRoleName))
    .limit(1);

  if (fallbackRole) {
    await db
      .update(profiles)
      .set({ roleId: fallbackRole.id, updatedAt: new Date() })
      .where(eq(profiles.id, p.id));
    invalidateFirebaseCacheForEmail(normalized);
    return {
      roleName: fallbackRoleName,
      permissions: (fallbackRole.permissions as string[]) ?? [],
    };
  }

  return {
    roleName: 'student',
    permissions: [],
  };
}

async function resolveProfileByToken(token: string): Promise<
  | { ok: true; profile: AuthProfile; firebaseIdToken?: string }
  | { ok: false; status: number; message: string }
> {
  // 1. Try SBIT server-signed session token
  if (token.startsWith('sbit.') || token.startsWith('sbist.')) {
    const decoded = verifySessionToken(token);
    if (!decoded) {
      return { ok: false, status: 401, message: 'Session expired or invalid. Please sign in again.' };
    }
    const rows = await db
      .select({
        id: profiles.id,
        firebaseUid: profiles.firebaseUid,
        email: profiles.email,
        fullName: profiles.fullName,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        employeeId: profiles.employeeId,
        passwordHash: profiles.passwordHash,
        status: profiles.status,
        emailVerified: profiles.emailVerified,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.id, decoded.profileId))
      .limit(1);

    if (rows.length === 0) {
      return { ok: false, status: 401, message: 'Account not found.' };
    }
    const p = rows[0];
    if (p.status !== 'approved') {
      return {
        ok: false,
        status: 403,
        message:
          p.status === 'pending'
            ? 'Your account is pending Super Admin approval.'
            : p.status === 'rejected'
              ? 'Your registration was rejected. Contact college administration.'
              : 'Your account has been deactivated.',
      };
    }

    const enforced = await enforceSinglePermanentAdmin(p);

    return {
      ok: true,
      profile: {
        id: p.id,
        firebaseUid: p.firebaseUid,
        email: p.email,
        fullName: p.fullName,
        phone: p.phone,
        rollNumber: p.rollNumber,
        employeeId: p.employeeId,
        role: enforced.roleName,
        permissions: enforced.permissions,
        status: p.status,
        emailVerified: p.emailVerified,
        hasPassword: Boolean(p.passwordHash),
      },
    };
  }

  // 2. Verify Firebase ID Token (with short-lived verified token cache)
  try {
    const cached = getCachedFirebaseToken(token);
    let decodedUid: string;
    let email: string;
    let decodedEmailVerified = true;

    if (cached.decoded) {
      decodedUid = cached.decoded.uid;
      email = cached.decoded.email;
      decodedEmailVerified = cached.decoded.emailVerified;
    } else {
      const decoded = await adminAuth.verifyIdToken(token);
      email = (decoded.email || '').toLowerCase().trim();
      if (!email) {
        return { ok: false, status: 401, message: 'Google account email missing from token.' };
      }
      decodedUid = decoded.uid;
      decodedEmailVerified = Boolean(decoded.email_verified ?? true);
      const tokenExpMs = decoded.exp ? decoded.exp * 1000 : Date.now() + 300_000;
      const cacheUntil = Math.min(tokenExpMs - 5_000, Date.now() + 300_000);
      if (cacheUntil > Date.now()) {
        setCachedFirebaseToken(cached.key, {
          uid: decodedUid,
          email,
          emailVerified: decodedEmailVerified,
          expiresAtMs: cacheUntil,
        });
      }
    }

    // Hydrate from Firestore after cold restart before looking up profile
    if (email === INITIAL_SUPER_ADMIN_EMAIL) {
      await hydrateAllFromFirestore(token);
    } else {
      await hydrateUserFromFirestore(token, email, decodedUid);
    }

    let rows = await db
      .select({
        id: profiles.id,
        firebaseUid: profiles.firebaseUid,
        email: profiles.email,
        fullName: profiles.fullName,
        phone: profiles.phone,
        rollNumber: profiles.rollNumber,
        employeeId: profiles.employeeId,
        passwordHash: profiles.passwordHash,
        status: profiles.status,
        emailVerified: profiles.emailVerified,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.firebaseUid, decodedUid))
      .limit(1);

    if (rows.length === 0) {
      rows = await db
        .select({
          id: profiles.id,
          firebaseUid: profiles.firebaseUid,
          email: profiles.email,
          fullName: profiles.fullName,
          phone: profiles.phone,
          rollNumber: profiles.rollNumber,
          employeeId: profiles.employeeId,
          passwordHash: profiles.passwordHash,
          status: profiles.status,
          emailVerified: profiles.emailVerified,
          roleName: roles.name,
          permissions: roles.permissions,
        })
        .from(profiles)
        .innerJoin(roles, eq(profiles.roleId, roles.id))
        .where(eq(profiles.email, email))
        .limit(1);

      if (rows.length > 0 && !rows[0].firebaseUid) {
        await db
          .update(profiles)
          .set({
            firebaseUid: decodedUid,
            emailVerified: decodedEmailVerified,
            updatedAt: new Date(),
          })
          .where(eq(profiles.id, rows[0].id));
        rows[0].firebaseUid = decodedUid;
        rows[0].emailVerified = decodedEmailVerified;
        await syncProfileAndEnrollmentToFirestore(token, rows[0].id);
      }
    }

    if (rows.length === 0) {
      return {
        ok: false,
        status: 403,
        message: `No registered SBIT portal account found for ${email}. Students must register via an admin QR code and await approval.`,
      };
    }

    const p = rows[0];
    if (p.status !== 'approved') {
      return {
        ok: false,
        status: 403,
        message:
          p.status === 'pending'
            ? 'Your registration is currently Pending Approval by the Super Admin.'
            : p.status === 'rejected'
              ? 'Your registration was rejected by college administration.'
              : 'Your account has been deactivated.',
      };
    }

    const enforced = await enforceSinglePermanentAdmin(p);

    return {
      ok: true,
      firebaseIdToken: token,
      profile: {
        id: p.id,
        firebaseUid: p.firebaseUid,
        email: p.email,
        fullName: p.fullName,
        phone: p.phone,
        rollNumber: p.rollNumber,
        employeeId: p.employeeId,
        role: enforced.roleName,
        permissions: enforced.permissions,
        status: p.status,
        emailVerified: p.emailVerified,
        hasPassword: Boolean(p.passwordHash),
      },
    };
  } catch (err) {
    console.error('Token verification failed:', err);
    return { ok: false, status: 401, message: 'Invalid or expired authentication token.' };
  }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await ensureBaselineSeeded();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'Authentication token is empty.' });
    }

    const resolved = await resolveProfileByToken(token);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.message });
    }

    req.authProfile = resolved.profile;
    req.firebaseIdToken = resolved.firebaseIdToken;
    req.clientIp = extractClientIp(req);
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Authentication verification failed.' });
  }
}

export function requireRole(...allowedRoles: PortalRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.authProfile) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.authProfile.role)) {
      return res.status(403).json({
        error: `Forbidden: ${req.authProfile.role} role cannot access this resource.`,
      });
    }
    next();
  };
}

export interface StaffScope {
  departmentIds: string[];
  classIds: string[];
  subjectIds: string[];
  canCreateSessions: boolean;
  assignments: Array<{
    id: string;
    departmentId: string;
    classId: string | null;
    subjectId: string | null;
    canCreateSessions: boolean;
  }>;
}

export async function getStaffScope(staffId: string): Promise<StaffScope> {
  const rows = await db
    .select({
      id: staffAssignments.id,
      departmentId: staffAssignments.departmentId,
      classId: staffAssignments.classId,
      subjectId: staffAssignments.subjectId,
      canCreateSessions: staffAssignments.canCreateSessions,
    })
    .from(staffAssignments)
    .where(and(eq(staffAssignments.staffId, staffId), eq(staffAssignments.isActive, true)));

  const deptSet = new Set<string>();
  const classSet = new Set<string>();
  const subjectSet = new Set<string>();
  let canCreate = false;

  for (const r of rows) {
    deptSet.add(r.departmentId);
    if (r.classId) classSet.add(r.classId);
    if (r.subjectId) subjectSet.add(r.subjectId);
    if (r.canCreateSessions) canCreate = true;
  }

  return {
    departmentIds: Array.from(deptSet),
    classIds: Array.from(classSet),
    subjectIds: Array.from(subjectSet),
    canCreateSessions: canCreate,
    assignments: rows,
  };
}
