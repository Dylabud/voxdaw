import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Safe parameter ramp.
//
// Problem: Tone.js Param.rampTo() calls assertRange(value, param.minValue, param.maxValue).
// When the AudioContext is suspended (before Tone.start()), AudioParams report
// minValue = maxValue = 0, so any non-zero value throws RangeError [0, 0].
// Additionally, for exponential-type params (frequency, Q), a target of 0 or a
// Tone-internal substitution of 1e-7 also triggers this check.
//
// Fix: use direct .value assignment (always valid regardless of context state) when the
// context is not running, and rampTo() only when it is running.  This also initialises
// params correctly so they are set to the right value the moment powerOn() resumes the context.
function safeRamp(param, value, rampTime = 0.05) {
  if (Tone.context.state === 'running') {
    param.rampTo(value, rampTime);
  } else {
    param.value = value;
  }
}

// Maps all 52 jack IDs to Tone.js port descriptors.
// type:'out' → source node (plus optional waveform to set before connecting)
// type:'in'  → destination: ToneAudioNode (audio input) or AudioParam (CV input)
// dest:null  → deferred jack (patching does nothing until a later phase wires it)
function buildJackMap(n) {
  return {
    // ── VCO 1 ──
    'vco1-cv':  { type: 'in',  dest: n.vco1.frequency },
    'vco1-fm':  { type: 'in',  dest: n.vco1.frequency },
    'vco1-sin': { type: 'out', node: n.vco1, waveform: 'sine'      },
    'vco1-tri': { type: 'out', node: n.vco1, waveform: 'triangle'  },
    'vco1-saw': { type: 'out', node: n.vco1, waveform: 'sawtooth'  },
    'vco1-sqr': { type: 'out', node: n.vco1, waveform: 'square'    },
    // ── VCO 2 ──
    'vco2-cv':  { type: 'in',  dest: n.vco2.frequency },
    'vco2-fm':  { type: 'in',  dest: n.vco2.frequency },
    'vco2-sin': { type: 'out', node: n.vco2, waveform: 'sine'      },
    'vco2-tri': { type: 'out', node: n.vco2, waveform: 'triangle'  },
    'vco2-saw': { type: 'out', node: n.vco2, waveform: 'sawtooth'  },
    'vco2-sqr': { type: 'out', node: n.vco2, waveform: 'square'    },
    // ── VCO 3 ──
    'vco3-cv':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-fm':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-sin': { type: 'out', node: n.vco3, waveform: 'sine'      },
    'vco3-tri': { type: 'out', node: n.vco3, waveform: 'triangle'  },
    'vco3-saw': { type: 'out', node: n.vco3, waveform: 'sawtooth'  },
    'vco3-sqr': { type: 'out', node: n.vco3, waveform: 'square'    },
    // ── Noise ──
    'noise-wht': { type: 'out', node: n.noiseW },
    'noise-pnk': { type: 'out', node: n.noiseP },
    // ── CP3 Mixer ──
    'cp3-in1': { type: 'in',  dest: n.cp3ch1 },
    'cp3-in2': { type: 'in',  dest: n.cp3ch2 },
    'cp3-in3': { type: 'in',  dest: n.cp3ch3 },
    'cp3-in4': { type: 'in',  dest: n.cp3ch4 },
    'cp3-out': { type: 'out', node: n.cp3bus },
    // ── VCF ──
    'vcf-in':  { type: 'in',  dest: n.vcf },
    'vcf-cv1': { type: 'in',  dest: n.vcf.frequency },
    'vcf-cv2': { type: 'in',  dest: n.vcf.frequency },
    'vcf-env': { type: 'in',  dest: n.vcf.frequency },
    'vcf-out': { type: 'out', node: n.vcf },
    // ── VCA ──
    'vca-in':  { type: 'in',  dest: n.vca },
    'vca-cv':  { type: 'in',  dest: n.vca.gain },
    'vca-out': { type: 'out', node: n.vca },
    // ── ENV 1 ── (gate/trig deferred to Phase 6; out available as CV source)
    'env1-gate': { type: 'in',  dest: null },
    'env1-trig': { type: 'in',  dest: null },
    'env1-out':  { type: 'out', node: n.env1 },
    // ── ENV 2 ──
    'env2-gate': { type: 'in',  dest: null },
    'env2-trig': { type: 'in',  dest: null },
    'env2-out':  { type: 'out', node: n.env2 },
    // ── LFO ──
    'lfo-sync': { type: 'in',  dest: null },
    'lfo-sin':  { type: 'out', node: n.lfo, waveform: 'sine'      },
    'lfo-tri':  { type: 'out', node: n.lfo, waveform: 'triangle'  },
    'lfo-sqr':  { type: 'out', node: n.lfo, waveform: 'square'    },
    'lfo-saw':  { type: 'out', node: n.lfo, waveform: 'sawtooth'  },
    // ── Multiples (passive routing — deferred to Phase 7 audio wiring) ──
    'mult-a1': { type: 'in', dest: null }, 'mult-a2': { type: 'in', dest: null },
    'mult-a3': { type: 'in', dest: null }, 'mult-a4': { type: 'in', dest: null },
    'mult-b1': { type: 'in', dest: null }, 'mult-b2': { type: 'in', dest: null },
    'mult-b3': { type: 'in', dest: null }, 'mult-b4': { type: 'in', dest: null },
    // ── I/O ── audio signal enters the I/O module here and exits to Destination
    'io-in': { type: 'in', dest: n.master },
  };
}

