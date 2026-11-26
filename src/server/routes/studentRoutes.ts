import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  biometricTemplates,
  collegeSettings,
  studentEnrollments,
  subjects,
} from '../../db/schema.ts';
import { type AuthRequest, requireAuth, requireRole } from '../../middleware/auth.ts';
import {
  areEnrollmentSamplesConsistent,
  computeGeofenceDistanceMeters,
  CURRENT_BIOMETRIC_ALGORITHM,
  decryptBiometricTemplate,
  deriveFaceIdCode,
  encryptBiometricTemplateV2,
  formatISTTimestamp,
  getISTDateString,
  isValidUuid,
  verifyLiveFaceDescriptors,
} from '../crypto.ts';
import { writeAuditLog } from '../audit.ts';
import {
  type DailySlotSummary,
  formatTime12h,
  getNormalizedScheduleSettings,
  getStudentSlotMessage,
  syncAutomaticDailySessions,
  validateSessionAttendanceWindow,
} from '../attendanceScheduler.ts';
import { computeStudentFullAttendanceProfile } from '../attendanceCalculator.ts';
import {
  deleteBiometricFromFirestore,
  syncAttendanceRecordToFirestore,
  syncBiometricToFirestore,
  syncCorrectionToFirestore,
} from '../firestoreRestSync.ts';

export const studentRouter = Router();

studentRouter.use(requireAuth, requireRole('student'));

const attendanceMarkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attendance verification attempts. Please wait a moment.' },
});

