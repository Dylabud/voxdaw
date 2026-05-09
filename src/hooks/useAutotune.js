import { useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';
import { YIN } from 'pitchfinder';
import { snapToNearest } from '../utils/dsp';
import { SCALES } from '../utils/scales';

const VOCAL_MIN_HZ = 45;   // covers down to ~F#1 (bass vocal floor)
const VOCAL_MAX_HZ = 1200;
// Detection runs at ~30 fps (every 2nd rAF frame at 60 fps)
const DETECTION_DT = 1 / 30;

// currentRootRef: ref from useAudioEngine holding the pitch hand's post-snap root Hz.
// Updated every rAF frame by updateParams. Consumed here in HAND mode to target the
// chord root instead of the nearest scale degree.
export default function useAutotune(currentRootRef, masterMixRef) {
  const [isAutotuneActive, setIsAutotuneActive] = useState(false);

  const isActiveRef      = useRef(false);
  const micRef           = useRef(null);
  const pitchShiftRef    = useRef(null);
  const analyserNodeRef  = useRef(null);
  const detectBufferRef  = useRef(null);
  const yinRef           = useRef(null);
  const rafIdRef         = useRef(null);
  const frameCountRef    = useRef(0);
  const scaleFreqsRef    = useRef(SCALES.cMajor);
  const tuneModeRef      = useRef('SCALE'); // 'SCALE' | 'HAND'
  const glideTimeRef     = useRef(0);       // seconds; 0 = instant snap
  // Hysteresis: track last target so we only update targetSemitonesRef on note change
  const lastTargetHzRef      = useRef(null);
  // Lerp accumulators: target is set on note change; current lerps toward it each frame
  const targetSemitonesRef   = useRef(0);
  const currentSemitonesRef  = useRef(0);

  // DOM element refs written imperatively by the rAF loop — zero React state in hot path
  const detectedNoteRef  = useRef(null);
  const correctedNoteRef = useRef(null);

  const setAutotuneScale = useCallback((key) => {
    scaleFreqsRef.current = SCALES[key] ?? SCALES.cMajor;
  }, []);

  const setAutotuneWet = useCallback((value) => {
    if (pitchShiftRef.current) pitchShiftRef.current.wet.value = value;
  }, []);

  const setAutotuneGlide = useCallback((val) => { glideTimeRef.current = val; }, []);

  const toggleTuneMode = useCallback(() => {
    tuneModeRef.current = tuneModeRef.current === 'SCALE' ? 'HAND' : 'SCALE';
  }, []);

  const startAutotune = useCallback(async () => {
    if (isActiveRef.current) return;

    // Ensure Tone.js AudioContext is running (idempotent — no-op if already started)
    await Tone.start();

    let mic;
    try {
      mic = new Tone.UserMedia();
      await mic.open();
    } catch {
      console.warn('useAutotune: microphone permission denied');
      return;
    }
    micRef.current = mic;

    // Dead-end analyser tap on the raw mic signal — BEFORE pitch shifting so YIN
    // sees the unmodified voice. 4096 samples covers down to ~10 Hz at 44100 Hz.
    const rawCtx   = Tone.getContext().rawContext;
    const analyser = rawCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0; // raw waveform — no temporal smoothing
    mic.connect(analyser);
    analyserNodeRef.current = analyser;
    detectBufferRef.current = new Float32Array(analyser.fftSize);

    // Processing chain: mic → PitchShift (wet=1 = 100% corrected) → Destination
    const pitchShift = new Tone.PitchShift({ windowSize: 0.04, pitch: 0 });
    pitchShift.wet.value = 1;
    mic.connect(pitchShift);
    if (masterMixRef?.current) {
      pitchShift.connect(masterMixRef.current);
    } else {
      pitchShift.toDestination();
    }
    pitchShiftRef.current = pitchShift;

    // Create YIN detector calibrated to the actual Tone.js sample rate
    yinRef.current = YIN({ sampleRate: Tone.getContext().sampleRate });
    frameCountRef.current    = 0;
    lastTargetHzRef.current  = null;
    targetSemitonesRef.current  = 0;
    currentSemitonesRef.current = 0;

    // rAF detection loop gated to ~30 fps (every 2nd frame).
    // YIN on 4096 samples is O(n²) — gating halves CPU load vs 60 fps.
    const loop = () => {
      rafIdRef.current = requestAnimationFrame(loop);
      frameCountRef.current++;
      if (frameCountRef.current % 2 !== 0) return;

      analyserNodeRef.current.getFloatTimeDomainData(detectBufferRef.current);
      const freq = yinRef.current(detectBufferRef.current);

      if (freq && freq > VOCAL_MIN_HZ && freq < VOCAL_MAX_HZ) {
        // HAND mode: target the chord root; SCALE mode: snap to nearest scale degree
        const targetHz = (tuneModeRef.current === 'HAND' && currentRootRef?.current)
          ? currentRootRef.current
          : snapToNearest(freq, scaleFreqsRef.current);

        // Hysteresis: only recompute target semitones when the target note changes.
        // Tone.PitchShift.pitch is a plain number setter — not a Tone Signal/Param.
        if (targetHz !== lastTargetHzRef.current) {
          lastTargetHzRef.current = targetHz;
          targetSemitonesRef.current = 12 * Math.log2(targetHz / freq);
        }

        // Exponential lerp from current to target.
        // τ = glide/3 → reaches ~95% of target in glideTime seconds.
        // At glide=0: alpha=1 → instant snap (T-Pain hard-tune preserved).
        const glide = glideTimeRef.current;
        const alpha = glide < 0.005 ? 1 : 1 - Math.exp(-DETECTION_DT / (glide / 3));
        currentSemitonesRef.current += alpha * (targetSemitonesRef.current - currentSemitonesRef.current);
        pitchShiftRef.current.pitch = currentSemitonesRef.current;

        if (detectedNoteRef.current)  detectedNoteRef.current.textContent  = Tone.Frequency(freq).toNote();
        if (correctedNoteRef.current) correctedNoteRef.current.textContent = Tone.Frequency(targetHz).toNote();
      }
    };
    rafIdRef.current = requestAnimationFrame(loop);

    isActiveRef.current = true;
    setIsAutotuneActive(true);
  }, [currentRootRef]);

  const stopAutotune = useCallback(() => {
    if (!isActiveRef.current) return;

    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;

    micRef.current?.close();
    micRef.current?.dispose();
    micRef.current = null;

    analyserNodeRef.current?.disconnect();
    analyserNodeRef.current = null;
    detectBufferRef.current = null;
    yinRef.current = null;

    pitchShiftRef.current?.dispose();
    pitchShiftRef.current = null;

    lastTargetHzRef.current     = null;
    targetSemitonesRef.current  = 0;
    currentSemitonesRef.current = 0;
    tuneModeRef.current = 'SCALE'; // reset to default so re-engage starts clean

    isActiveRef.current = false;
    setIsAutotuneActive(false);
  }, []);

  return {
    startAutotune, stopAutotune,
    isAutotuneActive,
    setAutotuneScale, setAutotuneWet, setAutotuneGlide,
    toggleTuneMode,
    detectedNoteRef, correctedNoteRef,
  };
}
