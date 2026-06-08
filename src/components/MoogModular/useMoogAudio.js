import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Sequencer pitch range — same as VCO FREQ knob (C1–C6)
const SEQ_HZ_MIN = 32.703;
const SEQ_HZ_MAX = 1046.502;

// Quantizer scale definitions (semitone offsets from root).
// Sent to the quantizer AudioWorklet via port.postMessage.
const SCALE_DEFS = {
  CHR:  [0,1,2,3,4,5,6,7,8,9,10,11],
  MAJ:  [0,2,4,5,7,9,11],
  MIN:  [0,2,3,5,7,8,10],
  PMAJ: [0,2,4,7,9],
  PMIN: [0,3,5,7,10],
  // Chord intervals — used by chord-aware quantization (ChordSeqModule → Quantizer).
  // When the chord sequencer fires, it sets root AND scale to one of these interval arrays;
  // the quantizer then snaps incoming melody notes to chord tones only.
  CMAJ:  [0,4,7],
  CMIN:  [0,3,7],
  CDOM:  [0,4,7,10],
  CMAJ7: [0,4,7,11],
  CMIN7: [0,3,7,10],
  CSUS4: [0,5,7],
  CDIM:  [0,3,6],
};

// Base Hz for chord sequencer root CV output — C3 (MIDI 48).
// rootClass 0→11 maps to C3→B3 (130.81–246.94 Hz).
// All values > 10 Hz so the qnt-transpose-in analyser threshold correctly detects them.
const CHORD_BASE_HZ = 130.81;

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
    // Hard sync jacks — dest/node null until the AudioWorklet module loads.
    // connect() silently no-ops on null, so cables patched before worklet is
    // ready are harmless; jackMap is rebuilt once the worklet finishes loading.
    'vco2-sync-in':  { type: 'in',  dest: n.hardSyncNode ?? null },
    'vco2-sync-out': { type: 'out', node: n.vco2syncOut ?? null  },
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
    // ── Sequencer ──
    'seq-pitch-out': { type: 'out', node: n.seqPitchOut },
    'seq-gate-out':  { type: 'out', node: null, isGate: true },
    'seq-clk-in':    { type: 'in',  dest: null },
    'seq-clk-out':   { type: 'out', node: null },
    // ── Chord Sequencer ──
    'chordseq-cv-out': { type: 'out', node: n.chordSeqPitchOut },
    // ── Keyboard ──
    'kbd-pitch-out': { type: 'out', node: n.kbdPitchOut },
    'kbd-gate-out':  { type: 'out', node: null, isGate: true },
    // ── Quantizer ──
    // qnt-cv-in        → AudioWorkletNode audio input (null until worklet loads)
    // qnt-cv-out       → Tone.Gain wrapper (always live)
    // qnt-transpose-in → waveform analyser; rAF loop in QuantizerModule reads Hz → note class
    'qnt-cv-in':        { type: 'in',  dest: n.quantizerNode ?? null   },
    'qnt-cv-out':       { type: 'out', node: n.quantizerOut             },
    'qnt-transpose-in': { type: 'in',  dest: n.qntTransposeAnalyser    },
    // ── I/O ── audio signal enters the I/O module here and exits to Destination
    // io-in routes directly to master (legacy single-input path, kept for patch compat).
    // io-in1–4 each route through independent channel gain nodes → master.
    'io-in':  { type: 'in', dest: n.master },
    'io-in1': { type: 'in', dest: n.ioCh1  },
    'io-in2': { type: 'in', dest: n.ioCh2  },
    'io-in3': { type: 'in', dest: n.ioCh3  },
    'io-in4': { type: 'in', dest: n.ioCh4  },
  };
}

