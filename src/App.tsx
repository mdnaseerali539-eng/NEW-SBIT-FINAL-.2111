import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from './lib/firebase';
import { apiFetch, getAuthToken, setAuthToken, subscribeDataChange } from './lib/api';
import { AcademicYear, AuthMeResponse, CollegeSettings, Department, Semester } from './types';
import { LoginView } from './components/LoginView';

const QrRegistrationView = lazy(() =>
  import('./components/QrRegistrationView').then((m) => ({ default: m.QrRegistrationView }))
);
const QrAttendanceCheckInView = lazy(() =>
  import('./components/QrAttendanceCheckInView').then((m) => ({
    default: m.QrAttendanceCheckInView,
  }))
);
const StudentPortal = lazy(() =>
  import('./components/StudentPortal').then((m) => ({ default: m.StudentPortal }))
);
const StaffPortal = lazy(() =>
  import('./components/StaffPortal').then((m) => ({ default: m.StaffPortal }))
);
const AdminPortal = lazy(() =>
  import('./components/AdminPortal').then((m) => ({ default: m.AdminPortal }))
);

const PortalLoader = ({ message = 'Loading portal...' }: { message?: string }) => (
  <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
    <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-slate-700">
      {message}
    </div>
  </div>
);

export default function App() {
  const [publicInfo, setPublicInfo] = useState<{
    settings: CollegeSettings | null;
    departments: Department[];
    academicYears: AcademicYear[];
    semesters: Semester[];
  }>({
    settings: null,
    departments: [],
    academicYears: [],
    semesters: [],
  });
  const [publicInfoLastUpdated, setPublicInfoLastUpdated] = useState<Date | null>(null);
  const [refreshingPublicInfo, setRefreshingPublicInfo] = useState(false);

  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(() => Boolean(getAuthToken()));
  const [authError, setAuthError] = useState<string | null>(null);
  const [portalBannerMsg, setPortalBannerMsg] = useState<string | null>(null);
  const loggingOutRef = useRef(false);

  const pathname = window.location.pathname.toLowerCase();
  const searchParams = new URLSearchParams(window.location.search);
  const initialQrToken = searchParams.get('registerQr') || '';
  const initialAttendQrToken = searchParams.get('attendQr') || '';
  const initialSetupToken = searchParams.get('setupToken') || '';

  const [showQrRegister, setShowQrRegister] = useState(
    Boolean(initialQrToken) || pathname === '/register' || pathname === '/qr-register'
  );
  const [showQrAttend, setShowQrAttend] = useState(
    Boolean(initialAttendQrToken) || pathname === '/attend' || pathname === '/check-in'
  );
  const [activeSetupToken, setActiveSetupToken] = useState(initialSetupToken);

  const loadPublicInfo = useCallback(async () => {
    setRefreshingPublicInfo(true);
    try {
      const res = await apiFetch<typeof publicInfo>('/api/college/public-info', {
        skipAuth: true,
        cache: 'no-store',
      });
      setPublicInfo(res);
      setPublicInfoLastUpdated(new Date());
    } catch {
      // Ignore transient network errors
    } finally {
      setRefreshingPublicInfo(false);
    }
  }, []);

  useEffect(() => {
    void loadPublicInfo();
    return subscribeDataChange((type) => {
      if (type === 'SETTINGS_UPDATED' || type === 'DATA_UPDATED') {
        void loadPublicInfo();
      }
    });
  }, [loadPublicInfo]);

  const fetchMe = useCallback(async () => {
    if (!getAuthToken()) {
      setMe(null);
      setLoadingMe(false);
      return;
    }
    setLoadingMe(true);
    setAuthError(null);
    try {
      const res = await apiFetch<AuthMeResponse>('/api/auth/me', { cache: 'no-store' });
      setMe(res);
    } catch (err) {
      setAuthToken(null);
      setMe(null);
      setAuthError(err instanceof Error ? err.message : 'Session validation failed.');
    } finally {
      setLoadingMe(false);
    }
  }, []);

  useEffect(() => {
    if (getAuthToken()) {
      void fetchMe();
    }
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (loggingOutRef.current) return;
      if (firebaseUser && !getAuthToken()) {
        try {
          const idToken = await firebaseUser.getIdToken();
          if (idToken && !getAuthToken() && !loggingOutRef.current) {
            setAuthToken(idToken);
            await fetchMe();
          }
        } catch {
          // Ignore silent Firebase token refresh errors
        }
      }
    });
    return () => unsubscribe();
  }, [fetchMe]);

  const handleLogout = useCallback(async () => {
    loggingOutRef.current = true;
    setAuthToken(null);
    setMe(null);
    setPortalBannerMsg(null);
    try {
      await signOut(auth);
    } catch {
      // Ignore if not signed in via Firebase
    } finally {
      loggingOutRef.current = false;
    }
  }, []);

  let view: React.ReactNode;

  if (showQrRegister) {
    view = (
      <Suspense fallback={<PortalLoader message="Loading Student Registration Portal..." />}>
        <QrRegistrationView
          initialToken={initialQrToken}
          collegeSettings={publicInfo.settings}
          departments={publicInfo.departments}
          academicYears={publicInfo.academicYears}
          semesters={publicInfo.semesters}
          onRefreshPublicInfo={loadPublicInfo}
          publicInfoLastUpdated={publicInfoLastUpdated}
          refreshingPublicInfo={refreshingPublicInfo}
          onProceedToSetup={(tok) => {
            setActiveSetupToken(tok);
            setShowQrRegister(false);
            window.history.replaceState({}, '', '/');
          }}
          onGoogleAuthenticated={() => {
            setShowQrRegister(false);
            window.history.replaceState({}, '', '/');
            void fetchMe();
          }}
          onBackToLogin={() => {
            setShowQrRegister(false);
            window.history.replaceState({}, '', '/');
          }}
        />
      </Suspense>
    );
  } else if (showQrAttend && !me) {
    view = (
      <Suspense fallback={<PortalLoader message="Loading Attendance Check-In..." />}>
        <QrAttendanceCheckInView
          initialToken={initialAttendQrToken}
          collegeSettings={publicInfo.settings}
          onRefreshPublicInfo={loadPublicInfo}
          publicInfoLastUpdated={publicInfoLastUpdated}
          refreshingPublicInfo={refreshingPublicInfo}
          onAuthenticated={(msg) => {
            if (msg) setPortalBannerMsg(msg);
            setShowQrAttend(false);
            void fetchMe();
          }}
          onBackToLogin={() => {
            setShowQrAttend(false);
            window.history.replaceState({}, '', '/');
          }}
        />
      </Suspense>
    );
  } else if (loadingMe) {
    view = <PortalLoader message="Verifying institutional account and loading portal..." />;
  } else if (!me) {
    view = (
      <div>
        {authError && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2.5 text-center text-xs font-medium text-red-800">
            {authError}
          </div>
        )}
        <LoginView
          collegeSettings={publicInfo.settings}
          initialSetupToken={activeSetupToken}
          lastUpdatedAt={publicInfoLastUpdated}
          isRefreshingSite={refreshingPublicInfo}
          onRefreshSite={loadPublicInfo}
          onAuthenticated={fetchMe}
          onClearAuthError={() => setAuthError(null)}
          onOpenQrRegistration={() => setShowQrRegister(true)}
          onOpenQrAttendance={() => setShowQrAttend(true)}
        />
      </div>
    );
  } else if (me.profile.role === 'super_admin') {
    view = (
      <Suspense fallback={<PortalLoader message="Loading Super Admin Portal..." />}>
        <AdminPortal me={me} onLogout={handleLogout} />
      </Suspense>
    );
  } else if (me.profile.role === 'staff') {
    view = (
      <Suspense fallback={<PortalLoader message="Loading Staff Portal..." />}>
        <StaffPortal
          me={me}
          departments={publicInfo.departments}
          semesters={publicInfo.semesters}
          onLogout={handleLogout}
        />
      </Suspense>
    );
  } else {
    view = (
      <Suspense fallback={<PortalLoader message="Loading Student Portal..." />}>
        <StudentPortal me={me} initialBannerMsg={portalBannerMsg} onLogout={handleLogout} />
      </Suspense>
    );
  }

  return <>{view}</>;
}
