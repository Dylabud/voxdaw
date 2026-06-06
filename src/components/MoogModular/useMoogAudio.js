import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Sequencer pitch range — same as VCO FREQ knob (C1–C6)
const SEQ_HZ_MIN = 32.703;
const SEQ_HZ_MAX = 1046.502;

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

// Maps all jack IDs to Tone.js port descriptors.
// type:'out' → source node (plus optional waveform to set before connecting)
// type:'in'  → destination: ToneAudioNode (audio input) or AudioParam (CV input)
// dest:null  → deferred jack (patching does nothing until a later phase wires it)
function buildJackMap(n) {
  return {
    // ── VCO 1 ──
    // cv  → direct to frequency: Hz-range sources (sequencer, keyboard) patch here
    // fm  → through vco1fm Gain(500): LFO/audio-rate mod — ±1 signal → ±500 Hz
    'vco1-cv':  { type: 'in',  dest: n.vco1.frequency },
    'vco1-fm':  { type: 'in',  dest: n.vco1fm },
    'vco1-sin': { type: 'out', node: n.vco1, waveform: 'sine'      },
    'vco1-tri': { type: 'out', node: n.vco1, waveform: 'triangle'  },
    'vco1-saw': { type: 'out', node: n.vco1, waveform: 'sawtooth'  },
    'vco1-sqr': { type: 'out', node: n.vco1, waveform: 'square'    },
    // ── VCO 2 ──
    'vco2-cv':  { type: 'in',  dest: n.vco2.frequency },
    'vco2-fm':  { type: 'in',  dest: n.vco2fm },
    'vco2-sin': { type: 'out', node: n.vco2, waveform: 'sine'      },
    'vco2-tri': { type: 'out', node: n.vco2, waveform: 'triangle'  },
    'vco2-saw': { type: 'out', node: n.vco2, waveform: 'sawtooth'  },
    'vco2-sqr': { type: 'out', node: n.vco2, waveform: 'square'    },
    // ── VCO 3 ──
    'vco3-cv':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-fm':  { type: 'in',  dest: n.vco3fm },
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
    // cv1/cv2 → vcfcv1/vcfcv2 Gain(5000): LFO ±1 → ±5000 Hz — sweeps full audible spectrum
    // env     → vcfenv Gain(1000):         env  0→1 →  0→1000 Hz lift above base cutoff
    'vcf-in':  { type: 'in',  dest: n.vcf },
    'vcf-cv1': { type: 'in',  dest: n.vcfcv1 },
    'vcf-cv2': { type: 'in',  dest: n.vcfcv2 },
    'vcf-env': { type: 'in',  dest: n.vcfenv },
    'vcf-out': { type: 'out', node: n.vcf },
    // ── VCA ──
    'vca-in':  { type: 'in',  dest: n.vca },
    'vca-cv':  { type: 'in',  dest: n.vca.gain },
    'vca-out': { type: 'out', node: n.seqGateNode }, // seqGateNode is the gated tap — Loop controls gain
    // ── Reverb ──
    'reverb-in':  { type: 'in',  dest: n.reverb },
    'reverb-out': { type: 'out', node: n.reverb },
    // ── ENV 1 ── gate jack wired to gateActionsRef by connect(); trig deferred
    'env1-gate': { type: 'in', dest: null, isGate: true, envId: 'env1' },
    'env1-trig': { type: 'in', dest: null },
    'env1-out':  { type: 'out', node: n.env1 },
    // ── ENV 2 ──
    'env2-gate': { type: 'in', dest: null, isGate: true, envId: 'env2' },
    'env2-trig': { type: 'in', dest: null },
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
    // ── Sequencer ──
    'seq-pitch-out': { type: 'out', node: n.seqPitchOut },
    'seq-gate-out':  { type: 'out', node: null, isGate: true },
    'seq-clk-in':    { type: 'in',  dest: null },
    'seq-clk-out':   { type: 'out', node: null },
    // ── Keyboard ──
    'kbd-pitch-out': { type: 'out', node: n.kbdPitchOut },
    'kbd-gate-out':  { type: 'out', node: null, isGate: true },
    // ── I/O ── audio signal enters the I/O module here and exits to Destination
    'io-in': { type: 'in', dest: n.master },
  };
}

