import { eq, inArray } from 'drizzle-orm';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { db } from '../db/index.ts';
import {
  academicYears,
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  biometricTemplates,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
  jntuhRegulationRules,
  profiles,
  registrationQrCodes,
  roles,
  semesters,
  staffAssignments,
  studentAcademicHistory,
  studentEnrollments,
  subjects,
} from '../db/schema.ts';
import { invalidateScheduleSyncCache } from './attendanceScheduler.ts';

export const PERMANENT_ADMIN_EMAIL = 'mdnaseerali539@gmail.com';

const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId || '(default)';
const DOCS_PARENT = `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const BASE_URL = `https://firestore.googleapis.com/v1/${DOCS_PARENT}`;

export function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_MOCK_DB_PERSISTENCE === 'true' ||
    process.argv.some((a) => a.includes('test')) ||
    process.execArgv.some((a) => a.includes('test'))
  );
}

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

function jsToFsValue(val: unknown): FsValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (val instanceof Date) {
    return { timestampValue: Number.isNaN(val.getTime()) ? new Date().toISOString() : val.toISOString() };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((v) => jsToFsValue(v)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = jsToFsValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function mapToFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = jsToFsValue(v);
    }
  }
  return fields;
}

function fsValueToJs(val: FsValue | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) {
    const d = new Date(val.timestampValue);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values ?? []).map((v) => fsValueToJs(v));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields ?? {})) {
      out[k] = fsValueToJs(v);
    }
    return out;
  }
  return null;
}

function fsDocToJs(doc: FsDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    out[k] = fsValueToJs(v);
  }
  return out;
}

function docIdFromName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] || '';
}

function toDateOrNull(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  if (typeof val === 'string') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toDateOrNow(val: unknown): Date {
  return toDateOrNull(val) ?? new Date();
}

function toIsoStringOrNull(val: unknown): string | null {
  const d = toDateOrNull(val);
  return d ? d.toISOString() : typeof val === 'string' && val ? val : null;
}

function toIsoStringOrNow(val: unknown): string {
  return toIsoStringOrNull(val) ?? new Date().toISOString();
}

const knownCreatedAtCache = new Map<string, string>();
const syncedDocKeys = new Set<string>();
const syncedBucketSessionIds = new Set<string>();

function rememberDocCreatedAt(collection: string, docId: string, doc: FsDocument) {
  syncedDocKeys.add(`${collection}/${docId}`);
  const ts = doc.fields?.createdAt;
  if (ts && 'timestampValue' in ts && ts.timestampValue) {
    knownCreatedAtCache.set(`${collection}/${docId}`, ts.timestampValue);
  }
}

async function fsFetch(
  url: string,
  init: RequestInit & { firebaseIdToken?: string | null }
): Promise<Response> {
  const { firebaseIdToken, ...rest } = init;
  const headers = new Headers(rest.headers || {});
  if (firebaseIdToken) {
    headers.set('Authorization', `Bearer ${firebaseIdToken}`);
  }
  if (rest.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...rest, headers });
}

async function getFsDoc(
  collection: string,
  docId: string,
  firebaseIdToken?: string | null
): Promise<FsDocument | null> {
  const res = await fsFetch(`${BASE_URL}/${collection}/${encodeURIComponent(docId)}`, {
    method: 'GET',
    firebaseIdToken,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore GET ${collection}/${docId} failed (${res.status}): ${text}`);
  }
  const doc = (await res.json()) as FsDocument;
  rememberDocCreatedAt(collection, docId, doc);
  return doc;
}

async function listAllFsDocs(
  collection: string,
  firebaseIdToken: string
): Promise<FsDocument[]> {
  const all: FsDocument[] = [];
  let lastDocName: string | undefined;
  const pageSize = 500;

  for (let i = 0; i < 40; i++) {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize,
    };
    if (lastDocName) {
      structuredQuery.startAt = {
        values: [{ referenceValue: lastDocName }],
        before: false,
      };
    }

    const res = await fsFetch(`${BASE_URL}:runQuery`, {
      method: 'POST',
      firebaseIdToken,
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Firestore LIST ${collection} failed (${res.status}): ${text}`);
    }
    const rows = (await res.json()) as Array<{ document?: FsDocument }>;
    let batchCount = 0;
    let newestDocName: string | undefined;
    for (const r of rows) {
      if (r.document) {
        rememberDocCreatedAt(collection, docIdFromName(r.document.name), r.document);
        all.push(r.document);
        batchCount++;
        newestDocName = r.document.name;
      }
    }
    if (batchCount < pageSize || !newestDocName) break;
    lastDocName = newestDocName;
  }
  return all;
}