studentRouter.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const syncRes = await syncAutomaticDailySessions();

    const requestedSemId =
      typeof req.query.semesterId === 'string' && isValidUuid(req.query.semesterId)
        ? req.query.semesterId
        : null;

    const profileData = await computeStudentFullAttendanceProfile({
      studentId: student.id,
      selectedSemesterId: requestedSemId,
    });

    if (!profileData) {
      return res.status(404).json({ error: 'Student enrollment record not found.' });
    }

    const { enrollment } = profileData;

    const [bio, activeSessionsRaw, todayAutoSessions, todayRecords, overrideRequests] =
      await Promise.all([
        db
          .select({
            authTag: biometricTemplates.authTag,
            algorithm: biometricTemplates.algorithm,
            sampleCount: biometricTemplates.sampleCount,
            consentTimestamp: biometricTemplates.consentTimestamp,
            retentionPolicyVersion: biometricTemplates.retentionPolicyVersion,
            isActive: biometricTemplates.isActive,
          })
          .from(biometricTemplates)
          .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
          .limit(1),
        db
          .select({
            id: attendanceSessions.id,
            sessionCode: attendanceSessions.sessionCode,
            subjectId: attendanceSessions.subjectId,
            subjectCode: subjects.code,
            subjectName: subjects.name,
            sessionDate: attendanceSessions.sessionDate,
            startTime: attendanceSessions.startTime,
            endTime: attendanceSessions.endTime,
            periodSlot: attendanceSessions.periodSlot,
            sessionType: attendanceSessions.sessionType,
            status: attendanceSessions.status,
          })
          .from(attendanceSessions)
          .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
          .where(
            and(
              eq(attendanceSessions.departmentId, enrollment.departmentId),
              eq(attendanceSessions.classId, enrollment.classId),
              eq(attendanceSessions.status, 'active')
            )
          )
          .orderBy(desc(attendanceSessions.createdAt)),
        db
          .select({
            id: attendanceSessions.id,
            sessionCode: attendanceSessions.sessionCode,
            periodSlot: attendanceSessions.periodSlot,
            startTime: attendanceSessions.startTime,
            endTime: attendanceSessions.endTime,
            status: attendanceSessions.status,
          })
          .from(attendanceSessions)
          .where(
            and(
              eq(attendanceSessions.departmentId, enrollment.departmentId),
              eq(attendanceSessions.classId, enrollment.classId),
              eq(attendanceSessions.sessionDate, syncRes.todayIST)
            )
          ),
        db
          .select({
            sessionId: attendanceRecords.sessionId,
            status: attendanceRecords.status,
          })
          .from(attendanceRecords)
          .where(
            and(
              eq(attendanceRecords.studentId, student.id),
              eq(attendanceRecords.attendanceDate, syncRes.todayIST)
            )
          ),
        db
          .select()
          .from(attendanceCorrectionRequests)
          .where(eq(attendanceCorrectionRequests.studentId, student.id))
          .orderBy(desc(attendanceCorrectionRequests.createdAt))
          .limit(20),
      ]);

    const todayMarkedSet = new Set(todayRecords.map((r) => r.sessionId));
    const normSettings = getNormalizedScheduleSettings(profileData.settings);

    const buildTodaySlot = (slot: 'morning' | 'afternoon'): DailySlotSummary => {
      const startTime =
        slot === 'morning' ? normSettings.morningStartTime : normSettings.afternoonStartTime;
      const endTime =
        slot === 'morning' ? normSettings.morningEndTime : normSettings.afternoonEndTime;
      const slotSes =
        todayAutoSessions.find(
          (s) => s.periodSlot === slot && s.sessionCode.startsWith('AUTO-')
        ) ?? todayAutoSessions.find((s) => s.periodSlot === slot);

      const lifecycleStatus = slotSes
        ? (slotSes.status as DailySlotSummary['status'])
        : slot === 'morning'
          ? syncRes.morningStatus
          : syncRes.afternoonStatus;

      const alreadyMarked = slotSes ? todayMarkedSet.has(slotSes.id) : false;
      const canMark =
        syncRes.dayEval.isWorkingDay &&
        !syncRes.dayEval.isHoliday &&
        lifecycleStatus === 'active' &&
        !alreadyMarked &&
        Boolean(slotSes);

      return {
        slot,
        label: slot === 'morning' ? 'Morning Session' : 'Afternoon Session',
        startTime,
        endTime,
        startTime12h: formatTime12h(startTime),
        endTime12h: formatTime12h(endTime),
        status: lifecycleStatus,
        canMark,
        alreadyMarked,
        sessionId: slotSes?.id ?? null,
        sessionCode: slotSes?.sessionCode ?? null,
        message: getStudentSlotMessage({
          slot,
          status: lifecycleStatus,
          startTime,
          dayEval: syncRes.dayEval,
          alreadyMarked,
        }),
      };
    };

    const morningSlot = buildTodaySlot('morning');
    const afternoonSlot = buildTodaySlot('afternoon');
    const remainingOpportunitiesToday = syncRes.dayEval.isWorkingDay
      ? [morningSlot, afternoonSlot].filter(
          (s) => !s.alreadyMarked && (s.status === 'scheduled' || s.status === 'active')
        ).length
      : 0;

    const allMarkedIds = new Set(profileData.selectedRecords.map((r) => r.sessionId));
    const activeSessionsAnnotated = activeSessionsRaw.map((s) => ({
      ...s,
      subjectCode: s.subjectCode ?? 'DAILY',
      subjectName:
        s.subjectName ?? (s.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
      alreadyMarked: allMarkedIds.has(s.id) || todayMarkedSet.has(s.id),
    }));

    const bioRow = bio[0];

    res.json({
      student,
      todayIST: profileData.todayIST,
      todayDayEval: profileData.todayDayEval,
      todaySchedule: {
        dayEval: profileData.todayDayEval,
        morning: morningSlot,
        afternoon: afternoonSlot,
        remainingOpportunitiesToday,
      },
      enrollment,
      selectedSemesterId: profileData.selectedMeta.semesterId,
      viewingHistoricalSemester: profileData.selectedMeta.semesterId !== enrollment.semesterId,
      availableSemesters: profileData.availableSemesters,
      academicHistory: profileData.historyRows.map((h) => ({
        ...h,
        recordedAtIST: formatISTTimestamp(new Date(h.recordedAt)),
      })),
      biometricStatus:
        bioRow && bioRow.algorithm === CURRENT_BIOMETRIC_ALGORITHM
          ? {
              enrolled: true,
              reEnrollRequired: false,
              faceId: deriveFaceIdCode(student.id, bioRow.authTag),
              sampleCount: bioRow.sampleCount,
              consentTimestamp: bioRow.consentTimestamp,
              retentionPolicyVersion: bioRow.retentionPolicyVersion,
            }
          : {
              enrolled: false,
              reEnrollRequired: Boolean(bioRow),
              faceId: null,
              sampleCount: 0,
              consentTimestamp: null,
              retentionPolicyVersion: null,
            },
      summary: profileData.summary,
      currentSemesterSummary: profileData.currentSemesterSummary,
      overallSummary: profileData.overallSummary,
      subjectWise: profileData.subjectWise,
      calendar: profileData.calendar,
      holidays: [...profileData.holidayRows].sort((a, b) => a.startDate.localeCompare(b.startDate)),
      calendarOverrides: profileData.overrideRows,
      activeSessions: activeSessionsAnnotated,
      recentRecords: profileData.selectedRecords.map((r) => ({
        ...r,
        subjectCode: r.subjectCode ?? 'DAILY',
        subjectName:
          r.subjectName ?? (r.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
        markedAtIST: formatISTTimestamp(new Date(r.markedAt)),
      })),
      overrideRequests,
      collegeSettings: profileData.settings,
    });
  } catch (err) {
    console.error('Student dashboard error:', err);
    res.status(500).json({ error: 'Failed to load student dashboard.' });
  }
});