export default function useMoogAudio() {
  const [isPowered, setIsPowered] = useState(false);

  const isPoweredRef      = useRef(false);
  const nodesRef          = useRef(null);
  const jackMapRef        = useRef(null);
  const connectionsRef    = useRef(new Map()); // key: "fromId→toId" → { node, dest }
  const seqLoopRef        = useRef(null);
  const seqStepsRef       = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true })));
  const seqCurrentStepRef = useRef(-1);
  const seqStepCbRef      = useRef(null);   // UI callback for LED animation
  const gateActionsRef    = useRef(new Map()); // toJackId → Tone.Envelope

  useEffect(() => {
    const n = {
      vco1:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco2:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco3:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      noiseW:      new Tone.Noise({ type: 'white' }),
      noiseP:      new Tone.Noise({ type: 'pink'  }),
      cp3ch1:      new Tone.Gain(0.8),
      cp3ch2:      new Tone.Gain(0.8),
      cp3ch3:      new Tone.Gain(0.8),
      cp3ch4:      new Tone.Gain(0.8),
      cp3bus:      new Tone.Gain(0.7),
      vcf:         new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vca:         new Tone.Gain(1.0),
      env1:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env2:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      lfo:         new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),
      master:      new Tone.Volume(-14),             // no longer goes direct to Destination
      seqMasterGate: new Tone.Gain(1).toDestination(), // sole gateway to speakers — Loop gates here
      analyser:    new Tone.Analyser('waveform', 512),
      seqPitchOut: new Tone.Signal(SEQ_HZ_MIN), // never init to 0 — exponential ramps from 0 are undefined
      kbdPitchOut: new Tone.Signal(SEQ_HZ_MIN), // keyboard pitch CV out — same non-zero init rule

      // Studio reverb — Freeverb (proven in this codebase via VoxTool arpReverb).
      // wet starts at 0 so patching in the reverb doesn't colour sound until MIX is raised.
      reverb: new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),

      // Sequencer hardware gate — sits between n.vca and the vca-out jack.
      // Tone.Loop is the sole writer: gain=1 (gate on) / gain=0 (gate off).
      // Because it lives on the vca-out side, it gates any downstream patch
      // (vca-out → io-in, etc.) without requiring an envelope cable.
      seqGateNode: new Tone.Gain(1),

      // Recording tap — side connection from seqMasterGate so the Workstation's
      // Tone.Recorder can capture Moog audio without touching the speaker path.
      moogBus: new Tone.Gain(1),

      // Level meters — dead-end side taps for LED feedback (no effect on audio routing).
      // smoothing controls the RMS window: higher = more averaged, lower = more transient-responsive.
      lfoMeter:    new Tone.Meter({ normalRange: true, smoothing: 0.7  }),
      env1Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      env2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      masterMeter: new Tone.Meter({ normalRange: true, smoothing: 0.2  }),

      // CV input scalers — LFO outputs -1..+1 which adds ±1 Hz directly to frequency
      // params: completely inaudible. These Gain nodes sit between a patch cable's source
      // and the AudioParam, scaling the signal to a musically useful range.
      //
      // vco?-cv (pitch CV) stays DIRECT to frequency — the sequencer outputs Hz values
      // (32–1046 Hz) and patches here; multiplying by 500 would wreck it.
      // vco?-fm (FM / LFO mod) goes through a ×500 scaler: LFO at depth=1 → ±500 Hz.
      //
      // VCF cv1/cv2 (LFO sweep) ×5000: sweeps most of the 20 Hz–20 kHz range at depth=1.
      // VCF env (envelope track) ×1000: envelope 0→1 lifts cutoff by 0–1000 Hz above base.
      vco1fm: new Tone.Gain(500),
      vco2fm: new Tone.Gain(500),
      vco3fm: new Tone.Gain(500),
      vcfcv1: new Tone.Gain(5000),
      vcfcv2: new Tone.Gain(5000),
      vcfenv: new Tone.Gain(1000),
    };

    // CP3 internal summing — channels always sum to bus (internal mixer architecture,
    // not a patch cable concern). Everything else starts fully disconnected.
    n.cp3ch1.connect(n.cp3bus);
    n.cp3ch2.connect(n.cp3bus);
    n.cp3ch3.connect(n.cp3bus);
    n.cp3ch4.connect(n.cp3bus);

    // CV scaler hardwires — permanent front-doors for modulation inputs.
    // Sources patched to the FM / CV1 / CV2 / ENV jacks flow through these gains
    // before reaching the AudioParam; the scaler itself is never a patch destination.
    n.vco1fm.connect(n.vco1.frequency);
    n.vco2fm.connect(n.vco2.frequency);
    n.vco3fm.connect(n.vco3.frequency);
    n.vcfcv1.connect(n.vcf.frequency);
    n.vcfcv2.connect(n.vcf.frequency);
    n.vcfenv.connect(n.vcf.frequency);

    // master → seqMasterGate → Destination: every patch cable that reaches io-in
    // flows through master, then seqMasterGate. The Loop gates seqMasterGate per step —
    // this silences ALL audio on gate-off steps regardless of how cables are routed.
    n.master.connect(n.seqMasterGate);

    // moogBus: side tap after the master gate, feeds the Workstation's Tone.Recorder.
    // Does not connect to Destination — purely a recording tap.
    n.seqMasterGate.connect(n.moogBus);

    // Oscilloscope and masterMeter tap from master (pre-gate so the scope still shows
    // waveform shape even on muted steps — useful for debugging patches).
    n.master.connect(n.analyser);

    // seqGateNode sits between VCA and the vca-out jack — secondary gate for vca-out path.
    n.vca.connect(n.seqGateNode);

    // Level meter taps — all dead-end side connections, do not affect audio routing.
    n.lfo.connect(n.lfoMeter);
    n.env1.connect(n.env1Meter);
    n.env2.connect(n.env2Meter);
    n.seqGateNode.connect(n.masterMeter);

    // Sequencer loop — 8th-note clock driven by Tone.Transport.
    // Advances step, sets seqPitchOut Hz, fires connected envelope gates,
    // and calls the UI LED callback (all on the main thread — safe per Tone.js design).
    const loop = new Tone.Loop((time) => {
      seqCurrentStepRef.current = (seqCurrentStepRef.current + 1) % 16;
      const idx  = seqCurrentStepRef.current;
      const step = seqStepsRef.current[idx];

      // Pitch CV — sample-accurate step change at exact note boundary
      const hz = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step.voltage);
      n.seqPitchOut.setValueAtTime(hz, time);

      // Hardware gate — sample-accurate silence on gate-off steps.
      // seqMasterGate sits between master volume and Destination, blocking ALL audio
      // regardless of how patch cables are routed. seqGateNode gates vca-out specifically.
      const gateVal = step.gate ? 1 : 0;
      n.seqMasterGate.gain.setValueAtTime(gateVal, time);
      n.seqGateNode.gain.setValueAtTime(gateVal, time);

      // Gate — trigger or release envelopes connected to seq-gate-out.
      // Gate OFF: explicitly fire triggerRelease so the previous note is
      // never left open (hanging note bug). Gate ON: attack + pre-scheduled
      // release at 80% of step duration gives clear note articulation.
      // gateActionsRef keyed by cable key so keyboard gates don't interfere.
      if (gateActionsRef.current.size > 0) {
        const stepDur = step.gate ? Tone.Time('8n').toSeconds() : 0;
        for (const [, { env, fromId }] of gateActionsRef.current) {
          if (fromId !== 'seq-gate-out') continue;
          if (step.gate) {
            env.triggerAttack(time);
            env.triggerRelease(time + stepDur * 0.8);
          } else {
            env.triggerRelease(time);
          }
        }
      }

      // Notify UI for LED animation (Tone callbacks execute on main thread)
      if (seqStepCbRef.current) seqStepCbRef.current(idx);
    }, '8n');

    seqLoopRef.current = loop;

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    return () => {
      [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      if (seqLoopRef.current) {
        try { seqLoopRef.current.stop(); } catch (_) {}
        try { seqLoopRef.current.dispose(); } catch (_) {}
        seqLoopRef.current = null;
      }
      try { Tone.Transport.stop(); } catch (_) {}
      Object.values(n).forEach(node => {
        try { node.dispose(); } catch (_) {}
      });
      connectionsRef.current.clear();
      gateActionsRef.current.clear();
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

    // Start sequencer clock — reset step so first tick lands on step 0
    seqCurrentStepRef.current = -1;
    Tone.Transport.start();
    seqLoopRef.current?.start(0);

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

    // Stop sequencer loop and clear active LED
    seqLoopRef.current?.stop();
    seqCurrentStepRef.current = -1;
    if (seqStepCbRef.current) seqStepCbRef.current(-1); // signal LEDs to clear
    Tone.Transport.stop();

    // Re-open both gates so keyboard / manual playing is audible after sequencer stops.
    // Last gate-off step may have left them closed.
    n.seqMasterGate.gain.value = 1;
    n.seqGateNode.gain.value   = 1;

    setIsPowered(false);
  }, []);

  const connect = useCallback((fromId, toId) => {
    const jm = jackMapRef.current;
    const n  = nodesRef.current;
    if (!jm || !n) return;

    const from = jm[fromId];
    const to   = jm[toId];
    if (!from || !to) return;

    const key = `${fromId}→${toId}`;
    if (connectionsRef.current.has(key)) return;

    // Gate cable: any isGate out → env?-gate — register programmatic trigger.
    // Keyed by full cable key so kbd-gate and seq-gate can both connect to the
    // same env jack independently without overwriting each other.
    if (from.isGate && to.isGate) {
      const env = n[to.envId];
      if (env) {
        gateActionsRef.current.set(key, { env, fromId });
        connectionsRef.current.set(key, { isGate: true, toId });
      }
      return;
    }

    if (from.type !== 'out' || to.type !== 'in') return;
    if (to.dest === null) return;   // deferred jack — silently no-op
    if (from.node === null) return; // unimplemented output (e.g. seq-clk-out)

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

    if (conn.isGate) {
      gateActionsRef.current.delete(key); // keyed by cable key, not toId
      connectionsRef.current.delete(key);
      return;
    }

    try {
      conn.node.disconnect(conn.dest);
    } catch (e) {
      console.warn(`[MoogAudio] disconnect ${key}:`, e.message);
    }
    connectionsRef.current.delete(key);
  }, []);

  // Update VCO audio parameters — single writer per node.
  // vcoId: 'vco1' | 'vco2' | 'vco3'
  //
  // Uses setTargetAtTime (τ=20ms) instead of safeRamp/rampTo for frequency and detune.
  // Reason: rampTo dispatches to exponentialRampTo for frequency-type AudioParams.
  // Exponential ramps are undefined at 0 — if seqPitchOut (initialized to 0 before this
  // fix) schedules a setValueAtTime(0) on the same AudioParam via a patch cable, the
  // subsequent exponential ramp crashes: "Value must be within [0, 0]".
  // setTargetAtTime bypasses Tone.js assertRange, accepts any value, and approaches the
  // target asymptotically (never actually reaches 0), so it is safe in all cases.
  const updateVcoParams = useCallback((vcoId, { hz, detune, type } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    const vco = n[vcoId];
    if (!vco) return;
    if (hz     !== undefined) vco.frequency.setTargetAtTime(Math.max(0.1, hz), Tone.now(), 0.02);
    if (detune !== undefined) vco.detune.setTargetAtTime(detune, Tone.now(), 0.02);
    if (type   !== undefined) vco.type = type;
  }, []);

  // Update VCF audio parameters — single writer per node.
  // cutoff   (0–1) → exponential 20 Hz–20 kHz  (20 * 1000^cutoff)
  // resonance (0–1) → Q 0–20; floored at 0.001 — Q=0 fails exponential ramp.
  //
  // cutoff uses setTargetAtTime for the same reason as VCO frequency — it is a
  // frequency-type AudioParam where rampTo → exponentialRampTo, unsafe near 0.
  // resonance uses safeRamp (linear path, floor already applied, no crash risk).
  const updateVcfParams = useCallback(({ cutoff, resonance } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (cutoff    !== undefined) n.vcf.frequency.setTargetAtTime(
      20 * Math.pow(1000, cutoff), Tone.now(), 0.02
    );
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

  // Update reverb parameters — single writer on n.reverb.
  // roomSize (0–1): 0 = small/tight, 1 = large/diffuse.
  // wet      (0–1): dry/wet mix crossfade.
  const updateReverbParams = useCallback(({ roomSize, wet } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (roomSize !== undefined) safeRamp(n.reverb.roomSize, roomSize);
    if (wet      !== undefined) safeRamp(n.reverb.wet,      wet);
  }, []);

  // Update master output volume — single writer on n.master.volume.
  // volume (0–1) → -60 dB to +6 dB  (linear dB scale; 0.75 ≈ -13.5 dB, matching init)
  const updateIoParams = useCallback(({ volume } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (volume !== undefined) safeRamp(n.master.volume, -60 + volume * 66);
  }, []);

  // Returns the Moog recording bus node (Tone.Gain) for the Workstation's Tone.Recorder.
  // Returns null until the audio engine has initialised (before POWER is first clicked is fine —
  // the bus node exists from creation, not from powerOn).
  const getMoogBusNode = useCallback(() => nodesRef.current?.moogBus ?? null, []);

  // Returns the current waveform snapshot from the oscilloscope analyser tap.
  // Returns Float32Array of 512 samples in [-1, 1], or null before nodes are created.
  const getOscilloscopeData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.analyser.getValue();
  }, []);

  // Returns the normalised level [0, 1] from a named meter tap.
  // id: 'lfo' | 'env1' | 'env2' | 'master'
  // Returns 0 if nodes not yet created or id is unknown. Handles -Infinity (silence)
  // and NaN gracefully — Tone.Meter can return -Infinity in dB mode, but with
  // normalRange:true it returns 0 for silence, so isFinite is a safety net.
  const getMeterValue = useCallback((id) => {
    const n = nodesRef.current;
    if (!n) return 0;
    const meter = n[`${id}Meter`];
    if (!meter) return 0;
    const v = meter.getValue();
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }, []);

  // Sequencer BPM — ramps Transport tempo so the change is click-free.
  const setTempo = useCallback((bpm) => {
    Tone.Transport.bpm.rampTo(bpm, 0.1);
  }, []);

  // Push latest step data into the audio loop ref — no React state involved.
  const updateSequencerSteps = useCallback((steps) => {
    seqStepsRef.current = steps;
  }, []);

  // Register the UI step-advance callback (called inside Tone.Loop, main thread).
  // Pass null to deregister. The callback receives: (stepIndex: 0–7) | -1 (clear all).
  const setSeqStepCallback = useCallback((fn) => {
    seqStepCbRef.current = fn;
  }, []);

  // Keyboard pitch + gate control.
  // hz: the note frequency in Hz (e.g. Tone.Frequency("C4").toFrequency()).
  // isGateDown: true = note on (triggerAttack), false = note off (triggerRelease).
  // Only envelopes connected via kbd-gate-out are triggered; seq-gate-out is unaffected.
  const updateKeyboard = useCallback((hz, isGateDown) => {
    const n = nodesRef.current;
    if (!n) return;
    n.kbdPitchOut.setValueAtTime(hz, Tone.now());
    for (const [, { env, fromId }] of gateActionsRef.current) {
      if (fromId !== 'kbd-gate-out') continue;
      if (isGateDown) env.triggerAttack();
      else            env.triggerRelease();
    }
  }, []);

  return {
    powerOn, powerOff, connect, disconnect, isPowered,
    updateVcoParams, updateVcfParams, updateEnvParams, triggerGate, updateVcaParams,
    updateLfoParams, updateIoParams, updateReverbParams, getMoogBusNode,
    getOscilloscopeData, getMeterValue,
    setTempo, updateSequencerSteps, setSeqStepCallback, updateKeyboard,
  };
}
