import * as faceapi from '@vladmandic/face-api';

let modelsLoaded = false;
let modelsLoadingPromise: Promise<void> | null = null;

export async function ensureFaceModelsLoaded(): Promise<void> {
  if (modelsLoaded) return;
  if (!modelsLoadingPromise) {
    modelsLoadingPromise = (async () => {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      ]);
      modelsLoaded = true;
    })().catch((err) => {
      modelsLoadingPromise = null;
      throw err;
    });
  }
  return modelsLoadingPromise;
}

export interface FrameAnalysisResult {
  faceCount: number;
  brightness: number; // 0..255
  lightingOk: boolean;
  centeringOk: boolean;
  sizeOk: boolean;
  poseOk: boolean;
  guidanceMessage: string;
  ear: number | null; // Eye Aspect Ratio for blink detection
  yawRatio: number | null; // Nose-to-eye horizontal ratio for head turn
  descriptor: number[] | null;
  box: { x: number; y: number; width: number; height: number } | null;
  boxCenter: { x: number; y: number } | null; // Normalized 0..1 center for anti-swap jump detection
}

export function computeNormalizedFaceDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] / normA - b[i] / normB;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function avgY(points: faceapi.Point[]): number {
  if (points.length === 0) return 0;
  return points.reduce((sum, p) => sum + p.y, 0) / points.length;
}

function computeEyeAspectRatio(eye: faceapi.Point[]): number {
  if (eye.length < 6) return 0.3;
  const v1 = dist(eye[1], eye[5]);
  const v2 = dist(eye[2], eye[4]);
  const h = dist(eye[0], eye[3]);
  if (h === 0) return 0.3;
  return (v1 + v2) / (2.0 * h);
}

function measureRegionBrightness(
  video: HTMLVideoElement,
  box?: { x: number; y: number; width: number; height: number }
): number {
  const canvas = document.createElement('canvas');
  const w = 96;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;
  ctx.drawImage(video, 0, 0, w, h);

  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  if (box && video.videoWidth > 0 && video.videoHeight > 0) {
    sx = Math.max(0, Math.floor((box.x / video.videoWidth) * w));
    sy = Math.max(0, Math.floor((box.y / video.videoHeight) * h));
    sw = Math.max(8, Math.min(w - sx, Math.floor((box.width / video.videoWidth) * w)));
    sh = Math.max(8, Math.min(h - sy, Math.floor((box.height / video.videoHeight) * h)));
  }

  const imageData = ctx.getImageData(sx, sy, sw, sh).data;
  let totalLuma = 0;
  const pixelCount = imageData.length / 4;
  for (let i = 0; i < imageData.length; i += 4) {
    totalLuma += 0.2126 * imageData[i] + 0.7152 * imageData[i + 1] + 0.0722 * imageData[i + 2];
  }
  return pixelCount > 0 ? totalLuma / pixelCount : 128;
}

function evaluatePose(landmarks: faceapi.FaceLandmarks68, box: { x: number; width: number }, scoreOk: boolean) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const mouth = landmarks.getMouth();
  const nose = landmarks.getNose();
  const jaw = landmarks.getJawOutline();

  const ear = (computeEyeAspectRatio(leftEye) + computeEyeAspectRatio(rightEye)) / 2;

  const leftEdge = jaw[0]?.x ?? box.x;
  const rightEdge = jaw[16]?.x ?? box.x + box.width;
  const noseTipX = nose[3]?.x ?? box.x + box.width / 2;
  const faceSpan = Math.max(1, rightEdge - leftEdge);
  const yawRatio = (noseTipX - leftEdge) / faceSpan;

  const eyeCenterY = (avgY(leftEye) + avgY(rightEye)) / 2;
  const mouthCenterY = avgY(mouth);
  const noseTipY = nose[3]?.y ?? (eyeCenterY + mouthCenterY) / 2;
  const verticalSpan = Math.max(1, mouthCenterY - eyeCenterY);
  const pitchRatio = (noseTipY - eyeCenterY) / verticalSpan;

  const poseOk =
    scoreOk &&
    yawRatio >= 0.34 &&
    yawRatio <= 0.66 &&
    pitchRatio >= 0.25 &&
    pitchRatio <= 0.75;

  return { ear, yawRatio, poseOk };
}

