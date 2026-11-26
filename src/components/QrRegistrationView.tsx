import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MapPin,
  QrCode,
  RefreshCw,
} from 'lucide-react';
import { signInWithPopup } from 'firebase/auth';
import {
  auth,
  browserPopupRedirectResolver,
  createGoogleAuthProvider,
} from '../lib/firebase';
import { apiFetch, broadcastDataChange, setAuthToken, subscribeDataChange } from '../lib/api';
import { AcademicYear, CollegeSettings, Department, Semester } from '../types';
import { RefreshBar } from './RefreshBar';

const QR_REG_STORAGE_KEY = 'sbit_qr_submitted_reg_v1';

interface SubmittedRegState {
  message: string;
  status: string;
  autoApproved?: boolean;
  distanceMeters?: number | null;
  rollNumber: string;
  email?: string;
  rejectionReason?: string | null;
  setupToken?: string;
}

function readStoredSubmittedReg(): SubmittedRegState | null {
  try {
    const raw =
      window.localStorage?.getItem(QR_REG_STORAGE_KEY) ||
      window.sessionStorage?.getItem(QR_REG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SubmittedRegState;
    if (parsed && typeof parsed.rollNumber === 'string' && parsed.rollNumber.trim()) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveStoredSubmittedReg(val: SubmittedRegState | null): void {
  try {
    if (!val) {
      window.localStorage?.removeItem(QR_REG_STORAGE_KEY);
      window.sessionStorage?.removeItem(QR_REG_STORAGE_KEY);
    } else {
      const json = JSON.stringify(val);
      window.localStorage?.setItem(QR_REG_STORAGE_KEY, json);
      window.sessionStorage?.setItem(QR_REG_STORAGE_KEY, json);
    }
  } catch {
    // Ignore storage restrictions
  }
}

function calcDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

interface QrRegistrationViewProps {
  initialToken: string;
  collegeSettings: CollegeSettings | null;
  departments: Department[];
  academicYears: AcademicYear[];
  semesters: Semester[];
  onRefreshPublicInfo?: () => void | Promise<void>;
  publicInfoLastUpdated?: Date | null;
  refreshingPublicInfo?: boolean;
  onProceedToSetup?: (setupToken: string) => void;
  onGoogleAuthenticated?: () => void;
  onBackToLogin: () => void;
}

export const QrRegistrationView: React.FC<QrRegistrationViewProps> = ({
  initialToken,
  collegeSettings,
  departments,
  academicYears,
  semesters,
  onRefreshPublicInfo,
  publicInfoLastUpdated = null,
  refreshingPublicInfo = false,
  onProceedToSetup,
  onGoogleAuthenticated,
  onBackToLogin,
}) => {
  const [qrToken, setQrToken] = useState(initialToken || 'SBIT-REGISTER-CAMPUS');
  const [qrInfo, setQrInfo] = useState<{
    label: string;
    departmentId: string | null;
    academicYearId: string | null;
    semesterId: string | null;
  } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [checkingQr, setCheckingQr] = useState(false);

  const [fullName, setFullName] = useState('');
  const [rollNumber, setRollNumber] = useState('');
  const [departmentId, setDepartmentId] = useState(departments[0]?.id || '');
  const [academicYearId, setAcademicYearId] = useState(academicYears[0]?.id || '');
  const [semesterId, setSemesterId] = useState(semesters[0]?.id || '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [googleVerifiedEmail, setGoogleVerifiedEmail] = useState<string | null>(
    () => auth.currentUser?.email?.toLowerCase().trim() || null
  );
  const [verifyingGoogle, setVerifyingGoogle] = useState(false);
  const [submittedResult, setSubmittedResult] = useState<SubmittedRegState | null>(() =>
    readStoredSubmittedReg()
  );
  const [checkingStatus, setCheckingStatus] = useState(false);

  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationChecking, setLocationChecking] = useState(false);
  const [locationUnavailableMsg, setLocationUnavailableMsg] = useState<string | null>(null);

  const checkLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationUnavailableMsg('Location access is not supported by this browser.');
      return;
    }
    setLocationChecking(true);
    setLocationUnavailableMsg(null);

    const onSuccess = (pos: GeolocationPosition) => {
      setCoords({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      setLocationChecking(false);
      setLocationUnavailableMsg(null);
    };

    const onFinalError = (err: GeolocationPositionError) => {
      setCoords(null);
      setLocationChecking(false);
      setLocationUnavailableMsg(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission was denied. Allow location access to verify if you are on campus (no approval needed), or submit as off-campus for Super Admin approval.'
          : 'Unable to detect GPS coordinates right now. Click Verify Location to retry, or submit for Super Admin approval.'
      );
    };

    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          onFinalError(err);
          return;
        }
        // Fallback to network/Wi-Fi location when high-accuracy GPS times out indoors
        navigator.geolocation.getCurrentPosition(onSuccess, onFinalError, {
          enableHighAccuracy: false,
          timeout: 6000,
          maximumAge: 60000,
        });
      },
      { enableHighAccuracy: true, timeout: 5500, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    if (onRefreshPublicInfo) {
      void onRefreshPublicInfo();
    }
  }, [onRefreshPublicInfo]);

  useEffect(() => {
    if (!submittedResult) {
      checkLocation();
    }
  }, [checkLocation, submittedResult]);

  useEffect(() => {
    if (!departmentId && departments.length > 0) {
      setDepartmentId(departments[0].id);
    }
  }, [departmentId, departments]);

  useEffect(() => {
    if (!academicYearId && academicYears.length > 0) {
      setAcademicYearId(academicYears[0].id);
    }
  }, [academicYearId, academicYears]);

  useEffect(() => {
    if (!semesterId && semesters.length > 0) {
      setSemesterId(semesters[0].id);
    }
  }, [semesterId, semesters]);

  const checkQrStatus = useCallback(async () => {
    if (!qrToken.trim()) return;
    setCheckingQr(true);
    setQrError(null);
    try {
      const res = await apiFetch<{
        qr: {
          label: string;
          departmentId: string | null;
          academicYearId: string | null;
          semesterId: string | null;
        };
      }>(`/api/qr/${encodeURIComponent(qrToken.trim())}`, {
        skipAuth: true,
        cache: 'no-store',
      });
      setQrInfo(res.qr);
      if (res.qr.departmentId) setDepartmentId(res.qr.departmentId);
      if (res.qr.academicYearId) setAcademicYearId(res.qr.academicYearId);
      if (res.qr.semesterId) setSemesterId(res.qr.semesterId);
    } catch (err) {
      setQrInfo(null);
      setQrError(err instanceof Error ? err.message : 'Invalid QR code.');
    } finally {
      setCheckingQr(false);
    }
  }, [qrToken]);

  useEffect(() => {
    void checkQrStatus();
  }, [checkQrStatus]);

  const getGoogleRegistrationToken = useCallback(async (): Promise<string | null> => {
    if (!auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken(false);
    } catch {
      return null;
    }
  }, []);

  const handleVerifyGoogleForRegistration = useCallback(async () => {
    setSubmitError(null);
    setVerifyingGoogle(true);
    try {
      const cred = await signInWithPopup(
        auth,
        createGoogleAuthProvider(),
        browserPopupRedirectResolver
      );
      const verifiedMail = (cred.user.email || '').toLowerCase().trim();
      if (verifiedMail) {
        setGoogleVerifiedEmail(verifiedMail);
        setEmail(verifiedMail);
      }
      if (!fullName.trim() && cred.user.displayName) {
        setFullName(cred.user.displayName.trim());
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Google verification could not be completed.');
    } finally {
      setVerifyingGoogle(false);
    }
  }, [fullName]);

  const refreshSubmittedStatus = useCallback(async () => {
    if (!submittedResult?.rollNumber) return;
    setCheckingStatus(true);
    try {
      const fbToken = await getGoogleRegistrationToken();
      const res = await apiFetch<{
        rollNumber: string;
        status: string;
        autoApproved?: boolean;
        rejectionReason?: string | null;
        setupToken?: string;
      }>('/api/qr/registration-status', {
        method: 'POST',
        skipAuth: true,
        headers: fbToken ? { Authorization: `Bearer ${fbToken}` } : undefined,
        cache: 'no-store',
        body: JSON.stringify({
          rollNumber: submittedResult.rollNumber,
          ...(submittedResult.email ? { email: submittedResult.email } : {}),
        }),
      });

      const nextState: SubmittedRegState = {
        ...submittedResult,
        status: res.status,
        autoApproved: res.autoApproved ?? submittedResult.autoApproved,
        rejectionReason: res.rejectionReason ?? null,
        setupToken: res.setupToken ?? submittedResult.setupToken,
        message:
          res.status === 'approved'
            ? res.autoApproved
              ? `Campus location verified. Your student account is active right away.`
              : 'Your student registration has been approved by the Super Admin! You can now sign in and enroll your face.'
            : res.status === 'rejected'
              ? res.rejectionReason
                ? `Your registration was rejected: ${res.rejectionReason}`
                : 'Your registration was rejected by college administration.'
              : submittedResult.message,
      };
      setSubmittedResult(nextState);
      saveStoredSubmittedReg(nextState);
    } catch (err) {
      // If user was removed by Super Admin, clear stale local state so form can be used again
      if (err instanceof Error && /not found/i.test(err.message)) {
        setSubmittedResult(null);
        saveStoredSubmittedReg(null);
      }
    } finally {
      setCheckingStatus(false);
    }
  }, [submittedResult, getGoogleRegistrationToken]);

  useEffect(() => {
    if (submittedResult?.rollNumber) {
      void refreshSubmittedStatus();
    }
    // Only re-check on mount or when rollNumber changes to avoid infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedResult?.rollNumber]);

  useEffect(() => {
    return subscribeDataChange((type) => {
      if (
        (type === 'DATA_UPDATED' || type === 'REGISTRATION_SUBMITTED') &&
        submittedResult?.rollNumber
      ) {
        void refreshSubmittedStatus();
      }
    });
  }, [submittedResult?.rollNumber, refreshSubmittedStatus]);

  useEffect(() => {
    if (!submittedResult || submittedResult.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void refreshSubmittedStatus();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [submittedResult, refreshSubmittedStatus]);

  const handleRefreshRegistration = useCallback(async () => {
    await Promise.all([
      onRefreshPublicInfo ? Promise.resolve(onRefreshPublicInfo()) : Promise.resolve(),
      checkQrStatus(),
      submittedResult ? refreshSubmittedStatus() : Promise.resolve(),
    ]);
    if (!submittedResult) {
      checkLocation();
    }
  }, [onRefreshPublicInfo, checkQrStatus, submittedResult, refreshSubmittedStatus, checkLocation]);

  const distanceFromCampus =
    coords && collegeSettings
      ? calcDistanceMeters(
          coords.latitude,
          coords.longitude,
          collegeSettings.collegeLatitude,
          collegeSettings.collegeLongitude
        )
      : null;

  const isWithinCampus =
    distanceFromCampus !== null &&
    collegeSettings !== null &&
    distanceFromCampus <= collegeSettings.geofenceRadiusMeters;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!departmentId || !academicYearId || !semesterId) {
      setSubmitError(
        'Academic options are still loading. Please select a department, year, and semester.'
      );
      return;
    }
    setSubmitting(true);
    try {
      const normalizedEmail = email.toLowerCase().trim();
      const fbToken =
        googleVerifiedEmail && googleVerifiedEmail === normalizedEmail
          ? await getGoogleRegistrationToken()
          : null;
      const res = await apiFetch<SubmittedRegState>('/api/qr/register', {
        method: 'POST',
        skipAuth: true,
        headers: fbToken ? { Authorization: `Bearer ${fbToken}` } : undefined,
        body: JSON.stringify({
          qrToken: qrToken.trim(),
          fullName,
          rollNumber,
          departmentId,
          academicYearId,
          semesterId,
          email: normalizedEmail,
          phone,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        }),
      });
      const stored: SubmittedRegState = { ...res, email: normalizedEmail };
      broadcastDataChange('REGISTRATION_SUBMITTED');
      setSubmittedResult(stored);
      saveStoredSubmittedReg(stored);
      if (res.status === 'approved' && fbToken) {
        setAuthToken(fbToken);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Registration submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleResetForNewStudent() {
    setSubmittedResult(null);
    saveStoredSubmittedReg(null);
    setFullName('');
    setRollNumber('');
    setEmail('');
    setPhone('');
    setSubmitError(null);
    checkLocation();
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-8 px-4">
      <div className="mx-auto w-full max-w-xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm">
        <div className="flex items-center gap-3 pb-5 border-b border-slate-200">
          <img
            src={collegeSettings?.logoUrl || '/src/assets/images/sbist_college_crest_1795533458624.jpg'}
            alt="Swarna Bharathi Institute of Science and Technology Logo"
            referrerPolicy="no-referrer"
            className="h-12 w-12 rounded-lg object-contain border border-slate-200 bg-white p-1"
          />
          <div>
            <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight">
              {collegeSettings?.collegeName || 'Swarna Bharathi Institute of Science and Technology'}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Smart Attendance Management System · Student QR Registration
            </p>
          </div>
        </div>

        <div className="mt-4">
          <RefreshBar
            compact
            label="Registration Live Sync"
            lastUpdatedAt={publicInfoLastUpdated}
            isRefreshing={refreshingPublicInfo || checkingQr || checkingStatus}
            onRefresh={handleRefreshRegistration}
            defaultAutoRefreshSeconds={0}
          />
        </div>

        {submittedResult ? (
          submittedResult.status === 'approved' ? (
            <div className="py-8 space-y-4 text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <h2 className="text-lg font-semibold text-slate-900">
                {submittedResult.autoApproved
                  ? 'Account Activated Immediately (In Campus Range)'
                  : 'Registration Approved'}
              </h2>
              <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                {submittedResult.message}
              </p>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 font-mono-tabular">
                Roll Number: {submittedResult.rollNumber} · Status: Approved
                {typeof submittedResult.distanceMeters === 'number'
                  ? ` · Distance: ${submittedResult.distanceMeters}m`
                  : ''}
              </div>
              <p className="text-xs text-slate-500">
                {submittedResult.autoApproved
                  ? 'No Super Admin approval was needed because your campus location was verified. Sign in with Google or set a portal password below to access your dashboard and enroll your face.'
                  : 'Your registration is active. Sign in with Google or set a portal password below to open your Student Dashboard.'}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                {googleVerifiedEmail &&
                  submittedResult.email === googleVerifiedEmail &&
                  onGoogleAuthenticated && (
                    <button
                      type="button"
                      onClick={async () => {
                        const tok = await getGoogleRegistrationToken();
                        if (tok) {
                          setAuthToken(tok);
                          onGoogleAuthenticated();
                        } else {
                          onBackToLogin();
                        }
                      }}
                      className="px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
                    >
                      Open Student Dashboard Now
                    </button>
                  )}
                {submittedResult.setupToken && onProceedToSetup && (
                  <button
                    type="button"
                    onClick={() => onProceedToSetup(submittedResult.setupToken!)}
                    className="px-5 py-2.5 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800"
                  >
                    Set Portal Password &amp; Activate
                  </button>
                )}
                <button
                  type="button"
                  onClick={onBackToLogin}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Go to Sign In Portal
                </button>
                <button
                  type="button"
                  onClick={handleResetForNewStudent}
                  className="px-4 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100"
                >
                  Register Another Student
                </button>
              </div>
            </div>
          ) : submittedResult.status === 'rejected' ? (
            <div className="py-8 space-y-4 text-center">
              <AlertTriangle className="h-12 w-12 text-red-600 mx-auto" />
              <h2 className="text-lg font-semibold text-slate-900">Registration Rejected</h2>
              <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                {submittedResult.message}
              </p>
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 font-mono-tabular">
                Roll Number: {submittedResult.rollNumber} · Status: Rejected
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleResetForNewStudent}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Register Again
                </button>
                <button
                  type="button"
                  onClick={onBackToLogin}
                  className="px-4 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100"
                >
                  Return to Login Portal
                </button>
              </div>
            </div>
          ) : (
            <div className="py-8 space-y-4 text-center">
              <CheckCircle2 className="h-12 w-12 text-blue-600 mx-auto" />
              <h2 className="text-lg font-semibold text-slate-900">
                Off-Campus Registration · Pending Approval
              </h2>
              <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                {submittedResult.message}
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 font-mono-tabular">
                Roll Number: {submittedResult.rollNumber} · Status: Pending Approval
                {typeof submittedResult.distanceMeters === 'number'
                  ? ` · Distance: ${submittedResult.distanceMeters}m`
                  : ''}
              </div>
              <p className="text-xs text-slate-500">
                This screen updates automatically as soon as the Super Admin approves your registration.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={refreshSubmittedStatus}
                  disabled={checkingStatus}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${checkingStatus ? 'animate-spin' : ''}`} />
                  {checkingStatus ? 'Checking Status...' : 'Check Approval Status Now'}
                </button>
                <button
                  type="button"
                  onClick={onBackToLogin}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Go to Login Portal
                </button>
                <button
                  type="button"
                  onClick={handleResetForNewStudent}
                  className="px-4 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100"
                >
                  Register Another Student
                </button>
              </div>
            </div>
          )
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            {/* Campus Location Verification Banner */}
            <div
              className={`rounded-lg border p-3 text-xs flex items-start justify-between gap-3 ${
                isWithinCampus
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                  : distanceFromCampus !== null
                    ? 'border-amber-200 bg-amber-50 text-amber-950'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
              }`}
            >
              <div className="flex items-start gap-2">
                {locationChecking ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-0.5 shrink-0 text-blue-600" />
                ) : (
                  <MapPin
                    className={`h-4 w-4 mt-0.5 shrink-0 ${
                      isWithinCampus
                        ? 'text-emerald-700'
                        : distanceFromCampus !== null
                          ? 'text-amber-700'
                          : 'text-slate-500'
                    }`}
                  />
                )}
                <div className="space-y-0.5">
                  <div className="font-semibold">
                    {locationChecking
                      ? 'Checking campus GPS location...'
                      : isWithinCampus
                        ? `In SBIT Campus Range (${distanceFromCampus}m) — No Approval Required`
                        : distanceFromCampus !== null
                          ? `Out of Range (${distanceFromCampus}m away; campus radius ${collegeSettings?.geofenceRadiusMeters ?? 300}m)`
                          : 'Campus Location Check'}
                  </div>
                  <div className="opacity-90">
                    {isWithinCampus
                      ? 'Your student account will activate immediately without entering the Approvals list.'
                      : distanceFromCampus !== null
                        ? 'Because you are outside campus range, your registration will go to the Super Admin Approvals list.'
                        : locationUnavailableMsg ||
                          'Students in campus range activate immediately with no approval required. Off-campus registrations go to Approvals.'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={checkLocation}
                disabled={locationChecking}
                className="shrink-0 px-2.5 py-1 rounded border border-current/25 bg-white/80 font-medium hover:bg-white disabled:opacity-50"
              >
                {locationChecking ? 'Checking...' : 'Verify Location'}
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Registration QR Token
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <QrCode className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    required
                    value={qrToken}
                    onChange={(e) => setQrToken(e.target.value)}
                    placeholder="SBIT-..."
                    className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              {checkingQr && <p className="text-xs text-slate-500 mt-1">Validating QR code...</p>}
              {qrInfo && (
                <p className="text-xs text-emerald-700 mt-1">
                  Verified QR Batch: {qrInfo.label}
                </p>
              )}
              {qrError && <p className="text-xs text-red-600 mt-1">{qrError}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Karthikeya Sharma"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Roll Number</label>
                <input
                  type="text"
                  required
                  value={rollNumber}
                  onChange={(e) => setRollNumber(e.target.value)}
                  placeholder="e.g. 24SB1A0501"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-tabular uppercase focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {departments.length === 0 && (
                    <option value="" disabled>
                      Loading departments...
                    </option>
                  )}
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Academic Year</label>
                <select
                  value={academicYearId}
                  onChange={(e) => setAcademicYearId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {academicYears.length === 0 && (
                    <option value="" disabled>
                      Loading years...
                    </option>
                  )}
                  {academicYears.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Semester</label>
                <select
                  value={semesterId}
                  onChange={(e) => setSemesterId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {semesters.length === 0 && (
                    <option value="" disabled>
                      Loading semesters...
                    </option>
                  )}
                  {semesters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-blue-950">
                <span className="font-semibold">
                  {googleVerifiedEmail
                    ? `Google Verified: ${googleVerifiedEmail}`
                    : 'Verify Gmail with Google (Recommended)'}
                </span>
                <p className="text-[11px] text-blue-800 mt-0.5">
                  {googleVerifiedEmail
                    ? 'Your Gmail is verified — registration details will save immediately to your account.'
                    : 'Connect your Google account so your registration details are saved permanently.'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleVerifyGoogleForRegistration}
                disabled={verifyingGoogle}
                className="shrink-0 px-3 py-1.5 rounded-lg border border-blue-300 bg-white font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
              >
                {verifyingGoogle
                  ? 'Connecting...'
                  : googleVerifiedEmail
                    ? 'Switch Google Account'
                    : 'Verify with Google'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Gmail Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={Boolean(googleVerifiedEmail && email.toLowerCase().trim() === googleVerifiedEmail)}
                  placeholder="student@gmail.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 read-only:bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="9876543210"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            {!isWithinCampus && (
              <p className="text-xs text-slate-500">
                Students inside campus geofence activate immediately without approval. Out-of-range registrations go to the Super Admin Approvals list.
              </p>
            )}

            {submitError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {submitError}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={onBackToLogin}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Login
              </button>
              <button
                type="submit"
                disabled={submitting || locationChecking || !qrInfo}
                className={`px-5 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${
                  isWithinCampus
                    ? 'bg-emerald-700 hover:bg-emerald-800'
                    : 'bg-slate-900 hover:bg-slate-800'
                }`}
              >
                {submitting
                  ? 'Submitting...'
                  : locationChecking
                    ? 'Checking Location...'
                    : isWithinCampus
                      ? 'Register & Activate Now'
                      : 'Submit for Approval'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
