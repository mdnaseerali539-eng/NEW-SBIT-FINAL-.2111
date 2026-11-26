import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import * as dotenv from 'dotenv';
import { eq } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import {
  academicYears,
  classes,
  departments,
  profiles,
  roles,
  semesters,
  subjects,
} from '../src/db/schema.ts';
import { ensureBaselineSeeded, INITIAL_SUPER_ADMIN_EMAIL } from '../src/server/seed.ts';
import { averageAndNormalizeDescriptors, signSessionToken } from '../src/server/crypto.ts';
import { authAndPublicRouter } from '../src/server/routes/authAndPublic.ts';
import { adminRouter } from '../src/server/routes/adminRoutes.ts';
import { staffRouter } from '../src/server/routes/staffRoutes.ts';
import { studentRouter } from '../src/server/routes/studentRoutes.ts';
import { reportRouter } from '../src/server/routes/reportRoutes.ts';

function buildTestVectors() {
  const base = averageAndNormalizeDescriptors([
    Array.from({ length: 128 }, (_, i) => Math.sin(i * 1.3 + 0.5)),
  ]);
  const sample2 = averageAndNormalizeDescriptors([
    base.map((v, i) => v + (i % 2 === 0 ? 0.008 : -0.008)),
  ]);
  const sample3 = averageAndNormalizeDescriptors([
    base.map((v, i) => v + (i % 3 === 0 ? 0.009 : -0.009)),
  ]);

  const rawOther = Array.from({ length: 128 }, (_, i) => Math.cos(i * 1.7 + 2.1));
  const dot = rawOther.reduce((s, v, idx) => s + v * base[idx], 0);
  const ortho = averageAndNormalizeDescriptors([
    rawOther.map((v, idx) => v - dot * base[idx]),
  ]);

  // Close biological relative (~0.36 L2 distance) — must be rejected at 0.30 threshold
  const relativeFace = averageAndNormalizeDescriptors([
    base.map((v, i) => v * 0.935 + ortho[i] * 0.354),
  ]);
  const strangerFace = ortho;

  return { base, sample2, sample3, relativeFace, strangerFace };
}

let server: http.Server | null = null;

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await pool.end();
});