async function runFsFieldQuery(
  collection: string,
  fieldPath: string,
  value: string,
  firebaseIdToken: string
): Promise<FsDocument[]> {
  const res = await fsFetch(`${BASE_URL}:runQuery`, {
    method: 'POST',
    firebaseIdToken,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: {
          fieldFilter: {
            field: { fieldPath },
            op: 'EQUAL',
            value: { stringValue: value },
          },
        },
        limit: 500,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore runQuery ${collection} (${fieldPath}) failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as Array<{ document?: FsDocument }>;
  const docs: FsDocument[] = [];
  for (const r of rows) {
    if (r.document) {
      rememberDocCreatedAt(collection, docIdFromName(r.document.name), r.document);
      docs.push(r.document);
    }
  }
  return docs;
}

async function commitFsWrites(
  writes: Array<Record<string, unknown>>,
  firebaseIdToken: string
): Promise<Array<{ updateTime?: string; transformResults?: FsValue[] }>> {
  if (writes.length === 0) return [];
  const results: Array<{ updateTime?: string; transformResults?: FsValue[] }> = [];
  for (let i = 0; i < writes.length; i += 200) {
    const chunk = writes.slice(i, i + 200);
    const res = await fsFetch(`${BASE_URL}:commit`, {
      method: 'POST',
      firebaseIdToken,
      body: JSON.stringify({ writes: chunk }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Firestore commit failed (${res.status}): ${text}`) as Error & {
        status?: number;
        body?: string;
      };
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const json = (await res.json()) as {
      writeResults?: Array<{ updateTime?: string; transformResults?: FsValue[] }>;
    };
    if (Array.isArray(json.writeResults)) {
      results.push(...json.writeResults);
    }
  }
  return results;
}

async function upsertFsDocWithUpdatedOnly(
  collection: string,
  docId: string,
  fieldsObj: Record<string, unknown>,
  firebaseIdToken: string
): Promise<void> {
  const fields = mapToFsFields(fieldsObj);
  delete fields.updatedAt;
  await commitFsWrites(
    [
      {
        update: {
          name: `${DOCS_PARENT}/${collection}/${docId}`,
          fields,
        },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      },
    ],
    firebaseIdToken
  );
  syncedDocKeys.add(`${collection}/${docId}`);
}

async function upsertFsDocWithCreatedAndUpdated(
  collection: string,
  docId: string,
  fieldsObj: Record<string, unknown>,
  firebaseIdToken: string
): Promise<void> {
  const cacheKey = `${collection}/${docId}`;
  const docName = `${DOCS_PARENT}/${collection}/${docId}`;
  const cachedCreatedAt = knownCreatedAtCache.get(cacheKey);

  const attemptUpdate = async (createdAtIso: string) => {
    const fields = mapToFsFields(fieldsObj);
    fields.createdAt = { timestampValue: createdAtIso };
    delete fields.updatedAt;
    await commitFsWrites(
      [
        {
          update: { name: docName, fields },
          updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { exists: true },
        },
      ],
      firebaseIdToken
    );
  };

  const attemptCreate = async () => {
    const fields = mapToFsFields(fieldsObj);
    delete fields.createdAt;
    delete fields.updatedAt;
    const writeResults = await commitFsWrites(
      [
        {
          update: { name: docName, fields },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { exists: false },
        },
      ],
      firebaseIdToken
    );
    const tsVal =
      writeResults[0]?.transformResults?.[0] &&
      'timestampValue' in writeResults[0].transformResults[0]
        ? writeResults[0].transformResults[0].timestampValue
        : writeResults[0]?.updateTime;
    if (tsVal) {
      knownCreatedAtCache.set(cacheKey, tsVal);
    }
  };

  if (cachedCreatedAt) {
    try {
      await attemptUpdate(cachedCreatedAt);
      return;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 400) {
        knownCreatedAtCache.delete(cacheKey);
      } else {
        throw err;
      }
    }
  }

  try {
    await attemptCreate();
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const body = (err as { body?: string }).body || '';
    if (status === 409 || status === 400 || body.includes('ALREADY_EXISTS') || body.includes('FAILED_PRECONDITION')) {
      const existing = await getFsDoc(collection, docId, firebaseIdToken);
      const existingCreated =
        existing?.fields?.createdAt && 'timestampValue' in existing.fields.createdAt
          ? existing.fields.createdAt.timestampValue
          : new Date().toISOString();
      knownCreatedAtCache.set(cacheKey, existingCreated);
      await attemptUpdate(existingCreated);
      return;
    }
    throw err;
  }
}

async function deleteFsDoc(
  collection: string,
  docId: string,
  firebaseIdToken: string
): Promise<void> {
  try {
    const res = await fsFetch(`${BASE_URL}/${collection}/${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      firebaseIdToken,
    });
    knownCreatedAtCache.delete(`${collection}/${docId}`);
    syncedDocKeys.delete(`${collection}/${docId}`);
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      console.warn(`[FirestoreSync] DELETE ${collection}/${docId} returned ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn(`[FirestoreSync] DELETE ${collection}/${docId} error:`, err);
  }
}

// ---------- Serializers matching firestore.rules exact schemas ----------

function serializeUserProfile(
  prof: typeof profiles.$inferSelect,
  roleName: string
): Record<string, unknown> {
  const email = String(prof.email || '').toLowerCase().trim();
  const safeRole =
    roleName === 'super_admin' && email !== PERMANENT_ADMIN_EMAIL
      ? 'student'
      : roleName;
  return {
    id: prof.id,
    firebaseUid: prof.firebaseUid ?? null,
    role: safeRole,
    fullName: String(prof.fullName || email || 'SBIT User').slice(0, 160),
    email,
    phone: prof.phone ? String(prof.phone).slice(0, 30) : null,
    rollNumber: prof.rollNumber ? String(prof.rollNumber).slice(0, 50) : null,
    employeeId: prof.employeeId ? String(prof.employeeId).slice(0, 50) : null,
    status: prof.status,
    emailVerified: Boolean(prof.emailVerified),
    rejectionReason: prof.rejectionReason ? String(prof.rejectionReason).slice(0, 500) : null,
  };
}

function serializeEnrollment(
  enr: typeof studentEnrollments.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: enr.id,
    studentId: enr.studentId,
    studentEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    rollNumber: enr.rollNumber,
    departmentId: enr.departmentId,
    academicYearId: enr.academicYearId,
    semesterId: enr.semesterId,
    classId: enr.classId,
    isActive: Boolean(enr.isActive),
    approvalRequired: Boolean(enr.approvalRequired),
    regulation: enr.regulation || 'R22',
    academicStanding: enr.academicStanding || 'active',
    creditsEarned: Math.trunc(enr.creditsEarned ?? 0),
    totalCreditsAttempted: Math.trunc(enr.totalCreditsAttempted ?? 0),
    activeBacklogs: Math.trunc(enr.activeBacklogs ?? 0),
    latestResultStatus: enr.latestResultStatus || 'pending',
    detentionReason: enr.detentionReason ? enr.detentionReason.slice(0, 500) : null,
    joinedDateIST: enr.joinedDateIST ?? null,
    approvedBy: enr.approvedBy ?? null,
    approvedAt: toIsoStringOrNull(enr.approvedAt),
    lastPromotedAt: toIsoStringOrNull(enr.lastPromotedAt),
    enrolledAt: toIsoStringOrNow(enr.enrolledAt),
  };
}

function serializeBiometric(
  bio: typeof biometricTemplates.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: bio.id,
    studentId: bio.studentId,
    studentEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    encryptedDescriptor: bio.encryptedDescriptor,
    iv: bio.iv,
    authTag: bio.authTag,
    algorithm: bio.algorithm || 'face-api-128d-aes256gcm',
    sampleCount: Math.max(1, Math.min(10, Math.trunc(bio.sampleCount ?? 3))),
    consentGiven: true,
    consentTimestamp: toIsoStringOrNow(bio.consentTimestamp),
    retentionPolicyVersion: bio.retentionPolicyVersion || 'SBIT-BIO-2026-v1',
    isActive: Boolean(bio.isActive),
  };
}

function serializeAttendanceRecord(
  rec: typeof attendanceRecords.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: rec.id,
    studentId: rec.studentId,
    studentEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    sessionId: rec.sessionId,
    departmentId: rec.departmentId,
    classId: rec.classId,
    subjectId: rec.subjectId ?? null,
    academicYearId: rec.academicYearId ?? null,
    semesterId: rec.semesterId ?? null,
    attendanceDate: rec.attendanceDate,
    markedAt: toIsoStringOrNow(rec.markedAt),
    status: rec.status,
    verificationMethod: rec.verificationMethod,
    verificationResult: rec.verificationResult,
    faceConfidence: rec.faceConfidence ?? null,
    livenessPassed: Boolean(rec.livenessPassed),
    latitude: rec.latitude ?? null,
    longitude: rec.longitude ?? null,
    geofenceDistanceM: rec.geofenceDistanceM ?? null,
    correctionReason: rec.correctionReason ? rec.correctionReason.slice(0, 500) : null,
    correctedBy: rec.correctedBy ?? null,
  };
}

function serializeStaffAssignment(
  sa: typeof staffAssignments.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: sa.id,
    staffId: sa.staffId,
    staffEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    departmentId: sa.departmentId,
    classId: sa.classId ?? null,
    subjectId: sa.subjectId ?? null,
    canCreateSessions: Boolean(sa.canCreateSessions),
    isActive: Boolean(sa.isActive),
  };
}

function serializeAttendanceCorrection(
  reqRow: typeof attendanceCorrectionRequests.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: reqRow.id,
    studentId: reqRow.studentId,
    studentEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    sessionId: reqRow.sessionId,
    requestedBy: reqRow.requestedBy,
    requestedStatus: reqRow.requestedStatus,
    requestType: reqRow.requestType,
    reason: reqRow.reason.slice(0, 500),
    status: reqRow.status,
    reviewedBy: reqRow.reviewedBy ?? null,
    reviewNote: reqRow.reviewNote ? reqRow.reviewNote.slice(0, 500) : null,
    reviewedAt: toIsoStringOrNull(reqRow.reviewedAt),
  };
}

function serializeAcademicHistory(
  hist: typeof studentAcademicHistory.$inferSelect,
  prof: typeof profiles.$inferSelect
): Record<string, unknown> {
  return {
    id: hist.id,
    studentId: hist.studentId,
    studentEmail: prof.email.toLowerCase().trim(),
    firebaseUid: prof.firebaseUid ?? null,
    academicYearId: hist.academicYearId,
    semesterId: hist.semesterId,
    departmentId: hist.departmentId,
    classId: hist.classId,
    regulation: hist.regulation || 'R22',
    attendancePercentage: hist.attendancePercentage ?? null,
    workingDays: 0,
    presentDays: 0,
    creditsEarned: Math.trunc(hist.creditsEarned ?? 0),
    creditsAttempted: 0,
    activeBacklogs: Math.trunc(hist.activeBacklogs ?? 0),
    resultStatus: hist.resultStatus || 'pending',
    status: hist.status || 'promoted',
    remarks: null,
    recordedAt: toIsoStringOrNow(hist.recordedAt),
  };
}

// ---------- Public Sync Helpers (safe non-throwing wrappers) ----------

export async function syncCatalogToFirestore(firebaseIdToken?: string | null): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const [
      [settings],
      depts,
      years,
      sems,
      clsList,
      subList,
      holList,
      ovrList,
      qrList,
      ruleList,
    ] = await Promise.all([
      db.select().from(collegeSettings).limit(1),
      db.select().from(departments),
      db.select().from(academicYears),
      db.select().from(semesters),
      db.select().from(classes),
      db.select().from(subjects),
      db.select().from(holidays),
      db.select().from(calendarOverrides),
      db.select().from(registrationQrCodes),
      db.select().from(jntuhRegulationRules),
    ]);

    if (!settings) return;

    await upsertFsDocWithUpdatedOnly(
      'systemCatalog',
      'college',
      {
        id: 'college',
        collegeSettings: settings,
        departments: depts,
        academicYears: years,
        semesters: sems,
        classes: clsList,
        subjects: subList,
        holidays: holList,
        calendarOverrides: ovrList,
        registrationQrCodes: qrList,
        jntuhRegulationRules: ruleList,
      },
      firebaseIdToken
    );
  } catch (err) {
    console.warn('[FirestoreSync] syncCatalogToFirestore failed:', err);
  }
}

export async function syncProfileAndEnrollmentToFirestore(
  firebaseIdToken: string | null | undefined,
  profileId: string
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const [row] = await db
      .select({
        prof: profiles,
        roleName: roles.name,
      })
      .from(profiles)
      .innerJoin(roles, eq(profiles.roleId, roles.id))
      .where(eq(profiles.id, profileId))
      .limit(1);

    if (!row) return;

    await upsertFsDocWithCreatedAndUpdated(
      'users',
      row.prof.id,
      serializeUserProfile(row.prof, row.roleName),
      firebaseIdToken
    );

    const [enr] = await db
      .select()
      .from(studentEnrollments)
      .where(eq(studentEnrollments.studentId, profileId))
      .limit(1);

    if (enr) {
      await upsertFsDocWithCreatedAndUpdated(
        'studentEnrollments',
        row.prof.id,
        serializeEnrollment(enr, row.prof),
        firebaseIdToken
      );
    }
  } catch (err) {
    console.warn('[FirestoreSync] syncProfileAndEnrollmentToFirestore failed:', err);
  }
}

export async function syncProfilesBulkToFirestore(
  firebaseIdToken: string | null | undefined,
  profileIds: string[]
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken || profileIds.length === 0) return;
  for (const id of profileIds) {
    await syncProfileAndEnrollmentToFirestore(firebaseIdToken, id);
  }
}

export async function deleteUserFromFirestore(
  firebaseIdToken: string | null | undefined,
  profileId: string,
  related?: {
    recordIds?: string[];
    assignmentIds?: string[];
    correctionIds?: string[];
    historyIds?: string[];
  }
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const deletes: Promise<void>[] = [
      deleteFsDoc('users', profileId, firebaseIdToken),
      deleteFsDoc('studentEnrollments', profileId, firebaseIdToken),
      deleteFsDoc('biometricTemplates', profileId, firebaseIdToken),
    ];
    for (const id of related?.recordIds ?? []) {
      deletes.push(deleteFsDoc('attendanceRecords', id, firebaseIdToken));
    }
    for (const id of related?.assignmentIds ?? []) {
      deletes.push(deleteFsDoc('staffAssignments', id, firebaseIdToken));
    }
    for (const id of related?.correctionIds ?? []) {
      deletes.push(deleteFsDoc('attendanceCorrections', id, firebaseIdToken));
    }
    for (const id of related?.historyIds ?? []) {
      deletes.push(deleteFsDoc('studentAcademicHistory', id, firebaseIdToken));
    }
    await Promise.all(deletes);
  } catch (err) {
    console.warn('[FirestoreSync] deleteUserFromFirestore failed:', err);
  }
}

export async function syncBiometricToFirestore(
  firebaseIdToken: string | null | undefined,
  studentId: string
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const [[bio], [prof]] = await Promise.all([
      db.select().from(biometricTemplates).where(eq(biometricTemplates.studentId, studentId)).limit(1),
      db.select().from(profiles).where(eq(profiles.id, studentId)).limit(1),
    ]);
    if (!bio || !prof) return;
    await upsertFsDocWithCreatedAndUpdated(
      'biometricTemplates',
      studentId,
      serializeBiometric(bio, prof),
      firebaseIdToken
    );
  } catch (err) {
    console.warn('[FirestoreSync] syncBiometricToFirestore failed:', err);
  }
}

export async function deleteBiometricFromFirestore(
  firebaseIdToken: string | null | undefined,
  studentId: string
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  await deleteFsDoc('biometricTemplates', studentId, firebaseIdToken);
}

export async function syncClassSessionBucketsToFirestore(
  firebaseIdToken: string | null | undefined,
  targetClassIds?: string[]
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const sessions =
      targetClassIds && targetClassIds.length > 0
        ? await db
            .select()
            .from(attendanceSessions)
            .where(inArray(attendanceSessions.classId, targetClassIds))
        : await db.select().from(attendanceSessions);

    if (sessions.length === 0) return;

    const bucketMap = new Map<
      string,
      {
        id: string;
        classId: string;
        departmentId: string;
        monthKey: string;
        sessions: Array<Record<string, unknown>>;
      }
    >();

    for (const s of sessions) {
      const monthKey = s.sessionDate.slice(0, 7); // YYYY-MM
      const bucketId = `${s.classId}_${monthKey.replace('-', '_')}`;
      let bucket = bucketMap.get(bucketId);
      if (!bucket) {
        bucket = {
          id: bucketId,
          classId: s.classId,
          departmentId: s.departmentId,
          monthKey,
          sessions: [],
        };
        bucketMap.set(bucketId, bucket);
      }
      if (bucket.sessions.length < 400) {
        bucket.sessions.push({
          ...s,
          createdAt: toIsoStringOrNow(s.createdAt),
          updatedAt: toIsoStringOrNow(s.updatedAt),
        });
      }
    }

    for (const bucket of bucketMap.values()) {
      await upsertFsDocWithUpdatedOnly(
        'classSessionBuckets',
        bucket.id,
        bucket,
        firebaseIdToken
      );
      for (const s of bucket.sessions) {
        if (typeof s.id === 'string') {
          syncedBucketSessionIds.add(s.id);
        }
      }
    }
  } catch (err) {
    console.warn('[FirestoreSync] syncClassSessionBucketsToFirestore failed:', err);
  }
}

export async function syncAttendanceRecordToFirestore(
  firebaseIdToken: string | null | undefined,
  recordId: string
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const [rec] = await db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, recordId))
      .limit(1);
    if (!rec) return;
    const [prof] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, rec.studentId))
      .limit(1);
    if (!prof) return;
    await upsertFsDocWithCreatedAndUpdated(
      'attendanceRecords',
      rec.id,
      serializeAttendanceRecord(rec, prof),
      firebaseIdToken
    );
  } catch (err) {
    console.warn('[FirestoreSync] syncAttendanceRecordToFirestore failed:', err);
  }
}

export async function syncStaffAssignmentsToFirestore(
  firebaseIdToken: string | null | undefined,
  staffId: string,
  removedAssignmentIds?: string[]
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    if (removedAssignmentIds && removedAssignmentIds.length > 0) {
      await Promise.all(
        removedAssignmentIds.map((id) => deleteFsDoc('staffAssignments', id, firebaseIdToken))
      );
    }
    const [prof] = await db.select().from(profiles).where(eq(profiles.id, staffId)).limit(1);
    if (!prof) return;
    const rows = await db
      .select()
      .from(staffAssignments)
      .where(eq(staffAssignments.staffId, staffId));
    for (const sa of rows) {
      await upsertFsDocWithCreatedAndUpdated(
        'staffAssignments',
        sa.id,
        serializeStaffAssignment(sa, prof),
        firebaseIdToken
      );
    }
  } catch (err) {
    console.warn('[FirestoreSync] syncStaffAssignmentsToFirestore failed:', err);
  }
}

export async function syncCorrectionToFirestore(
  firebaseIdToken: string | null | undefined,
  correctionId: string
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken) return;
  try {
    const [row] = await db
      .select()
      .from(attendanceCorrectionRequests)
      .where(eq(attendanceCorrectionRequests.id, correctionId))
      .limit(1);
    if (!row) return;
    const [prof] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, row.studentId))
      .limit(1);
    if (!prof) return;
    await upsertFsDocWithCreatedAndUpdated(
      'attendanceCorrections',
      row.id,
      serializeAttendanceCorrection(row, prof),
      firebaseIdToken
    );
  } catch (err) {
    console.warn('[FirestoreSync] syncCorrectionToFirestore failed:', err);
  }
}

export async function syncAcademicHistoryToFirestore(
  firebaseIdToken: string | null | undefined,
  studentIds: string[]
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken || studentIds.length === 0) return;
  try {
    const [profs, rows] = await Promise.all([
      db.select().from(profiles).where(inArray(profiles.id, studentIds)),
      db.select().from(studentAcademicHistory).where(inArray(studentAcademicHistory.studentId, studentIds)),
    ]);
    const profMap = new Map(profs.map((p) => [p.id, p]));
    for (const hist of rows) {
      const prof = profMap.get(hist.studentId);
      if (!prof) continue;
      await upsertFsDocWithUpdatedOnly(
        'studentAcademicHistory',
        hist.id,
        serializeAcademicHistory(hist, prof),
        firebaseIdToken
      );
    }
  } catch (err) {
    console.warn('[FirestoreSync] syncAcademicHistoryToFirestore failed:', err);
  }
}

// ---------- Hydration Helpers (Firestore -> DB on restart / login) ----------

let publicCatalogHydrated = false;
let publicCatalogPromise: Promise<boolean> | null = null;
let adminHydrated = false;
let adminHydratePromise: Promise<void> | null = null;
const hydratedUserEmails = new Set<string>();
const userHydratePromises = new Map<string, Promise<void>>();

async function applyCatalogDocToDb(data: Record<string, unknown>, authoritative: boolean): Promise<void> {
  const settingsData = data.collegeSettings as Record<string, unknown> | undefined;
  if (settingsData && typeof settingsData === 'object') {
    const existingSettings = await db.select().from(collegeSettings).limit(1);
    const settingsPayload = {
      collegeName: String(settingsData.collegeName || 'Swarna Bharathi Institute of Science and Technology'),
      logoUrl: (settingsData.logoUrl as string) || '/src/assets/images/sbist_college_crest_1795533458624.jpg',
      locationVerificationEnabled: Boolean(settingsData.locationVerificationEnabled ?? true),
      collegeLatitude: Number(settingsData.collegeLatitude ?? 17.2473),
      collegeLongitude: Number(settingsData.collegeLongitude ?? 80.1514),
      geofenceRadiusMeters: Math.trunc(Number(settingsData.geofenceRadiusMeters ?? 300)),
      attendanceFrequency: String(settingsData.attendanceFrequency || 'every_class_period'),
      qrDefaultExpiryHours: Math.trunc(Number(settingsData.qrDefaultExpiryHours ?? 24)),
      faceMatchThreshold: (() => {
        const raw = Number(settingsData.faceMatchThreshold ?? 0.3);
        if (!Number.isFinite(raw) || raw > 0.33 || raw < 0.22) return 0.3;
        return raw;
      })(),
      livenessRequired: Boolean(settingsData.livenessRequired ?? true),
      autoDailySessionsEnabled: Boolean(settingsData.autoDailySessionsEnabled ?? true),
      morningStartTime: String(settingsData.morningStartTime || '09:00'),
      morningEndTime: String(settingsData.morningEndTime || '09:40'),
      afternoonStartTime: String(settingsData.afternoonStartTime || '13:30'),
      afternoonEndTime: String(settingsData.afternoonEndTime || '13:40'),
      workingWeekdays: Array.isArray(settingsData.workingWeekdays)
        ? (settingsData.workingWeekdays as number[])
        : [1, 2, 3, 4, 5, 6],
      updatedBy: null,
      updatedAt: toDateOrNow(settingsData.updatedAt),
    };
    if (existingSettings.length > 0) {
      await db
        .update(collegeSettings)
        .set(settingsPayload)
        .where(eq(collegeSettings.id, existingSettings[0].id));
    } else if (typeof settingsData.id === 'string') {
      await db.insert(collegeSettings).values({ id: settingsData.id, ...settingsPayload }).onConflictDoNothing();
    }
  }

  const depts = Array.isArray(data.departments) ? (data.departments as Array<Record<string, unknown>>) : [];
  for (const d of depts) {
    if (typeof d.id !== 'string' || typeof d.code !== 'string') continue;
    await db
      .insert(departments)
      .values({
        id: d.id,
        code: d.code,
        name: String(d.name || d.code),
        isActive: Boolean(d.isActive ?? true),
        createdAt: toDateOrNow(d.createdAt),
      })
      .onConflictDoUpdate({
        target: departments.code,
        set: { name: String(d.name || d.code), isActive: Boolean(d.isActive ?? true) },
      });
  }

  const years = Array.isArray(data.academicYears) ? (data.academicYears as Array<Record<string, unknown>>) : [];
  for (const y of years) {
    if (typeof y.id !== 'string' || typeof y.yearNumber !== 'number') continue;
    await db
      .insert(academicYears)
      .values({
        id: y.id,
        yearNumber: Math.trunc(y.yearNumber),
        label: String(y.label || `${y.yearNumber} Year`),
        academicSession: String(y.academicSession || '2026-2027'),
        isActive: Boolean(y.isActive ?? true),
        createdAt: toDateOrNow(y.createdAt),
      })
      .onConflictDoUpdate({
        target: academicYears.yearNumber,
        set: {
          label: String(y.label || `${y.yearNumber} Year`),
          academicSession: String(y.academicSession || '2026-2027'),
          isActive: Boolean(y.isActive ?? true),
        },
      });
  }

  const sems = Array.isArray(data.semesters) ? (data.semesters as Array<Record<string, unknown>>) : [];
  for (const s of sems) {
    if (typeof s.id !== 'string' || typeof s.semesterNumber !== 'number' || typeof s.academicYearId !== 'string') continue;
    await db
      .insert(semesters)
      .values({
        id: s.id,
        semesterNumber: Math.trunc(s.semesterNumber),
        label: String(s.label || `Semester ${s.semesterNumber}`),
        academicYearId: s.academicYearId,
        isActive: Boolean(s.isActive ?? true),
        createdAt: toDateOrNow(s.createdAt),
      })
      .onConflictDoUpdate({
        target: semesters.semesterNumber,
        set: {
          label: String(s.label || `Semester ${s.semesterNumber}`),
          isActive: Boolean(s.isActive ?? true),
        },
      });
  }

  const clsList = Array.isArray(data.classes) ? (data.classes as Array<Record<string, unknown>>) : [];
  for (const c of clsList) {
    if (
      typeof c.id !== 'string' ||
      typeof c.departmentId !== 'string' ||
      typeof c.academicYearId !== 'string' ||
      typeof c.semesterId !== 'string'
    ) {
      continue;
    }
    await db
      .insert(classes)
      .values({
        id: c.id,
        departmentId: c.departmentId,
        academicYearId: c.academicYearId,
        semesterId: c.semesterId,
        sectionName: String(c.sectionName || 'Regular'),
        displayName: String(c.displayName || 'Class'),
        isActive: Boolean(c.isActive ?? true),
        createdAt: toDateOrNow(c.createdAt),
      })
      .onConflictDoNothing();
  }

  const subList = Array.isArray(data.subjects) ? (data.subjects as Array<Record<string, unknown>>) : [];
  for (const sub of subList) {
    if (
      typeof sub.id !== 'string' ||
      typeof sub.code !== 'string' ||
      typeof sub.departmentId !== 'string' ||
      typeof sub.semesterId !== 'string'
    ) {
      continue;
    }
    await db
      .insert(subjects)
      .values({
        id: sub.id,
        code: sub.code,
        name: String(sub.name || sub.code),
        departmentId: sub.departmentId,
        semesterId: sub.semesterId,
        credits: Math.trunc(Number(sub.credits ?? 3)),
        isActive: Boolean(sub.isActive ?? true),
        createdAt: toDateOrNow(sub.createdAt),
      })
      .onConflictDoNothing();
  }

  const holList = Array.isArray(data.holidays) ? (data.holidays as Array<Record<string, unknown>>) : [];
  if (authoritative) {
    await db.delete(holidays);
  }
  for (const h of holList) {
    if (typeof h.id !== 'string' || typeof h.startDate !== 'string' || typeof h.endDate !== 'string') continue;
    await db
      .insert(holidays)
      .values({
        id: h.id,
        title: String(h.title || 'Holiday'),
        startDate: h.startDate,
        endDate: h.endDate,
        reason: (h.reason as string | null) ?? null,
        createdBy: null,
        createdAt: toDateOrNow(h.createdAt),
        updatedAt: toDateOrNow(h.updatedAt),
      })
      .onConflictDoUpdate({
        target: holidays.id,
        set: {
          title: String(h.title || 'Holiday'),
          startDate: h.startDate,
          endDate: h.endDate,
          reason: (h.reason as string | null) ?? null,
          updatedAt: toDateOrNow(h.updatedAt),
        },
      });
  }

  const ovrList = Array.isArray(data.calendarOverrides) ? (data.calendarOverrides as Array<Record<string, unknown>>) : [];
  if (authoritative) {
    await db.delete(calendarOverrides);
  }
  for (const o of ovrList) {
    if (typeof o.id !== 'string' || typeof o.overrideDate !== 'string') continue;
    await db
      .insert(calendarOverrides)
      .values({
        id: o.id,
        overrideDate: o.overrideDate,
        overrideType: String(o.overrideType || 'working_day'),
        title: String(o.title || 'Override'),
        reason: (o.reason as string | null) ?? null,
        createdBy: null,
        createdAt: toDateOrNow(o.createdAt),
        updatedAt: toDateOrNow(o.updatedAt),
      })
      .onConflictDoUpdate({
        target: calendarOverrides.overrideDate,
        set: {
          overrideType: String(o.overrideType || 'working_day'),
          title: String(o.title || 'Override'),
          reason: (o.reason as string | null) ?? null,
          updatedAt: toDateOrNow(o.updatedAt),
        },
      });
  }

  const qrList = Array.isArray(data.registrationQrCodes)
    ? (data.registrationQrCodes as Array<Record<string, unknown>>)
    : [];
  for (const q of qrList) {
    if (typeof q.id !== 'string' || typeof q.token !== 'string') continue;
    await db
      .insert(registrationQrCodes)
      .values({
        id: q.id,
        token: q.token,
        qrPurpose: String(q.qrPurpose || 'registration'),
        label: String(q.label || q.token),
        departmentId: (q.departmentId as string | null) ?? null,
        academicYearId: (q.academicYearId as string | null) ?? null,
        semesterId: (q.semesterId as string | null) ?? null,
        sessionId: (q.sessionId as string | null) ?? null,
        maxUses: typeof q.maxUses === 'number' ? Math.trunc(q.maxUses) : null,
        usedCount: Math.trunc(Number(q.usedCount ?? 0)),
        expiresAt: toDateOrNull(q.expiresAt),
        isRevoked: Boolean(q.isRevoked ?? false),
        createdBy: null,
        createdAt: toDateOrNow(q.createdAt),
      })
      .onConflictDoUpdate({
        target: registrationQrCodes.token,
        set: {
          qrPurpose: String(q.qrPurpose || 'registration'),
          label: String(q.label || q.token),
          usedCount: Math.trunc(Number(q.usedCount ?? 0)),
          expiresAt: toDateOrNull(q.expiresAt),
          isRevoked: Boolean(q.isRevoked ?? false),
        },
      });
  }

  const ruleList = Array.isArray(data.jntuhRegulationRules)
    ? (data.jntuhRegulationRules as Array<Record<string, unknown>>)
    : [];
  for (const r of ruleList) {
    if (typeof r.id !== 'string' || typeof r.code !== 'string') continue;
    await db
      .insert(jntuhRegulationRules)
      .values({
        id: r.id,
        code: r.code,
        name: String(r.name || r.code),
        minAttendancePercent: Number(r.minAttendancePercent ?? 65),
        sem2To3MinCredits: Math.trunc(Number(r.sem2To3MinCredits ?? 20)),
        sem4To5MinCredits: Math.trunc(Number(r.sem4To5MinCredits ?? 40)),
        sem6To7MinCredits: Math.trunc(Number(r.sem6To7MinCredits ?? 60)),
        maxBacklogsForPromotion:
          typeof r.maxBacklogsForPromotion === 'number' ? Math.trunc(r.maxBacklogsForPromotion) : null,
        requireResultPublished: Boolean(r.requireResultPublished ?? true),
        isActive: Boolean(r.isActive ?? true),
        createdAt: toDateOrNow(r.createdAt),
        updatedAt: toDateOrNow(r.updatedAt),
      })
      .onConflictDoUpdate({
        target: jntuhRegulationRules.code,
        set: {
          minAttendancePercent: Number(r.minAttendancePercent ?? 65),
          sem2To3MinCredits: Math.trunc(Number(r.sem2To3MinCredits ?? 20)),
          sem4To5MinCredits: Math.trunc(Number(r.sem4To5MinCredits ?? 40)),
          sem6To7MinCredits: Math.trunc(Number(r.sem6To7MinCredits ?? 60)),
          maxBacklogsForPromotion:
            typeof r.maxBacklogsForPromotion === 'number' ? Math.trunc(r.maxBacklogsForPromotion) : null,
          requireResultPublished: Boolean(r.requireResultPublished ?? true),
          isActive: Boolean(r.isActive ?? true),
          updatedAt: toDateOrNow(r.updatedAt),
        },
      });
  }

  invalidateScheduleSyncCache();
}

export async function hydratePublicCatalogFromFirestore(): Promise<boolean> {
  if (isTestEnv()) return false;
  if (publicCatalogHydrated) return true;
  if (publicCatalogPromise) return publicCatalogPromise;

  publicCatalogPromise = (async () => {
    try {
      const doc = await getFsDoc('systemCatalog', 'college', null);
      if (!doc) {
        publicCatalogHydrated = true;
        return false;
      }
      await applyCatalogDocToDb(fsDocToJs(doc), true);
      publicCatalogHydrated = true;
      return true;
    } catch (err) {
      console.warn('[FirestoreSync] hydratePublicCatalogFromFirestore failed:', err);
      return false;
    } finally {
      publicCatalogPromise = null;
    }
  })();

  return publicCatalogPromise;
}

async function upsertSessionsFromBucketDocs(bucketDocs: FsDocument[]): Promise<void> {
  for (const bDoc of bucketDocs) {
    const bData = fsDocToJs(bDoc);
    const sessions = Array.isArray(bData.sessions) ? (bData.sessions as Array<Record<string, unknown>>) : [];
    for (const s of sessions) {
      if (
        typeof s.id !== 'string' ||
        typeof s.sessionCode !== 'string' ||
        typeof s.departmentId !== 'string' ||
        typeof s.classId !== 'string' ||
        typeof s.academicYearId !== 'string' ||
        typeof s.semesterId !== 'string' ||
        typeof s.sessionDate !== 'string'
      ) {
        continue;
      }
      syncedBucketSessionIds.add(s.id);
      await db
        .insert(attendanceSessions)
        .values({
          id: s.id,
          sessionCode: s.sessionCode,
          departmentId: s.departmentId,
          classId: s.classId,
          academicYearId: s.academicYearId,
          semesterId: s.semesterId,
          subjectId: (s.subjectId as string | null) ?? null,
          sessionDate: s.sessionDate,
          startTime: String(s.startTime || '09:00'),
          endTime: String(s.endTime || '09:40'),
          periodSlot: String(s.periodSlot || 'daily'),
          sessionType: String(s.sessionType || 'manual'),
          isAutoScheduled: Boolean(s.isAutoScheduled ?? false),
          autoScheduleKey: (s.autoScheduleKey as string | null) ?? null,
          status: String(s.status || 'closed'),
          cancelledReason: (s.cancelledReason as string | null) ?? null,
          createdBy: null,
          createdAt: toDateOrNow(s.createdAt),
          updatedAt: toDateOrNow(s.updatedAt),
        })
        .onConflictDoUpdate({
          target: attendanceSessions.sessionCode,
          set: {
            status: String(s.status || 'closed'),
            startTime: String(s.startTime || '09:00'),
            endTime: String(s.endTime || '09:40'),
            cancelledReason: (s.cancelledReason as string | null) ?? null,
            updatedAt: toDateOrNow(s.updatedAt),
          },
        });
    }
  }
}

async function upsertUserDocToDb(
  uData: Record<string, unknown>,
  roleByName: Map<string, string>
): Promise<string | null> {
  if (typeof uData.id !== 'string' || typeof uData.email !== 'string') return null;
  const email = uData.email.toLowerCase().trim();
  let desiredRole = String(uData.role || 'student');
  if (email !== PERMANENT_ADMIN_EMAIL && desiredRole === 'super_admin') {
    desiredRole = 'student';
  }
  if (email === PERMANENT_ADMIN_EMAIL) {
    desiredRole = 'super_admin';
  }
  const roleId = roleByName.get(desiredRole) ?? roleByName.get('student');
  if (!roleId) return null;

  await db
    .insert(profiles)
    .values({
      id: uData.id,
      firebaseUid: (uData.firebaseUid as string | null) ?? null,
      roleId,
      fullName: String(uData.fullName || email),
      email,
      phone: (uData.phone as string | null) ?? null,
      rollNumber: (uData.rollNumber as string | null) ?? null,
      employeeId: (uData.employeeId as string | null) ?? null,
      passwordHash: null,
      status: String(uData.status || 'pending'),
      emailVerified: Boolean(uData.emailVerified ?? false),
      rejectionReason: (uData.rejectionReason as string | null) ?? null,
      createdAt: toDateOrNow(uData.createdAt),
      updatedAt: toDateOrNow(uData.updatedAt),
    })
    .onConflictDoUpdate({
      target: profiles.email,
      set: {
        firebaseUid: (uData.firebaseUid as string | null) ?? null,
        roleId,
        fullName: String(uData.fullName || email),
        phone: (uData.phone as string | null) ?? null,
        rollNumber: (uData.rollNumber as string | null) ?? null,
        employeeId: (uData.employeeId as string | null) ?? null,
        status: String(uData.status || 'pending'),
        emailVerified: Boolean(uData.emailVerified ?? false),
        rejectionReason: (uData.rejectionReason as string | null) ?? null,
        updatedAt: toDateOrNow(uData.updatedAt),
      },
    });
  return uData.id;
}

async function upsertEnrollmentDocToDb(eData: Record<string, unknown>): Promise<void> {
  if (
    typeof eData.id !== 'string' ||
    typeof eData.studentId !== 'string' ||
    typeof eData.rollNumber !== 'string' ||
    typeof eData.departmentId !== 'string' ||
    typeof eData.academicYearId !== 'string' ||
    typeof eData.semesterId !== 'string' ||
    typeof eData.classId !== 'string'
  ) {
    return;
  }
  await db
    .insert(studentEnrollments)
    .values({
      id: eData.id,
      studentId: eData.studentId,
      rollNumber: eData.rollNumber,
      departmentId: eData.departmentId,
      academicYearId: eData.academicYearId,
      semesterId: eData.semesterId,
      classId: eData.classId,
      isActive: Boolean(eData.isActive ?? true),
      approvalRequired: Boolean(eData.approvalRequired ?? false),
      regulation: String(eData.regulation || 'R22'),
      academicStanding: String(eData.academicStanding || 'active'),
      creditsEarned: Math.trunc(Number(eData.creditsEarned ?? 0)),
      totalCreditsAttempted: Math.trunc(Number(eData.totalCreditsAttempted ?? 0)),
      activeBacklogs: Math.trunc(Number(eData.activeBacklogs ?? 0)),
      latestResultStatus: String(eData.latestResultStatus || 'pending'),
      detentionReason: (eData.detentionReason as string | null) ?? null,
      lastPromotedAt: toDateOrNull(eData.lastPromotedAt),
      lastPromotionBatchId: null,
      approvedBy: null,
      approvedAt: toDateOrNull(eData.approvedAt),
      joinedDateIST: (eData.joinedDateIST as string | null) ?? null,
      enrolledAt: toDateOrNow(eData.enrolledAt),
    })
    .onConflictDoUpdate({
      target: studentEnrollments.studentId,
      set: {
        departmentId: eData.departmentId,
        academicYearId: eData.academicYearId,
        semesterId: eData.semesterId,
        classId: eData.classId,
        isActive: Boolean(eData.isActive ?? true),
        approvalRequired: Boolean(eData.approvalRequired ?? false),
        regulation: String(eData.regulation || 'R22'),
        academicStanding: String(eData.academicStanding || 'active'),
        creditsEarned: Math.trunc(Number(eData.creditsEarned ?? 0)),
        totalCreditsAttempted: Math.trunc(Number(eData.totalCreditsAttempted ?? 0)),
        activeBacklogs: Math.trunc(Number(eData.activeBacklogs ?? 0)),
        latestResultStatus: String(eData.latestResultStatus || 'pending'),
        detentionReason: (eData.detentionReason as string | null) ?? null,
        lastPromotedAt: toDateOrNull(eData.lastPromotedAt),
        approvedAt: toDateOrNull(eData.approvedAt),
        joinedDateIST: (eData.joinedDateIST as string | null) ?? null,
      },
    });
}

async function upsertBiometricDocToDb(bData: Record<string, unknown>): Promise<void> {
  if (
    typeof bData.id !== 'string' ||
    typeof bData.studentId !== 'string' ||
    typeof bData.encryptedDescriptor !== 'string' ||
    typeof bData.iv !== 'string' ||
    typeof bData.authTag !== 'string'
  ) {
    return;
  }
  await db
    .insert(biometricTemplates)
    .values({
      id: bData.id,
      studentId: bData.studentId,
      encryptedDescriptor: bData.encryptedDescriptor,
      iv: bData.iv,
      authTag: bData.authTag,
      algorithm: String(bData.algorithm || 'face-api-128d-aes256gcm'),
      sampleCount: Math.trunc(Number(bData.sampleCount ?? 3)),
      consentGiven: Boolean(bData.consentGiven ?? true),
      consentTimestamp: toDateOrNow(bData.consentTimestamp),
      retentionPolicyVersion: String(bData.retentionPolicyVersion || 'SBIT-BIO-2026-v1'),
      isActive: Boolean(bData.isActive ?? true),
      createdAt: toDateOrNow(bData.createdAt),
      updatedAt: toDateOrNow(bData.updatedAt),
    })
    .onConflictDoUpdate({
      target: biometricTemplates.studentId,
      set: {
        encryptedDescriptor: bData.encryptedDescriptor,
        iv: bData.iv,
        authTag: bData.authTag,
        algorithm: String(bData.algorithm || 'face-api-128d-aes256gcm'),
        sampleCount: Math.trunc(Number(bData.sampleCount ?? 3)),
        isActive: Boolean(bData.isActive ?? true),
        updatedAt: toDateOrNow(bData.updatedAt),
      },
    });
}

async function upsertAttendanceDocToDb(aData: Record<string, unknown>): Promise<void> {
  if (
    typeof aData.id !== 'string' ||
    typeof aData.studentId !== 'string' ||
    typeof aData.sessionId !== 'string' ||
    typeof aData.departmentId !== 'string' ||
    typeof aData.classId !== 'string' ||
    typeof aData.attendanceDate !== 'string'
  ) {
    return;
  }
  await db
    .insert(attendanceRecords)
    .values({
      id: aData.id,
      studentId: aData.studentId,
      sessionId: aData.sessionId,
      departmentId: aData.departmentId,
      classId: aData.classId,
      subjectId: (aData.subjectId as string | null) ?? null,
      academicYearId: (aData.academicYearId as string | null) ?? null,
      semesterId: (aData.semesterId as string | null) ?? null,
      attendanceDate: aData.attendanceDate,
      markedAt: toDateOrNow(aData.markedAt),
      status: String(aData.status || 'present'),
      verificationMethod: String(aData.verificationMethod || 'face_geofence'),
      verificationResult: String(aData.verificationResult || 'verified'),
      faceConfidence: typeof aData.faceConfidence === 'number' ? aData.faceConfidence : null,
      livenessPassed: Boolean(aData.livenessPassed ?? false),
      latitude: typeof aData.latitude === 'number' ? aData.latitude : null,
      longitude: typeof aData.longitude === 'number' ? aData.longitude : null,
      geofenceDistanceM: typeof aData.geofenceDistanceM === 'number' ? aData.geofenceDistanceM : null,
      correctionReason: (aData.correctionReason as string | null) ?? null,
      correctedBy: null,
      createdAt: toDateOrNow(aData.createdAt),
    })
    .onConflictDoUpdate({
      target: [attendanceRecords.studentId, attendanceRecords.sessionId],
      set: {
        status: String(aData.status || 'present'),
        verificationMethod: String(aData.verificationMethod || 'face_geofence'),
        verificationResult: String(aData.verificationResult || 'verified'),
        correctionReason: (aData.correctionReason as string | null) ?? null,
      },
    });
}

async function upsertStaffAssignmentDocToDb(saData: Record<string, unknown>): Promise<void> {
  if (
    typeof saData.id !== 'string' ||
    typeof saData.staffId !== 'string' ||
    typeof saData.departmentId !== 'string'
  ) {
    return;
  }
  await db
    .insert(staffAssignments)
    .values({
      id: saData.id,
      staffId: saData.staffId,
      departmentId: saData.departmentId,
      classId: (saData.classId as string | null) ?? null,
      subjectId: (saData.subjectId as string | null) ?? null,
      canCreateSessions: Boolean(saData.canCreateSessions ?? true),
      isActive: Boolean(saData.isActive ?? true),
      createdAt: toDateOrNow(saData.createdAt),
    })
    .onConflictDoNothing();
}

async function upsertCorrectionDocToDb(cData: Record<string, unknown>): Promise<void> {
  if (
    typeof cData.id !== 'string' ||
    typeof cData.studentId !== 'string' ||
    typeof cData.sessionId !== 'string' ||
    typeof cData.requestedBy !== 'string'
  ) {
    return;
  }
  await db
    .insert(attendanceCorrectionRequests)
    .values({
      id: cData.id,
      studentId: cData.studentId,
      sessionId: cData.sessionId,
      requestedBy: cData.requestedBy,
      requestedStatus: String(cData.requestedStatus || 'present'),
      requestType: String(cData.requestType || 'correction'),
      reason: String(cData.reason || 'Request'),
      status: String(cData.status || 'pending'),
      reviewedBy: null,
      reviewNote: (cData.reviewNote as string | null) ?? null,
      reviewedAt: toDateOrNull(cData.reviewedAt),
      createdAt: toDateOrNow(cData.createdAt),
    })
    .onConflictDoUpdate({
      target: attendanceCorrectionRequests.id,
      set: {
        status: String(cData.status || 'pending'),
        reviewNote: (cData.reviewNote as string | null) ?? null,
        reviewedAt: toDateOrNull(cData.reviewedAt),
      },
    });
}

async function upsertAcademicHistoryDocToDb(hData: Record<string, unknown>): Promise<void> {
  if (
    typeof hData.id !== 'string' ||
    typeof hData.studentId !== 'string' ||
    typeof hData.departmentId !== 'string' ||
    typeof hData.academicYearId !== 'string' ||
    typeof hData.semesterId !== 'string' ||
    typeof hData.classId !== 'string'
  ) {
    return;
  }
  await db
    .insert(studentAcademicHistory)
    .values({
      id: hData.id,
      studentId: hData.studentId,
      rollNumber: String(hData.rollNumber || hData.studentId),
      departmentId: hData.departmentId,
      academicYearId: hData.academicYearId,
      semesterId: hData.semesterId,
      classId: hData.classId,
      regulation: String(hData.regulation || 'R22'),
      creditsEarned: Math.trunc(Number(hData.creditsEarned ?? 0)),
      activeBacklogs: Math.trunc(Number(hData.activeBacklogs ?? 0)),
      resultStatus: String(hData.resultStatus || 'pending'),
      attendancePercentage:
        typeof hData.attendancePercentage === 'number' ? hData.attendancePercentage : null,
      status: String(hData.status || 'promoted'),
      promotionBatchId: null,
      recordedAt: toDateOrNow(hData.recordedAt),
    })
    .onConflictDoNothing();
}

export async function hydrateUserFromFirestore(
  firebaseIdToken: string,
  email: string,
  uid: string
): Promise<void> {
  if (isTestEnv()) return;
  const normalizedEmail = email.toLowerCase().trim();
  if (hydratedUserEmails.has(normalizedEmail)) return;
  const inflight = userHydratePromises.get(normalizedEmail);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      await hydratePublicCatalogFromFirestore();

      const roleRows = await db.select().from(roles);
      const roleByName = new Map(roleRows.map((r) => [r.name, r.id]));

      let userDocs = await runFsFieldQuery('users', 'email', normalizedEmail, firebaseIdToken);
      if (userDocs.length === 0 && uid) {
        userDocs = await runFsFieldQuery('users', 'firebaseUid', uid, firebaseIdToken);
      }

      if (userDocs.length === 0) {
        hydratedUserEmails.add(normalizedEmail);
        return;
      }

      for (const uDoc of userDocs) {
        await upsertUserDocToDb(fsDocToJs(uDoc), roleByName);
      }

      const [enrDocs, bioDocs, attDocs, corrDocs, histDocs, staffDocs] = await Promise.all([
        runFsFieldQuery('studentEnrollments', 'studentEmail', normalizedEmail, firebaseIdToken),
        runFsFieldQuery('biometricTemplates', 'studentEmail', normalizedEmail, firebaseIdToken),
        runFsFieldQuery('attendanceRecords', 'studentEmail', normalizedEmail, firebaseIdToken),
        runFsFieldQuery('attendanceCorrections', 'studentEmail', normalizedEmail, firebaseIdToken),
        runFsFieldQuery('studentAcademicHistory', 'studentEmail', normalizedEmail, firebaseIdToken),
        runFsFieldQuery('staffAssignments', 'staffEmail', normalizedEmail, firebaseIdToken),
      ]);

      // Fetch classSessionBuckets for student's class (current & previous 5 months) so session FKs & stats restore completely
      const classIds = new Set<string>();
      for (const e of enrDocs) {
        const cid = fsDocToJs(e).classId;
        if (typeof cid === 'string') classIds.add(cid);
      }
      for (const a of attDocs) {
        const cid = fsDocToJs(a).classId;
        if (typeof cid === 'string') classIds.add(cid);
      }

      if (classIds.size > 0) {
        const now = new Date();
        const bucketGets: Promise<FsDocument | null>[] = [];
        for (const cid of classIds) {
          for (let m = 0; m < 6; m++) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
            const ym = `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            bucketGets.push(
              getFsDoc('classSessionBuckets', `${cid}_${ym}`, firebaseIdToken).catch(() => null)
            );
          }
        }
        const buckets = (await Promise.all(bucketGets)).filter((b): b is FsDocument => b !== null);
        await upsertSessionsFromBucketDocs(buckets);
      }

      for (const e of enrDocs) await upsertEnrollmentDocToDb(fsDocToJs(e));
      for (const b of bioDocs) await upsertBiometricDocToDb(fsDocToJs(b));
      for (const a of attDocs) await upsertAttendanceDocToDb(fsDocToJs(a));
      for (const c of corrDocs) await upsertCorrectionDocToDb(fsDocToJs(c));
      for (const h of histDocs) await upsertAcademicHistoryDocToDb(fsDocToJs(h));
      for (const s of staffDocs) await upsertStaffAssignmentDocToDb(fsDocToJs(s));

      hydratedUserEmails.add(normalizedEmail);
      invalidateScheduleSyncCache();
    } catch (err) {
      console.warn('[FirestoreSync] hydrateUserFromFirestore failed:', err);
    } finally {
      userHydratePromises.delete(normalizedEmail);
    }
  })();

  userHydratePromises.set(normalizedEmail, p);
  return p;
}