const enrollBiometricSchema = z.object({
  consentGiven: z.literal(true, { message: 'Informed biometric consent is mandatory.' }),
  descriptors: z
    .array(z.array(z.number().finite()).length(128))
    .min(3, 'At least 3 live face samples are required for enrollment.')
    .max(5),
});

studentRouter.post('/biometrics/enroll', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    if (student.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved students can enroll facial biometrics.' });
    }

    const parsed = enrollBiometricSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid biometric samples.' });
    }

    if (!areEnrollmentSamplesConsistent(parsed.data.descriptors, 0.26)) {
      return res.status(400).json({
        error:
          'Enrollment face samples were inconsistent. Keep only your face centered, straight-on, and in clear light for all 3 captures.',
      });
    }

    const encrypted = encryptBiometricTemplateV2(parsed.data.descriptors);

    await db
      .insert(biometricTemplates)
      .values({
        studentId: student.id,
        encryptedDescriptor: encrypted.encryptedDescriptor,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        algorithm: CURRENT_BIOMETRIC_ALGORITHM,
        sampleCount: parsed.data.descriptors.length,
        consentGiven: true,
        consentTimestamp: new Date(),
        retentionPolicyVersion: 'SBIT-BIO-2026-v1',
        isActive: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: biometricTemplates.studentId,
        set: {
          encryptedDescriptor: encrypted.encryptedDescriptor,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          algorithm: CURRENT_BIOMETRIC_ALGORITHM,
          sampleCount: parsed.data.descriptors.length,
          consentGiven: true,
          consentTimestamp: new Date(),
          isActive: true,
          updatedAt: new Date(),
        },
      });

    const faceId = deriveFaceIdCode(student.id, encrypted.authTag);

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'BIOMETRIC_TEMPLATE_ENROLLED',
      entityType: 'biometric_template',
      entityId: student.id,
      details: { faceId, sampleCount: parsed.data.descriptors.length, policy: 'SBIT-BIO-2026-v1' },
      ipAddress: req.clientIp,
    });

    await syncBiometricToFirestore(req.firebaseIdToken, student.id);

    res.json({
      message: `Face ID ${faceId} created and encrypted successfully.`,
      faceId,
      sampleCount: parsed.data.descriptors.length,
      retentionPolicyVersion: 'SBIT-BIO-2026-v1',
    });
  } catch (err) {
    console.error('Biometric enrollment error:', err);
    res.status(500).json({ error: 'Failed to enroll biometric template.' });
  }
});

const testFaceIdMatchSchema = z.object({
  descriptor: z.array(z.number().finite()).length(128).optional(),
  descriptors: z.array(z.array(z.number().finite()).length(128)).min(1).max(5),
  livenessPassed: z.boolean(),
  livenessSignals: z
    .object({
      blinkDetected: z.boolean(),
      headTurnDetected: z.boolean(),
      frameVariance: z.number().nonnegative(),
    })
    .optional(),
});

