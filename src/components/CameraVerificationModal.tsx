import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, AlertTriangle, ShieldCheck, X, RefreshCw } from 'lucide-react';
import {
  analyzeVideoFrame,
  computeNormalizedFaceDistance,
  ensureFaceModelsLoaded,
  FrameAnalysisResult,
} from '../lib/faceEngine';
import { apiFetch, ApiError } from '../lib/api';

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

interface CameraVerificationModalProps {
  mode: 'enroll' | 'verify' | 'test';
  faceId?: string | null;
  sessionId?: string;
  sessionLabel?: string;
  locationRequired?: boolean;
  livenessRequired?: boolean;
  campusLocation?: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
  } | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onRequestAssistedFallback?: (sessionId: string, reason: string, type: 'location_bypass' | 'liveness_assisted') => void;
}

export const CameraVerificationModal: React.FC<CameraVerificationModalProps> = ({
  mode,
  faceId = null,
  sessionId,
  sessionLabel,
  locationRequired = false,
  livenessRequired = true,
  campusLocation = null,
  onClose,
  onSuccess,
  onRequestAssistedFallback,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const [consentAccepted, setConsentAccepted] = useState(mode !== 'enroll');
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<FrameAnalysisResult | null>(null);
  const [samples, setSamples] = useState<number[][]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    faceId: string;
    matched: boolean;
    distance: number;
    threshold: number;
    confidence: number;
    message: string;
  } | null>(null);

  // Liveness tracking states (real landmark checks + anti-swap TTL)
  const [blinkDetected, setBlinkDetected] = useState(false);
  const [headTurnDetected, setHeadTurnDetected] = useState(false);
  const earHistoryRef = useRef<number[]>([]);
  const yawHistoryRef = useRef<number[]>([]);
  const blinkAtRef = useRef<number | null>(null);
  const lastBoxCenterRef = useRef<{ x: number; y: number } | null>(null);

  // Location state (requested ONLY during verify mode if enabled)
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<string>(
    locationRequired ? 'Requesting campus location...' : 'Campus location check optional'
  );
  const [locationError, setLocationError] = useState<string | null>(null);
  const [checkingGps, setCheckingGps] = useState(false);

  const requestGps = React.useCallback(() => {
    if (mode !== 'verify' || !locationRequired) return;
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    setCheckingGps(true);
    setLocationError(null);
    setLocationStatus('Requesting campus location...');

    const onSuccess = (pos: GeolocationPosition) => {
      setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      setLocationStatus(
        `GPS captured (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`
      );
      setLocationError(null);
      setCheckingGps(false);
    };

    const onFinalError = (err: GeolocationPositionError) => {
      setCheckingGps(false);
      setLocationError(
        `Location permission denied or unavailable (${err.message}). You can retry GPS or request staff-assisted attendance below.`
      );
    };

    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          onFinalError(err);
          return;
        }
        navigator.geolocation.getCurrentPosition(onSuccess, onFinalError, {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 60000,
        });
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 15000 }
    );
  }, [mode, locationRequired]);

  useEffect(() => {
    requestGps();
  }, [requestGps]);

  const distanceFromCampus =
    coords && campusLocation
      ? calcDistanceMeters(
          coords.latitude,
          coords.longitude,
          campusLocation.latitude,
          campusLocation.longitude
        )
      : null;
  const isOutsideCampus =
    locationRequired &&
    distanceFromCampus !== null &&
    campusLocation !== null &&
    distanceFromCampus > campusLocation.radiusMeters;

  useEffect(() => {
    if (!consentAccepted) return;
    let cancelled = false;

    async function startCameraAndModels() {
      try {
        await ensureFaceModelsLoaded();
        if (cancelled) return;
        setModelsReady(true);

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraReady(true);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unable to access camera';
        setCameraError(`Camera initialization failed: ${msg}. Please allow camera permission.`);
      }
    }

    startCameraAndModels();

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [consentAccepted]);

  // Continuous live frame analysis loop
  useEffect(() => {
    if (!cameraReady || !modelsReady || submitting) return;
    let busy = false;

    const id = window.setInterval(async () => {
      if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
      busy = true;
      try {
        const res = await analyzeVideoFrame(videoRef.current, false);
        setAnalysis(res);

        const now = Date.now();
        let jumped = false;
        if (res.faceCount === 1 && res.boxCenter && lastBoxCenterRef.current) {
          const jumpDist = Math.hypot(
            res.boxCenter.x - lastBoxCenterRef.current.x,
            res.boxCenter.y - lastBoxCenterRef.current.y
          );
          if (jumpDist > 0.14) jumped = true;
        }
        lastBoxCenterRef.current = res.faceCount === 1 ? res.boxCenter : null;

        if (res.faceCount !== 1 || jumped) {
          earHistoryRef.current = [];
          yawHistoryRef.current = [];
          blinkAtRef.current = null;
          setBlinkDetected(false);
          setHeadTurnDetected(false);
        } else {
          if (blinkAtRef.current !== null && now - blinkAtRef.current > 12000) {
            blinkAtRef.current = null;
            earHistoryRef.current = [];
            setBlinkDetected(false);
          }
          if (res.ear !== null && res.yawRatio !== null) {
            earHistoryRef.current.push(res.ear);
            if (earHistoryRef.current.length > 25) earHistoryRef.current.shift();
            const maxEar = Math.max(...earHistoryRef.current);
            const minEar = Math.min(...earHistoryRef.current);
            // Natural blink shows a dip in Eye Aspect Ratio
            if (maxEar - minEar >= 0.045 || minEar < 0.23) {
              blinkAtRef.current = now;
              setBlinkDetected(true);
            }

            yawHistoryRef.current.push(res.yawRatio);
            if (yawHistoryRef.current.length > 25) yawHistoryRef.current.shift();
            const minYaw = Math.min(...yawHistoryRef.current);
            const maxYaw = Math.max(...yawHistoryRef.current);
            if (maxYaw - minYaw >= 0.08) {
              setHeadTurnDetected(true);
            }
          }
        }
      } catch {
        // Skip transient frame read issues
      } finally {
        busy = false;
      }
    }, 260);

    timerRef.current = id;
    return () => window.clearInterval(id);
  }, [cameraReady, modelsReady, submitting]);

  async function handleCaptureEnrollmentSample() {
    if (!videoRef.current || submitting) return;
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const res = await analyzeVideoFrame(videoRef.current, true);
      if (res.faceCount !== 1 || !res.descriptor) {
        setErrorMsg(res.guidanceMessage);
        return;
      }
      if (!res.lightingOk || !res.centeringOk || !res.sizeOk || !res.poseOk) {
        setErrorMsg(res.guidanceMessage);
        return;
      }
      for (const prevSample of samples) {
        const sampleDist = computeNormalizedFaceDistance(prevSample, res.descriptor);
        if (sampleDist < 0.0005) {
          setErrorMsg(
            'Duplicate static frame detected. Move slightly and capture a fresh live frame.'
          );
          return;
        }
        if (sampleDist > 0.26) {
          setErrorMsg(
            'Face did not match the earlier sample closely enough. Keep only your own face straight in steady light and retry.'
          );
          return;
        }
      }
      const nextSamples = [...samples, res.descriptor];
      setSamples(nextSamples);

      if (nextSamples.length >= 3) {
        const resp = await apiFetch<{ message: string; faceId?: string }>('/api/student/biometrics/enroll', {
          method: 'POST',
          body: JSON.stringify({
            consentGiven: true,
            descriptors: nextSamples,
          }),
        });
        onSuccess(resp.message);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Enrollment sample failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestFaceIdMatch() {
    if (!videoRef.current || submitting) return;
    setErrorMsg(null);
    setErrorCode(null);
    setTestResult(null);

    if (livenessRequired && !blinkDetected) {
      setErrorMsg('Please blink naturally once so the liveness check detects eye motion.');
      return;
    }

    setSubmitting(true);
    try {
      const capturedFrames: FrameAnalysisResult[] = [];
      for (let i = 0; i < 3; i++) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 220));
        }
        const frame = await analyzeVideoFrame(videoRef.current, true);
        if (frame.faceCount !== 1 || !frame.descriptor) {
          setErrorMsg(frame.guidanceMessage);
          return;
        }
        if (!frame.lightingOk || !frame.centeringOk || !frame.sizeOk || !frame.poseOk) {
          setErrorMsg(frame.guidanceMessage);
          return;
        }
        capturedFrames.push(frame);
      }

      const d1 = capturedFrames[0].descriptor!;
      const d2 = capturedFrames[1].descriptor!;
      const d3 = capturedFrames[2].descriptor!;

      const pair12 = computeNormalizedFaceDistance(d1, d2);
      const pair23 = computeNormalizedFaceDistance(d2, d3);
      const pair13 = computeNormalizedFaceDistance(d1, d3);
      if (pair12 > 0.22 || pair23 > 0.22 || pair13 > 0.22) {
        blinkAtRef.current = null;
        earHistoryRef.current = [];
        setBlinkDetected(false);
        setErrorMsg('Hold one face steady facing the camera during the check and retry.');
        return;
      }

      let sqDiff = 0;
      for (let i = 0; i < 128; i++) {
        const d = d1[i] - d2[i];
        sqDiff += d * d;
      }
      const frameVariance = Math.sqrt(sqDiff);

      const resp = await apiFetch<{
        faceId: string;
        matched: boolean;
        distance: number;
        threshold: number;
        confidence: number;
        message: string;
      }>('/api/student/biometrics/test-match', {
        method: 'POST',
        body: JSON.stringify({
          descriptor: d2,
          descriptors: [d1, d2, d3],
          livenessPassed: livenessRequired ? blinkDetected && frameVariance > 0.0002 : true,
          livenessSignals: {
            blinkDetected,
            headTurnDetected,
            frameVariance,
          },
        }),
      });

      setTestResult(resp);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message);
        setErrorCode(err.code || null);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Face ID check failed.');
      }
    } finally {
      blinkAtRef.current = null;
      earHistoryRef.current = [];
      yawHistoryRef.current = [];
      setBlinkDetected(false);
      setHeadTurnDetected(false);
      setSubmitting(false);
    }
  }

  async function handleVerifyAndMarkAttendance() {
    if (!videoRef.current || !sessionId || submitting) return;
    setErrorMsg(null);
    setErrorCode(null);

    if (locationRequired && !coords) {
      setErrorMsg('Campus location coordinates are required before verifying your face.');
      setErrorCode('LOCATION_REQUIRED');
      return;
    }

    if (livenessRequired && !blinkDetected) {
      setErrorMsg('Please blink naturally once so the liveness check detects eye motion.');
      return;
    }

    setSubmitting(true);
    try {
      const capturedFrames: FrameAnalysisResult[] = [];
      for (let i = 0; i < 3; i++) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 220));
        }
        const frame = await analyzeVideoFrame(videoRef.current, true);
        if (frame.faceCount !== 1 || !frame.descriptor) {
          setErrorMsg(frame.guidanceMessage);
          return;
        }
        if (!frame.lightingOk || !frame.centeringOk || !frame.sizeOk || !frame.poseOk) {
          setErrorMsg(frame.guidanceMessage);
          return;
        }
        capturedFrames.push(frame);
      }

      const d1 = capturedFrames[0].descriptor!;
      const d2 = capturedFrames[1].descriptor!;
      const d3 = capturedFrames[2].descriptor!;

      const pair12 = computeNormalizedFaceDistance(d1, d2);
      const pair23 = computeNormalizedFaceDistance(d2, d3);
      const pair13 = computeNormalizedFaceDistance(d1, d3);
      if (pair12 > 0.22 || pair23 > 0.22 || pair13 > 0.22) {
        blinkAtRef.current = null;
        earHistoryRef.current = [];
        setBlinkDetected(false);
        setErrorMsg('Hold steady facing the camera during verification and retry.');
        return;
      }

      let sqDiff = 0;
      for (let i = 0; i < 128; i++) {
        const d = d1[i] - d2[i];
        sqDiff += d * d;
      }
      const frameVariance = Math.sqrt(sqDiff);

      const resp = await apiFetch<{ message: string; record: { markedAtIST: string } }>(
        '/api/student/attendance/mark',
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            descriptor: d2,
            descriptors: [d1, d2, d3],
            livenessPassed: livenessRequired ? blinkDetected && frameVariance > 0.0002 : true,
            livenessSignals: {
              blinkDetected,
              headTurnDetected,
              frameVariance,
            },
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
          }),
        }
      );

      onSuccess(`${resp.message} (${resp.record.markedAtIST})`);
    } catch (err: unknown) {
      // Force fresh liveness blink before any retry after verification failure
      blinkAtRef.current = null;
      earHistoryRef.current = [];
      yawHistoryRef.current = [];
      setBlinkDetected(false);
      setHeadTurnDetected(false);
      if (err instanceof ApiError) {
        setErrorMsg(err.message);
        setErrorCode(err.code || null);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Verification failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-6">
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden max-h-[94vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {mode === 'enroll'
                ? 'Create Your Face ID'
                : mode === 'test'
                  ? 'Check Face ID Match'
                  : 'Live Camera Attendance Verification'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'enroll'
                ? 'Swarna Bharathi Institute of Science and Technology · Captures 3 live samples to create your Face ID'
                : mode === 'test'
                  ? `Checking live face against enrolled Face ID ${faceId || ''} (same strict check used for attendance)`
                  : `${sessionLabel || 'Active Class Session'}${faceId ? ` · Face ID ${faceId}` : ''}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close camera modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {!consentAccepted ? (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-blue-700 shrink-0 mt-0.5" />
                <div className="space-y-2 text-sm text-slate-700">
                  <p className="font-semibold text-slate-900">
                    Informed Biometric Consent & Privacy Notice (SBIT-BIO-2026-v1)
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-xs leading-relaxed text-slate-600">
                    <li>
                      Your browser extracts a mathematical 128-dimensional facial descriptor locally. Raw
                      photographs are never stored on the server.
                    </li>
                    <li>
                      The descriptor template is encrypted with AES-256-GCM on the server and used strictly
                      for Swarna Bharathi Institute of Science and Technology attendance verification.
                    </li>
                    <li>
                      Biometric templates are never sent back to frontend JavaScript and may be deleted or
                      re-enrolled by you or an administrator at any time.
                    </li>
                  </ul>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-slate-700 rounded-lg border border-slate-300 hover:bg-slate-100"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => setConsentAccepted(true)}
                  className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  I Consent & Continue to Camera
                </button>
              </div>
            </div>
          ) : (
            <>
              {mode === 'verify' && (
                <div
                  className={`rounded-lg border px-3.5 py-2.5 text-xs space-y-1 ${
                    locationError || isOutsideCampus
                      ? 'border-amber-300 bg-amber-50 text-amber-950'
                      : distanceFromCampus !== null
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                        : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      Location Check:{' '}
                      {locationError
                        ? 'Unavailable / Denied'
                        : !locationRequired
                          ? 'Campus location check optional'
                          : distanceFromCampus !== null && campusLocation
                            ? isOutsideCampus
                              ? `Outside Campus Geofence (${distanceFromCampus}m away; allowed ${campusLocation.radiusMeters}m)`
                              : `In Campus Range (${distanceFromCampus}m <= ${campusLocation.radiusMeters}m)`
                            : locationStatus}
                    </span>
                    {locationRequired && (
                      <button
                        type="button"
                        onClick={requestGps}
                        disabled={checkingGps}
                        className="px-2 py-0.5 rounded border border-current/25 bg-white/80 font-medium hover:bg-white disabled:opacity-50"
                      >
                        {checkingGps ? 'Checking...' : 'Retry GPS'}
                      </button>
                    )}
                  </div>
                  {locationError && <p>{locationError}</p>}
                  {isOutsideCampus && (
                    <p>
                      Verification will be blocked by campus geofence (403) unless campus coordinates are updated in Super Admin Settings or you submit a Staff-Assisted request below.
                    </p>
                  )}
                </div>
              )}

              <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-900 border border-slate-200">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="h-full w-full object-cover scale-x-[-1]"
                />
                {/* Centering guide */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className={`h-52 w-40 sm:h-60 sm:w-48 rounded-full border-2 transition-colors ${
                      analysis?.faceCount === 1 &&
                      analysis.lightingOk &&
                      analysis.centeringOk &&
                      analysis.sizeOk &&
                      analysis.poseOk
                        ? 'border-emerald-400'
                        : 'border-white/70 border-dashed'
                    }`}
                  />
                </div>
                {(!modelsReady || !cameraReady) && !cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 text-white text-sm gap-2">
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    <span>{modelsReady ? 'Starting camera stream...' : 'Loading local face recognition models...'}</span>
                  </div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 p-4 text-center text-sm text-red-300">
                    {cameraError}
                  </div>
                )}
              </div>

              {/* Real-time Guidance & Checks Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">1. Face Detection</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {analysis
                      ? analysis.faceCount === 1
                        ? '1 Face Detected'
                        : analysis.faceCount === 0
                          ? 'No Face Visible'
                          : `${analysis.faceCount} Faces (Rejected)`
                      : 'Analyzing...'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">2. Lighting & Framing</div>
                  <div className="font-semibold text-slate-900 mt-1">
                    {analysis?.lightingOk && analysis.centeringOk && analysis.sizeOk && analysis.poseOk
                      ? 'Optimal Lighting & Frame'
                      : analysis?.guidanceMessage || 'Align face in oval'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-slate-500">
                    {mode === 'enroll' ? '3. Enrollment Samples' : '3. Liveness Check'}
                  </div>
                  <div className="font-semibold text-slate-900 mt-1 tabular-nums">
                    {mode === 'enroll'
                      ? `${samples.length} / 3 Samples Captured`
                      : livenessRequired
                        ? blinkDetected
                          ? 'Blink Verified'
                          : 'Please Blink Naturally'
                        : 'Optional'}
                  </div>
                </div>
              </div>

              {mode === 'verify' && (
                <p className="text-xs text-slate-500 leading-relaxed">
                  Liveness transparency: Browser checks verify live eye blink (EAR) and frame-to-frame
                  descriptor variance, while identity matching compares your 128D face vector against your
                  encrypted template on the backend. Basic camera liveness reduces static photo spoofing
                  but is not certified hardware-grade anti-spoofing; staff-assisted verification is
                  available whenever needed.
                </p>
              )}

              {testResult && (
                <div
                  className={`rounded-lg border px-4 py-3 text-xs flex items-start gap-2.5 ${
                    testResult.matched
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                      : 'border-red-300 bg-red-50 text-red-950'
                  }`}
                >
                  {testResult.matched ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-red-700 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-1">
                    <div className="font-bold">
                      {testResult.matched
                        ? `MATCHED with Face ID ${testResult.faceId}`
                        : `NOT MATCHED with Face ID ${testResult.faceId}`}
                    </div>
                    <p>{testResult.message}</p>
                    <p className="text-[11px] opacity-80 font-mono-tabular">
                      Distance: {testResult.distance.toFixed(3)} · Allowed Limit: {testResult.threshold.toFixed(2)} · Similarity Score: {Math.round(testResult.confidence * 100)}%
                    </p>
                  </div>
                </div>
              )}

              {errorMsg && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="space-y-1.5">
                    <p>{errorMsg}</p>
                    {mode === 'verify' &&
                      sessionId &&
                      onRequestAssistedFallback &&
                      (errorCode === 'OUTSIDE_GEOFENCE' ||
                        errorCode === 'LOCATION_REQUIRED' ||
                        errorCode === 'LIVENESS_FAILED' ||
                        errorCode === 'FACE_MISMATCH') && (
                        <button
                          type="button"
                          onClick={() =>
                            onRequestAssistedFallback(
                              sessionId,
                              errorMsg,
                              errorCode === 'OUTSIDE_GEOFENCE' || errorCode === 'LOCATION_REQUIRED'
                                ? 'location_bypass'
                                : 'liveness_assisted'
                            )
                          }
                          className="font-semibold text-blue-700 underline hover:text-blue-900"
                        >
                          Submit Staff-Assisted Verification Request Instead
                        </button>
                      )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                {mode === 'verify' && sessionId && onRequestAssistedFallback ? (
                  <button
                    type="button"
                    onClick={() =>
                      onRequestAssistedFallback(
                        sessionId,
                        'Camera, lighting, or GPS check could not complete; requesting staff-assisted verification.',
                        'liveness_assisted'
                      )
                    }
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 underline"
                  >
                    Camera/Location issue? Request Staff-Assisted Verification
                  </button>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    {mode === 'test' ? 'Done' : 'Cancel'}
                  </button>
                  {mode === 'enroll' ? (
                    <button
                      type="button"
                      disabled={!cameraReady || !modelsReady || submitting}
                      onClick={handleCaptureEnrollmentSample}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                    >
                      <Camera className="h-4 w-4" />
                      {submitting
                        ? 'Creating Face ID...'
                        : samples.length === 2
                          ? 'Capture Final Sample (3/3) & Create Face ID'
                          : `Capture Sample (${samples.length + 1}/3)`}
                    </button>
                  ) : mode === 'test' ? (
                    <button
                      type="button"
                      disabled={!cameraReady || !modelsReady || submitting}
                      onClick={handleTestFaceIdMatch}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      {submitting ? 'Checking Face ID...' : 'Check Face Match Now'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!cameraReady || !modelsReady || submitting}
                      onClick={handleVerifyAndMarkAttendance}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {submitting ? 'Verifying Face ID...' : 'Verify Face & Mark Present'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