export async function hydrateAllFromFirestore(firebaseIdToken: string): Promise<void> {
  if (isTestEnv()) return;
  if (adminHydrated) return;
  if (adminHydratePromise) return adminHydratePromise;

  adminHydratePromise = (async () => {
    try {
      const roleRows = await db.select().from(roles);
      const roleByName = new Map(roleRows.map((r) => [r.name, r.id]));

      // 1. Catalog
      const catalogDoc = await getFsDoc('systemCatalog', 'college', firebaseIdToken);
      if (catalogDoc) {
        await applyCatalogDocToDb(fsDocToJs(catalogDoc), true);
        publicCatalogHydrated = true;
      } else {
        await syncCatalogToFirestore(firebaseIdToken);
      }

      // 2. Pull all domain collections with allSettled so one transient read issue does not abort hydration
      const collectionDefs = [
        { name: 'users', run: () => listAllFsDocs('users', firebaseIdToken) },
        { name: 'studentEnrollments', run: () => listAllFsDocs('studentEnrollments', firebaseIdToken) },
        { name: 'biometricTemplates', run: () => listAllFsDocs('biometricTemplates', firebaseIdToken) },
        { name: 'classSessionBuckets', run: () => listAllFsDocs('classSessionBuckets', firebaseIdToken) },
        { name: 'attendanceRecords', run: () => listAllFsDocs('attendanceRecords', firebaseIdToken) },
        { name: 'staffAssignments', run: () => listAllFsDocs('staffAssignments', firebaseIdToken) },
        { name: 'attendanceCorrections', run: () => listAllFsDocs('attendanceCorrections', firebaseIdToken) },
        { name: 'studentAcademicHistory', run: () => listAllFsDocs('studentAcademicHistory', firebaseIdToken) },
      ] as const;

      const settled = await Promise.allSettled(collectionDefs.map((c) => c.run()));
      const docsByCol = new Map<string, FsDocument[]>();
      const succeededCols = new Set<string>();

      settled.forEach((res, idx) => {
        const name = collectionDefs[idx].name;
        if (res.status === 'fulfilled') {
          docsByCol.set(name, res.value);
          succeededCols.add(name);
        } else {
          console.warn(`[FirestoreSync] hydrateAllFromFirestore collection "${name}" failed:`, res.reason);
          docsByCol.set(name, []);
        }
      });

      const userDocs = docsByCol.get('users') ?? [];
      const enrDocs = docsByCol.get('studentEnrollments') ?? [];
      const bioDocs = docsByCol.get('biometricTemplates') ?? [];
      const bucketDocs = docsByCol.get('classSessionBuckets') ?? [];
      const attDocs = docsByCol.get('attendanceRecords') ?? [];
      const staffDocs = docsByCol.get('staffAssignments') ?? [];
      const corrDocs = docsByCol.get('attendanceCorrections') ?? [];
      const histDocs = docsByCol.get('studentAcademicHistory') ?? [];

      // Track what's already in Firestore
      const fsUserEmails = new Set<string>();
      const fsEnrStudentIds = new Set<string>();
      const fsBioStudentIds = new Set<string>();
      const fsStaffAssignIds = new Set<string>();
      const fsAttRecordIds = new Set<string>();
      const fsCorrIds = new Set<string>();
      const fsHistIds = new Set<string>();
      const fsSessionIds = new Set<string>();

      for (const u of userDocs) {
        const data = fsDocToJs(u);
        if (typeof data.email === 'string') {
          fsUserEmails.add(data.email.toLowerCase().trim());
        }
        await upsertUserDocToDb(data, roleByName);
      }

      await upsertSessionsFromBucketDocs(bucketDocs);
      for (const b of bucketDocs) {
        const bData = fsDocToJs(b);
        if (Array.isArray(bData.sessions)) {
          for (const s of bData.sessions as Array<Record<string, unknown>>) {
            if (typeof s.id === 'string') {
              fsSessionIds.add(s.id);
              syncedBucketSessionIds.add(s.id);
            }
          }
        }
      }

      for (const e of enrDocs) {
        const d = fsDocToJs(e);
        if (typeof d.studentId === 'string') fsEnrStudentIds.add(d.studentId);
        await upsertEnrollmentDocToDb(d);
      }
      for (const b of bioDocs) {
        const d = fsDocToJs(b);
        if (typeof d.studentId === 'string') fsBioStudentIds.add(d.studentId);
        await upsertBiometricDocToDb(d);
      }
      for (const sa of staffDocs) {
        const d = fsDocToJs(sa);
        if (typeof d.id === 'string') fsStaffAssignIds.add(d.id);
        await upsertStaffAssignmentDocToDb(d);
      }
      for (const a of attDocs) {
        const d = fsDocToJs(a);
        if (typeof d.id === 'string') fsAttRecordIds.add(d.id);
        await upsertAttendanceDocToDb(d);
      }
      for (const c of corrDocs) {
        const d = fsDocToJs(c);
        if (typeof d.id === 'string') fsCorrIds.add(d.id);
        await upsertCorrectionDocToDb(d);
      }
      for (const h of histDocs) {
        const d = fsDocToJs(h);
        if (typeof d.id === 'string') fsHistIds.add(d.id);
        await upsertAcademicHistoryDocToDb(d);
      }

      // 3. Push any local-only records (e.g. QR signup/check-in created before admin signed in)
      const [localUsers, localEnrs, localBios, localStaff, localAtts, localCorrs, localHists, localSessions] =
        await Promise.all([
          db
            .select({ prof: profiles, roleName: roles.name })
            .from(profiles)
            .innerJoin(roles, eq(profiles.roleId, roles.id)),
          db.select().from(studentEnrollments),
          db.select().from(biometricTemplates),
          db.select().from(staffAssignments),
          db.select().from(attendanceRecords),
          db.select().from(attendanceCorrectionRequests),
          db.select().from(studentAcademicHistory),
          db.select().from(attendanceSessions),
        ]);

      const localProfMap = new Map(localUsers.map((u) => [u.prof.id, u.prof]));

      if (succeededCols.has('users')) {
        for (const u of localUsers) {
          if (!fsUserEmails.has(String(u.prof.email || '').toLowerCase().trim())) {
            await upsertFsDocWithCreatedAndUpdated(
              'users',
              u.prof.id,
              serializeUserProfile(u.prof, u.roleName),
              firebaseIdToken
            );
          }
        }
      }
      if (succeededCols.has('studentEnrollments')) {
        for (const enr of localEnrs) {
          if (!fsEnrStudentIds.has(enr.studentId)) {
            const prof = localProfMap.get(enr.studentId);
            if (prof) {
              await upsertFsDocWithCreatedAndUpdated(
                'studentEnrollments',
                prof.id,
                serializeEnrollment(enr, prof),
                firebaseIdToken
              );
            }
          }
        }
      }
      if (succeededCols.has('biometricTemplates')) {
        for (const bio of localBios) {
          if (!fsBioStudentIds.has(bio.studentId)) {
            const prof = localProfMap.get(bio.studentId);
            if (prof) {
              await upsertFsDocWithCreatedAndUpdated(
                'biometricTemplates',
                prof.id,
                serializeBiometric(bio, prof),
                firebaseIdToken
              );
            }
          }
        }
      }
      if (succeededCols.has('staffAssignments')) {
        for (const sa of localStaff) {
          if (!fsStaffAssignIds.has(sa.id)) {
            const prof = localProfMap.get(sa.staffId);
            if (prof) {
              await upsertFsDocWithCreatedAndUpdated(
                'staffAssignments',
                sa.id,
                serializeStaffAssignment(sa, prof),
                firebaseIdToken
              );
            }
          }
        }
      }
      if (succeededCols.has('attendanceRecords')) {
        for (const rec of localAtts) {
          if (!fsAttRecordIds.has(rec.id)) {
            const prof = localProfMap.get(rec.studentId);
            if (prof) {
              await upsertFsDocWithCreatedAndUpdated(
                'attendanceRecords',
                rec.id,
                serializeAttendanceRecord(rec, prof),
                firebaseIdToken
              );
            }
          }
        }
      }
      if (succeededCols.has('attendanceCorrections')) {
        for (const corr of localCorrs) {
          if (!fsCorrIds.has(corr.id)) {
            const prof = localProfMap.get(corr.studentId);
            if (prof) {
              await upsertFsDocWithCreatedAndUpdated(
                'attendanceCorrections',
                corr.id,
                serializeAttendanceCorrection(corr, prof),
                firebaseIdToken
              );
            }
          }
        }
      }
      if (succeededCols.has('studentAcademicHistory')) {
        for (const hist of localHists) {
          if (!fsHistIds.has(hist.id)) {
            const prof = localProfMap.get(hist.studentId);
            if (prof) {
              await upsertFsDocWithUpdatedOnly(
                'studentAcademicHistory',
                hist.id,
                serializeAcademicHistory(hist, prof),
                firebaseIdToken
              );
            }
          }
        }
      }

      if (succeededCols.has('classSessionBuckets')) {
        const missingSessionClassIds = Array.from(
          new Set(localSessions.filter((s) => !fsSessionIds.has(s.id)).map((s) => s.classId))
        );
        if (missingSessionClassIds.length > 0) {
          await syncClassSessionBucketsToFirestore(firebaseIdToken, missingSessionClassIds);
        }
      }

      if (succeededCols.has('users') && succeededCols.has('studentEnrollments')) {
        adminHydrated = true;
      }
      invalidateScheduleSyncCache();
    } catch (err) {
      console.warn('[FirestoreSync] hydrateAllFromFirestore failed:', err);
    } finally {
      adminHydratePromise = null;
    }
  })();

  return adminHydratePromise;
}