export async function analyzeVideoFrame(
  video: HTMLVideoElement,
  withDescriptor = false
): Promise<FrameAnalysisResult> {
  await ensureFaceModelsLoaded();

  if (withDescriptor) {
    const ssdOptions = new faceapi.SsdMobilenetv1Options({
      minConfidence: 0.78,
    });
    const detections = await faceapi
      .detectAllFaces(video, ssdOptions)
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length === 0) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: 0,
        brightness,
        lightingOk: brightness >= 50,
        centeringOk: false,
        sizeOk: false,
        poseOk: false,
        guidanceMessage:
          brightness < 50
            ? 'Poor lighting detected. Move to a brighter area and face the camera.'
            : 'No clear face detected. Position your face squarely inside the camera frame.',
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
        boxCenter: null,
      };
    }

    if (detections.length > 1) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: detections.length,
        brightness,
        lightingOk: brightness >= 50,
        centeringOk: false,
        sizeOk: false,
        poseOk: false,
        guidanceMessage: `Multiple faces detected (${detections.length}). Only one person may appear in the frame.`,
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
        boxCenter: null,
      };
    }

    const det = detections[0];
    const box = det.detection.box;
    const brightness = measureRegionBrightness(video, box);
    const lightingOk = brightness >= 50 && brightness <= 240;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const centerX = (box.x + box.width / 2) / vw;
    const centerY = (box.y + box.height / 2) / vh;
    const widthRatio = box.width / vw;

    const centeringOk = centerX > 0.25 && centerX < 0.75 && centerY > 0.2 && centerY < 0.8;
    const sizeOk = widthRatio >= 0.20 && widthRatio <= 0.75;

    const { ear, yawRatio, poseOk } = evaluatePose(
      det.landmarks,
      box,
      det.detection.score >= 0.78
    );

    let guidanceMessage = 'Face aligned and ready.';
    if (!lightingOk) {
      guidanceMessage =
        brightness < 50
          ? 'Poor lighting detected. Increase ambient light on your face.'
          : 'Overexposed lighting detected. Avoid direct glare behind you.';
    } else if (!sizeOk) {
      guidanceMessage =
        widthRatio < 0.20
          ? 'Move closer to the camera so your face fills the guide.'
          : 'Move slightly back from the camera.';
    } else if (!centeringOk) {
      guidanceMessage = 'Center your face inside the alignment guide.';
    } else if (!poseOk) {
      guidanceMessage = 'Look straight at the camera for clear frontal recognition.';
    }

    return {
      faceCount: 1,
      brightness,
      lightingOk,
      centeringOk,
      sizeOk,
      poseOk,
      guidanceMessage,
      ear,
      yawRatio,
      descriptor: Array.from(det.descriptor),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      boxCenter: { x: centerX, y: centerY },
    };
  } else {
    const detectorOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224,
      scoreThreshold: 0.5,
    });
    const detections = await faceapi
      .detectAllFaces(video, detectorOptions)
      .withFaceLandmarks();

    if (detections.length === 0) {
      const brightness = measureRegionBrightness(video);
      return {
        faceCount: 0,
        brightness,
        lightingOk: brightness >= 50,
        centeringOk: false,
        sizeOk: false,
        poseOk: false,
        guidanceMessage:
          brightness < 50
            ? 'Poor lighting detected. Move to a brighter area.'
            : 'No face detected. Position your face in the frame.',
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
        boxCenter: null,
      };
    }

    if (detections.length > 1) {
      return {
        faceCount: detections.length,
        brightness: 128,
        lightingOk: true,
        centeringOk: false,
        sizeOk: false,
        poseOk: false,
        guidanceMessage: `Multiple faces detected (${detections.length}). Ensure only your face is visible.`,
        ear: null,
        yawRatio: null,
        descriptor: null,
        box: null,
        boxCenter: null,
      };
    }

    const det = detections[0];
    const box = det.detection.box;
    const brightness = measureRegionBrightness(video, box);
    const lightingOk = brightness >= 50 && brightness <= 240;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const centerX = (box.x + box.width / 2) / vw;
    const centerY = (box.y + box.height / 2) / vh;
    const widthRatio = box.width / vw;
    const centeringOk = centerX > 0.25 && centerX < 0.75 && centerY > 0.2 && centerY < 0.8;
    const sizeOk = widthRatio >= 0.20 && widthRatio <= 0.75;

    const { ear, yawRatio, poseOk } = evaluatePose(det.landmarks, box, true);

    let guidanceMessage = 'Face detected. Follow the liveness prompt.';
    if (!lightingOk) {
      guidanceMessage =
        brightness < 50 ? 'Poor lighting detected. Increase light.' : 'Excessive glare detected.';
    } else if (!sizeOk) {
      guidanceMessage = widthRatio < 0.20 ? 'Move closer to camera.' : 'Move slightly back.';
    } else if (!centeringOk) {
      guidanceMessage = 'Center your face in the frame.';
    } else if (!poseOk) {
      guidanceMessage = 'Face the camera straight-on.';
    }

    return {
      faceCount: 1,
      brightness,
      lightingOk,
      centeringOk,
      sizeOk,
      poseOk,
      guidanceMessage,
      ear,
      yawRatio,
      descriptor: null,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      boxCenter: { x: centerX, y: centerY },
    };
  }
}
