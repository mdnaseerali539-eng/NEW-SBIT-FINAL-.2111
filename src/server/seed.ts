import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  academicYears,
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  auditLogs,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
  jntuhRegulationRules,
  profiles,
  promotionBatches,
  registrationQrCodes,
  roles,
  semesters,
  staffAssignments,
  studentEnrollments,
  subjects,
} from '../db/schema.ts';
import { deterministicUuid } from './crypto.ts';

export const INITIAL_SUPER_ADMIN_EMAIL = 'mdnaseerali539@gmail.com';
const LEGACY_REMOVED_ADMIN_EMAIL = 'alibhaibhai539@gmail.com';

const OFFICIAL_DEPARTMENTS = [
  { code: 'CSM C', name: 'CSM C — Computer Science & Engineering (AI & ML) Sec C' },
  { code: 'CSM B', name: 'CSM B — Computer Science & Engineering (AI & ML) Sec B' },
  { code: 'CSM A', name: 'CSM A — Computer Science & Engineering (AI & ML) Sec A' },
  { code: 'CSE C', name: 'CSE C — Computer Science & Engineering Sec C' },
  { code: 'CSE B', name: 'CSE B — Computer Science & Engineering Sec B' },
  { code: 'CSE A', name: 'CSE A — Computer Science & Engineering Sec A' },
  { code: 'CSD', name: 'CSD — Computer Science & Engineering (Data Science)' },
];

const CORE_SUBJECT_TEMPLATES = [
  { suffix: '101', name: 'Programming for Problem Solving', semesterNumber: 1, credits: 4 },
  { suffix: '201', name: 'Data Structures & Algorithms', semesterNumber: 2, credits: 4 },
  { suffix: '301', name: 'Database Management Systems', semesterNumber: 3, credits: 4 },
  { suffix: '401', name: 'Operating Systems', semesterNumber: 4, credits: 4 },
  { suffix: '501', name: 'Computer Networks', semesterNumber: 5, credits: 3 },
  { suffix: '601', name: 'Machine Learning & Pattern Recognition', semesterNumber: 6, credits: 4 },
  { suffix: '701', name: 'Cloud Computing & Distributed Systems', semesterNumber: 7, credits: 3 },
  { suffix: '801', name: 'Major Project & Seminar', semesterNumber: 8, credits: 6 },
];

let seedPromise: Promise<void> | null = null;

export async function ensureBaselineSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runBaselineSeed().catch((err) => {
      seedPromise = null;
      console.error('Baseline seed failed:', err);
      throw err;
    });
  }
  return seedPromise;
}