export async function pushUnsyncedRegistrationsIfAdmin(
  firebaseIdToken: string | null | undefined
): Promise<void> {
  if (isTestEnv() || !firebaseIdToken || !adminHydrated) return;
  try {
    const [
      localUsers,
      localBios,
      localStaff,
      localAtts,
      localCorrs,
      localHists,
      localSessions,
    ] = await Promise.all([
      db
        .select({ prof: profiles, roleName: roles.name })
        .from(profiles)
        .innerJoin(roles, eq(profiles.roleId, roles.id)),
      db.select({ studentId: biometricTemplates.studentId }).from(biometricTemplates),
      db.select({ id: staffAssignments.id, staffId: staffAssignments.staffId }).from(staffAssignments),
      db.select({ id: attendanceRecords.id }).from(attendanceRecords),
      db.select({ id: attendanceCorrectionRequests.id }).from(attendanceCorrectionRequests),
      db.select({ id: studentAcademicHistory.id, studentId: studentAcademicHistory.studentId }).from(studentAcademicHistory),
      db.select({ id: attendanceSessions.id, classId: attendanceSessions.classId }).from(attendanceSessions),
    ]);

    for (const u of localUsers) {
      const userMissing = !syncedDocKeys.has(`users/${u.prof.id}`);
      const enrollmentMissing =
        u.roleName === 'student' && !syncedDocKeys.has(`studentEnrollments/${u.prof.id}`);
      if (userMissing || enrollmentMissing) {
        await syncProfileAndEnrollmentToFirestore(firebaseIdToken, u.prof.id);
      }
    }

    for (const bio of localBios) {
      if (!syncedDocKeys.has(`biometricTemplates/${bio.studentId}`)) {
        await syncBiometricToFirestore(firebaseIdToken, bio.studentId);
      }
    }

    const staffIdsToSync = new Set<string>();
    for (const sa of localStaff) {
      if (!syncedDocKeys.has(`staffAssignments/${sa.id}`)) {
        staffIdsToSync.add(sa.staffId);
      }
    }
    for (const staffId of staffIdsToSync) {
      await syncStaffAssignmentsToFirestore(firebaseIdToken, staffId);
    }

    for (const att of localAtts) {
      if (!syncedDocKeys.has(`attendanceRecords/${att.id}`)) {
        await syncAttendanceRecordToFirestore(firebaseIdToken, att.id);
      }
    }

    for (const corr of localCorrs) {
      if (!syncedDocKeys.has(`attendanceCorrections/${corr.id}`)) {
        await syncCorrectionToFirestore(firebaseIdToken, corr.id);
      }
    }

    const histStudentIds = Array.from(
      new Set(
        localHists
          .filter((h) => !syncedDocKeys.has(`studentAcademicHistory/${h.id}`))
          .map((h) => h.studentId)
      )
    );
    if (histStudentIds.length > 0) {
      await syncAcademicHistoryToFirestore(firebaseIdToken, histStudentIds);
    }

    const missingSessionClassIds = Array.from(
      new Set(
        localSessions
          .filter((s) => !syncedBucketSessionIds.has(s.id))
          .map((s) => s.classId)
      )
    );
    if (missingSessionClassIds.length > 0) {
      await syncClassSessionBucketsToFirestore(firebaseIdToken, missingSessionClassIds);
    }
  } catch (err) {
    console.warn('[FirestoreSync] pushUnsyncedRegistrationsIfAdmin failed:', err);
  }
}