studentRouter.post('/biometrics/test-match', attendanceMarkLimiter, async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const parsed = testFaceIdMatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid face check payload.' });
    }
    const payload = parsed.data;

    const [template] = await db
      .select()
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    if (!template) {
      return res.status(400).json({
        error: 'No Face ID created yet. Please create your Face ID first.',
        code: 'BIOMETRIC_NOT_ENROLLED',
      });
    }
    if (template.algorithm !== CURRENT_BIOMETRIC_ALGORITHM) {
      return res.status(403).json({
        error: 'Your previous Face ID was retired for security. Please re-create your Face ID first.',
        code: 'BIOMETRIC_REENROLL_REQUIRED',
      });
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);
    const rawThreshold = settings?.faceMatchThreshold ?? 0.3;
    const faceThreshold = rawThreshold > 0.33 || rawThreshold < 0.22 ? 0.3 : rawThreshold;
    const livenessRequired = settings?.livenessRequired ?? true;

    if (livenessRequired) {
      const signalsValid =
        payload.livenessPassed &&
        (!payload.livenessSignals ||
          (payload.livenessSignals.blinkDetected && payload.livenessSignals.frameVariance > 0.0001));
      if (!signalsValid) {
        return res.status(403).json({
          error: 'Please blink naturally while facing the camera so the live liveness check completes.',
          code: 'LIVENESS_FAILED',
        });
      }
    }

    const faceId = deriveFaceIdCode(student.id, template.authTag);
    const enrolledTemplate = decryptBiometricTemplate(
      template.encryptedDescriptor,
      template.iv,
      template.authTag
    );
    const matchResult = verifyLiveFaceDescriptors({
      enrolledVector: enrolledTemplate.centroid,
      enrolledSamples: enrolledTemplate.samples,
      liveDescriptors: payload.descriptors,
      threshold: faceThreshold,
    });

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: matchResult.matched ? 'BIOMETRIC_SELF_CHECK_MATCHED' : 'BIOMETRIC_SELF_CHECK_REJECTED',
      entityType: 'biometric_template',
      entityId: student.id,
      details: {
        faceId,
        matched: matchResult.matched,
        distance: Math.round(matchResult.distance * 1000) / 1000,
        maxFrameDistance: Math.round(matchResult.maxFrameDistance * 1000) / 1000,
        inconsistentFrames: matchResult.inconsistentFrames,
        threshold: faceThreshold,
      },
      ipAddress: req.clientIp,
    });

    res.json({
      faceId,
      matched: matchResult.matched,
      inconsistentFrames: matchResult.inconsistentFrames,
      distance: Math.round(matchResult.distance * 1000) / 1000,
      maxFrameDistance: Math.round(matchResult.maxFrameDistance * 1000) / 1000,
      threshold: faceThreshold,
      confidence: matchResult.confidence,
      message: matchResult.matched
        ? `MATCHED — Live face matches Face ID ${faceId} (${student.fullName}, distance ${matchResult.distance.toFixed(3)} <= ${faceThreshold.toFixed(2)}).`
        : matchResult.inconsistentFrames
          ? `NOT MATCHED — Camera frames moved or changed faces mid-scan. Hold one face steady and try again.`
          : `NOT MATCHED — This face does NOT match Face ID ${faceId} (${student.fullName}; distance ${matchResult.distance.toFixed(3)} > limit ${faceThreshold.toFixed(2)}).`,
    });
  } catch (err) {
    console.error('Face ID test-match error:', err);
    res.status(500).json({ error: 'Failed to check Face ID match.' });
  }
});

studentRouter.delete('/biometrics', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    await db.delete(biometricTemplates).where(eq(biometricTemplates.studentId, student.id));

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'BIOMETRIC_TEMPLATE_DELETED',
      entityType: 'biometric_template',
      entityId: student.id,
      ipAddress: req.clientIp,
    });

    await deleteBiometricFromFirestore(req.firebaseIdToken, student.id);

    res.json({ message: 'Face ID permanently deleted. You may create a new Face ID at any time.' });
  } catch (err) {
    console.error('Biometric deletion error:', err);
    res.status(500).json({ error: 'Failed to delete biometric template.' });
  }
});