export default function useMoogAudio() {
  const [isPowered, setIsPowered] = useState(false);

  const isPoweredRef   = useRef(false);
  const nodesRef       = useRef(null);
  const jackMapRef     = useRef(null);
  const connectionsRef = useRef(new Map()); // key: "fromId→toId" → { node, dest }

  useEffect(() => {
    const n = {
      vco1:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco2:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco3:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      noiseW: new Tone.Noise({ type: 'white' }),
      noiseP: new Tone.Noise({ type: 'pink'  }),
      cp3ch1: new Tone.Gain(0.8),
      cp3ch2: new Tone.Gain(0.8),
      cp3ch3: new Tone.Gain(0.8),
      cp3ch4: new Tone.Gain(0.8),
      cp3bus: new Tone.Gain(0.7),
      vcf:    new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vca:    new Tone.Gain(1.0),
      env1:   new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env2:   new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      lfo:    new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),
      master:   new Tone.Volume(-14).toDestination(),
      analyser: new Tone.Analyser('waveform', 512),
    };

    // CP3 internal summing — channels always sum to bus (internal mixer architecture,
    // not a patch cable concern). Everything else starts fully disconnected.
    n.cp3ch1.connect(n.cp3bus);
    n.cp3ch2.connect(n.cp3bus);
    n.cp3ch3.connect(n.cp3bus);
    n.cp3ch4.connect(n.cp3bus);

    // Oscilloscope tap — side connection after master volume, dead-end (no further output).
    // Tone.Analyser wraps a native AnalyserNode; connecting to it is additive and does not
    // affect the master → Destination path.
    n.master.connect(n.analyser);

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    return () => {
      [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      Object.values(n).forEach(node => {
        try { node.dispose(); } catch (_) {}
      });
      connectionsRef.current.clear();
      isPoweredRef.current = false;
    };
  }, []);

  const powerOn = useCallback(async () => {
    if (isPoweredRef.current) return;
    await Tone.start(); // satisfies browser autoplay policy
    isPoweredRef.current = true;

    const n = nodesRef.current;
    if (!n) return;
    [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
      try { node.start(); } catch (_) {}
    });

    setIsPowered(true);
  }, []);

  const powerOff = useCallback(() => {
    if (!isPoweredRef.current) return;
    isPoweredRef.current = false;

    const n = nodesRef.current;
    if (!n) return;
    [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
      try { node.stop(); } catch (_) {}
    });

    setIsPowered(false);
  }, []);

  const connect = useCallback((fromId, toId) => {
    const jm = jackMapRef.current;
    if (!jm) return;

    const from = jm[fromId];
    const to   = jm[toId];
    if (!from || !to) return;
    if (from.type !== 'out' || to.type !== 'in') return;
    if (to.dest === null) return; // deferred jack — silently no-op

    const key = `${fromId}→${toId}`;
    if (connectionsRef.current.has(key)) return;

    // Set VCO or LFO waveform to match the specific output jack patched
    if (from.waveform) from.node.type = from.waveform;

    try {
      from.node.connect(to.dest);
      connectionsRef.current.set(key, { node: from.node, dest: to.dest });
    } catch (e) {
      console.warn(`[MoogAudio] connect ${key}:`, e.message);
    }
  }, []);

  const disconnect = useCallback((fromId, toId) => {
    const key  = `${fromId}→${toId}`;
    const conn = connectionsRef.current.get(key);
    if (!conn) return;

    try {
      conn.node.disconnect(conn.dest);
    } catch (e) {
      console.warn(`[MoogAudio] disconnect ${key}:`, e.message);
    }
    connectionsRef.current.delete(key);
  }, []);

  // Update VCO audio parameters — single writer per node.
  // vcoId: 'vco1' | 'vco2' | 'vco3'
  const updateVcoParams = useCallback((vcoId, { hz, detune, type } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    const vco = n[vcoId];
    if (!vco) return;
    if (hz      !== undefined) safeRamp(vco.frequency, hz);
    if (detune  !== undefined) safeRamp(vco.detune, detune);
    if (type    !== undefined) vco.type = type;
  }, []);

  // Update VCF audio parameters — single writer per node.
  // cutoff   (0–1) → exponential 20 Hz–20 kHz  (20 * 1000^cutoff)
  // resonance (0–1) → Q 0–20; floored at 0.001 — Q=0 is mathematically equivalent to
  //   flat response but Tone.js uses exponential ramps for Q and can't ramp to/from 0.
  const updateVcfParams = useCallback(({ cutoff, resonance } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (cutoff    !== undefined) safeRamp(n.vcf.frequency, 20 * Math.pow(1000, cutoff));
    if (resonance !== undefined) safeRamp(n.vcf.Q, Math.max(0.001, resonance * 20));
  }, []);

  // Update Envelope ADSR params.  envId: 'env1' | 'env2'.
  // All time values use exponential mapping so short/long times feel equally reachable.
  // attack/decay/release: 0–1 → 0.01s–10s   sustain: 0–1 → 0.0–1.0 (linear)
  const updateEnvParams = useCallback((envId, { attack, decay, sustain, release } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    const env = n[envId];
    if (!env) return;
    if (attack  !== undefined) env.attack  = 0.01 * Math.pow(1000, attack);
    if (decay   !== undefined) env.decay   = 0.01 * Math.pow(1000, decay);
    if (sustain !== undefined) env.sustain = sustain;
    if (release !== undefined) env.release = 0.01 * Math.pow(1000, release);
  }, []);

  // Trigger or release an envelope gate.  envId: 'env1' | 'env2'.
  // Tone.Envelope outputs a 0–1 CV signal — when patched to vca-cv the Web Audio
  // API adds it to vca.gain's base value (set by the GAIN knob / updateVcaParams).
  const triggerGate = useCallback((envId, isDown) => {
    const n = nodesRef.current;
    if (!n) return;
    const env = n[envId];
    if (!env) return;
    if (isDown) env.triggerAttack();
    else        env.triggerRelease();
  }, []);

  // Update VCA initial gain (manual bias, 0–1 linear).
  // The VCA is Tone.Gain; env CV adds on top — set GAIN=0 for full envelope gating.
  const updateVcaParams = useCallback(({ gain } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (gain !== undefined) safeRamp(n.vca.gain, gain);
  }, []);

  // Update LFO parameters.
  // rate  (0–1) → exponential 0.1 Hz–30 Hz  (0.1 * 300^rate)
  // depth (0–1) → lfo.amplitude 0–1 (scales the ±1 output swing)
  // type  (string) → lfo.type; UI-driven default, overridden by whichever waveform jack
  //        is patched (the connect() function also sets lfo.type via from.waveform).
  const updateLfoParams = useCallback(({ rate, depth, type } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (rate  !== undefined) safeRamp(n.lfo.frequency, 0.1 * Math.pow(300, rate));
    if (depth !== undefined) safeRamp(n.lfo.amplitude, depth);
    if (type  !== undefined) n.lfo.type = type;
  }, []);

  // Update master output volume — single writer on n.master.volume.
  // volume (0–1) → -60 dB to +6 dB  (linear dB scale; 0.75 ≈ -13.5 dB, matching init)
  const updateIoParams = useCallback(({ volume } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (volume !== undefined) safeRamp(n.master.volume, -60 + volume * 66);
  }, []);

  // Returns the current waveform snapshot from the oscilloscope analyser tap.
  // Returns Float32Array of 512 samples in [-1, 1], or null before nodes are created.
  const getOscilloscopeData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.analyser.getValue();
  }, []);

  return {
    powerOn, powerOff, connect, disconnect, isPowered,
    updateVcoParams, updateVcfParams, updateEnvParams, triggerGate, updateVcaParams,
    updateLfoParams, updateIoParams, getOscilloscopeData,
  };
}
