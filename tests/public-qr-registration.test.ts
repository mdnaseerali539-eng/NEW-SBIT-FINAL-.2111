import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import * as dotenv from 'dotenv';
import { eq, sql } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { profiles } from '../src/db/schema.ts';
import { signSessionToken } from '../src/server/crypto.ts';
import { INITIAL_SUPER_ADMIN_EMAIL } from '../src/server/seed.ts';
import { authAndPublicRouter } from '../src/server/routes/authAndPublic.ts';
import { adminRouter } from '../src/server/routes/adminRoutes.ts';
import { staffRouter } from '../src/server/routes/staffRoutes.ts';
import { studentRouter } from '../src/server/routes/studentRoutes.ts';
import { reportRouter } from '../src/server/routes/reportRoutes.ts';

const TEST_TAG = `QRREG_${Date.now()}`;
let server: http.Server | null = null;
let baseUrl = '';

after(async () => {
  try {
    await db.execute(
      sql`DELETE FROM audit_logs WHERE actor_email LIKE ${`%${TEST_TAG.toLowerCase()}%`}`
    );
    await db.execute(
      sql`DELETE FROM student_enrollments WHERE roll_number LIKE ${`${TEST_TAG}%`}`
    );
    await db.execute(
      sql`DELETE FROM profiles WHERE email LIKE ${`%${TEST_TAG.toLowerCase()}%`}`
    );
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pool.end();
  }
});