const markAttendanceSchema = z.object({
  sessionId: z.string().uuid('Please select an active attendance session.'),
  descriptor: z.array(z.number().finite()).length(128),
  descriptors: z.array(z.array(z.number().finite()).length(128)).min(1).max(5).optional(),
  livenessPassed: z.boolean(),
  livenessSignals: z
    .object({
      blinkDetected: z.boolean(),
      headTurnDetected: z.boolean(),
      frameVariance: z.number().nonnegative(),
    })
    .optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
});

studentRouter.post('/attendance/mark', attendanceMarkLimiter, async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const parsed = markAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid verification payload.' });
    }
    const payload = parsed.data;

    // Step 3: Backend checks approved and active account
    if (student.status !== 'approved') {
      return res.status(403).json({ error: 'Account is not approved or active.' });
    }

    const [enrollment] = await db
      .select()
      .from(studentEnrollments)
      .where(and(eq(studentEnrollments.studentId, student.id), eq(studentEnrollments.isActive, true)))
      .limit(1);

    if (!enrollment) {
      return res.status(403).json({ error: 'Active class enrollment not found for your account.' });
    }

    // Step 4 & 5: Validate authoritative IST session window, holiday/working day rules, and class eligibility
    const windowCheck = await validateSessionAttendanceWindow({
      sessionId: payload.sessionId,
      studentClassId: enrollment.classId,
      studentDepartmentId: enrollment.departmentId,
    });

    if (!windowCheck.allowed) {
      return res.status(windowCheck.httpStatus).json({
        error: windowCheck.error,
        code: windowCheck.code,
      });
    }
    const session = windowCheck.session;

    // Immediate duplicate check before biometric decryption
    const [existingMark] = await db
      .select({ id: attendanceRecords.id })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.studentId, student.id),
          eq(attendanceRecords.sessionId, session.id)
        )
      )
      .limit(1);

    if (existingMark) {
      return res.status(409).json({
        error: 'Attendance has already been marked for this session.',
      });
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);
    const locationEnabled = settings?.locationVerificationEnabled ?? true;
    const geofenceRadius = settings?.geofenceRadiusMeters ?? 300;
    const rawThreshold = settings?.faceMatchThreshold ?? 0.3;
    const faceThreshold = rawThreshold > 0.33 || rawThreshold < 0.22 ? 0.3 : rawThreshold;
    const livenessRequired = settings?.livenessRequired ?? true;

    // Check attendance frequency constraints (once_per_day / morning_afternoon)
    const frequency = settings?.attendanceFrequency ?? 'every_class_period';
    if (frequency === 'once_per_day') {
      const existingToday = await db
        .select({ id: attendanceRecords.id })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.studentId, student.id),
            eq(attendanceRecords.attendanceDate, session.sessionDate),
            eq(attendanceRecords.status, 'present')
          )
        )
        .limit(1);
      if (existingToday.length > 0) {
        return res.status(409).json({
          error: 'Daily attendance has already been marked today under Once-Per-Day college policy.',
        });
      }
    } else if (frequency === 'morning_afternoon') {
      const slotGroup = session.periodSlot === 'afternoon' ? 'afternoon' : 'morning';
      const existingSlot = await db
        .select({ id: attendanceRecords.id, periodSlot: attendanceSessions.periodSlot })
        .from(attendanceRecords)
        .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
        .where(
          and(
            eq(attendanceRecords.studentId, student.id),
            eq(attendanceRecords.attendanceDate, session.sessionDate),
            eq(attendanceRecords.status, 'present')
          )
        );
      if (existingSlot.some((e) => (e.periodSlot === 'afternoon' ? 'afternoon' : 'morning') === slotGroup)) {
        return res.status(409).json({
          error: `Attendance has already been marked for the ${slotGroup} session today.`,
        });
      }
    }

    // Step 6 & 7: Geofence location verification (if enabled)
    let distanceMeters: number | null = null;
    if (locationEnabled) {
      if (payload.latitude == null || payload.longitude == null) {
        return res.status(400).json({
          error: 'Location permission is required by college policy to verify campus proximity.',
          code: 'LOCATION_REQUIRED',
        });
      }
      distanceMeters = computeGeofenceDistanceMeters(
        payload.latitude,
        payload.longitude,
        settings!.collegeLatitude,
        settings!.collegeLongitude
      );
      if (distanceMeters > geofenceRadius) {
        await writeAuditLog({
          actorId: student.id,
          actorEmail: student.email,
          actorRole: 'student',
          action: 'GEOFENCE_VERIFICATION_FAILED',
          entityType: 'attendance_session',
          entityId: session.id,
          details: { distanceMeters, allowedRadius: geofenceRadius },
          ipAddress: req.clientIp,
        });
        return res.status(403).json({
          error: `Outside campus geofence (${distanceMeters}m away; allowed radius is ${geofenceRadius}m). You may request a staff-assisted override.`,
          code: 'OUTSIDE_GEOFENCE',
          distanceMeters,
          allowedRadius: geofenceRadius,
        });
      }
    }

    // Step 10: Retrieve and decrypt enrolled biometric template on trusted backend
    const [template] = await db
      .select()
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    if (!template) {
      return res.status(400).json({
        error: 'Face enrollment is required before marking attendance. Please complete Face Enrollment first.',
        code: 'BIOMETRIC_NOT_ENROLLED',
      });
    }
    if (template.algorithm !== CURRENT_BIOMETRIC_ALGORITHM) {
      return res.status(403).json({
        error:
          'Your face template was enrolled on an older scanner version and has been invalidated for security. Please re-enroll your face in the Student Portal before marking attendance.',
        code: 'BIOMETRIC_REENROLL_REQUIRED',
      });
    }

    // Step 11: Liveness verification
    if (livenessRequired) {
      const signalsValid =
        payload.livenessPassed &&
        (!payload.livenessSignals ||
          (payload.livenessSignals.blinkDetected && payload.livenessSignals.frameVariance > 0.0001));
      if (!signalsValid) {
        await writeAuditLog({
          actorId: student.id,
          actorEmail: student.email,
          actorRole: 'student',
          action: 'LIVENESS_CHECK_FAILED',
          entityType: 'attendance_session',
          entityId: session.id,
          ipAddress: req.clientIp,
        });
        return res.status(403).json({
          error:
            'Liveness verification failed (blink/motion check incomplete). Please retry or use Staff-Assisted attendance.',
          code: 'LIVENESS_FAILED',
        });
      }
    }

    // Verify live frame(s) against decrypted enrolled template with strict distance & consistency checks
    const faceId = deriveFaceIdCode(student.id, template.authTag);
    const enrolledTemplate = decryptBiometricTemplate(
      template.encryptedDescriptor,
      template.iv,
      template.authTag
    );
    const liveDescriptors =
      payload.descriptors && payload.descriptors.length > 0
        ? payload.descriptors
        : [payload.descriptor];
    const matchResult = verifyLiveFaceDescriptors({
      enrolledVector: enrolledTemplate.centroid,
      enrolledSamples: enrolledTemplate.samples,
      liveDescriptors,
      threshold: faceThreshold,
    });
    const distance = matchResult.distance;
    const confidence = matchResult.confidence;

    if (!matchResult.matched) {
      await writeAuditLog({
        actorId: student.id,
        actorEmail: student.email,
        actorRole: 'student',
        action: 'FACE_VERIFICATION_REJECTED',
        entityType: 'attendance_session',
        entityId: session.id,
        details: {
          faceId,
          distance: Math.round(distance * 1000) / 1000,
          maxFrameDistance: Math.round(matchResult.maxFrameDistance * 1000) / 1000,
          inconsistentFrames: matchResult.inconsistentFrames,
          threshold: faceThreshold,
        },
        ipAddress: req.clientIp,
      });
      return res.status(403).json({
        error: matchResult.inconsistentFrames
          ? 'Camera frames were unstable or showed movement between faces. Hold steady facing the camera and retry.'
          : `Face verification rejected — live face does NOT match Face ID ${faceId} (distance ${distance.toFixed(3)} exceeds limit ${faceThreshold.toFixed(2)}).`,
        code: 'FACE_MISMATCH',
      });
    }

    // Step 12, 13, 14: Atomic transaction re-checking session active + unique constraint insert
    const istDate = session.sessionDate || getISTDateString();

    const insertResult = await db.transaction(async (tx) => {
      const [freshSession] = await tx
        .select()
        .from(attendanceSessions)
        .where(eq(attendanceSessions.id, session.id))
        .limit(1);

      if (!freshSession || freshSession.status !== 'active') {
        return { kind: 'inactive' as const };
      }

      const inserted = await tx
        .insert(attendanceRecords)
        .values({
          studentId: student.id,
          sessionId: session.id,
          departmentId: enrollment.departmentId,
          classId: enrollment.classId,
          subjectId: session.subjectId,
          academicYearId: session.academicYearId,
          semesterId: session.semesterId,
          attendanceDate: istDate,
          status: 'present',
          verificationMethod: locationEnabled ? 'face_geofence' : 'face_only',
          verificationResult: 'verified',
          faceConfidence: confidence,
          livenessPassed: payload.livenessPassed,
          latitude: payload.latitude ?? null,
          longitude: payload.longitude ?? null,
          geofenceDistanceM: distanceMeters,
        })
        .onConflictDoNothing({
          target: [attendanceRecords.studentId, attendanceRecords.sessionId],
        })
        .returning();

      if (inserted.length === 0) {
        return { kind: 'duplicate' as const };
      }
      return { kind: 'created' as const, record: inserted[0] };
    });

    if (insertResult.kind === 'inactive') {
      return res.status(409).json({
        error: 'No active attendance session is available for your class.',
      });
    }
    if (insertResult.kind === 'duplicate') {
      return res.status(409).json({
        error: 'Attendance has already been marked for this session.',
      });
    }

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'ATTENDANCE_MARKED',
      entityType: 'attendance_record',
      entityId: insertResult.record.id,
      details: {
        sessionId: session.id,
        sessionCode: session.sessionCode,
        confidence,
        distanceMeters,
      },
      ipAddress: req.clientIp,
    });

    await syncAttendanceRecordToFirestore(req.firebaseIdToken, insertResult.record.id);

    res.status(201).json({
      message: `Attendance verified with Face ID ${faceId} and marked successfully.`,
      faceId,
      record: {
        ...insertResult.record,
        markedAtIST: formatISTTimestamp(new Date(insertResult.record.markedAt)),
      },
    });
  } catch (err: unknown) {
    // Handle PostgreSQL unique violation code 23505 defensively
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({
        error: 'Attendance has already been marked for this session.',
      });
    }
    console.error('Mark attendance error:', err);
    res.status(500).json({ error: 'Failed to save attendance record.' });
  }
});

const overrideRequestSchema = z.object({
  sessionId: z.string().uuid('Please select a valid attendance session.'),
  requestType: z.enum(['location_bypass', 'liveness_assisted', 'correction']),
  reason: z.string().min(10, 'Please provide a clear reason (at least 10 characters).').max(500),
});

studentRouter.post('/attendance/override-request', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const parsed = overrideRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid request.' });
    }

    const [created] = await db
      .insert(attendanceCorrectionRequests)
      .values({
        studentId: student.id,
        sessionId: parsed.data.sessionId,
        requestedBy: student.id,
        requestedStatus: 'present',
        requestType: parsed.data.requestType,
        reason: parsed.data.reason.trim(),
        status: 'pending',
      })
      .returning();

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'ATTENDANCE_OVERRIDE_REQUESTED',
      entityType: 'attendance_correction_request',
      entityId: created.id,
      details: { requestType: parsed.data.requestType, sessionId: parsed.data.sessionId },
      ipAddress: req.clientIp,
    });

    await syncCorrectionToFirestore(req.firebaseIdToken, created.id);

    res.status(201).json({
      message: 'Verification exception request submitted to faculty/admin for review.',
      request: created,
    });
  } catch (err) {
    console.error('Override request error:', err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});
