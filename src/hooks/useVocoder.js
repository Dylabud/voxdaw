import { useRef, useCallback, useState } from 'react';

const NUM_BANDS      = 16;
const BAND_MIN_HZ    = 100;
const BAND_MAX_HZ    = 8000;
const CARRIER_VOICES = 4;

// Initial defaults — overridable live via updateVocoderParams
const INIT_Q          = 2.5;
const INIT_ENV_HZ     = 20;
const INIT_MOD_GAIN   = 10;
const INIT_OUT_GAIN   = 6;
const INIT_MIX        = 1.0; // fully wet by default

const BAND_FREQS = (() => {
  const freqs = new Float32Array(NUM_BANDS);
  const logMin = Math.log(BAND_MIN_HZ);
  const logMax = Math.log(BAND_MAX_HZ);
  for (let i = 0; i < NUM_BANDS; i++) {
    freqs[i] = Math.exp(logMin + (i / (NUM_BANDS - 1)) * (logMax - logMin));
  }
  return freqs;
})();

// Full-wave rectifier: maps [-1, 1] → [0, 1] (|x|)
const RECTIFIER_CURVE = (() => {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    curve[i] = Math.abs((i * 2) / (n - 1) - 1);
  }
  return curve;
})();

export default function useVocoder() {
  const [isVocoderActive, setIsVocoderActive] = useState(false);

  const ctxRef         = useRef(null);
  const micStreamRef   = useRef(null);
  const micSourceRef   = useRef(null);
  const carrierBusRef  = useRef(null);
  const oscNodesRef    = useRef([]);
  const oscGainsRef    = useRef([]);
  const bandNodesRef   = useRef(null);
  const isActiveRef    = useRef(false);

  // Tunable node refs — written on start, read by updateVocoderParams
  const modPreGainRef  = useRef(null);
  const outputGainRef  = useRef(null);
  const wetGainRef     = useRef(null);
  const dryGainRef     = useRef(null);
  const analyserRef    = useRef(null);
  const modBPFsRef     = useRef([]);
  const carrBPFsRef    = useRef([]);
  const envLPsRef      = useRef([]);

  // Called every rAF frame from useAudioEngine.updateParams.
  // freqs: Hz array [root, (third), (fifth), (seventh)] — 1–4 elements.
  const updateNotes = useCallback((freqs) => {
    if (!isActiveRef.current) return;
    const ctx   = ctxRef.current;
    const oscs  = oscNodesRef.current;
    const gains = oscGainsRef.current;
    if (!ctx || !oscs.length) return;

    const now = ctx.currentTime;
    const amp = freqs.length > 0 ? 1 / freqs.length : 0; // equal-power mix
    for (let i = 0; i < CARRIER_VOICES; i++) {
      if (i < freqs.length) {
        oscs[i].frequency.setTargetAtTime(freqs[i], now, 0.01);
        gains[i].gain.setTargetAtTime(amp, now, 0.01);
      } else {
        gains[i].gain.setTargetAtTime(0, now, 0.01);
      }
    }
  }, []);

  // Live param updates — all changes use setTargetAtTime for glitch-free transitions.
  // q: BPF resonance (0.5–10), envHz: envelope LP cutoff (1–50),
  // modGain: mic pre-emphasis (1–30), outGain: reconstruction level (1–20),
  // mix: wet/dry 0.0–1.0 (linear crossfade).
  const updateVocoderParams = useCallback(({ q, envHz, modGain, outGain, mix }) => {
    if (!isActiveRef.current || !ctxRef.current) return;
    const now = ctxRef.current.currentTime;
    const τ = 0.02; // 20ms smoothing

    if (q !== undefined) {
      modBPFsRef.current.forEach(f => { f.Q.value = q; });
      carrBPFsRef.current.forEach(f => { f.Q.value = q; });
    }
    if (envHz !== undefined) {
      envLPsRef.current.forEach(f => { f.frequency.value = envHz; });
    }
    if (modGain !== undefined && modPreGainRef.current) {
      modPreGainRef.current.gain.setTargetAtTime(modGain, now, τ);
    }
    if (outGain !== undefined && outputGainRef.current) {
      outputGainRef.current.gain.setTargetAtTime(outGain, now, τ);
    }
    if (mix !== undefined && wetGainRef.current && dryGainRef.current) {
      wetGainRef.current.gain.setTargetAtTime(mix,       now, τ);
      dryGainRef.current.gain.setTargetAtTime(1 - mix,   now, τ);
    }
  }, []);

  // Populates dataArray with current frequency-domain data (Uint8Array, length = fftSize/2).
  const getAnalyserData = useCallback((dataArray) => {
    analyserRef.current?.getByteFrequencyData(dataArray);
  }, []);

  const startVocoder = useCallback(async () => {
    if (isActiveRef.current) return;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch {
      console.warn('useVocoder: microphone permission denied');
      return;
    }

    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    ctxRef.current = ctx;
    micStreamRef.current = stream;

    // ── Analyser → destination (final mix lands here) ─────────────
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;

    // ── Wet / Dry crossfade ───────────────────────────────────────
    const wetGain = ctx.createGain();
    wetGain.gain.value = INIT_MIX;
    wetGain.connect(analyser);
    wetGainRef.current = wetGain;

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1 - INIT_MIX;
    dryGain.connect(analyser);
    dryGainRef.current = dryGain;

    // ── Microphone source ─────────────────────────────────────────
    const micSource  = ctx.createMediaStreamSource(stream);
    micSourceRef.current = micSource;

    // Dry path: raw mic → dryGain (bypasses pre-emphasis so levels are natural)
    micSource.connect(dryGain);

    // Wet path: mic → modPreGain → 16-band vocoder → outputGain → wetGain
    const modPreGain = ctx.createGain();
    modPreGain.gain.value = INIT_MOD_GAIN;
    micSource.connect(modPreGain);
    modPreGainRef.current = modPreGain;

    // ── Carrier bus ───────────────────────────────────────────────
    const carrierBus = ctx.createGain();
    carrierBus.gain.value = 1;
    carrierBusRef.current = carrierBus;

    const oscs  = [];
    const gains = [];
    for (let i = 0; i < CARRIER_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 440;

      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;
      osc.connect(g);
      g.connect(carrierBus);
      osc.start();
      oscs.push(osc);
      gains.push(g);
    }
    oscNodesRef.current = oscs;
    oscGainsRef.current = gains;

    // ── Reconstruction output gain ────────────────────────────────
    const outputGain = ctx.createGain();
    outputGain.gain.value = INIT_OUT_GAIN;
    outputGain.connect(wetGain);
    outputGainRef.current = outputGain;

    // ── 16-band filter bank ───────────────────────────────────────
    const bands     = [];
    const modBPFs   = [];
    const carrBPFs  = [];
    const envLPs    = [];

    for (let i = 0; i < NUM_BANDS; i++) {
      const freq = BAND_FREQS[i];

      const modBPF = ctx.createBiquadFilter();
      modBPF.type = 'bandpass';
      modBPF.frequency.value = freq;
      modBPF.Q.value = INIT_Q;

      const rectifier = ctx.createWaveShaper();
      rectifier.curve = RECTIFIER_CURVE;
      rectifier.oversample = '2x';

      const envLP = ctx.createBiquadFilter();
      envLP.type = 'lowpass';
      envLP.frequency.value = INIT_ENV_HZ;

      const carrBPF = ctx.createBiquadFilter();
      carrBPF.type = 'bandpass';
      carrBPF.frequency.value = freq;
      carrBPF.Q.value = INIT_Q;

      // gain.value = 0 so the audio-rate envelope signal fully controls it
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;

      modPreGain.connect(modBPF);
      modBPF.connect(rectifier);
      rectifier.connect(envLP);
      envLP.connect(gainNode.gain);

      carrierBus.connect(carrBPF);
      carrBPF.connect(gainNode);
      gainNode.connect(outputGain);

      bands.push({ modBPF, rectifier, envLP, carrBPF, gainNode });
      modBPFs.push(modBPF);
      carrBPFs.push(carrBPF);
      envLPs.push(envLP);
    }

    bandNodesRef.current  = bands;
    modBPFsRef.current    = modBPFs;
    carrBPFsRef.current   = carrBPFs;
    envLPsRef.current     = envLPs;

    isActiveRef.current = true;
    setIsVocoderActive(true);
  }, []);

  const stopVocoder = useCallback(() => {
    if (!isActiveRef.current) return;

    oscNodesRef.current.forEach(osc => { try { osc.stop(); } catch (_) {} osc.disconnect(); });
    oscGainsRef.current.forEach(g => g.disconnect());
    oscNodesRef.current = [];
    oscGainsRef.current = [];

    micSourceRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micSourceRef.current = null;
    micStreamRef.current = null;

    carrierBusRef.current?.disconnect();
    carrierBusRef.current = null;

    bandNodesRef.current?.forEach(b => {
      b.modBPF.disconnect();
      b.rectifier.disconnect();
      b.envLP.disconnect();
      b.carrBPF.disconnect();
      b.gainNode.disconnect();
    });
    bandNodesRef.current = null;
    modBPFsRef.current   = [];
    carrBPFsRef.current  = [];
    envLPsRef.current    = [];

    modPreGainRef.current?.disconnect();   modPreGainRef.current  = null;
    outputGainRef.current?.disconnect();   outputGainRef.current  = null;
    wetGainRef.current?.disconnect();      wetGainRef.current     = null;
    dryGainRef.current?.disconnect();      dryGainRef.current     = null;
    analyserRef.current?.disconnect();     analyserRef.current    = null;

    ctxRef.current?.close();
    ctxRef.current = null;

    isActiveRef.current = false;
    setIsVocoderActive(false);
  }, []);

  return {
    startVocoder, stopVocoder,
    updateNotes, updateVocoderParams, getAnalyserData,
    isVocoderActive,
  };
}