test('Public QR registration (pending off-campus, instant auto-approve on-campus) & Super Admin user removal', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', authAndPublicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/reports', reportRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Public college metadata includes all 7 official departments (including CSM B)
  const pubRes = await fetch(`${baseUrl}/api/college/public-info`);
  assert.equal(pubRes.status, 200);
  const pubData = (await pubRes.json()) as {
    settings: { collegeLatitude: number; collegeLongitude: number; geofenceRadiusMeters: number };
    departments: Array<{ id: string; code: string }>;
    academicYears: Array<{ id: string }>;
    semesters: Array<{ id: string }>;
  };
  assert.equal(pubData.departments.length, 7);
  const csmBDept = pubData.departments.find((d) => d.code === 'CSM B');
  assert.ok(csmBDept, 'CSM B department must be present');
  assert.ok(pubData.academicYears.length === 4);
  assert.ok(pubData.semesters.length === 8);

  // 2. Unauthenticated registration QR token validation
  const qrRes = await fetch(`${baseUrl}/api/qr/SBIT-REGISTER-CAMPUS`);
  assert.equal(qrRes.status, 200);
  const qrData = (await qrRes.json()) as { qr: { label: string; expiresAt: string | null } };
  assert.equal(qrData.qr.expiresAt, null);

  // 3. Unauthenticated attendance QR token validation
  const attendQrRes = await fetch(`${baseUrl}/api/qr/attendance/SBIT-ATTEND-CAMPUS`);
  assert.equal(attendQrRes.status, 200);

  // 4a. Off-campus / no-location registration remains pending Super Admin approval
  const regPendingRes = await fetch(`${baseUrl}/api/qr/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qrToken: 'SBIT-REGISTER-CAMPUS',
      fullName: 'Public QR Off-Campus Student',
      rollNumber: `${TEST_TAG}01`,
      departmentId: csmBDept.id,
      academicYearId: pubData.academicYears[0].id,
      semesterId: pubData.semesters[0].id,
      email: `off_${TEST_TAG.toLowerCase()}@gmail.com`,
      phone: '9876543210',
    }),
  });
  assert.equal(regPendingRes.status, 201);
  const regPendingBody = (await regPendingRes.json()) as {
    status: string;
    autoApproved: boolean;
    rollNumber: string;
    setupToken?: string;
  };
  assert.equal(regPendingBody.status, 'pending');
  assert.equal(regPendingBody.autoApproved, false);
  assert.equal(regPendingBody.setupToken, undefined);
  assert.equal(regPendingBody.rollNumber, `${TEST_TAG}01`);

  // 4b. On-campus registration (inside SBIT geofence) is automatically approved without admin approval
  const regAutoRes = await fetch(`${baseUrl}/api/qr/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qrToken: 'SBIT-REGISTER-CAMPUS',
      fullName: 'Public QR On-Campus Student',
      rollNumber: `${TEST_TAG}02`,
      departmentId: csmBDept.id,
      academicYearId: pubData.academicYears[0].id,
      semesterId: pubData.semesters[0].id,
      email: `on_${TEST_TAG.toLowerCase()}@gmail.com`,
      phone: '9876543211',
      latitude: pubData.settings.collegeLatitude,
      longitude: pubData.settings.collegeLongitude,
    }),
  });
  assert.equal(regAutoRes.status, 201);
  const regAutoBody = (await regAutoRes.json()) as {
    status: string;
    autoApproved: boolean;
    distanceMeters: number;
    rollNumber: string;
    setupToken?: string;
  };
  assert.equal(regAutoBody.status, 'approved');
  assert.equal(regAutoBody.autoApproved, true);
  assert.equal(regAutoBody.distanceMeters, 0);
  assert.ok(regAutoBody.setupToken && regAutoBody.setupToken.length > 10);

  // Verify auto-approved student can immediately activate password and access student portal
  const claimRes = await fetch(`${baseUrl}/api/auth/claim-with-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      setupToken: regAutoBody.setupToken,
      password: 'CampusUser@2026',
    }),
  });
  assert.equal(claimRes.status, 200);
  const claimBody = (await claimRes.json()) as { token: string };
  assert.ok(claimBody.token);

  const autoStudentDashRes = await fetch(`${baseUrl}/api/student/dashboard`, {
    headers: { Authorization: `Bearer ${claimBody.token}` },
  });
  assert.equal(autoStudentDashRes.status, 200);

  // 5. Protected endpoints still enforce auth (401 without Bearer token, never leaked)
  const adminRes = await fetch(`${baseUrl}/api/admin/dashboard`);
  assert.equal(adminRes.status, 401);
  const staffRes = await fetch(`${baseUrl}/api/staff/dashboard`);
  assert.equal(staffRes.status, 401);
  const studentRes = await fetch(`${baseUrl}/api/student/dashboard`);
  assert.equal(studentRes.status, 401);

  // 6. Super Admin can permanently remove people (and cannot remove self)
  const [adminProfile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.email, INITIAL_SUPER_ADMIN_EMAIL))
    .limit(1);
  assert.ok(adminProfile);
  const adminToken = signSessionToken({
    profileId: adminProfile.id,
    email: adminProfile.email,
    role: 'super_admin',
  });

  const selfDeleteRes = await fetch(`${baseUrl}/api/admin/users/${adminProfile.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(selfDeleteRes.status, 400);

  const [onCampusStu] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.rollNumber, `${TEST_TAG}02`))
    .limit(1);
  const [offCampusStu] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.rollNumber, `${TEST_TAG}01`))
    .limit(1);
  assert.ok(onCampusStu && offCampusStu);

  // 6b. On-campus auto-approved student must NOT be in Approvals list (pending, approved, or all), only in Students directory
  const regAllBeforeRes = await fetch(`${baseUrl}/api/admin/registrations?status=all`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(regAllBeforeRes.status, 200);
  const regAllBeforeBody = (await regAllBeforeRes.json()) as {
    items: Array<{ id: string; rollNumber: string; status: string }>;
  };
  assert.ok(
    !regAllBeforeBody.items.some((r) => r.id === onCampusStu.id),
    'On-campus student must NOT appear in Approvals list'
  );
  assert.ok(
    regAllBeforeBody.items.some((r) => r.id === offCampusStu.id && r.status === 'pending'),
    'Off-campus student must appear in Approvals list as pending'
  );

  const studentsListRes = await fetch(
    `${baseUrl}/api/admin/students?search=${encodeURIComponent(`${TEST_TAG}02`)}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(studentsListRes.status, 200);
  const studentsListBody = (await studentsListRes.json()) as {
    items: Array<{ id: string; status: string }>;
  };
  assert.ok(
    studentsListBody.items.some((s) => s.id === onCampusStu.id && s.status === 'approved'),
    'On-campus student must appear directly in Student Directory as approved'
  );

  // 6c. Public status check shows pending before admin approval, then approved after approval
  const statusPendingRes = await fetch(`${baseUrl}/api/qr/registration-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rollNumber: `${TEST_TAG}01`,
      email: `off_${TEST_TAG.toLowerCase()}@gmail.com`,
    }),
  });
  assert.equal(statusPendingRes.status, 200);
  const statusPendingBody = (await statusPendingRes.json()) as { status: string; setupToken?: string };
  assert.equal(statusPendingBody.status, 'pending');
  assert.equal(statusPendingBody.setupToken, undefined);

  const approveOffRes = await fetch(`${baseUrl}/api/admin/registrations/${offCampusStu.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(approveOffRes.status, 200);

  const statusApprovedRes = await fetch(`${baseUrl}/api/qr/registration-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rollNumber: `${TEST_TAG}01`,
      email: `off_${TEST_TAG.toLowerCase()}@gmail.com`,
    }),
  });
  assert.equal(statusApprovedRes.status, 200);
  const statusApprovedBody = (await statusApprovedRes.json()) as { status: string; setupToken?: string };
  assert.equal(statusApprovedBody.status, 'approved');
  assert.ok(statusApprovedBody.setupToken && statusApprovedBody.setupToken.length > 10);

  const regApprovedRes = await fetch(`${baseUrl}/api/admin/registrations?status=approved`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(regApprovedRes.status, 200);
  const regApprovedBody = (await regApprovedRes.json()) as {
    items: Array<{ id: string; status: string }>;
  };
  assert.ok(
    regApprovedBody.items.some((r) => r.id === offCampusStu.id && r.status === 'approved'),
    'Approved off-campus student must appear in Approvals -> Approved list'
  );
  assert.ok(
    !regApprovedBody.items.some((r) => r.id === onCampusStu.id),
    'On-campus student must still NOT appear in Approvals -> Approved list'
  );

  const delAutoRes = await fetch(`${baseUrl}/api/admin/users/${onCampusStu.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(delAutoRes.status, 200);

  const delPendingRes = await fetch(`${baseUrl}/api/admin/users/${offCampusStu.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(delPendingRes.status, 200);

  // Removed student's session token is immediately rejected
  const afterDeleteDashRes = await fetch(`${baseUrl}/api/student/dashboard`, {
    headers: { Authorization: `Bearer ${claimBody.token}` },
  });
  assert.equal(afterDeleteDashRes.status, 401);

  // 7. Public website chatbot validates empty/malformed inputs cleanly
  const badChatRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(badChatRes.status, 400);

  const badHistoryRes = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Hello',
      history: [{ role: 'admin', text: 'fake role' }],
    }),
  });
  assert.equal(badHistoryRes.status, 400);
});