async function runBaselineSeed(): Promise<void> {
  // 1. Seed Roles with deterministic IDs
  const roleDefinitions = [
    {
      id: deterministicUuid('role:super_admin'),
      name: 'super_admin',
      description: 'College-wide Super Administrator with full governance and security access',
      permissions: [
        'manage_departments',
        'manage_academics',
        'manage_students',
        'approve_registrations',
        'manage_staff',
        'manage_admins',
        'manage_sessions',
        'correct_attendance',
        'manage_qr_codes',
        'manage_settings',
        'view_reports',
        'export_reports',
        'view_audit_logs',
        'manage_biometrics',
        'promote_students',
      ],
    },
    {
      id: deterministicUuid('role:staff'),
      name: 'staff',
      description: 'Faculty / Staff scoped to assigned departments, classes, and subjects',
      permissions: [
        'view_assigned_scope',
        'manage_assigned_sessions',
        'view_assigned_attendance',
        'assist_attendance',
        'request_corrections',
        'export_assigned_reports',
      ],
    },
    {
      id: deterministicUuid('role:student'),
      name: 'student',
      description: 'Approved student with self-service attendance, camera verification, and history access',
      permissions: ['view_own_profile', 'view_own_attendance', 'enroll_biometrics', 'mark_attendance'],
    },
  ];

  for (const r of roleDefinitions) {
    await db
      .insert(roles)
      .values(r)
      .onConflictDoUpdate({
        target: roles.name,
        set: { description: r.description, permissions: r.permissions },
      });
  }

  const allRoles = await db.select().from(roles);
  const superAdminRole = allRoles.find((r) => r.name === 'super_admin')!;
  const staffRole = allRoles.find((r) => r.name === 'staff')!;
  const studentRole = allRoles.find((r) => r.name === 'student')!;

  // 2. Seed ONLY the single permanent Super Admin profile (mdnaseerali539@gmail.com)
  await db
    .insert(profiles)
    .values({
      id: deterministicUuid(`profile:${INITIAL_SUPER_ADMIN_EMAIL}`),
      roleId: superAdminRole.id,
      fullName: 'Swarna Bharathi Super Admin',
      email: INITIAL_SUPER_ADMIN_EMAIL,
      status: 'approved',
      emailVerified: true,
    })
    .onConflictDoUpdate({
      target: profiles.email,
      set: {
        roleId: superAdminRole.id,
        status: 'approved',
        emailVerified: true,
      },
    });

  // Strip super_admin rights from ALL other accounts (including legacy alibhaibhai539@gmail.com)
  const otherAdmins = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.roleId, superAdminRole.id), ne(profiles.email, INITIAL_SUPER_ADMIN_EMAIL)));

  for (const other of otherAdmins) {
    const otherEmail = other.email.toLowerCase().trim();
    const [[hasEnr], [hasStaff], [hasAtt], [hasSess]] = await Promise.all([
      db.select({ id: studentEnrollments.id }).from(studentEnrollments).where(eq(studentEnrollments.studentId, other.id)).limit(1),
      db.select({ id: staffAssignments.id }).from(staffAssignments).where(eq(staffAssignments.staffId, other.id)).limit(1),
      db.select({ id: attendanceRecords.id }).from(attendanceRecords).where(eq(attendanceRecords.studentId, other.id)).limit(1),
      db.select({ id: attendanceSessions.id }).from(attendanceSessions).where(eq(attendanceSessions.createdBy, other.id)).limit(1),
    ]);

    if (otherEmail === LEGACY_REMOVED_ADMIN_EMAIL && !hasEnr && !hasStaff && !hasAtt && !hasSess) {
      await Promise.all([
        db.update(auditLogs).set({ actorId: null }).where(eq(auditLogs.actorId, other.id)),
        db.update(collegeSettings).set({ updatedBy: null }).where(eq(collegeSettings.updatedBy, other.id)),
        db.update(holidays).set({ createdBy: null }).where(eq(holidays.createdBy, other.id)),
        db.update(calendarOverrides).set({ createdBy: null }).where(eq(calendarOverrides.createdBy, other.id)),
        db.update(registrationQrCodes).set({ createdBy: null }).where(eq(registrationQrCodes.createdBy, other.id)),
        db.update(promotionBatches).set({ promotedBy: null }).where(eq(promotionBatches.promotedBy, other.id)),
        db.update(promotionBatches).set({ rolledBackBy: null }).where(eq(promotionBatches.rolledBackBy, other.id)),
        db.update(attendanceCorrectionRequests).set({ reviewedBy: null }).where(eq(attendanceCorrectionRequests.reviewedBy, other.id)),
        db.update(attendanceRecords).set({ correctedBy: null }).where(eq(attendanceRecords.correctedBy, other.id)),
        db.update(studentEnrollments).set({ approvedBy: null }).where(eq(studentEnrollments.approvedBy, other.id)),
      ]);
      await db.delete(profiles).where(eq(profiles.id, other.id));
    } else {
      const targetRoleId = hasStaff ? staffRole.id : studentRole.id;
      await db
        .update(profiles)
        .set({ roleId: targetRoleId, updatedAt: new Date() })
        .where(eq(profiles.id, other.id));
    }
  }

  // Upgrade legacy short-form label in persisted snapshots
  await db
    .update(profiles)
    .set({ fullName: 'SBIT Portal Administrator' })
    .where(eq(profiles.fullName, 'SBIST Portal Administrator'));

  // 3. Seed Official Departments (and clean up legacy erroneous 'CSMB C' if present in snapshot)
  for (const dept of OFFICIAL_DEPARTMENTS) {
    await db
      .insert(departments)
      .values({
        id: deterministicUuid(`dept:${dept.code}`),
        ...dept,
      })
      .onConflictDoNothing({ target: departments.code });
  }

  const [wrongCsmb] = await db
    .select()
    .from(departments)
    .where(eq(departments.code, 'CSMB C'))
    .limit(1);
  if (wrongCsmb) {
    const [rightCsmC] = await db
      .select()
      .from(departments)
      .where(eq(departments.code, 'CSM C'))
      .limit(1);
    if (rightCsmC) {
      const csmCClasses = await db
        .select()
        .from(classes)
        .where(eq(classes.departmentId, rightCsmC.id));
      const classBySem = new Map(csmCClasses.map((c) => [c.semesterId, c.id]));
      const oldEnrollments = await db
        .select()
        .from(studentEnrollments)
        .where(eq(studentEnrollments.departmentId, wrongCsmb.id));
      for (const enr of oldEnrollments) {
        await db
          .update(studentEnrollments)
          .set({
            departmentId: rightCsmC.id,
            classId: classBySem.get(enr.semesterId) || enr.classId,
          })
          .where(eq(studentEnrollments.id, enr.id));
      }
      await db
        .update(registrationQrCodes)
        .set({ departmentId: rightCsmC.id })
        .where(eq(registrationQrCodes.departmentId, wrongCsmb.id));
    }
    await db.delete(subjects).where(eq(subjects.departmentId, wrongCsmb.id));
    await db.delete(classes).where(eq(classes.departmentId, wrongCsmb.id));
    await db.delete(departments).where(eq(departments.id, wrongCsmb.id));
  }

  // 4. Seed 4 Academic Years
  const yearDefs = [
    { id: deterministicUuid('year:1'), yearNumber: 1, label: '1st Year', academicSession: '2026-2027' },
    { id: deterministicUuid('year:2'), yearNumber: 2, label: '2nd Year', academicSession: '2026-2027' },
    { id: deterministicUuid('year:3'), yearNumber: 3, label: '3rd Year', academicSession: '2026-2027' },
    { id: deterministicUuid('year:4'), yearNumber: 4, label: '4th Year', academicSession: '2026-2027' },
  ];

  for (const y of yearDefs) {
    await db
      .insert(academicYears)
      .values(y)
      .onConflictDoNothing({ target: academicYears.yearNumber });
  }

  const allYears = await db.select().from(academicYears);
  const yearByNum = new Map(allYears.map((y) => [y.yearNumber, y]));

  // 5. Seed 8 Semesters
  for (let sem = 1; sem <= 8; sem++) {
    const yrNum = Math.ceil(sem / 2);
    const yr = yearByNum.get(yrNum);
    if (!yr) continue;
    await db
      .insert(semesters)
      .values({
        id: deterministicUuid(`sem:${sem}`),
        semesterNumber: sem,
        label: `Semester ${sem}`,
        academicYearId: yr.id,
      })
      .onConflictDoNothing({ target: semesters.semesterNumber });
  }

  const allDepts = await db.select().from(departments);
  const allSemesters = await db.select().from(semesters);
  const semByNum = new Map(allSemesters.map((s) => [s.semesterNumber, s]));

  // 6. Seed Default Classes & Subjects for every official department (including newly added departments like CSM B)
  const existingClasses = await db
    .select({
      departmentId: classes.departmentId,
      semesterId: classes.semesterId,
    })
    .from(classes);
  const classKeySet = new Set(
    existingClasses.map((c) => `${c.departmentId}:${c.semesterId}`)
  );

  const classValues: Array<{
    id: string;
    departmentId: string;
    academicYearId: string;
    semesterId: string;
    sectionName: string;
    displayName: string;
  }> = [];

  for (const dept of allDepts) {
    for (const sem of allSemesters) {
      if (!classKeySet.has(`${dept.id}:${sem.id}`)) {
        classValues.push({
          id: deterministicUuid(`class:${dept.code}:sem${sem.semesterNumber}:Regular`),
          departmentId: dept.id,
          academicYearId: sem.academicYearId,
          semesterId: sem.id,
          sectionName: 'Regular',
          displayName: `${dept.code} · Sem ${sem.semesterNumber}`,
        });
      }
    }
  }
  if (classValues.length > 0) {
    await db.insert(classes).values(classValues).onConflictDoNothing();
  }

  const existingSubjects = await db
    .select({
      code: subjects.code,
      departmentId: subjects.departmentId,
      semesterId: subjects.semesterId,
    })
    .from(subjects);
  const subjectKeySet = new Set(
    existingSubjects.map((s) => `${s.code}:${s.departmentId}:${s.semesterId}`)
  );

  const subjectValues: Array<{
    id: string;
    code: string;
    name: string;
    departmentId: string;
    semesterId: string;
    credits: number;
  }> = [];

  for (const dept of allDepts) {
    const prefix = dept.code.replace(/\s+/g, '');
    for (const tmpl of CORE_SUBJECT_TEMPLATES) {
      const sem = semByNum.get(tmpl.semesterNumber);
      if (!sem) continue;
      const subjCode = `${prefix}-${tmpl.suffix}`;
      if (!subjectKeySet.has(`${subjCode}:${dept.id}:${sem.id}`)) {
        subjectValues.push({
          id: deterministicUuid(`subject:${subjCode}:${dept.code}:sem${sem.semesterNumber}`),
          code: subjCode,
          name: tmpl.name,
          departmentId: dept.id,
          semesterId: sem.id,
          credits: tmpl.credits,
        });
      }
    }
  }
  if (subjectValues.length > 0) {
    await db.insert(subjects).values(subjectValues).onConflictDoNothing();
  }

  // 7. Seed College Settings
  const existingSettings = await db
    .select({ id: collegeSettings.id, faceMatchThreshold: collegeSettings.faceMatchThreshold })
    .from(collegeSettings)
    .limit(1);
  if (existingSettings.length === 0) {
    await db.insert(collegeSettings).values({
      id: deterministicUuid('settings:college'),
      collegeName: 'Swarna Bharathi Institute of Science and Technology',
      logoUrl: '/src/assets/images/sbist_college_crest_1795533458624.jpg',
      locationVerificationEnabled: true,
      collegeLatitude: 17.2473,
      collegeLongitude: 80.1514,
      geofenceRadiusMeters: 300,
      attendanceFrequency: 'every_class_period',
      qrDefaultExpiryHours: 24,
      faceMatchThreshold: 0.3,
      livenessRequired: true,
      autoDailySessionsEnabled: true,
      morningStartTime: '09:00',
      morningEndTime: '09:40',
      afternoonStartTime: '13:30',
      afternoonEndTime: '13:40',
      workingWeekdays: [1, 2, 3, 4, 5, 6],
    });
  } else if (
    existingSettings[0].faceMatchThreshold > 0.33 ||
    existingSettings[0].faceMatchThreshold < 0.22
  ) {
    await db
      .update(collegeSettings)
      .set({ faceMatchThreshold: 0.3, updatedAt: new Date() })
      .where(eq(collegeSettings.id, existingSettings[0].id));
  }

  // 8. Seed Permanent Lifetime Campus QR Codes (1. Everyday Attendance Check-In, 2. Student Registration)
  await db.delete(registrationQrCodes).where(eq(registrationQrCodes.token, 'SBIST-ATTEND-CAMPUS'));
  await db.delete(registrationQrCodes).where(eq(registrationQrCodes.token, 'SBIST-REGISTER-CAMPUS'));

  await db
    .insert(registrationQrCodes)
    .values({
      id: deterministicUuid('qr:SBIT-ATTEND-CAMPUS'),
      token: 'SBIT-ATTEND-CAMPUS',
      qrPurpose: 'attendance',
      label: 'Lifetime Campus Attendance QR (Hall Ticket + Face Check-In)',
      maxUses: null,
      expiresAt: null,
      isRevoked: false,
    })
    .onConflictDoUpdate({
      target: registrationQrCodes.token,
      set: {
        qrPurpose: 'attendance',
        label: 'Lifetime Campus Attendance QR (Hall Ticket + Face Check-In)',
        maxUses: null,
        expiresAt: null,
        isRevoked: false,
      },
    });

  await db
    .insert(registrationQrCodes)
    .values({
      id: deterministicUuid('qr:SBIT-REGISTER-CAMPUS'),
      token: 'SBIT-REGISTER-CAMPUS',
      qrPurpose: 'registration',
      label: 'Lifetime Campus Student Registration QR',
      maxUses: null,
      expiresAt: null,
      isRevoked: false,
    })
    .onConflictDoUpdate({
      target: registrationQrCodes.token,
      set: {
        qrPurpose: 'registration',
        label: 'Lifetime Campus Student Registration QR',
        maxUses: null,
        expiresAt: null,
        isRevoked: false,
      },
    });

  // 9. Seed JNTUH Regulation Rules (R22, R20, R18)
  const jntuhRules = [
    {
      id: deterministicUuid('jntuh:R22'),
      code: 'R22',
      name: 'JNTUH B.Tech R22 Regulation (50% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 40,
      sem6To7MinCredits: 60,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
    {
      id: deterministicUuid('jntuh:R20'),
      code: 'R20',
      name: 'JNTUH B.Tech R20 Regulation (60% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 48,
      sem6To7MinCredits: 72,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
    {
      id: deterministicUuid('jntuh:R18'),
      code: 'R18',
      name: 'JNTUH B.Tech R18 Regulation (60% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 48,
      sem6To7MinCredits: 72,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
  ];

  for (const rule of jntuhRules) {
    await db
      .insert(jntuhRegulationRules)
      .values(rule)
      .onConflictDoNothing({ target: jntuhRegulationRules.code });
  }
}