test('End-to-End Full Feature Suite: Roles, GPS Settings, QR Auto-Approve, Face ID Create & Check Match, Attendance, Calendar & Reports', async () => {
  await ensureBaselineSeeded();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', authAndPublicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/reports', reportRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiJson<T>(
    path: string,
    opts: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  // 1. Public college info & QR inspection
  const pubRes = await apiJson<{
    settings: { collegeLatitude: number; collegeLongitude: number; faceMatchThreshold: number };
    departments: Array<{ id: string; code: string }>;
    academicYears: Array<{ id: string; yearNumber: number }>;
    semesters: Array<{ id: string; semesterNumber: number }>;
  }>('/api/college/public-info');
  assert.equal(pubRes.status, 200);
  assert.equal(pubRes.data.departments.length, 7);
  assert.equal(pubRes.data.settings.faceMatchThreshold, 0.3);

  const deptId = pubRes.data.departments[0].id;
  const yearId = pubRes.data.academicYears.find((y) => y.yearNumber === 1)!.id;
  const semId = pubRes.data.semesters.find((s) => s.semesterNumber === 1)!.id;

  const regQrRes = await apiJson<{ qr: { id: string; label: string } }>('/api/qr/SBIT-REGISTER-CAMPUS');
  assert.equal(regQrRes.status, 200);
  const attQrRes = await apiJson<{ qr: { id: string; token: string } }>('/api/qr/attendance/SBIT-ATTEND-CAMPUS');
  assert.equal(attQrRes.status, 200);

  // 2. Super Admin session & GPS/Threshold settings governance
  const [adminProfile] = await db
    .select({ id: profiles.id, email: profiles.email })
    .from(profiles)
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);
  assert.ok(adminProfile);
  const adminToken = signSessionToken({
    profileId: adminProfile.id,
    email: adminProfile.email,
    role: 'super_admin',
  });

  // Invalid loose threshold (> 0.33) must be rejected
  const badThreshold = await apiJson<{ error: string }>('/api/admin/settings', {
    method: 'PATCH',
    token: adminToken,
    body: { faceMatchThreshold: 0.45 },
  });
  assert.equal(badThreshold.status, 400);

  // One-click GPS coordinate save & strict 0.30 threshold
  const saveSettings = await apiJson<{
    settings: { collegeLatitude: number; collegeLongitude: number; geofenceRadiusMeters: number; faceMatchThreshold: number };
  }>('/api/admin/settings', {
    method: 'PATCH',
    token: adminToken,
    body: {
      locationVerificationEnabled: true,
      collegeLatitude: 17.2473,
      collegeLongitude: 80.1514,
      geofenceRadiusMeters: 300,
      faceMatchThreshold: 0.3,
    },
  });
  assert.equal(saveSettings.status, 200);
  assert.equal(saveSettings.data.settings.faceMatchThreshold, 0.3);

  // 3. On-campus QR student registration auto-approves immediately
  const tag = `E2E${Date.now()}`;
  const onCampusReg = await apiJson<{ autoApproved: boolean; rollNumber: string }>('/api/qr/register', {
    method: 'POST',
    body: {
      qrToken: 'SBIT-REGISTER-CAMPUS',
      fullName: 'E2E Test Student',
      rollNumber: `${tag}01`,
      departmentId: deptId,
      academicYearId: yearId,
      semesterId: semId,
      email: `${tag.toLowerCase()}01@gmail.com`,
      phone: '9876543210',
      latitude: 17.2473,
      longitude: 80.1514,
    },
  });
  assert.equal(onCampusReg.status, 201);
  assert.equal(onCampusReg.data.autoApproved, true);

  // Off-campus QR student registration stays pending
  const offCampusReg = await apiJson<{ autoApproved: boolean }>('/api/qr/register', {
    method: 'POST',
    body: {
      qrToken: 'SBIT-REGISTER-CAMPUS',
      fullName: 'E2E Pending Student',
      rollNumber: `${tag}02`,
      departmentId: deptId,
      academicYearId: yearId,
      semesterId: semId,
      email: `${tag.toLowerCase()}02@gmail.com`,
      phone: '9876543211',
      latitude: 17.5,
      longitude: 80.5,
    },
  });
  assert.equal(offCampusReg.status, 201);
  assert.equal(offCampusReg.data.autoApproved, false);

  const [studentProfile] = await db
    .select({ id: profiles.id, email: profiles.email, roleName: roles.name })
    .from(profiles)
    .innerJoin(roles, eq(profiles.roleId, roles.id))
    .where(eq(profiles.email, `${tag.toLowerCase()}01@gmail.com`))
    .limit(1);
  assert.equal(studentProfile.roleName, 'student');

  const studentToken = signSessionToken({
    profileId: studentProfile.id,
    email: studentProfile.email,
    role: 'student',
  });

  // Student must be blocked from Admin routes (RBAC)
  const rbacBlock = await apiJson<{ error: string }>('/api/admin/overview', { token: studentToken });
  assert.equal(rbacBlock.status, 403);

  // 4. Create Face ID & check Face ID match
  const { base, sample2, sample3, relativeFace, strangerFace } = buildTestVectors();

  // Inconsistent enrollment (mixing stranger face) must fail
  const badEnroll = await apiJson<{ error: string }>('/api/student/biometrics/enroll', {
    method: 'POST',
    token: studentToken,
    body: { consentGiven: true, descriptors: [base, strangerFace, sample3] },
  });
  assert.equal(badEnroll.status, 400);

  // Clean 3-sample enrollment creates Face ID
  const goodEnroll = await apiJson<{ faceId: string; message: string }>('/api/student/biometrics/enroll', {
    method: 'POST',
    token: studentToken,
    body: { consentGiven: true, descriptors: [base, sample2, sample3] },
  });
  assert.equal(goodEnroll.status, 200);
  assert.match(goodEnroll.data.faceId, /^FID-[0-9A-F]{8}$/);
  const createdFaceId = goodEnroll.data.faceId;

  // /auth/me must expose enrolled=true & same faceId
  const meRes = await apiJson<{
    biometricStatus: { enrolled: boolean; faceId: string | null };
  }>('/api/auth/me', { token: studentToken });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.biometricStatus.enrolled, true);
  assert.equal(meRes.data.biometricStatus.faceId, createdFaceId);

  // Check Face ID Match — same face matches
  const testOwnFace = await apiJson<{
    faceId: string;
    matched: boolean;
    distance: number;
  }>('/api/student/biometrics/test-match', {
    method: 'POST',
    token: studentToken,
    body: {
      descriptors: [base, sample2, sample3],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
    },
  });
  assert.equal(testOwnFace.status, 200);
  assert.equal(testOwnFace.data.matched, true);
  assert.equal(testOwnFace.data.faceId, createdFaceId);

  // Check Face ID Match — biological relative (~0.36) is REJECTED
  const testRelativeFace = await apiJson<{
    faceId: string;
    matched: boolean;
  }>('/api/student/biometrics/test-match', {
    method: 'POST',
    token: studentToken,
    body: {
      descriptors: [relativeFace, relativeFace, relativeFace],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
    },
  });
  assert.equal(testRelativeFace.status, 200);
  assert.equal(testRelativeFace.data.matched, false);
  assert.equal(testRelativeFace.data.faceId, createdFaceId);

  // 5. Attendance session creation, geofence block, mismatch block, valid mark, duplicate block & calendar update
  const [cls] = await db.select().from(classes).where(eq(classes.departmentId, deptId)).limit(1);
  const [subj] = await db.select().from(subjects).where(eq(subjects.departmentId, deptId)).limit(1);
  const todayIST = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const createSes = await apiJson<{ session: { id: string } }>('/api/admin/sessions', {
    method: 'POST',
    token: adminToken,
    body: {
      departmentId: deptId,
      classId: cls.id,
      subjectId: subj.id,
      sessionDate: todayIST,
      startTime: '00:00',
      endTime: '23:59',
      periodSlot: 'daily',
      status: 'active',
    },
  });
  assert.equal(createSes.status, 201);
  const sessionId = createSes.data.session.id;

  // Outside geofence blocked
  const outGeo = await apiJson<{ code: string }>('/api/student/attendance/mark', {
    method: 'POST',
    token: studentToken,
    body: {
      sessionId,
      descriptor: base,
      descriptors: [base, sample2, sample3],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
      latitude: 17.5,
      longitude: 80.5,
    },
  });
  assert.equal(outGeo.status, 403);
  assert.equal(outGeo.data.code, 'OUTSIDE_GEOFENCE');

  // Relative face inside geofence blocked with FACE_MISMATCH
  const wrongFaceMark = await apiJson<{ code: string }>('/api/student/attendance/mark', {
    method: 'POST',
    token: studentToken,
    body: {
      sessionId,
      descriptor: relativeFace,
      descriptors: [relativeFace, relativeFace, relativeFace],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
      latitude: 17.2473,
      longitude: 80.1514,
    },
  });
  assert.equal(wrongFaceMark.status, 403);
  assert.equal(wrongFaceMark.data.code, 'FACE_MISMATCH');

  // Genuine student face marks Present
  const rightFaceMark = await apiJson<{ faceId: string; record: { status: string } }>(
    '/api/student/attendance/mark',
    {
      method: 'POST',
      token: studentToken,
      body: {
        sessionId,
        descriptor: sample2,
        descriptors: [base, sample2, sample3],
        livenessPassed: true,
        livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
        latitude: 17.2473,
        longitude: 80.1514,
      },
    }
  );
  assert.equal(rightFaceMark.status, 201);
  assert.equal(rightFaceMark.data.faceId, createdFaceId);
  assert.equal(rightFaceMark.data.record.status, 'present');

  // Duplicate mark rejected with 409
  const dupMark = await apiJson<{ error: string }>('/api/student/attendance/mark', {
    method: 'POST',
    token: studentToken,
    body: {
      sessionId,
      descriptor: sample2,
      descriptors: [base, sample2, sample3],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
      latitude: 17.2473,
      longitude: 80.1514,
    },
  });
  assert.equal(dupMark.status, 409);

  // 6. QR Lookup & Face Check-In (while session is active)
  const qrLookup = await apiJson<{
    student: { hasBiometrics: boolean; faceId: string | null };
  }>('/api/qr/attendance/lookup', {
    method: 'POST',
    body: { qrToken: 'SBIT-ATTEND-CAMPUS', rollNumber: `${tag}01` },
  });
  assert.equal(qrLookup.status, 200);
  assert.equal(qrLookup.data.student.hasBiometrics, true);
  assert.equal(qrLookup.data.student.faceId, createdFaceId);

  const qrWrongFace = await apiJson<{ code: string }>('/api/qr/attendance/verify-and-mark', {
    method: 'POST',
    body: {
      qrToken: 'SBIT-ATTEND-CAMPUS',
      rollNumber: `${tag}01`,
      descriptor: relativeFace,
      descriptors: [relativeFace, relativeFace, relativeFace],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
    },
  });
  assert.equal(qrWrongFace.status, 403);
  assert.equal(qrWrongFace.data.code, 'FACE_MISMATCH');

  const qrRightFace = await apiJson<{ token: string; message: string }>('/api/qr/attendance/verify-and-mark', {
    method: 'POST',
    body: {
      qrToken: 'SBIT-ATTEND-CAMPUS',
      rollNumber: `${tag}01`,
      descriptor: sample2,
      descriptors: [base, sample2, sample3],
      livenessPassed: true,
      livenessSignals: { blinkDetected: true, headTurnDetected: true, frameVariance: 0.01 },
    },
  });
  assert.equal(qrRightFace.status, 200);
  assert.ok(qrRightFace.data.token.startsWith('sbit.'));
  assert.ok(qrRightFace.data.message.includes(createdFaceId));

  // Close session and verify dashboard workingDays, presentDays & green calendar update
  const closeSes = await apiJson<{ session: { status: string } }>(
    `/api/admin/sessions/${sessionId}/status`,
    {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'closed' },
    }
  );
  assert.equal(closeSes.status, 200);
  assert.equal(closeSes.data.session.status, 'closed');

  const dashRes = await apiJson<{
    biometricStatus: { enrolled: boolean; faceId: string };
    summary: { workingDays: number; presentDays: number; attendancePercentage: number };
    calendar: Array<{ date: string; status: string }>;
  }>('/api/student/dashboard', { token: studentToken });
  assert.equal(dashRes.status, 200);
  assert.equal(dashRes.data.biometricStatus.faceId, createdFaceId);
  assert.ok(dashRes.data.summary.workingDays >= 1);
  assert.ok(dashRes.data.summary.presentDays >= 1);
  assert.ok(dashRes.data.calendar.some((c) => c.date === todayIST && c.status === 'present'));

  // 7. Admin Reports query works cleanly
  const reportRes = await apiJson<{
    summary: { totalRecords: number; presentCount: number };
    items: Array<{ rollNumber: string }>;
  }>(`/api/reports/attendance?search=${encodeURIComponent(`${tag}01`)}`, {
    token: adminToken,
  });
  assert.equal(reportRes.status, 200);
  assert.ok(reportRes.data.summary.presentCount >= 1);
});
