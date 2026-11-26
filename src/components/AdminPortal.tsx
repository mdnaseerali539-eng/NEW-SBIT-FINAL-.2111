import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileBarChart,
  LayoutDashboard,
  Loader2,
  LogOut,
  MapPin,
  QrCode,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
  TrendingUp,
  UserCog,
  Users,
} from 'lucide-react';
import { apiFetch, broadcastDataChange, subscribeDataChange } from '../lib/api';
import { getDefaultQrBaseUrl, isPrivateDevOrigin } from '../lib/qrUrl';
import {
  AcademicYear,
  AuthMeResponse,
  CollegeSettings,
  Department,
  Semester,
} from '../types';
import { AcademicPromotionPanel } from './AcademicPromotionPanel';
import { HolidayScheduler } from './HolidayScheduler';
import { RefreshBar } from './RefreshBar';

const ReportsPanel = lazy(() =>
  import('./ReportsPanel').then((m) => ({ default: m.ReportsPanel }))
);

interface AdminPortalProps {
  me: AuthMeResponse;
  onLogout: () => void;
}

type AdminNav =
  | 'overview'
  | 'approvals'
  | 'students'
  | 'staff'
  | 'academics'
  | 'promotion'
  | 'sessions'
  | 'holidays'
  | 'qr'
  | 'reports'
  | 'settings';

const VALID_ADMIN_NAVS: AdminNav[] = [
  'overview',
  'approvals',
  'students',
  'staff',
  'academics',
  'promotion',
  'sessions',
  'holidays',
  'qr',
  'reports',
  'settings',
];

