import { useRef, useEffect, useCallback } from 'react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
  [0, 5], [0, 9], [0, 13], [0, 17],
  [5, 9], [9, 13], [13, 17],
];

function drawHands(ctx, landmarks, mapPoint) {
  landmarks.forEach((hand) => {
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = '#5DCAA5';
    ctx.lineWidth = 1.5;
    HAND_CONNECTIONS.forEach(([a, b]) => {
      const [ax, ay] = mapPoint(hand[a]);
      const [bx, by] = mapPoint(hand[b]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    });

    ctx.globalAlpha = 1.0;
    ctx.fillStyle = '#5DCAA5';
    hand.forEach((pt) => {
      const [x, y] = mapPoint(pt);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

export default function useHandTracking(videoRef, isActive, onLandmarks) {
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const isReadyRef = useRef(false);
  const rafIdRef = useRef(null);
  const onLandmarksRef = useRef(onLandmarks);
  useEffect(() => { onLandmarksRef.current = onLandmarks; }, [onLandmarks]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      if (!cancelled) {
        landmarkerRef.current = landmarker;
        isReadyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !landmarkerRef.current) return;

    const ctx = canvas.getContext('2d');

    const tick = () => {
      if (video.readyState < 2) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      const W_c = canvas.offsetWidth;
      const H_c = canvas.offsetHeight;
      if (canvas.width !== W_c || canvas.height !== H_c) {
        canvas.width = W_c;
        canvas.height = H_c;
      }

      const W_v = video.videoWidth;
      const H_v = video.videoHeight;
      const scale = Math.max(W_c / W_v, H_c / H_v);
      const cropX = (W_v * scale - W_c) / 2;
      const cropY = (H_v * scale - H_c) / 2;
      const mapPoint = (pt) => [
        pt.x * W_v * scale - cropX,
        pt.y * H_v * scale - cropY,
      ];

      const result = landmarkerRef.current.detectForVideo(video, performance.now());
      ctx.clearRect(0, 0, W_c, H_c);
      if (result.landmarks.length > 0) {
        drawHands(ctx, result.landmarks, mapPoint);
        onLandmarksRef.current?.(result.landmarks, result.handednesses);
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [videoRef]);

  const stopLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  useEffect(() => {
    if (isActive) {
      if (isReadyRef.current) {
        startLoop();
      } else {
        const poll = setInterval(() => {
          if (isReadyRef.current) {
            clearInterval(poll);
            startLoop();
          }
        }, 100);
        return () => clearInterval(poll);
      }
    } else {
      stopLoop();
    }
    return stopLoop;
  }, [isActive, startLoop, stopLoop]);

  return canvasRef;
}