export default function useMoogAudio() {
  const [isPowered, setIsPowered] = useState(false);

  const isPoweredRef        = useRef(false);
  const nodesRef            = useRef(null);
  const jackMapRef          = useRef(null);
  const connectionsRef      = useRef(new Map()); // key: "fromId→toId" → { node, dest }
  const seqLoopRef          = useRef(null);
  const seqStepsRef         = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true })));
  const seqCurrentStepRef   = useRef(-1);
  const seqStepCbRef        = useRef(null);   // UI callback for sequencer LED animation
  const gateActionsRef      = useRef(new Map()); // toJackId → Tone.Envelope

  // Chord sequencer — separate slower-clocked 8-step pitch CV source.
  // Each step stores { rootClass: 0-11, chordType: keyof SCALE_DEFS }.
  // On step fire: outputs root Hz via chordSeqPitchOut AND calls chordSeqChordCbRef
  // with (rootClass, chordType) so MoogShell can sync the quantizer scale.
  const chordSeqLoopRef        = useRef(null);
  const chordSeqStepsRef       = useRef(
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [0, 0, 5, 5, 7, 7, 0, 0][i], // I IV V I default (C, C, F, F, G, G, C, C)
      chordType: 'CMAJ',
    }))
  );
  const chordSeqCurrentStepRef = useRef(-1);
  const chordSeqStepCbRef      = useRef(null);
  const chordSeqChordCbRef     = useRef(null); // fn(rootClass, chordType) — called on each step
  const chordSeqDivisionRef    = useRef('1m'); // default: advance every 1 bar
  const quantizerStepCbRef    = useRef(null);   // UI callback for quantizer LED animation
  const lastQuantizedMidiRef  = useRef(69);     // A4 default — updated on each note change
  // Persists latest quantizer config so it can be flushed when the worklet finishes loading.
  const quantizerParamsRef    = useRef({ scale: SCALE_DEFS.MAJ, root: 0, octShift: 0, bypass: false });

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
      seqPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // never init to 0 — exponential ramps from 0 are undefined
      kbdPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // keyboard pitch CV out — same non-zero init rule
      chordSeqPitchOut:  new Tone.Signal(SEQ_HZ_MIN), // chord sequencer root CV out — same rule

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

      // I/O 4-channel input gains — each sums independently into n.master.
      // Single writer per node: updateIoChannelVol owns these gain params.
      // Meters tap post-gain so LEDs show each channel's actual contribution.
      ioCh1: new Tone.Gain(0.8),
      ioCh2: new Tone.Gain(0.8),
      ioCh3: new Tone.Gain(0.8),
      ioCh4: new Tone.Gain(0.8),
      ioCh1Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh2Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh3Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh4Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),

      // Hard sync output wrapper — gain 0 until user enables HARD SYNC toggle.
      // AudioWorkletNode (hardSyncNode) connects here after the worklet loads.
      // Sits outside the jackMap initially (null); jackMap is rebuilt after load.
      vco2syncOut: new Tone.Gain(0),

      // Quantizer output wrapper — gain 1 (always pass-through).
      // AudioWorkletNode (quantizerNode) connects to .input after worklet loads.
      // Tone.Gain so that downstream Tone.js nodes (vco.frequency) can receive it.
      quantizerOut: new Tone.Gain(1),

      // Transposition CV analyser — taps the incoming TRANSPOSE CV signal so the
      // QuantizerModule's rAF loop can read the current Hz value and derive a note class.
      // Tone.Analyser with 'waveform' type calls getFloatTimeDomainData, which returns
      // the actual float values (Hz) from the ConstantSourceNode inside Tone.Signal.
      // When nothing is connected the analyser returns all zeros → avgHz = 0 < 10 → inactive.
      qntTransposeAnalyser: new Tone.Analyser('waveform', 256),

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

    // I/O channel gains → master: each channel has its own Gain node so the
    // 4-channel mixer faders are independent. Meters tap from the channel output
    // (post-gain) so LEDs reflect the actual contribution of each channel.
    n.ioCh1.connect(n.master);
    n.ioCh2.connect(n.master);
    n.ioCh3.connect(n.master);
    n.ioCh4.connect(n.master);
    n.ioCh1.connect(n.ioCh1Meter);
    n.ioCh2.connect(n.ioCh2Meter);
    n.ioCh3.connect(n.ioCh3Meter);
    n.ioCh4.connect(n.ioCh4Meter);

    // master → seqMasterGate → Destination: every patch cable that reaches io-in
    // or any io-inN channel flows through master, then seqMasterGate. The Loop gates
    // seqMasterGate per step — silences ALL audio on gate-off steps regardless of routing.
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

    // Chord sequencer loop — advances every chordSeqDivisionRef bars/beats.
    // step.rootClass (0-11) → Hz via CHORD_BASE_HZ (C3 * 2^(semitones/12)).
    // Also fires chordSeqChordCbRef so MoogShell can update the quantizer scale
    // to use this chord's interval set (chord-aware melody snapping).
    const chordLoop = new Tone.Loop((time) => {
      chordSeqCurrentStepRef.current = (chordSeqCurrentStepRef.current + 1) % 8;
      const idx  = chordSeqCurrentStepRef.current;
      const step = chordSeqStepsRef.current[idx];
      const hz   = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
      n.chordSeqPitchOut.setValueAtTime(hz, time);
      if (chordSeqStepCbRef.current) chordSeqStepCbRef.current(idx);
      if (chordSeqChordCbRef.current) chordSeqChordCbRef.current(step.rootClass, step.chordType);
    }, chordSeqDivisionRef.current);

    chordSeqLoopRef.current = chordLoop;

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    // rawCtx must be declared before either worklet load block — both share it.
    const rawCtx = Tone.context.rawContext;

    // Load the quantizer AudioWorklet asynchronously (parallel to hard sync load).
    let quantizerNode = null;
    rawCtx.audioWorklet.addModule('/quantizer-worklet.js').then(() => {
      if (nodesRef.current !== n) return;
      // Use Tone.context.createAudioWorkletNode() — NOT `new AudioWorkletNode(rawCtx, ...)`.
      // Tone.js wraps all nodes in standardized-audio-context (SAC). SAC's connect() throws
      // InvalidAccessError when connecting TO any node created outside its own registry
      // (i.e. native AudioWorkletNode). Tone.context.createAudioWorkletNode() creates a
      // SAC-wrapped node that is accepted by every SAC connect() call in the graph.
      quantizerNode = Tone.context.createAudioWorkletNode('quantizer-processor');
      n.quantizerNode = quantizerNode;

      // Connect worklet output to the Tone.Gain wrapper via its native GainNode.
      // (Same pattern as hard sync: native AudioWorkletNode.connect() needs native AudioNode.)
      quantizerNode.connect(n.quantizerOut.input);

      // Flush the latest scale/root config that may have been set before the worklet loaded.
      quantizerNode.port.postMessage(quantizerParamsRef.current);

      // Route port messages to the UI callback (delta-checked inside the worklet).
      // noteClass/midiNote → LED + display update.
      // hasSignal → IN LED update (fires only on cable connect/disconnect).
      // The callback signature is (noteClass, midiNote, hasSignal); null noteClass
      // means "signal-state-only update — skip LED/display logic."
      quantizerNode.port.onmessage = ({ data }) => {
        if (data.midiNote !== undefined) lastQuantizedMidiRef.current = data.midiNote;
        if (quantizerStepCbRef.current) {
          if (data.noteClass !== undefined) {
            quantizerStepCbRef.current(data.noteClass, data.midiNote, undefined);
          }
          if (data.hasSignal !== undefined) {
            quantizerStepCbRef.current(null, null, data.hasSignal);
          }
        }
      };

      // Rebuild jackMap so qnt-cv-in is now live (was dest:null before worklet loaded).
      jackMapRef.current = buildJackMap(n);
    }).catch(err => {
      console.warn('[MoogAudio] Quantizer worklet unavailable:', err);
    });

    // Load the hard sync AudioWorklet asynchronously.
    // All Tone.js nodes above are already live; this just adds the worklet-backed
    // slave oscillator. If the load fails (unsupported browser, etc.), the sync
    // jacks remain no-ops and everything else works normally.
    let hardSyncNode = null;
    rawCtx.audioWorklet.addModule('/hard-sync-worklet.js').then(() => {
      if (nodesRef.current !== n) return; // same guard as quantizer block above
      hardSyncNode = Tone.context.createAudioWorkletNode('hard-sync-processor'); // same SAC-wrap reason
      n.hardSyncNode = hardSyncNode;

      // Route VCO2's FM scaler to the worklet's slaveFreq AudioParam (additive).
      // Envelope or LFO patched to vco2-fm will now modulate both VCO2.frequency
      // AND the worklet slave — no extra cables needed for the Houdini patch.
      n.vco2fm.connect(hardSyncNode.parameters.get('slaveFreq'));

      // Wire worklet output to the sync output wrapper.
      // n.vco2syncOut is a Tone.Gain — its .input property is the underlying native
      // GainNode (confirmed: Tone.Gain.input = this._gainNode = context.createGain()).
      // Native AudioWorkletNode.connect() only accepts native AudioNode, NOT Tone.js
      // wrappers, so we must pass .input explicitly. Connecting to n.vco2syncOut directly
      // would throw TypeError and abort the .then() before jackMapRef is rebuilt.
      // vco2syncOut gain is 0 until the user enables the HARD SYNC toggle.
      hardSyncNode.connect(n.vco2syncOut.input);

      // Rebuild jackMap so vco2-sync-in and vco2-sync-out are now live.
      jackMapRef.current = buildJackMap(n);
    }).catch(err => {
      console.warn('[MoogAudio] Hard sync worklet unavailable:', err);
    });

    return () => {
      // Null out nodesRef first so any in-flight worklet Promise .then() bails immediately.
      nodesRef.current = null;
      jackMapRef.current = null;
      [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      if (seqLoopRef.current) {
        try { seqLoopRef.current.stop(); } catch (_) {}
        try { seqLoopRef.current.dispose(); } catch (_) {}
        seqLoopRef.current = null;
      }
      if (chordSeqLoopRef.current) {
        try { chordSeqLoopRef.current.stop(); } catch (_) {}
        try { chordSeqLoopRef.current.dispose(); } catch (_) {}
        chordSeqLoopRef.current = null;
      }
      try { Tone.Transport.stop(); } catch (_) {}
      // Disconnect AudioWorkletNodes (not Tone.js nodes — no .dispose()).
      if (hardSyncNode)   { try { hardSyncNode.disconnect();   } catch (_) {} }
      if (quantizerNode)  { try { quantizerNode.disconnect();  } catch (_) {} }
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

    // Start sequencer clocks — reset steps so first tick lands on step 0
    seqCurrentStepRef.current      = -1;
    chordSeqCurrentStepRef.current = -1;
    Tone.Transport.start();
    seqLoopRef.current?.start(0);
    chordSeqLoopRef.current?.start(0);

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

    // Stop sequencer loops and clear active LEDs
    seqLoopRef.current?.stop();
    seqCurrentStepRef.current = -1;
    if (seqStepCbRef.current) seqStepCbRef.current(-1);
    chordSeqLoopRef.current?.stop();
    chordSeqCurrentStepRef.current = -1;
    if (chordSeqStepCbRef.current) chordSeqStepCbRef.current(-1);
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
    if (hz !== undefined) {
      const safeHz = Math.max(0.1, hz);
      vco.frequency.setTargetAtTime(safeHz, Tone.now(), 0.02);
      // Mirror to hard sync slave frequency so the FREQ knob controls both oscillators.
      // The vco2fm scaler also additively connects to slaveFreq (handles CV modulation),
      // so this only needs to set the base value — not the CV offset.
      if (vcoId === 'vco2' && n.hardSyncNode) {
        n.hardSyncNode.parameters.get('slaveFreq').setTargetAtTime(safeHz, Tone.now(), 0.02);
      }
    }
    if (detune !== undefined) {
      vco.detune.setTargetAtTime(detune, Tone.now(), 0.02);
      if (vcoId === 'vco2' && n.hardSyncNode) {
        n.hardSyncNode.parameters.get('slaveDetune').setTargetAtTime(detune, Tone.now(), 0.02);
      }
    }
    if (type !== undefined) vco.type = type;
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

  // Update per-channel mixer volume for the 4-channel I/O input stage.
  // channelIndex: 1–4  value: 0–1 linear gain (0 = muted, 1 = unity gain).
  // Single writer per node — this is the only function that touches ioCh1–ioCh4.gain.
  const updateIoChannelVol = useCallback((channelIndex, value) => {
    const n = nodesRef.current;
    if (!n) return;
    const node = n[`ioCh${channelIndex}`];
    if (!node) return;
    safeRamp(node.gain, value);
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

  // Returns the raw waveform data from the TRANSPOSE CV analyser.
  // The average absolute value of these samples is the DC level = Hz from the patched source.
  // Returns Float32Array of 256 samples, or null before nodes are created.
  const getQntTransposeData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.qntTransposeAnalyser.getValue();
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

  // Update quantizer scale and/or root note.
  // scale (string key: 'CHR' | 'MAJ' | 'MIN' | 'PMAJ' | 'PMIN')
  // root  (0–11: 0=C, 1=C#, …, 11=B)
  // Params are buffered in quantizerParamsRef so they are sent correctly even if
  // called before the AudioWorklet finishes loading.
  const updateQuantizerParams = useCallback(({ scale, root, octShift, bypass } = {}) => {
    if (scale    !== undefined) quantizerParamsRef.current.scale    = SCALE_DEFS[scale] ?? SCALE_DEFS.MAJ;
    if (root     !== undefined) quantizerParamsRef.current.root     = root;
    if (octShift !== undefined) quantizerParamsRef.current.octShift = octShift;
    if (bypass   !== undefined) quantizerParamsRef.current.bypass   = bypass;
    const n = nodesRef.current;
    if (!n?.quantizerNode) return;
    n.quantizerNode.port.postMessage(quantizerParamsRef.current);
  }, []);

  // Chord sequencer step data — push new { rootClass, chordType } steps without touching React state.
  const updateChordSeqSteps = useCallback((steps) => {
    chordSeqStepsRef.current = steps;
  }, []);

  // Register the chord sequencer LED step callback (same pattern as setSeqStepCallback).
  const setChordSeqStepCallback = useCallback((fn) => {
    chordSeqStepCbRef.current = fn;
  }, []);

  // Register a callback fired on each chord step advance: fn(rootClass: 0-11, chordType: string).
  // MoogShell uses this to call updateQuantizerParams({ root, scale: chordType }) so the
  // quantizer snaps the melody to the current chord's interval set.
  const setChordSeqChordCallback = useCallback((fn) => {
    chordSeqChordCbRef.current = fn;
  }, []);

  // Change the chord sequencer clock division — takes effect immediately.
  // interval: Tone.js time string ('2n' | '1m' | '2m' | '4m')
  const setChordSeqDivision = useCallback((interval) => {
    chordSeqDivisionRef.current = interval;
    if (chordSeqLoopRef.current) chordSeqLoopRef.current.interval = interval;
  }, []);

  // Register the quantizer LED callback (called from quantizer port.onmessage, main thread).
  // The callback receives: (noteClass: 0–11, midiNote: int) when the quantized note changes.
  const setQuantizerCallback = useCallback((fn) => {
    quantizerStepCbRef.current = fn;
  }, []);

  // Returns the last quantized frequency in Hz (defaults to A4 = 440 Hz on startup).
  // Used by VcoModule's TUNE button to back-compute the correct FREQ knob position.
  const getLastQuantizedHz = useCallback(() => {
    return 440 * Math.pow(2, (lastQuantizedMidiRef.current - 69) / 12);
  }, []);

  // Enable or disable the VCO2 hard sync output path.
  // Ramps vco2syncOut.gain 0→1 (enable) or 1→0 (disable) over 10 ms — click-free.
  // The worklet continues running in both states; the gain gate controls audibility.
  const setVco2SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current;
    if (!n) return;
    safeRamp(n.vco2syncOut.gain, enabled ? 1 : 0, 0.01);
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
    updateLfoParams, updateIoParams, updateIoChannelVol, updateReverbParams, getMoogBusNode,
    getOscilloscopeData, getQntTransposeData, getMeterValue,
    setTempo, updateSequencerSteps, setSeqStepCallback, updateKeyboard,
    updateChordSeqSteps, setChordSeqStepCallback, setChordSeqDivision, setChordSeqChordCallback,
    setVco2SyncEnabled,
    updateQuantizerParams, setQuantizerCallback,
  };
}