export const AdminPortal: React.FC<AdminPortalProps> = ({ me, onLogout }) => {
  const [nav, setNavState] = useState<AdminNav>(() => {
    try {
      const saved = sessionStorage.getItem('sbit_admin_nav') as AdminNav | null;
      return saved && VALID_ADMIN_NAVS.includes(saved) ? saved : 'overview';
    } catch {
      return 'overview';
    }
  });
  const setNav = useCallback((next: AdminNav) => {
    setNavState(next);
    try {
      sessionStorage.setItem('sbit_admin_nav', next);
    } catch {
      // Ignore storage errors
    }
  }, []);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Overview state
  const [dash, setDash] = useState<{
    todayIST: string;
    todayDayEval?: {
      dateIST: string;
      dayStatus: string;
      isWorkingDay: boolean;
      isHoliday: boolean;
      holidayTitle: string | null;
      holidayReason: string | null;
      overrideTitle: string | null;
      overrideReason: string | null;
    };
    dailySchedule?: {
      autoDailySessionsEnabled: boolean;
      workingWeekdays: number[];
      morning: {
        slot: 'morning' | 'afternoon';
        label: string;
        startTime: string;
        endTime: string;
        startTime12h: string;
        endTime12h: string;
        status: string;
        totalSessions: number;
        presentCount: number;
      };
      afternoon: {
        slot: 'morning' | 'afternoon';
        label: string;
        startTime: string;
        endTime: string;
        startTime12h: string;
        endTime12h: string;
        status: string;
        totalSessions: number;
        presentCount: number;
      };
    };
    upcomingHolidays?: Array<{
      id: string;
      title: string;
      startDate: string;
      endDate: string;
      reason: string | null;
    }>;
    metrics: {
      totalStudents: number;
      totalStaff: number;
      pendingRegistrations: number;
      activeSessions: number;
      presentToday: number;
      absentToday: number;
      overallPercentage: number;
      overallHasData?: boolean;
      overallMessage?: string | null;
    };
    departmentBreakdown: Array<{
      departmentId: string;
      code: string;
      name: string;
      enrolledStudents: number;
      presentToday: number;
      absentToday: number;
      totalCompletedSessions?: number;
      presentSessions?: number;
      absentSessions?: number;
      percentage: number;
      hasData?: boolean;
      message?: string | null;
    }>;
    recentAudit: Array<{
      id: string;
      action: string;
      actorEmail: string | null;
      entityType: string;
      createdAtIST: string;
    }>;
  } | null>(null);

  // Academics shared state
  const [academics, setAcademics] = useState<{
    departments: Department[];
    academicYears: AcademicYear[];
    semesters: Semester[];
    classes: Array<{
      id: string;
      departmentId: string;
      departmentCode: string;
      academicYearId: string;
      yearLabel: string;
      semesterId: string;
      semesterLabel: string;
      sectionName: string;
      displayName: string;
    }>;
    subjects: Array<{
      id: string;
      code: string;
      name: string;
      departmentId: string;
      departmentCode: string;
      semesterId: string;
      semesterLabel: string;
      credits: number;
    }>;
  }>({
    departments: [],
    academicYears: [],
    semesters: [],
    classes: [],
    subjects: [],
  });

  // Approvals state
  const [regStatusFilter, setRegStatusFilterState] = useState(() => {
    try {
      const saved = sessionStorage.getItem('sbit_admin_reg_filter');
      return saved && ['pending', 'approved', 'rejected', 'all'].includes(saved)
        ? saved
        : 'pending';
    } catch {
      return 'pending';
    }
  });
  const setRegStatusFilter = useCallback((next: string) => {
    setRegStatusFilterState(next);
    try {
      sessionStorage.setItem('sbit_admin_reg_filter', next);
    } catch {
      // Ignore storage errors
    }
  }, []);
  const [regSearch, setRegSearch] = useState('');
  const [copiedRegLink, setCopiedRegLink] = useState(false);
  const [registrations, setRegistrations] = useState<
    Array<{
      id: string;
      fullName: string;
      email: string;
      phone: string | null;
      rollNumber: string | null;
      status: string;
      rejectionReason?: string | null;
      departmentCode: string;
      yearLabel: string;
      semesterLabel: string;
      createdAtIST: string;
    }>
  >([]);
  const [latestSetupLink, setLatestSetupLink] = useState<string | null>(null);
  const [rejectingReg, setRejectingReg] = useState<{
    id: string;
    fullName: string;
    rollNumber: string | null;
  } | null>(null);
  const [confirmRemoveUser, setConfirmRemoveUser] = useState<{
    id: string;
    fullName: string;
    detail: string;
    roleLabel: string;
  } | null>(null);
  const [removingUser, setRemovingUser] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  // Students directory state
  const [students, setStudents] = useState<
    Array<{
      id: string;
      fullName: string;
      email: string;
      phone: string | null;
      rollNumber: string | null;
      status: string;
      departmentCode: string;
      yearLabel: string;
      semesterLabel: string;
      className: string;
      biometricEnrolled: boolean;
    }>
  >([]);
  const [studentPage, setStudentPage] = useState(1);
  const [studentPagination, setStudentPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [studentSearch, setStudentSearch] = useState('');
  const [studentDeptFilter, setStudentDeptFilter] = useState('');
  const [newStu, setNewStu] = useState({
    fullName: '',
    rollNumber: '',
    email: '',
    phone: '',
    departmentId: '',
    academicYearId: '',
    semesterId: '',
  });

  // Staff & Admins state
  const [staffList, setStaffList] = useState<
    Array<{
      id: string;
      fullName: string;
      email: string;
      employeeId: string | null;
      roleName: string;
      status: string;
      assignments: Array<{
        id: string;
        departmentCode: string;
        className: string | null;
        subjectCode: string | null;
      }>;
    }>
  >([]);
  const [newStaff, setNewStaff] = useState({
    fullName: '',
    email: '',
    phone: '',
    employeeId: '',
    departmentId: '',
    classId: '',
    subjectId: '',
    canCreateSessions: true,
  });

  // Academics forms
  const [newClass, setNewClass] = useState({
    departmentId: '',
    academicYearId: '',
    semesterId: '',
    sectionName: '',
  });
  const [newSubject, setNewSubject] = useState({
    code: '',
    name: '',
    departmentId: '',
    semesterId: '',
    credits: 3,
  });

  // Sessions & Attendance state
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      sessionCode: string;
      departmentCode: string;
      className: string;
      subjectCode: string;
      subjectName: string;
      sessionDate: string;
      startTime: string;
      endTime: string;
      status: string;
      isAutoScheduled?: boolean;
      cancelledReason?: string | null;
      presentCount: number;
    }>
  >([]);
  const [newSes, setNewSes] = useState({
    departmentId: '',
    classId: '',
    subjectId: '',
    sessionDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    startTime: '09:30',
    endTime: '10:30',
    periodSlot: 'daily',
  });
  const [correctionRequests, setCorrectionRequests] = useState<
    Array<{
      id: string;
      studentName: string;
      rollNumber: string | null;
      sessionCode: string;
      subjectName: string;
      requestType: string;
      requestedStatus: string;
      reason: string;
      status: string;
      createdAtIST: string;
    }>
  >([]);
  const [directCorrect, setDirectCorrect] = useState({
    studentId: '',
    sessionId: '',
    status: 'present' as 'present' | 'absent' | 'excused',
    reason: '',
  });

  // QR Codes state
  const [qrList, setQrList] = useState<
    Array<{
      id: string;
      token: string;
      qrPurpose: 'registration' | 'attendance';
      label: string;
      departmentCode: string | null;
      sessionId: string | null;
      sessionCode: string | null;
      usedCount: number;
      maxUses: number | null;
      expiresAtIST: string;
      isRevoked: boolean;
    }>
  >([]);
  const [qrBaseUrl, setQrBaseUrl] = useState<string>(() => getDefaultQrBaseUrl());
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [lifetimeQrImages, setLifetimeQrImages] = useState<{ attend: string; register: string }>({
    attend: '',
    register: '',
  });
  const [newQr, setNewQr] = useState({
    qrPurpose: 'attendance' as 'registration' | 'attendance',
    label: '',
    departmentId: '',
    academicYearId: '',
    semesterId: '',
    sessionId: '',
    expiryHours: 0,
    maxUses: 0,
  });

  // Settings & Audit logs
  const [settingsForm, setSettingsForm] = useState<CollegeSettings | null>(null);
  const [capturingGps, setCapturingGps] = useState(false);
  const [auditLogs, setAuditLogs] = useState<
    Array<{
      id: string;
      action: string;
      actorEmail: string | null;
      actorRole: string | null;
      entityType: string;
      createdAtIST: string;
      ipAddress: string | null;
    }>
  >([]);
  const [adminPassword, setAdminPassword] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      const res = await apiFetch<typeof dash>('/api/admin/dashboard', { cache: 'no-store' });
      setDash(res);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
    }
  }, []);

  const loadAcademics = useCallback(async () => {
    try {
      const res = await apiFetch<typeof academics>('/api/admin/academics', { cache: 'no-store' });
      setAcademics(res);
      const firstDeptId = res.departments[0]?.id || '';
      if (firstDeptId) {
        setNewStu((s) => (s.departmentId ? s : { ...s, departmentId: firstDeptId }));
        setNewStaff((s) => (s.departmentId ? s : { ...s, departmentId: firstDeptId }));
        setNewClass((s) => (s.departmentId ? s : { ...s, departmentId: firstDeptId }));
        setNewSubject((s) => (s.departmentId ? s : { ...s, departmentId: firstDeptId }));
        setNewSes((s) => {
          const deptId = s.departmentId || firstDeptId;
          const validClass = res.classes.some((c) => c.id === s.classId && c.departmentId === deptId)
            ? s.classId
            : res.classes.find((c) => c.departmentId === deptId)?.id || '';
          const validSubj = res.subjects.some((sub) => sub.id === s.subjectId && sub.departmentId === deptId)
            ? s.subjectId
            : res.subjects.find((sub) => sub.departmentId === deptId)?.id || '';
          return { ...s, departmentId: deptId, classId: validClass, subjectId: validSubj };
        });
      }
      if (res.academicYears[0]) {
        setNewStu((s) => (s.academicYearId ? s : { ...s, academicYearId: res.academicYears[0].id }));
        setNewClass((s) => (s.academicYearId ? s : { ...s, academicYearId: res.academicYears[0].id }));
      }
      if (res.semesters[0]) {
        setNewStu((s) => (s.semesterId ? s : { ...s, semesterId: res.semesters[0].id }));
        setNewClass((s) => (s.semesterId ? s : { ...s, semesterId: res.semesters[0].id }));
        setNewSubject((s) => (s.semesterId ? s : { ...s, semesterId: res.semesters[0].id }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load academics.');
    }
  }, []);

  const loadRegistrations = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        status: regStatusFilter,
        ...(regSearch.trim() ? { search: regSearch.trim() } : {}),
      });
      const res = await apiFetch<{ items: typeof registrations }>(
        `/api/admin/registrations?${p.toString()}`,
        { cache: 'no-store' }
      );
      setRegistrations(res.items);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load registrations.');
    }
  }, [regStatusFilter, regSearch]);

  const loadStudents = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        page: String(studentPage),
        limit: '25',
        ...(studentSearch.trim() ? { search: studentSearch.trim() } : {}),
        ...(studentDeptFilter ? { departmentId: studentDeptFilter } : {}),
      });
      const res = await apiFetch<{
        items: typeof students;
        pagination: typeof studentPagination;
      }>(`/api/admin/students?${p.toString()}`, { cache: 'no-store' });
      setStudents(res.items);
      setStudentPagination(res.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load students.');
    }
  }, [studentPage, studentSearch, studentDeptFilter]);

  const loadStaff = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: typeof staffList }>('/api/admin/staff', {
        cache: 'no-store',
      });
      setStaffList(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load staff.');
    }
  }, []);

  const loadSessionsAndCorrections = useCallback(async () => {
    try {
      const [sesRes, corrRes] = await Promise.all([
        apiFetch<{ items: typeof sessions }>('/api/admin/sessions', { cache: 'no-store' }),
        apiFetch<{ items: typeof correctionRequests }>('/api/admin/correction-requests', {
          cache: 'no-store',
        }),
      ]);
      setSessions(sesRes.items);
      setCorrectionRequests(corrRes.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions.');
    }
  }, []);

  const normalizedQrBase = (qrBaseUrl || getDefaultQrBaseUrl()).replace(/\/+$/, '');
  const campusRegisterUrl = `${normalizedQrBase}/?registerQr=${encodeURIComponent('SBIT-REGISTER-CAMPUS')}`;

  const loadQrCodes = useCallback(async () => {
    try {
      const attendUrl = `${normalizedQrBase}/?attendQr=${encodeURIComponent('SBIT-ATTEND-CAMPUS')}`;
      const registerUrl = `${normalizedQrBase}/?registerQr=${encodeURIComponent('SBIT-REGISTER-CAMPUS')}`;
      const [{ default: QRCode }, res] = await Promise.all([
        import('qrcode'),
        apiFetch<{ items: typeof qrList }>('/api/admin/qr-codes', { cache: 'no-store' }),
      ]);
      const [attendPng, registerPng, qrPairs] = await Promise.all([
        QRCode.toDataURL(attendUrl, { width: 260, margin: 1 }),
        QRCode.toDataURL(registerUrl, { width: 260, margin: 1 }),
        Promise.all(
          res.items.map(async (q) => {
            const targetUrl =
              q.qrPurpose === 'attendance'
                ? `${normalizedQrBase}/?attendQr=${encodeURIComponent(q.token)}`
                : `${normalizedQrBase}/?registerQr=${encodeURIComponent(q.token)}`;
            const png = await QRCode.toDataURL(targetUrl, { width: 180, margin: 1 });
            return [q.id, png] as const;
          })
        ),
      ]);
      setLifetimeQrImages({ attend: attendPng, register: registerPng });
      setQrList(res.items);
      setQrImages(Object.fromEntries(qrPairs));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load QR codes.');
    }
  }, [normalizedQrBase]);

  const loadSettingsAndAudit = useCallback(async () => {
    try {
      const [sRes, aRes] = await Promise.all([
        apiFetch<{ settings: CollegeSettings }>('/api/admin/settings', { cache: 'no-store' }),
        apiFetch<{ items: typeof auditLogs }>('/api/admin/audit-logs', { cache: 'no-store' }),
      ]);
      setSettingsForm(sRes.settings);
      setAuditLogs(aRes.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings.');
    }
  }, []);

  const refreshAllActive = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const tasks: Array<Promise<unknown>> = [loadOverview()];
      if (nav === 'approvals') tasks.push(loadRegistrations());
      else if (nav === 'students') tasks.push(loadStudents());
      else if (nav === 'staff') tasks.push(loadStaff());
      else if (nav === 'academics' || nav === 'promotion') tasks.push(loadAcademics());
      else if (nav === 'sessions') {
        tasks.push(loadSessionsAndCorrections(), loadStudents());
      } else if (nav === 'holidays') {
        tasks.push(loadSessionsAndCorrections());
      } else if (nav === 'qr') {
        tasks.push(loadQrCodes(), loadSessionsAndCorrections());
      } else if (nav === 'settings') {
        tasks.push(loadSettingsAndAudit());
      }
      await Promise.all(tasks);
      setLastUpdatedAt(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, [
    nav,
    loadOverview,
    loadRegistrations,
    loadStudents,
    loadStaff,
    loadAcademics,
    loadSessionsAndCorrections,
    loadQrCodes,
    loadSettingsAndAudit,
  ]);

  useEffect(() => {
    loadOverview();
    loadAcademics();
  }, [loadOverview, loadAcademics]);

  useEffect(() => {
    if (nav === 'approvals') loadRegistrations();
    if (nav === 'students') loadStudents();
    if (nav === 'staff') loadStaff();
    if (nav === 'sessions') {
      loadSessionsAndCorrections();
      loadStudents();
    }
    if (nav === 'holidays') {
      loadSessionsAndCorrections();
    }
    if (nav === 'qr') {
      loadQrCodes();
      loadSessionsAndCorrections();
    }
    if (nav === 'settings') loadSettingsAndAudit();
  }, [
    nav,
    loadRegistrations,
    loadStudents,
    loadStaff,
    loadSessionsAndCorrections,
    loadQrCodes,
    loadSettingsAndAudit,
  ]);

  useEffect(() => {
    return subscribeDataChange((type) => {
      if (
        type === 'REGISTRATION_SUBMITTED' ||
        type === 'ATTENDANCE_MARKED' ||
        type === 'SETTINGS_UPDATED' ||
        type === 'DATA_UPDATED'
      ) {
        void loadOverview();
        if (type === 'REGISTRATION_SUBMITTED' || nav === 'approvals') {
          void loadRegistrations();
        }
        if (nav === 'students') void loadStudents();
        if (nav === 'staff') void loadStaff();
        if (nav === 'sessions' || nav === 'holidays') void loadSessionsAndCorrections();
        if (nav === 'qr') void loadQrCodes();
        if (nav === 'settings') void loadSettingsAndAudit();
      }
    });
  }, [
    nav,
    loadOverview,
    loadRegistrations,
    loadStudents,
    loadStaff,
    loadSessionsAndCorrections,
    loadQrCodes,
    loadSettingsAndAudit,
  ]);

  async function handleCopyRegistrationLink() {
    try {
      await navigator.clipboard.writeText(campusRegisterUrl);
      setCopiedRegLink(true);
      window.setTimeout(() => setCopiedRegLink(false), 2000);
    } catch {
      // Clipboard restricted in iframe
    }
  }

  async function handleApproveRegistration(id: string) {
    setError(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ message: string; setupToken: string }>(
        `/api/admin/registrations/${id}/approve`,
        { method: 'POST' }
      );
      setMsg(res.message);
      setLatestSetupLink(`${window.location.origin}/?setupToken=${encodeURIComponent(res.setupToken)}`);
      broadcastDataChange('DATA_UPDATED');
      await Promise.all([loadRegistrations(), loadStudents(), loadOverview()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve.');
    }
  }

  async function handleConfirmRejectRegistration(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectingReg) return;
    const reason = rejectReason.trim();
    if (reason.length < 4) {
      setError('Please enter a rejection reason (at least 4 characters).');
      return;
    }
    setError(null);
    setMsg(null);
    setRejectSubmitting(true);
    try {
      await apiFetch(`/api/admin/registrations/${rejectingReg.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setMsg(`Rejected registration for ${rejectingReg.fullName}.`);
      setRejectingReg(null);
      setRejectReason('');
      broadcastDataChange('DATA_UPDATED');
      loadRegistrations();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject.');
    } finally {
      setRejectSubmitting(false);
    }
  }

  async function handleCreateStudent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    if (!newStu.departmentId || !newStu.academicYearId || !newStu.semesterId) {
      setError('Please select a valid department, academic year, and semester.');
      return;
    }
    try {
      const res = await apiFetch<{ setupToken: string }>('/api/admin/students', {
        method: 'POST',
        body: JSON.stringify(newStu),
      });
      setMsg('Student created and approved.');
      setLatestSetupLink(`${window.location.origin}/?setupToken=${encodeURIComponent(res.setupToken)}`);
      setNewStu((s) => ({ ...s, fullName: '', rollNumber: '', email: '', phone: '' }));
      loadStudents();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add student.');
    }
  }

  async function handleToggleStudentStatus(id: string, currentStatus: string) {
    const nextStatus = currentStatus === 'deactivated' ? 'approved' : 'deactivated';
    try {
      await apiFetch(`/api/admin/students/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setMsg(`Student account ${nextStatus}. Historical attendance records preserved.`);
      loadStudents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update student status.');
    }
  }

  async function handleResetBiometrics(studentId: string) {
    try {
      await apiFetch(`/api/admin/biometrics/${studentId}`, { method: 'DELETE' });
      setMsg('Biometric template cleared so student can re-enroll.');
      loadStudents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset biometrics.');
    }
  }

  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    if (!newStaff.departmentId) {
      setError('Please select a department for this staff member.');
      return;
    }
    try {
      const res = await apiFetch<{ setupToken: string }>('/api/admin/staff', {
        method: 'POST',
        body: JSON.stringify({
          fullName: newStaff.fullName,
          email: newStaff.email,
          phone: newStaff.phone || undefined,
          employeeId: newStaff.employeeId,
          assignments: [
            {
              departmentId: newStaff.departmentId,
              classId: newStaff.classId || null,
              subjectId: newStaff.subjectId || null,
              canCreateSessions: newStaff.canCreateSessions,
            },
          ],
        }),
      });
      setMsg('Staff member added with scoped department/class/subject assignments.');
      setLatestSetupLink(`${window.location.origin}/?setupToken=${encodeURIComponent(res.setupToken)}`);
      setNewStaff((s) => ({ ...s, fullName: '', email: '', phone: '', employeeId: '' }));
      loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add staff.');
    }
  }

  async function handleToggleStaffStatus(id: string, currentStatus: string) {
    const nextStatus = currentStatus === 'deactivated' ? 'approved' : 'deactivated';
    setError(null);
    try {
      await apiFetch(`/api/admin/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setMsg(`Staff/admin account ${nextStatus}.`);
      broadcastDataChange('DATA_UPDATED');
      loadStaff();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update account status.');
    }
  }

  async function handleConfirmRemoveUser() {
    if (!confirmRemoveUser) return;
    setError(null);
    setMsg(null);
    setRemovingUser(true);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/admin/users/${confirmRemoveUser.id}`,
        { method: 'DELETE' }
      );
      setMsg(res.message);
      setConfirmRemoveUser(null);
      broadcastDataChange('DATA_UPDATED');
      await Promise.all([
        loadOverview(),
        loadRegistrations(),
        loadStudents(),
        loadStaff(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user.');
    } finally {
      setRemovingUser(false);
    }
  }

  async function handleCreateClass(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newClass.departmentId || !newClass.academicYearId || !newClass.semesterId) {
      setError('Please select a department, academic year, and semester.');
      return;
    }
    try {
      await apiFetch('/api/admin/classes', { method: 'POST', body: JSON.stringify(newClass) });
      setNewClass((c) => ({ ...c, sectionName: '' }));
      setMsg('Class/section added.');
      loadAcademics();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add class.');
    }
  }

  async function handleCreateSubject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newSubject.departmentId || !newSubject.semesterId) {
      setError('Please select a department and semester for this subject.');
      return;
    }
    try {
      await apiFetch('/api/admin/subjects', { method: 'POST', body: JSON.stringify(newSubject) });
      setNewSubject((s) => ({ ...s, code: '', name: '' }));
      setMsg('Subject added.');
      loadAcademics();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add subject.');
    }
  }

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newSes.departmentId || !newSes.classId || !newSes.subjectId) {
      setError('Please select a valid department, class, and subject for this session.');
      return;
    }
    try {
      await apiFetch('/api/admin/sessions', {
        method: 'POST',
        body: JSON.stringify({ ...newSes, status: 'active' }),
      });
      setMsg('Attendance session created and activated.');
      loadSessionsAndCorrections();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session.');
    }
  }

  async function handleUpdateSessionStatus(id: string, status: string) {
    try {
      await apiFetch(`/api/admin/sessions/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      loadSessionsAndCorrections();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update session status.');
    }
  }

  async function handleDirectCorrection(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/admin/attendance/correct', {
        method: 'POST',
        body: JSON.stringify(directCorrect),
      });
      setDirectCorrect((c) => ({ ...c, reason: '' }));
      setMsg('Attendance record updated with mandatory reason logged in audit trail.');
      loadSessionsAndCorrections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to correct attendance.');
    }
  }

  async function handleReviewCorrectionRequest(id: string, decision: 'approved' | 'rejected') {
    try {
      await apiFetch(`/api/admin/correction-requests/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setMsg(`Correction request ${decision}.`);
      loadSessionsAndCorrections();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to review request.');
    }
  }

  async function handleGenerateQr(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/admin/qr-codes', {
        method: 'POST',
        body: JSON.stringify({
          qrPurpose: newQr.qrPurpose,
          label: newQr.label,
          departmentId: newQr.departmentId || null,
          academicYearId: newQr.academicYearId || null,
          semesterId: newQr.semesterId || null,
          sessionId: newQr.qrPurpose === 'attendance' ? newQr.sessionId || null : null,
          expiryHours: Number(newQr.expiryHours) || 0,
          maxUses: Number(newQr.maxUses) > 0 ? Number(newQr.maxUses) : null,
        }),
      });
      setNewQr((q) => ({ ...q, label: '', sessionId: '' }));
      setMsg(
        newQr.qrPurpose === 'attendance'
          ? 'Attendance Face Check-In QR code generated.'
          : 'Registration QR code generated.'
      );
      loadQrCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate QR code.');
    }
  }

  async function handleRevokeQr(id: string) {
    try {
      await apiFetch(`/api/admin/qr-codes/${id}/revoke`, { method: 'PATCH' });
      setMsg('QR code revoked immediately.');
      loadQrCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke QR code.');
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settingsForm) return;
    setError(null);
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          collegeName: settingsForm.collegeName,
          logoUrl: settingsForm.logoUrl || '',
          locationVerificationEnabled: settingsForm.locationVerificationEnabled,
          collegeLatitude: Number(settingsForm.collegeLatitude),
          collegeLongitude: Number(settingsForm.collegeLongitude),
          geofenceRadiusMeters: Number(settingsForm.geofenceRadiusMeters),
          attendanceFrequency: settingsForm.attendanceFrequency,
          qrDefaultExpiryHours: Number(settingsForm.qrDefaultExpiryHours),
          faceMatchThreshold: Math.min(0.33, Math.max(0.22, Number(settingsForm.faceMatchThreshold))),
          livenessRequired: settingsForm.livenessRequired,
          autoDailySessionsEnabled: settingsForm.autoDailySessionsEnabled ?? true,
          morningStartTime: settingsForm.morningStartTime || '09:00',
          morningEndTime: settingsForm.morningEndTime || '09:40',
          afternoonStartTime: settingsForm.afternoonStartTime || '13:30',
          afternoonEndTime: settingsForm.afternoonEndTime || '13:40',
          workingWeekdays: settingsForm.workingWeekdays || [1, 2, 3, 4, 5, 6],
        }),
      });
      setMsg('College governance, daily schedule, and geofence settings saved.');
      broadcastDataChange('SETTINGS_UPDATED');
      loadSettingsAndAudit();
      loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    }
  }

  const handleCaptureAndSaveCampusGps = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Location access is not supported by this browser.');
      return;
    }
    setError(null);
    setMsg(null);
    setCapturingGps(true);

    const saveCapturedPosition = async (pos: GeolocationPosition) => {
      const lat = Number(pos.coords.latitude.toFixed(6));
      const lng = Number(pos.coords.longitude.toFixed(6));
      const accuracyM = Math.round(pos.coords.accuracy || 0);
      try {
        const res = await apiFetch<{ settings: CollegeSettings }>('/api/admin/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            locationVerificationEnabled: true,
            collegeLatitude: lat,
            collegeLongitude: lng,
          }),
        });
        setSettingsForm(res.settings);
        broadcastDataChange('SETTINGS_UPDATED');
        setMsg(
          `College GPS location saved automatically (${lat}, ${lng}${accuracyM > 0 ? `, ±${accuracyM}m accuracy` : ''}). Students within ${res.settings.geofenceRadiusMeters}m are approved automatically.`
        );
        await loadOverview();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save captured GPS location.');
      } finally {
        setCapturingGps(false);
      }
    };

    const handleFinalError = (err: GeolocationPositionError) => {
      setCapturingGps(false);
      setError(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission was denied. Please allow location access in your browser to set college GPS in one click.'
          : 'Unable to read current GPS location right now. Move near a window or enable Wi-Fi location and retry.'
      );
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void saveCapturedPosition(pos);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          handleFinalError(err);
          return;
        }
        // Fallback to network/Wi-Fi location if high-accuracy GPS times out indoors
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            void saveCapturedPosition(pos);
          },
          handleFinalError,
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 15000 }
        );
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
  }, [loadOverview]);

  async function handleSetAdminPassword(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ password: adminPassword }),
      });
      setAdminPassword('');
      setMsg('Super Admin portal password saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set password.');
    }
  }

  const collegeName =
    settingsForm?.collegeName ||
    me.collegeSettings?.collegeName ||
    'Swarna Bharathi Institute of Science and Technology';

  const navItems: Array<{ id: AdminNav; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
    { id: 'students', label: 'Students', icon: Users },
    { id: 'staff', label: 'Staff & Admins', icon: UserCog },
    { id: 'academics', label: 'Departments & Subjects', icon: BookOpen },
    { id: 'promotion', label: 'Academic Promotion', icon: TrendingUp },
    { id: 'sessions', label: 'Sessions & Corrections', icon: CheckCircle2 },
    { id: 'holidays', label: 'Holiday Scheduler', icon: CalendarDays },
    { id: 'qr', label: 'Lifetime QR Codes', icon: QrCode },
    { id: 'reports', label: 'Reports & Exports', icon: FileBarChart },
    { id: 'settings', label: 'Settings & Audit', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      <aside className="w-full lg:w-64 bg-slate-900 text-white flex flex-col justify-between shrink-0">
        <div className="p-5 space-y-6">
          <div className="flex items-center gap-3">
            <img
              src={
                settingsForm?.logoUrl ||
                me.collegeSettings?.logoUrl ||
                '/src/assets/images/sbist_college_crest_1795533458624.jpg'
              }
              alt="College Logo"
              referrerPolicy="no-referrer"
              className="h-10 w-10 rounded-lg object-contain bg-white p-0.5 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-xs font-bold leading-snug line-clamp-2">{collegeName}</div>
              <div className="text-[11px] text-blue-300">Super Admin Portal</div>
            </div>
          </div>

          <nav className="flex lg:flex-col gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const pendingBadge =
                item.id === 'approvals' ? (dash?.metrics.pendingRegistrations ?? 0) : 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setNav(item.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                    nav === item.id
                      ? 'bg-white text-slate-900'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {pendingBadge > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-400 text-slate-950 font-mono-tabular shrink-0">
                      {pendingBadge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-800 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium truncate">{me.profile.fullName}</div>
            <div className="text-[11px] text-slate-400 truncate">{me.profile.email}</div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="p-2 text-slate-300 hover:text-white rounded-lg hover:bg-slate-800"
            title="Sign Out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 sm:p-8 space-y-6 overflow-x-hidden">
        <RefreshBar
          label="Super Admin Live Sync"
          lastUpdatedAt={lastUpdatedAt}
          isRefreshing={isRefreshing}
          onRefresh={refreshAllActive}
          defaultAutoRefreshSeconds={15}
        />
        {msg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 flex items-center justify-between gap-2">
            <span>{msg}</span>
            <button type="button" onClick={() => setMsg(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}
        {latestSetupLink && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 space-y-1">
            <div className="font-semibold">
              One-Time Account Activation Link (share securely with the approved user if not using Google Sign-In):
            </div>
            <div className="font-mono-tabular break-all bg-white border border-blue-200 rounded p-2">
              {latestSetupLink}
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
            {error}
          </div>
        )}
        {confirmRemoveUser && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <div className="bg-white border border-red-200 rounded-xl max-w-md w-full p-5 shadow-xl space-y-4 text-xs">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                  <Trash2 className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-slate-900">
                    Permanently Remove {confirmRemoveUser.roleLabel}?
                  </h3>
                  <p className="text-slate-600 leading-relaxed">
                    You are about to permanently remove{' '}
                    <span className="font-semibold text-slate-900">{confirmRemoveUser.fullName}</span>{' '}
                    (<span className="font-mono-tabular">{confirmRemoveUser.detail}</span>). This deletes their profile, enrollment, biometrics, and portal access immediately.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={removingUser}
                  onClick={() => setConfirmRemoveUser(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={removingUser}
                  onClick={handleConfirmRemoveUser}
                  className="px-3.5 py-2 rounded-lg bg-red-700 text-white font-semibold hover:bg-red-800 disabled:opacity-50"
                >
                  {removingUser ? 'Removing...' : 'Permanently Remove'}
                </button>
              </div>
            </div>
          </div>
        )}

        {nav === 'overview' && dash && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold text-slate-900">College-Wide Governance Overview</h1>
              <p className="text-xs text-slate-500">
                {collegeName} · Reporting Date (IST): {dash.todayIST}
              </p>
            </div>

            {dash.todayDayEval?.isHoliday && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3.5 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-bold">
                    Today is a holiday: {dash.todayDayEval.holidayTitle}.
                  </span>{' '}
                  All daily attendance sessions are automatically cancelled and excluded from denominators.
                  {dash.todayDayEval.holidayReason ? ` Reason: ${dash.todayDayEval.holidayReason}` : ''}
                </div>
                <button
                  type="button"
                  onClick={() => setNav('holidays')}
                  className="font-semibold underline text-amber-900"
                >
                  Manage Holidays
                </button>
              </div>
            )}

            {dash.dailySchedule && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[dash.dailySchedule.morning, dash.dailySchedule.afternoon].map((slot) => (
                  <div
                    key={slot.slot}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="font-bold text-slate-900 text-sm">
                        Automatic {slot.label}
                      </div>
                      <div className="font-mono-tabular text-slate-500">
                        {slot.startTime12h} – {slot.endTime12h} IST
                      </div>
                      <div className="text-slate-600">
                        Active/Scheduled classes: {slot.totalSessions} · Present marked: {slot.presentCount}
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded text-[11px] font-bold uppercase ${
                        slot.status === 'active'
                          ? 'bg-blue-100 text-blue-800'
                          : slot.status === 'scheduled'
                            ? 'bg-slate-100 text-slate-800'
                            : slot.status === 'cancelled'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {slot.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              {[
                { label: 'Total Students', val: dash.metrics.totalStudents },
                { label: 'Total Staff', val: dash.metrics.totalStaff },
                { label: 'Pending Approvals', val: dash.metrics.pendingRegistrations },
                { label: 'Active Sessions', val: dash.metrics.activeSessions },
                { label: 'Present Today', val: dash.metrics.presentToday },
                { label: 'Absent Today', val: dash.metrics.absentToday },
                {
                  label: 'Overall Rate',
                  val:
                    dash.metrics.overallHasData === false
                      ? dash.metrics.overallMessage || 'No attendance data available'
                      : `${dash.metrics.overallPercentage}%`,
                  small: dash.metrics.overallHasData === false,
                },
              ].map((k) => (
                <div key={k.label} className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-[11px] text-slate-500">{k.label}</div>
                  <div
                    className={`${
                      k.small
                        ? 'text-xs font-semibold text-slate-600 mt-2'
                        : 'text-xl font-bold text-slate-900 mt-1 tabular-nums'
                    }`}
                  >
                    {k.val}
                  </div>
                </div>
              ))}
            </div>

            {(() => {
              const activeSettings = settingsForm || me.collegeSettings;
              return (
                <div className="bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-start gap-3">
                    <div className="h-9 w-9 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center shrink-0">
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div className="space-y-0.5">
                      <div className="font-bold text-slate-900 text-sm">
                        College Campus GPS Geofence
                      </div>
                      <div className="text-slate-600">
                        Saved Location:{' '}
                        <span className="font-mono-tabular font-semibold text-slate-900">
                          {activeSettings
                            ? `${activeSettings.collegeLatitude.toFixed(6)}, ${activeSettings.collegeLongitude.toFixed(6)}`
                            : 'Not set'}
                        </span>
                        {activeSettings ? ` · Range: ${activeSettings.geofenceRadiusMeters}m` : ''}
                      </div>
                      <div className="text-slate-500">
                        Students registering within campus range activate immediately without approval.
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCaptureAndSaveCampusGps}
                      disabled={capturingGps}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 text-white font-semibold hover:bg-blue-800 disabled:opacity-60"
                    >
                      {capturingGps ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MapPin className="h-3.5 w-3.5" />
                      )}
                      {capturingGps ? 'Tracking & Saving GPS...' : 'Set College GPS (1-Click)'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNav('settings')}
                      className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50"
                    >
                      Geofence Settings
                    </button>
                  </div>
                </div>
              );
            })()}

            {dash.upcomingHolidays && dash.upcomingHolidays.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-bold text-slate-900">Upcoming / Active Holidays:</span>{' '}
                  {dash.upcomingHolidays
                    .slice(0, 3)
                    .map(
                      (h) =>
                        `${h.title} (${h.startDate === h.endDate ? h.startDate : `${h.startDate}..${h.endDate}`})`
                    )
                    .join(' · ')}
                </div>
                <button
                  type="button"
                  onClick={() => setNav('holidays')}
                  className="text-blue-700 font-medium hover:underline"
                >
                  Open Holiday Scheduler
                </button>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h2 className="text-sm font-bold text-slate-900">
                  Department-Wise Attendance Breakdown (Accurate Completed Sessions · IST)
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold text-right">Enrolled</th>
                      <th className="px-4 py-3 font-semibold text-right">Present Today</th>
                      <th className="px-4 py-3 font-semibold text-right">Absent Today</th>
                      <th className="px-4 py-3 font-semibold text-right">Attendance %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dash.departmentBreakdown.map((d) => (
                      <tr key={d.departmentId}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{d.name}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{d.enrolledStudents}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700 font-semibold">
                          {d.presentToday}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-red-700">
                          {d.absentToday}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-bold">
                          {d.hasData === false ? (
                            <span className="font-normal text-slate-500">
                              {d.message || 'No attendance data available'}
                            </span>
                          ) : (
                            `${d.percentage}%`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h2 className="text-sm font-bold text-slate-900">Recent Audit Activity</h2>
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {dash.recentAudit.map((a) => (
                  <div key={a.id} className="px-5 py-2.5 flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono-tabular font-semibold text-slate-900">{a.action}</span>
                      {' · '}
                      <span className="text-slate-600">{a.actorEmail || 'system'}</span>
                    </div>
                    <span className="font-mono-tabular text-slate-500">{a.createdAtIST}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {nav === 'approvals' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-bold text-slate-900">
                  Off-Campus Student Registration Approvals
                </h1>
                <p className="text-xs text-slate-500">
                  Only students who register outside SBIT campus range appear here for approval. Students registering inside campus range activate automatically and appear directly in Students.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={regSearch}
                    onChange={(e) => setRegSearch(e.target.value)}
                    placeholder="Search roll no, name, email..."
                    className="rounded-lg border border-slate-300 bg-white pl-8 pr-3 py-1.5 text-xs w-56 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="flex gap-1 bg-slate-200/70 p-1 rounded-lg text-xs">
                  {['pending', 'approved', 'rejected', 'all'].map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setRegStatusFilter(st)}
                      className={`px-3 py-1.5 rounded-md font-medium capitalize ${
                        regStatusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      {st === 'pending' && dash?.metrics.pendingRegistrations
                        ? `pending (${dash.metrics.pendingRegistrations})`
                        : st}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
              <div className="space-y-1 min-w-0">
                <div className="font-bold text-blue-950">
                  Public Student Registration Link (Lifetime Campus QR: SBIT-REGISTER-CAMPUS)
                </div>
                <div className="font-mono-tabular text-blue-900 break-all bg-white border border-blue-200 rounded-lg px-2.5 py-1.5">
                  {campusRegisterUrl}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCopyRegistrationLink}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-blue-300 text-blue-900 font-semibold rounded-lg hover:bg-blue-100 whitespace-nowrap"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedRegLink ? 'Copied!' : 'Copy Link'}
                </button>
                <a
                  href={campusRegisterUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-700 text-white font-semibold rounded-lg hover:bg-blue-800 whitespace-nowrap"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Registration Link
                </a>
              </div>
            </div>

            {rejectingReg && (
              <form
                onSubmit={handleConfirmRejectRegistration}
                className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-red-900">
                    Reject Registration: {rejectingReg.fullName}
                    {rejectingReg.rollNumber ? ` (${rejectingReg.rollNumber})` : ''}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRejectingReg(null);
                      setRejectReason('');
                    }}
                    className="text-red-700 hover:underline"
                  >
                    Cancel
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    required
                    minLength={4}
                    autoFocus
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Enter mandatory reason for rejecting (min 4 characters, e.g. Duplicate roll number or not enrolled)"
                    className="flex-1 rounded-lg border border-red-300 bg-white px-3 py-2 text-slate-900"
                  />
                  <button
                    type="submit"
                    disabled={rejectSubmitting}
                    className="px-4 py-2 bg-red-700 text-white font-semibold rounded-lg hover:bg-red-800 disabled:opacity-50 shrink-0"
                  >
                    {rejectSubmitting ? 'Rejecting...' : 'Confirm Reject'}
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Roll No</th>
                      <th className="px-4 py-3 font-semibold">Student</th>
                      <th className="px-4 py-3 font-semibold">Department & Sem</th>
                      <th className="px-4 py-3 font-semibold">Submitted (IST)</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {registrations.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                          No registrations found for this filter.
                        </td>
                      </tr>
                    ) : (
                      registrations.map((r) => (
                        <tr key={r.id}>
                          <td className="px-4 py-2.5 font-mono-tabular font-semibold">{r.rollNumber}</td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-slate-900">{r.fullName}</div>
                            <div className="text-slate-500">
                              {r.email} · {r.phone}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            {r.departmentCode} · {r.yearLabel} · {r.semesterLabel}
                          </td>
                          <td className="px-4 py-2.5 font-mono-tabular text-slate-500">
                            {r.createdAtIST}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="uppercase font-semibold">{r.status}</div>
                            {r.status === 'rejected' && r.rejectionReason && (
                              <div className="text-[11px] text-red-700 mt-0.5">{r.rejectionReason}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                            {r.status !== 'approved' && (
                              <button
                                type="button"
                                onClick={() => handleApproveRegistration(r.id)}
                                className="px-2.5 py-1 bg-emerald-700 text-white rounded hover:bg-emerald-800"
                              >
                                Approve
                              </button>
                            )}
                            {r.status === 'pending' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setError(null);
                                  setRejectingReg({
                                    id: r.id,
                                    fullName: r.fullName,
                                    rollNumber: r.rollNumber,
                                  });
                                  setRejectReason('');
                                }}
                                className="px-2.5 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50"
                              >
                                Reject
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmRemoveUser({
                                  id: r.id,
                                  fullName: r.fullName,
                                  detail: r.rollNumber || r.email,
                                  roleLabel: 'Student',
                                })
                              }
                              className="px-2.5 py-1 bg-red-700 text-white rounded hover:bg-red-800"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {nav === 'students' && (
          <div className="space-y-6">
            <form
              onSubmit={handleCreateStudent}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <h2 className="text-sm font-bold text-slate-900">Add Approved Student Directly</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <input
                  type="text"
                  required
                  placeholder="Full Name"
                  value={newStu.fullName}
                  onChange={(e) => setNewStu({ ...newStu, fullName: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  required
                  placeholder="Roll Number (e.g. 24SB1A0502)"
                  value={newStu.rollNumber}
                  onChange={(e) => setNewStu({ ...newStu, rollNumber: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                />
                <input
                  type="email"
                  required
                  placeholder="Student Gmail"
                  value={newStu.email}
                  onChange={(e) => setNewStu({ ...newStu, email: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="tel"
                  required
                  placeholder="Phone Number"
                  value={newStu.phone}
                  onChange={(e) => setNewStu({ ...newStu, phone: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <select
                  required
                  value={newStu.departmentId}
                  onChange={(e) => setNewStu({ ...newStu, departmentId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.departments.length === 0 && (
                    <option value="" disabled>
                      Loading departments...
                    </option>
                  )}
                  {academics.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
                <select
                  required
                  value={newStu.academicYearId}
                  onChange={(e) => setNewStu({ ...newStu, academicYearId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.academicYears.length === 0 && (
                    <option value="" disabled>
                      Loading years...
                    </option>
                  )}
                  {academics.academicYears.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.label}
                    </option>
                  ))}
                </select>
                <select
                  required
                  value={newStu.semesterId}
                  onChange={(e) => setNewStu({ ...newStu, semesterId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.semesters.length === 0 && (
                    <option value="" disabled>
                      Loading semesters...
                    </option>
                  )}
                  {academics.semesters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Add & Approve Student
                </button>
              </div>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-bold text-slate-900">
                Student Directory ({studentPagination.total} total)
              </h2>
              <div className="flex gap-2">
                <select
                  value={studentDeptFilter}
                  onChange={(e) => {
                    setStudentDeptFilter(e.target.value);
                    setStudentPage(1);
                  }}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                >
                  <option value="">All Departments</option>
                  {academics.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={studentSearch}
                  onChange={(e) => {
                    setStudentSearch(e.target.value);
                    setStudentPage(1);
                  }}
                  placeholder="Search roll no, name, email..."
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs w-64"
                />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Roll No</th>
                      <th className="px-4 py-3 font-semibold">Name & Email</th>
                      <th className="px-4 py-3 font-semibold">Class</th>
                      <th className="px-4 py-3 font-semibold">Biometric</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {students.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5 font-mono-tabular font-semibold">{s.rollNumber}</td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{s.fullName}</div>
                          <div className="text-slate-500">{s.email}</div>
                        </td>
                        <td className="px-4 py-2.5">{s.className}</td>
                        <td className="px-4 py-2.5">
                          {s.biometricEnrolled ? (
                            <span className="text-emerald-700 font-medium">Enrolled</span>
                          ) : (
                            <span className="text-slate-400">Not Enrolled</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 uppercase font-semibold">{s.status}</td>
                        <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                          {s.biometricEnrolled && (
                            <button
                              type="button"
                              onClick={() => handleResetBiometrics(s.id)}
                              className="text-blue-700 hover:underline"
                            >
                              Reset Face
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleToggleStudentStatus(s.id, s.status)}
                            className="text-slate-700 hover:underline"
                          >
                            {s.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmRemoveUser({
                                id: s.id,
                                fullName: s.fullName,
                                detail: s.rollNumber || s.email,
                                roleLabel: 'Student',
                              })
                            }
                            className="text-red-700 font-semibold hover:underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
                <span>
                  Page {studentPagination.page} of {studentPagination.totalPages}
                </span>
                <div className="space-x-2">
                  <button
                    type="button"
                    disabled={studentPage <= 1}
                    onClick={() => setStudentPage((p) => p - 1)}
                    className="px-3 py-1 border border-slate-300 rounded disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={studentPage >= studentPagination.totalPages}
                    onClick={() => setStudentPage((p) => p + 1)}
                    className="px-3 py-1 border border-slate-300 rounded disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {nav === 'staff' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleCreateStaff}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs"
              >
                <h2 className="text-sm font-bold text-slate-900">Add Staff & Assign Scope</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Faculty Full Name"
                    value={newStaff.fullName}
                    onChange={(e) => setNewStaff({ ...newStaff, fullName: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Employee ID (e.g. FAC-101)"
                    value={newStaff.employeeId}
                    onChange={(e) => setNewStaff({ ...newStaff, employeeId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                  />
                  <input
                    type="email"
                    required
                    placeholder="Staff Gmail"
                    value={newStaff.email}
                    onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                  <input
                    type="tel"
                    placeholder="Phone Number"
                    value={newStaff.phone}
                    onChange={(e) => setNewStaff({ ...newStaff, phone: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                  <select
                    required
                    value={newStaff.departmentId}
                    onChange={(e) =>
                      setNewStaff({
                        ...newStaff,
                        departmentId: e.target.value,
                        classId: '',
                        subjectId: '',
                      })
                    }
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.departments.length === 0 && (
                      <option value="" disabled>
                        Loading departments...
                      </option>
                    )}
                    {academics.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        Dept: {d.code}
                      </option>
                    ))}
                  </select>
                  <select
                    value={newStaff.classId}
                    onChange={(e) => setNewStaff({ ...newStaff, classId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    <option value="">All Classes in Dept</option>
                    {academics.classes
                      .filter((c) => !newStaff.departmentId || c.departmentId === newStaff.departmentId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName}
                        </option>
                      ))}
                  </select>
                  <select
                    value={newStaff.subjectId}
                    onChange={(e) => setNewStaff({ ...newStaff, subjectId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white sm:col-span-2"
                  >
                    <option value="">All Subjects in Dept</option>
                    {academics.subjects
                      .filter((s) => !newStaff.departmentId || s.departmentId === newStaff.departmentId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </option>
                      ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-slate-700">
                  <input
                    type="checkbox"
                    checked={newStaff.canCreateSessions}
                    onChange={(e) =>
                      setNewStaff({ ...newStaff, canCreateSessions: e.target.checked })
                    }
                  />
                  Authorize staff member to create and activate attendance sessions
                </label>
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Add Staff Account
                </button>
              </form>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-blue-700" />
                  <h2 className="text-sm font-bold text-slate-900">Permanent Super Admin Governance</h2>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  <span className="font-mono-tabular font-semibold text-slate-900">
                    mdnaseerali539@gmail.com
                  </span>{' '}
                  is configured as the sole permanent Super Admin for SBIT. Admin rights are locked
                  exclusively to this account, additional admin creation is disabled, and all new
                  users signing up receive a standard student/user role by default.
                </p>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Staff & Administrator Directory</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Name & Email</th>
                      <th className="px-4 py-3 font-semibold">Role</th>
                      <th className="px-4 py-3 font-semibold">Assigned Scope</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {staffList.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{s.fullName}</div>
                          <div className="text-slate-500">
                            {s.email} {s.employeeId ? `· ${s.employeeId}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 uppercase font-semibold">{s.roleName}</td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {s.roleName === 'super_admin'
                            ? 'College-Wide All Departments'
                            : s.assignments
                                .map(
                                  (a) =>
                                    `${a.departmentCode}${a.className ? ` / ${a.className}` : ''}${
                                      a.subjectCode ? ` / ${a.subjectCode}` : ''
                                    }`
                                )
                                .join('; ') || 'Unassigned'}
                        </td>
                        <td className="px-4 py-2.5 uppercase font-semibold">{s.status}</td>
                        <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                          {s.id === me.profile.id ? (
                            <span className="text-slate-400 font-medium">Current Session</span>
                          ) : s.email.toLowerCase() === 'mdnaseerali539@gmail.com' ||
                            s.roleName === 'super_admin' ? (
                            <span className="text-slate-500 font-medium">Permanent Admin</span>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => handleToggleStaffStatus(s.id, s.status)}
                                className="text-slate-700 hover:underline"
                              >
                                {s.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmRemoveUser({
                                    id: s.id,
                                    fullName: s.fullName,
                                    detail: s.employeeId || s.email,
                                    roleLabel: 'Staff Member',
                                  })
                                }
                                className="text-red-700 font-semibold hover:underline"
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {nav === 'academics' && (
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900">
                Official Academic Departments & Four Academic Years (8 Semesters)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="border border-slate-200 rounded-lg p-3 space-y-1.5">
                  <div className="font-semibold text-slate-800">Departments</div>
                  {academics.departments.map((d) => (
                    <div key={d.id} className="flex justify-between py-1 border-b border-slate-100 last:border-0">
                      <span className="font-semibold">{d.code}</span>
                      <span className="text-slate-500 truncate ml-2">{d.name}</span>
                    </div>
                  ))}
                </div>
                <div className="border border-slate-200 rounded-lg p-3 space-y-1.5">
                  <div className="font-semibold text-slate-800">Academic Years & Semesters</div>
                  {academics.academicYears.map((y) => (
                    <div key={y.id} className="flex justify-between py-1 border-b border-slate-100 last:border-0">
                      <span className="font-semibold">{y.label}</span>
                      <span className="font-mono-tabular text-slate-500">
                        Session {y.academicSession}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleCreateClass}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs"
              >
                <h3 className="text-sm font-bold text-slate-900">Add Class / Section</h3>
                <div className="grid grid-cols-2 gap-3">
                  <select
                    required
                    value={newClass.departmentId}
                    onChange={(e) => setNewClass({ ...newClass, departmentId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.departments.length === 0 && (
                      <option value="" disabled>
                        Loading departments...
                      </option>
                    )}
                    {academics.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code}
                      </option>
                    ))}
                  </select>
                  <select
                    required
                    value={newClass.academicYearId}
                    onChange={(e) => setNewClass({ ...newClass, academicYearId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.academicYears.length === 0 && (
                      <option value="" disabled>
                        Loading years...
                      </option>
                    )}
                    {academics.academicYears.map((y) => (
                      <option key={y.id} value={y.id}>
                        {y.label}
                      </option>
                    ))}
                  </select>
                  <select
                    required
                    value={newClass.semesterId}
                    onChange={(e) => setNewClass({ ...newClass, semesterId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.semesters.length === 0 && (
                      <option value="" disabled>
                        Loading semesters...
                      </option>
                    )}
                    {academics.semesters.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    required
                    placeholder="Section (e.g. Batch-1)"
                    value={newClass.sectionName}
                    onChange={(e) => setNewClass({ ...newClass, sectionName: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Create Class Section
                </button>
              </form>

              <form
                onSubmit={handleCreateSubject}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs"
              >
                <h3 className="text-sm font-bold text-slate-900">Add Subject</h3>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Subject Code (e.g. CS602)"
                    value={newSubject.code}
                    onChange={(e) => setNewSubject({ ...newSubject, code: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular uppercase"
                  />
                  <input
                    type="text"
                    required
                    placeholder="Subject Name"
                    value={newSubject.name}
                    onChange={(e) => setNewSubject({ ...newSubject, name: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2"
                  />
                  <select
                    required
                    value={newSubject.departmentId}
                    onChange={(e) => setNewSubject({ ...newSubject, departmentId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.departments.length === 0 && (
                      <option value="" disabled>
                        Loading departments...
                      </option>
                    )}
                    {academics.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code}
                      </option>
                    ))}
                  </select>
                  <select
                    required
                    value={newSubject.semesterId}
                    onChange={(e) => setNewSubject({ ...newSubject, semesterId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                  >
                    {academics.semesters.length === 0 && (
                      <option value="" disabled>
                        Loading semesters...
                      </option>
                    )}
                    {academics.semesters.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Add Subject
                </button>
              </form>
            </div>
          </div>
        )}

        {nav === 'sessions' && (
          <div className="space-y-6">
            <form
              onSubmit={handleCreateSession}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900">Create Attendance Session</h2>
                <button
                  type="button"
                  onClick={() => setNav('holidays')}
                  className="text-xs font-medium text-slate-700 border border-slate-300 rounded-lg px-3 py-1.5 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  Open Holiday Scheduler
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <select
                  required
                  value={newSes.departmentId}
                  onChange={(e) => {
                    const deptId = e.target.value;
                    const firstClass = academics.classes.find((c) => c.departmentId === deptId);
                    const firstSubj = academics.subjects.find((s) => s.departmentId === deptId);
                    setNewSes({
                      ...newSes,
                      departmentId: deptId,
                      classId: firstClass?.id || '',
                      subjectId: firstSubj?.id || '',
                    });
                  }}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.departments.length === 0 && (
                    <option value="" disabled>
                      Loading departments...
                    </option>
                  )}
                  {academics.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
                <select
                  required
                  value={newSes.classId}
                  onChange={(e) => setNewSes({ ...newSes, classId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.classes.filter((c) => !newSes.departmentId || c.departmentId === newSes.departmentId).length === 0 && (
                    <option value="" disabled>
                      No classes in department
                    </option>
                  )}
                  {academics.classes
                    .filter((c) => !newSes.departmentId || c.departmentId === newSes.departmentId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                      </option>
                    ))}
                </select>
                <select
                  required
                  value={newSes.subjectId}
                  onChange={(e) => setNewSes({ ...newSes, subjectId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  {academics.subjects.filter((s) => !newSes.departmentId || s.departmentId === newSes.departmentId).length === 0 && (
                    <option value="" disabled>
                      No subjects in department
                    </option>
                  )}
                  {academics.subjects
                    .filter((s) => !newSes.departmentId || s.departmentId === newSes.departmentId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} · {s.name}
                      </option>
                    ))}
                </select>
                <input
                  type="date"
                  value={newSes.sessionDate}
                  onChange={(e) => setNewSes({ ...newSes, sessionDate: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2"
                />
                <input
                  type="time"
                  value={newSes.startTime}
                  onChange={(e) => setNewSes({ ...newSes, startTime: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2"
                />
                <input
                  type="time"
                  value={newSes.endTime}
                  onChange={(e) => setNewSes({ ...newSes, endTime: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Create & Activate Session
              </button>
            </form>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">All Attendance Sessions</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Session Code</th>
                      <th className="px-4 py-3 font-semibold">Class & Subject</th>
                      <th className="px-4 py-3 font-semibold">Date & Window (IST)</th>
                      <th className="px-4 py-3 font-semibold">Present</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Lifecycle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5 font-mono-tabular font-semibold">{s.sessionCode}</td>
                        <td className="px-4 py-2.5">
                          {s.className} · {s.subjectCode}
                        </td>
                        <td className="px-4 py-2.5 font-mono-tabular">
                          {s.sessionDate} · {s.startTime}–{s.endTime}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums font-semibold">{s.presentCount}</td>
                        <td className="px-4 py-2.5 uppercase font-semibold">{s.status}</td>
                        <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                          {s.status !== 'active' && s.status !== 'cancelled' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateSessionStatus(s.id, 'active')}
                              className="text-emerald-700 font-medium hover:underline"
                            >
                              Activate
                            </button>
                          )}
                          {s.status === 'active' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateSessionStatus(s.id, 'closed')}
                              className="text-blue-700 font-medium hover:underline"
                            >
                              Close
                            </button>
                          )}
                          {s.status !== 'cancelled' && s.status !== 'closed' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateSessionStatus(s.id, 'cancelled')}
                              className="text-red-700 font-medium hover:underline"
                            >
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form
                onSubmit={handleDirectCorrection}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs"
              >
                <h3 className="text-sm font-bold text-slate-900">
                  Correct Attendance (Mandatory Reason)
                </h3>
                <select
                  required
                  value={directCorrect.studentId}
                  onChange={(e) => setDirectCorrect({ ...directCorrect, studentId: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="">Select Student</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.rollNumber} · {s.fullName}
                    </option>
                  ))}
                </select>
                <select
                  required
                  value={directCorrect.sessionId}
                  onChange={(e) => setDirectCorrect({ ...directCorrect, sessionId: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="">Select Session</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.sessionCode} · {s.subjectCode} ({s.sessionDate})
                    </option>
                  ))}
                </select>
                <select
                  value={directCorrect.status}
                  onChange={(e) =>
                    setDirectCorrect({
                      ...directCorrect,
                      status: e.target.value as typeof directCorrect.status,
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="present">Present</option>
                  <option value="excused">Excused</option>
                  <option value="absent">Absent</option>
                </select>
                <textarea
                  required
                  minLength={8}
                  rows={2}
                  value={directCorrect.reason}
                  onChange={(e) => setDirectCorrect({ ...directCorrect, reason: e.target.value })}
                  placeholder="Mandatory correction reason for audit log..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Apply Audited Correction
                </button>
              </form>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200">
                  <h3 className="text-sm font-bold text-slate-900">
                    Pending Correction & Override Requests
                  </h3>
                </div>
                <div className="divide-y divide-slate-100 text-xs max-h-96 overflow-y-auto">
                  {correctionRequests.length === 0 ? (
                    <div className="p-5 text-center text-slate-500">No requests submitted.</div>
                  ) : (
                    correctionRequests.map((c) => (
                      <div key={c.id} className="p-4 space-y-2">
                        <div className="flex justify-between gap-2">
                          <span className="font-semibold text-slate-900">
                            {c.rollNumber} · {c.studentName}
                          </span>
                          <span className="uppercase font-semibold text-slate-600">{c.status}</span>
                        </div>
                        <div className="text-slate-600">
                          {c.sessionCode} ({c.subjectName}) · Type: {c.requestType} →{' '}
                          {c.requestedStatus.toUpperCase()}
                        </div>
                        <div className="text-slate-500">{c.reason}</div>
                        {c.status === 'pending' && (
                          <div className="flex gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => handleReviewCorrectionRequest(c.id, 'approved')}
                              className="px-3 py-1 bg-emerald-700 text-white rounded hover:bg-emerald-800"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReviewCorrectionRequest(c.id, 'rejected')}
                              className="px-3 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {nav === 'holidays' && (
          <HolidayScheduler
            sessions={sessions}
            onNotify={(message) => {
              setError(null);
              setMsg(message);
            }}
            onError={(errMessage) => {
              setMsg(null);
              setError(errMessage);
            }}
            onChanged={() => {
              loadSessionsAndCorrections();
              loadOverview();
            }}
          />
        )}

        {nav === 'qr' && (
          <div className="space-y-6">
            {/* Two Permanent Lifetime Campus QR Codes */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Two Lifetime Campus QR Codes (Print or Save Once — Valid Forever)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  You only ever need these two permanent QR codes: one for everyday student attendance check-in across all sessions, and one for new student registration from anywhere. Both have no expiry and unlimited uses.
                </p>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs space-y-2">
                <div className="font-semibold text-amber-950">
                  QR Destination URL (Live Current Origin)
                </div>
                {isPrivateDevOrigin() ? (
                  <p className="text-amber-900 leading-relaxed">
                    Currently using your active preview URL (<span className="font-mono-tabular">ais-dev-</span>), which works immediately on your signed-in owner account. Because <span className="font-mono-tabular">ais-dev-</span> is private to your editor session (and <span className="font-mono-tabular">ais-pre-</span> returns 404 until shared/published), click <strong>Deploy</strong> in AI Studio to publish a permanent public Cloud Run URL, then open your deployed URL (or paste it below) before downloading the two Lifetime QR PNGs for students.
                  </p>
                ) : (
                  <p className="text-amber-900 leading-relaxed">
                    QR codes point to this live app URL. Make sure this URL is publicly deployed before printing the two Lifetime QR PNGs for campus display.
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                  <input
                    type="url"
                    value={qrBaseUrl}
                    onChange={(e) => setQrBaseUrl(e.target.value)}
                    placeholder="https://your-deployed-cloud-run-url"
                    className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-mono-tabular text-xs text-slate-900"
                  />
                  <button
                    type="button"
                    onClick={loadQrCodes}
                    className="px-3 py-1.5 bg-amber-900 text-white font-medium rounded-lg hover:bg-amber-950 shrink-0"
                  >
                    Refresh QR Links
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Lifetime QR 1: Everyday Attendance */}
                <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/40 p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
                  <div className="space-y-2 min-w-0">
                    <span className="inline-block px-2 py-0.5 rounded bg-emerald-700 text-white font-bold uppercase text-[10px]">
                      QR 1 · Lifetime Attendance Check-In
                    </span>
                    <div className="text-sm font-bold text-slate-900">
                      Every-Day Attendance &amp; Roll-Number Portal
                    </div>
                    <p className="text-slate-600 leading-relaxed">
                      Students scan once, enter only their <strong>Hall Ticket / Roll Number</strong>, authenticate their face, and attendance is marked directly for their active session with the Student Dashboard opened.
                    </p>
                    <div className="font-mono-tabular text-slate-700 bg-white border border-emerald-200 rounded px-2.5 py-1.5 break-all">
                      Token: SBIT-ATTEND-CAMPUS · Expiry: Lifetime · Uses: Unlimited
                    </div>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <a
                        href={`${normalizedQrBase}/?attendQr=SBIT-ATTEND-CAMPUS`}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 bg-emerald-700 text-white font-medium rounded-lg hover:bg-emerald-800"
                      >
                        Open Attendance Portal
                      </a>
                      {lifetimeQrImages.attend && (
                        <a
                          href={lifetimeQrImages.attend}
                          download="SBIT-Lifetime-Attendance-QR.png"
                          className="px-3 py-1.5 border border-emerald-300 bg-white text-emerald-900 font-medium rounded-lg hover:bg-emerald-50"
                        >
                          Download QR PNG
                        </a>
                      )}
                    </div>
                  </div>
                  {lifetimeQrImages.attend && (
                    <img
                      src={lifetimeQrImages.attend}
                      alt="Lifetime Campus Attendance QR Code"
                      className="h-40 w-40 border border-emerald-200 rounded-lg p-1.5 bg-white shrink-0"
                    />
                  )}
                </div>

                {/* Lifetime QR 2: Student Registration */}
                <div className="rounded-xl border-2 border-blue-200 bg-blue-50/40 p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
                  <div className="space-y-2 min-w-0">
                    <span className="inline-block px-2 py-0.5 rounded bg-blue-700 text-white font-bold uppercase text-[10px]">
                      QR 2 · Lifetime Student Registration
                    </span>
                    <div className="text-sm font-bold text-slate-900">
                      New Student Registration (Works Anywhere)
                    </div>
                    <p className="text-slate-600 leading-relaxed">
                      New students scan this, fill in their Roll Number, Department, Year, Semester, Gmail &amp; Phone. Students inside SBIT campus range activate automatically without approval; off-campus registrations go to Approvals.
                    </p>
                    <div className="font-mono-tabular text-slate-700 bg-white border border-blue-200 rounded px-2.5 py-1.5 break-all">
                      Token: SBIT-REGISTER-CAMPUS · Expiry: Lifetime · Uses: Unlimited
                    </div>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <a
                        href={`${normalizedQrBase}/?registerQr=SBIT-REGISTER-CAMPUS`}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 bg-blue-700 text-white font-medium rounded-lg hover:bg-blue-800"
                      >
                        Open Registration Portal
                      </a>
                      {lifetimeQrImages.register && (
                        <a
                          href={lifetimeQrImages.register}
                          download="SBIT-Lifetime-Registration-QR.png"
                          className="px-3 py-1.5 border border-blue-300 bg-white text-blue-900 font-medium rounded-lg hover:bg-blue-50"
                        >
                          Download QR PNG
                        </a>
                      )}
                    </div>
                  </div>
                  {lifetimeQrImages.register && (
                    <img
                      src={lifetimeQrImages.register}
                      alt="Lifetime Campus Student Registration QR Code"
                      className="h-40 w-40 border border-blue-200 rounded-lg p-1.5 bg-white shrink-0"
                    />
                  )}
                </div>
              </div>
            </div>

            <form
              onSubmit={handleGenerateQr}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 text-xs"
            >
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Optional: Create Additional Department or Session-Specific QR Code
                </h2>
                <p className="text-slate-500 mt-0.5">
                  Only needed if you want a separate QR locked to one department or active session. Leave Expiry = 0 and Max Uses = 0 for lifetime validity.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <select
                  value={newQr.qrPurpose}
                  onChange={(e) =>
                    setNewQr({
                      ...newQr,
                      qrPurpose: e.target.value as 'attendance' | 'registration',
                      sessionId: '',
                    })
                  }
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white font-medium"
                >
                  <option value="attendance">Attendance Face Check-In QR</option>
                  <option value="registration">Student Registration QR</option>
                </select>
                <input
                  type="text"
                  required
                  placeholder={
                    newQr.qrPurpose === 'attendance'
                      ? 'Label (e.g. CSM-C Morning Check-In)'
                      : 'Label (e.g. 2026 CSE-A Intake)'
                  }
                  value={newQr.label}
                  onChange={(e) => setNewQr({ ...newQr, label: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 sm:col-span-2"
                />
                <select
                  value={newQr.departmentId}
                  onChange={(e) => setNewQr({ ...newQr, departmentId: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                >
                  <option value="">All Departments</option>
                  {academics.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
                {newQr.qrPurpose === 'attendance' && (
                  <select
                    value={newQr.sessionId}
                    onChange={(e) => setNewQr({ ...newQr, sessionId: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 bg-white sm:col-span-2"
                  >
                    <option value="">Auto-detect student's active session(s)</option>
                    {sessions
                      .filter((s) => s.status === 'active')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          Bind to Session: {s.sessionCode} · {s.className} ({s.subjectCode})
                        </option>
                      ))}
                  </select>
                )}
                <input
                  type="number"
                  min={0}
                  max={8760}
                  value={newQr.expiryHours}
                  onChange={(e) => setNewQr({ ...newQr, expiryHours: Number(e.target.value) })}
                  placeholder="Expiry hours (0 = lifetime)"
                  title="Expiry in hours (0 = lifetime)"
                  className="rounded-lg border border-slate-300 px-3 py-2 tabular-nums"
                />
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={newQr.maxUses}
                  onChange={(e) => setNewQr({ ...newQr, maxUses: Number(e.target.value) })}
                  placeholder="Max Uses (0 = unlimited)"
                  title="Max Uses (0 = unlimited)"
                  className="rounded-lg border border-slate-300 px-3 py-2 tabular-nums"
                />
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Generate QR
                </button>
              </div>
            </form>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {qrList.map((q) => {
                const isAttend = q.qrPurpose === 'attendance';
                const targetUrl = isAttend
                  ? `${normalizedQrBase}/?attendQr=${encodeURIComponent(q.token)}`
                  : `${normalizedQrBase}/?registerQr=${encodeURIComponent(q.token)}`;
                return (
                  <div
                    key={q.id}
                    className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3 text-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            isAttend
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {isAttend ? 'Attendance Face Check-In QR' : 'Student Registration QR'}
                        </div>
                        <div className="font-bold text-slate-900 text-sm">{q.label}</div>
                        <div className="font-mono-tabular text-slate-600 break-all">
                          Token: {q.token}
                        </div>
                        {(q.departmentCode || q.sessionCode) && (
                          <div className="text-slate-600">
                            {q.departmentCode ? `Dept: ${q.departmentCode}` : 'All Depts'}
                            {q.sessionCode ? ` · Session: ${q.sessionCode}` : ''}
                          </div>
                        )}
                        <div className="text-slate-500">
                          Uses: {q.usedCount} / {q.maxUses ?? 'Unlimited'} · Expires: {q.expiresAtIST === 'No Expiry' ? 'Lifetime' : q.expiresAtIST}
                        </div>
                        <div className={q.isRevoked ? 'text-red-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                          {q.isRevoked ? 'REVOKED' : 'ACTIVE'}
                        </div>
                      </div>
                      {qrImages[q.id] && (
                        <img
                          src={qrImages[q.id]}
                          alt={`QR Code for ${q.label}`}
                          className="h-24 w-24 border border-slate-200 rounded p-1 shrink-0"
                        />
                      )}
                    </div>
                    <div className="border-t border-slate-100 pt-2 flex items-center justify-between gap-2">
                      <a
                        href={targetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 hover:underline truncate font-medium"
                      >
                        {isAttend ? 'Open Face Check-In Link' : 'Open Registration Link'}
                      </a>
                      {!q.isRevoked && q.token !== 'SBIT-ATTEND-CAMPUS' && q.token !== 'SBIT-REGISTER-CAMPUS' && q.token !== 'SBIST-ATTEND-CAMPUS' && q.token !== 'SBIST-REGISTER-CAMPUS' && (
                        <button
                          type="button"
                          onClick={() => handleRevokeQr(q.id)}
                          className="text-red-700 font-medium hover:underline shrink-0"
                        >
                          Revoke QR
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {nav === 'promotion' && (
          <AcademicPromotionPanel
            departments={academics.departments}
            academicYears={academics.academicYears}
            semesters={academics.semesters}
            onPromoted={() => {
              loadOverview();
              loadAcademics();
              loadStaff();
            }}
          />
        )}

        {nav === 'reports' && (
          <Suspense
            fallback={
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-xs text-slate-500">
                Loading institutional reports & export engine...
              </div>
            }
          >
            <ReportsPanel
              collegeName={collegeName}
              generatedBy={`${me.profile.fullName} (Super Admin)`}
              departments={academics.departments}
              semesters={academics.semesters}
              subjects={academics.subjects}
              classes={academics.classes}
            />
          </Suspense>
        )}

        {nav === 'settings' && settingsForm && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <form
                onSubmit={handleSaveSettings}
                className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4 text-xs"
              >
                <h2 className="text-sm font-bold text-slate-900">
                  College Branding, Geofence, Frequency & Biometric Thresholds
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">Official College Name</label>
                    <input
                      type="text"
                      required
                      value={settingsForm.collegeName}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, collegeName: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">
                      Replaceable Logo URL
                    </label>
                    <input
                      type="text"
                      value={settingsForm.logoUrl || ''}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, logoUrl: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>
                  <div className="sm:col-span-2 rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-bold text-slate-900">
                          1-Click College GPS Location Setup
                        </div>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          Automatically detects your current campus GPS coordinates and saves them immediately. Students inside the radius require no approval.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleCaptureAndSaveCampusGps}
                        disabled={capturingGps}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 text-white font-semibold hover:bg-blue-800 disabled:opacity-60"
                      >
                        {capturingGps ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <MapPin className="h-3.5 w-3.5" />
                        )}
                        {capturingGps ? 'Tracking & Saving GPS...' : 'Track & Save College GPS (1-Click)'}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">
                          College Latitude (auto-filled by GPS)
                        </label>
                        <input
                          type="number"
                          step="0.000001"
                          value={settingsForm.collegeLatitude}
                          onChange={(e) =>
                            setSettingsForm({ ...settingsForm, collegeLatitude: Number(e.target.value) })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-tabular"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">
                          College Longitude (auto-filled by GPS)
                        </label>
                        <input
                          type="number"
                          step="0.000001"
                          value={settingsForm.collegeLongitude}
                          onChange={(e) =>
                            setSettingsForm({
                              ...settingsForm,
                              collegeLongitude: Number(e.target.value),
                            })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-tabular"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">
                      Geofence Radius (meters)
                    </label>
                    <input
                      type="number"
                      min={20}
                      max={10000}
                      value={settingsForm.geofenceRadiusMeters}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          geofenceRadiusMeters: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">
                      Attendance Frequency Policy
                    </label>
                    <select
                      value={settingsForm.attendanceFrequency}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          attendanceFrequency: e.target.value as CollegeSettings['attendanceFrequency'],
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-2 bg-white"
                    >
                      <option value="once_per_day">Once per day</option>
                      <option value="morning_afternoon">Morning and afternoon</option>
                      <option value="every_class_period">Every class period</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">
                      Default QR Expiry (hours)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      value={settingsForm.qrDefaultExpiryHours}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          qrDefaultExpiryHours: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 mb-1">
                      Face Match Max Distance (0.22–0.33)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min={0.22}
                      max={0.33}
                      value={Math.min(0.33, Math.max(0.22, settingsForm.faceMatchThreshold))}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          faceMatchThreshold: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                    />
                  </div>
                </div>

                <div className="border-t border-slate-200 pt-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-slate-900">
                      Automatic Daily Attendance Schedule (Asia/Kolkata IST)
                    </h3>
                    <label className="flex items-center gap-2 text-slate-700">
                      <input
                        type="checkbox"
                        checked={settingsForm.autoDailySessionsEnabled ?? true}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            autoDailySessionsEnabled: e.target.checked,
                          })
                        }
                      />
                      Enable Automatic Daily Morning &amp; Afternoon Sessions
                    </label>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Morning Start (IST)</label>
                      <input
                        type="time"
                        required
                        value={settingsForm.morningStartTime || '09:00'}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, morningStartTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Morning End (IST)</label>
                      <input
                        type="time"
                        required
                        value={settingsForm.morningEndTime || '09:40'}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, morningEndTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Afternoon Start (IST)</label>
                      <input
                        type="time"
                        required
                        value={settingsForm.afternoonStartTime || '13:30'}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, afternoonStartTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Afternoon End (IST)</label>
                      <input
                        type="time"
                        required
                        value={settingsForm.afternoonEndTime || '13:40'}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, afternoonEndTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-6 pt-1">
                  <label className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={settingsForm.locationVerificationEnabled}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          locationVerificationEnabled: e.target.checked,
                        })
                      }
                    />
                    Enable Campus Location Geofence Verification
                  </label>
                  <label className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={settingsForm.livenessRequired}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          livenessRequired: e.target.checked,
                        })
                      }
                    />
                    Require Camera Liveness Checks
                  </label>
                </div>

                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Save College Settings
                </button>
              </form>

              <form
                onSubmit={handleSetAdminPassword}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs"
              >
                <h2 className="text-sm font-bold text-slate-900">Super Admin Password Security</h2>
                <p className="text-slate-500">
                  Set or rotate your portal password securely (stored as salted scrypt hash).
                </p>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
                <button
                  type="submit"
                  className="px-4 py-2 font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
                >
                  Save Password
                </button>
              </form>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-900">Immutable Security & Governance Audit Logs</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Timestamp (IST)</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                      <th className="px-4 py-3 font-semibold">Actor</th>
                      <th className="px-4 py-3 font-semibold">Entity</th>
                      <th className="px-4 py-3 font-semibold">IP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditLogs.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2.5 font-mono-tabular text-slate-500">{a.createdAtIST}</td>
                        <td className="px-4 py-2.5 font-mono-tabular font-semibold text-slate-900">
                          {a.action}
                        </td>
                        <td className="px-4 py-2.5">
                          {a.actorEmail || 'system'} ({a.actorRole || '-'})
                        </td>
                        <td className="px-4 py-2.5">{a.entityType}</td>
                        <td className="px-4 py-2.5 font-mono-tabular text-slate-500">{a.ipAddress}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
