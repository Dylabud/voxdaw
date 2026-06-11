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

// Snap an input Hz to the nearest chord tone across all musical octaves.
// intervals: semitone array from SCALE_DEFS (e.g. [0,4,7] for major triad).
// Returns the chord-tone Hz closest in semitone distance to the input.
function snapToChordHz(inputHz, rootClass, chordType) {
  const intervals = SCALE_DEFS[chordType] ?? SCALE_DEFS.CMAJ;
  const rootHz    = CHORD_BASE_HZ * Math.pow(2, rootClass / 12);
  const inputMidi = 69 + 12 * Math.log2(Math.max(0.001, inputHz) / 440);
  let bestHz   = rootHz;
  let bestDist = Infinity;
  for (let oct = -3; oct <= 4; oct++) {
    for (const semitone of intervals) {
      const noteHz = rootHz * Math.pow(2, oct + semitone / 12);
      if (noteHz < 20 || noteHz > 20000) continue;
      const dist = Math.abs(inputMidi - (69 + 12 * Math.log2(noteHz / 440)));
      if (dist < bestDist) { bestDist = dist; bestHz = noteHz; }
    }
  }
  return bestHz;
}

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
    // Output jacks route through vco2bus so the HARD SYNC crossfade is transparent.
    // waveformTarget separates waveform-setting (n.vco2) from audio routing (n.vco2bus).
    'vco2-sin': { type: 'out', node: n.vco2bus, waveform: 'sine',      waveformTarget: n.vco2 },
    'vco2-tri': { type: 'out', node: n.vco2bus, waveform: 'triangle',  waveformTarget: n.vco2 },
    'vco2-saw': { type: 'out', node: n.vco2bus, waveform: 'sawtooth',  waveformTarget: n.vco2 },
    'vco2-sqr': { type: 'out', node: n.vco2bus, waveform: 'square',    waveformTarget: n.vco2 },
    // Hard sync jacks — both are always live from initial jackMap build.
    // vco2syncIn (Tone.Gain) receives the master signal via normal Tone connect().
    // vco2syncOut (Tone.Gain) passes the worklet's slave output downstream.
    // The SAC-level bridge (vco2syncIn.output → worklet → vco2syncOut.input) is
    // wired once in the worklet .then() block after the AudioWorkletNode is ready.
    'vco2-sync-in':  { type: 'in',  dest: n.vco2syncIn  },
    'vco2-sync-out': { type: 'out', node: n.vco2syncOut },
    // ── VCO 3 ──
    'vco3-cv':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-fm':  { type: 'in',  dest: n.vco3fm },
    'vco3-sin': { type: 'out', node: n.vco3, waveform: 'sine'      },
    'vco3-tri': { type: 'out', node: n.vco3, waveform: 'triangle'  },
    'vco3-saw': { type: 'out', node: n.vco3, waveform: 'sawtooth'  },
    'vco3-sqr': { type: 'out', node: n.vco3, waveform: 'square'    },
    'vco4-cv':  { type: 'in',  dest: n.vco4.frequency },
    'vco4-fm':  { type: 'in',  dest: n.vco4fm },
    'vco4-sin': { type: 'out', node: n.vco4, waveform: 'sine'      },
    'vco4-tri': { type: 'out', node: n.vco4, waveform: 'triangle'  },
    'vco4-saw': { type: 'out', node: n.vco4, waveform: 'sawtooth'  },
    'vco4-sqr': { type: 'out', node: n.vco4, waveform: 'square'    },
    // ── Noise ──
    'noise-wht':  { type: 'out', node: n.noiseW },
    'noise-pnk':  { type: 'out', node: n.noiseP },
    'noise2-wht': { type: 'out', node: n.noise2W },
    'noise2-pnk': { type: 'out', node: n.noise2P },
    'noise3-wht': { type: 'out', node: n.noise3W },
    'noise3-pnk': { type: 'out', node: n.noise3P },
    // ── VCF ──
    // cv1/cv2 → vcfcv1/vcfcv2 Gain(5000): LFO ±1 → ±5000 Hz — sweeps full audible spectrum
    // env     → vcfenv Gain(1000):         env  0→1 →  0→1000 Hz lift above base cutoff
    'vcf-in':  { type: 'in',  dest: n.vcf },
    'vcf-cv1': { type: 'in',  dest: n.vcfcv1 },
    'vcf-cv2': { type: 'in',  dest: n.vcfcv2 },
    'vcf-env': { type: 'in',  dest: n.vcfenv },
    'vcf-out': { type: 'out', node: n.vcf },
    // ── VCF 2 ──
    'vcf2-in':  { type: 'in',  dest: n.vcf2 },
    'vcf2-cv1': { type: 'in',  dest: n.vcf2cv1 },
    'vcf2-cv2': { type: 'in',  dest: n.vcf2cv2 },
    'vcf2-env': { type: 'in',  dest: n.vcf2env },
    'vcf2-out': { type: 'out', node: n.vcf2 },
    // ── VCA ──
    'vca-in':  { type: 'in',  dest: n.vca },
    'vca-cv':  { type: 'in',  dest: n.vca.gain },
    'vca-out': { type: 'out', node: n.seqGateNode }, // seqGateNode is the gated tap — Loop controls gain
    'vca2-in':  { type: 'in',  dest: n.vca2 },
    'vca2-cv':  { type: 'in',  dest: n.vca2.gain },
    'vca2-out': { type: 'out', node: n.vca2 },
    'vca3-in':  { type: 'in',  dest: n.vca3 },
    'vca3-cv':  { type: 'in',  dest: n.vca3.gain },
    'vca3-out': { type: 'out', node: n.vca3 },
    // ── Reverb ──
    'reverb-in':   { type: 'in',  dest: n.reverb  },
    'reverb-out':  { type: 'out', node: n.reverb  },
    'reverb2-in':  { type: 'in',  dest: n.reverb2 },
    'reverb2-out': { type: 'out', node: n.reverb2 },
    // ── Chorus ──
    'chorus-in':  { type: 'in',  dest: n.chorus },
    'chorus-out': { type: 'out', node: n.chorus },
    // ── ENV 1 ── gate jack wired to gateActionsRef by connect(); trig deferred
    'env1-gate': { type: 'in', dest: null, isGate: true, envId: 'env1' },
    'env1-trig': { type: 'in', dest: null },
    'env1-out':  { type: 'out', node: n.env1 },
    // ── ENV 2 ──
    'env2-gate': { type: 'in', dest: null, isGate: true, envId: 'env2' },
    'env2-trig': { type: 'in', dest: null },
    'env2-out':  { type: 'out', node: n.env2 },
    'env3-gate': { type: 'in', dest: null, isGate: true, envId: 'env3' },
    'env3-trig': { type: 'in', dest: null },
    'env3-out':  { type: 'out', node: n.env3 },
    // ── LFO ──
    // lfo-fm → lfo1modGain (Gain): patched CV * MOD DEPTH knob gain → lfo.frequency
    'lfo-sync':  { type: 'in',  dest: null },
    'lfo-fm':    { type: 'in',  dest: n.lfo1modGain },
    'lfo-sin':   { type: 'out', node: n.lfo,  waveform: 'sine'      },
    'lfo-tri':   { type: 'out', node: n.lfo,  waveform: 'triangle'  },
    'lfo-sqr':   { type: 'out', node: n.lfo,  waveform: 'square'    },
    'lfo-saw':   { type: 'out', node: n.lfo,  waveform: 'sawtooth'  },
    'lfo2-sync': { type: 'in',  dest: null },
    'lfo2-fm':   { type: 'in',  dest: n.lfo2modGain },
    'lfo2-sin':  { type: 'out', node: n.lfo2, waveform: 'sine'      },
    'lfo2-tri':  { type: 'out', node: n.lfo2, waveform: 'triangle'  },
    'lfo2-sqr':  { type: 'out', node: n.lfo2, waveform: 'square'    },
    'lfo2-saw':  { type: 'out', node: n.lfo2, waveform: 'sawtooth'  },
    // ── Sequencer 1 ──
    'seq-pitch-out': { type: 'out', node: n.seqPitchOut },
    'seq-gate-out':  { type: 'out', node: null, isGate: true },
    'seq-clk-in':    { type: 'in',  dest: null },
    'seq-clk-out':   { type: 'out', node: null },
    // ── Sequencer 2 ──
    'seq2-pitch-out': { type: 'out', node: n.seq2PitchOut },
    'seq2-gate-out':  { type: 'out', node: null, isGate: true },
    'seq2-clk-in':    { type: 'in',  dest: null },
    'seq2-clk-out':   { type: 'out', node: null },
    // ── Chord Sequencer ──
    'chordseq-cv-in':   { type: 'in',  dest: n.chordSeqInputAnalyser },
    'chordseq-cv-out':  { type: 'out', node: n.chordSeqPitchOut },
    'chordseq-root-out': { type: 'out', node: n.chordSeqRootOut },
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
  const vco2SyncEnabledRef  = useRef(false);     // tracks HARD SYNC toggle state across power cycles
  const seqLoopRef          = useRef(null);
  const seqStepsRef         = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true })));
  const seqCurrentStepRef   = useRef(-1);
  const seqStepCbRef        = useRef(null);   // UI callback for sequencer LED animation
  const seq2LoopRef         = useRef(null);
  const seq2StepsRef        = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true })));
  const seq2CurrentStepRef  = useRef(-1);
  const seq2StepCbRef       = useRef(null);
  const gateActionsRef      = useRef(new Map()); // toJackId → Tone.Envelope

  // Chord sequencer — separate slower-clocked 8-step pitch CV source.
  // Each step stores { rootClass: 0-11, chordType: keyof SCALE_DEFS }.
  // On step fire: outputs root Hz via chordSeqPitchOut AND calls chordSeqChordCbRef
  // with (rootClass, chordType) so MoogShell can sync the quantizer scale.
  const chordSeqLoopRef        = useRef(null);
  const chordSeqStepsRef       = useRef(
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i], // Am Am F F C C E E
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }))
  );
  const chordSeqCurrentStepRef = useRef(-1);
  const chordSeqStepCbRef      = useRef(null);
  const chordSeqChordCbRef     = useRef(null); // fn(rootClass, chordType) — called on each step
  const chordSeqDivisionRef    = useRef('1m'); // default: advance every 1 bar
  const chordSeqRootOctaveRef  = useRef(0);   // octave offset for chordseq-root-out (-3..+3)
  const chordSeqInputActiveRef  = useRef(false); // true when a CV source is patched to chordseq-cv-in
  const qntChordOverrideRef    = useRef(false); // true when chordseq-cv-out → qnt-transpose-in is patched
  // Stores the last Hz value from each VCO knob so it can be restored when a CV cable is removed.
  const vcoKnobHzRef = useRef({ vco1: null, vco2: null, vco3: null, vco4: null });
  const quantizerStepCbRef    = useRef(null);   // UI callback for quantizer LED animation
  const lastQuantizedMidiRef  = useRef(69);     // A4 default — updated on each note change
  // Persists latest quantizer config so it can be flushed when the worklet finishes loading.
  const quantizerParamsRef    = useRef({ scale: SCALE_DEFS.MAJ, root: 0, octShift: 0, bypass: false });

  useEffect(() => {
    const n = {
      vco1:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco2:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco3:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco4:        new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      noiseW:      new Tone.Noise({ type: 'white' }),
      noiseP:      new Tone.Noise({ type: 'pink'  }),
      noise2W:     new Tone.Noise({ type: 'white' }),
      noise2P:     new Tone.Noise({ type: 'pink'  }),
      noise3W:     new Tone.Noise({ type: 'white' }),
      noise3P:     new Tone.Noise({ type: 'pink'  }),
      vcf:         new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vcf2:        new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vca:         new Tone.Gain(1.0),
      vca2:        new Tone.Gain(1.0),
      vca3:        new Tone.Gain(1.0),
      env1:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env2:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env3:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      lfo:         new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),
      lfo2:        new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),

      // Rate-mod Gain nodes — sit between an incoming CV cable and lfo.frequency.
      // gain=0 on init so no modulation until the MOD DEPTH knob is raised.
      // Single writer: updateLfoParams/updateLfo2Params owns these via safeRamp.
      lfo1modGain: new Tone.Gain(0),
      lfo2modGain: new Tone.Gain(0),

      // Waveform analyser taps — read last sample each rAF for an instantaneous
      // phase value that drives the rate LED (pulses at the actual modulated rate).
      // 32-sample buffer = 0.73ms at 44100Hz — effectively instantaneous at LFO rates.
      lfoWaveAnalyser:  new Tone.Analyser('waveform', 32),
      lfo2WaveAnalyser: new Tone.Analyser('waveform', 32),
      master:      new Tone.Volume(-14),             // no longer goes direct to Destination
      seqMasterGate: new Tone.Gain(1).toDestination(), // sole gateway to speakers — Loop gates here
      analyser:    new Tone.Analyser('waveform', 512),
      seqPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // never init to 0 — exponential ramps from 0 are undefined
      seq2PitchOut:      new Tone.Signal(SEQ_HZ_MIN), // second sequencer pitch CV — same non-zero init rule
      kbdPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // keyboard pitch CV out — same non-zero init rule
      chordSeqPitchOut:      new Tone.Signal(SEQ_HZ_MIN), // chord sequencer root CV out — same rule
      chordSeqRootOut:       new Tone.Signal(SEQ_HZ_MIN), // independent root-note CV out (octave-shifted)
      chordSeqInputAnalyser: new Tone.Analyser('waveform', 256), // detects patched pitch CV input

      // Studio reverb — Freeverb (proven in this codebase via VoxTool arpReverb).
      // wet starts at 0 so patching in the reverb doesn't colour sound until MIX is raised.
      reverb:  new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),
      reverb2: new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),

      // Bucket Brigade Chorus — internal LFOs require explicit start()/stop() in powerOn/powerOff.
      // wet:0 on init so patching is transparent until MIX is raised (unity gain at Mix=0).
      chorus: new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.0 }),

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

      // Hard sync signal path.
      //
      // Tone.js's connectSignal() uses `instanceof AudioNode` which returns false for
      // SAC-wrapped AudioWorkletNodes — direct Tone→worklet connect() silently no-ops.
      // Fix: Tone.Gain buffers on both sides of the worklet boundary.
      //
      //   vco2syncIn  (gain 1) — receives master VCO via Tone→Tone connect (always works).
      //                          vco2syncIn.output → worklet is SAC-GainNode→SAC-AWN,
      //                          which goes native→native internally and always succeeds.
      //   vco2syncOut (gain 0) — receives worklet output; gain crossfades to 1 on HARD SYNC ON.
      //
      // VCO2 output bus — crossfades between normal VCO2 and synced slave.
      //   vco2normalGain (gain 1) — gates regular VCO2 into vco2bus; fades to 0 when HARD SYNC ON.
      //   vco2bus        (gain 1) — the node all vco2-* output jacks connect from.
      //                             Receives vco2normalGain + vco2syncOut; exactly one is non-zero.
      vco2syncIn:     new Tone.Gain(1),
      vco2syncOut:    new Tone.Gain(0),
      vco2normalGain: new Tone.Gain(1),
      vco2bus:        new Tone.Gain(1),

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
      lfo2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.7  }),
      env1Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      env2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      env3Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
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
      vco4fm: new Tone.Gain(500),
      vcfcv1: new Tone.Gain(5000),
      vcfcv2: new Tone.Gain(5000),
      vcfenv: new Tone.Gain(1000),
      vcf2cv1: new Tone.Gain(5000),
      vcf2cv2: new Tone.Gain(5000),
      vcf2env: new Tone.Gain(1000),
    };

    // VCO2 output bus — permanent crossfade between regular oscillator and sync slave.
    // vco2normalGain gates regular VCO2 (gain 1 normally, fades to 0 when HARD SYNC ON).
    // vco2syncOut feeds the worklet slave (gain 0 normally, fades to 1 when HARD SYNC ON).
    // Both feed vco2bus, which is what all vco2-* output jacks connect from.
    // Only one is non-zero at a time, so there is never signal bleed between modes.
    n.vco2.connect(n.vco2normalGain);
    n.vco2normalGain.connect(n.vco2bus);
    n.vco2syncOut.connect(n.vco2bus);

    // CV scaler hardwires — permanent front-doors for modulation inputs.
    // Sources patched to the FM / CV1 / CV2 / ENV jacks flow through these gains
    // before reaching the AudioParam; the scaler itself is never a patch destination.
    n.vco1fm.connect(n.vco1.frequency);
    n.vco2fm.connect(n.vco2.frequency);
    n.vco3fm.connect(n.vco3.frequency);
    n.vco4fm.connect(n.vco4.frequency);
    n.vcfcv1.connect(n.vcf.frequency);
    n.vcfcv2.connect(n.vcf.frequency);
    n.vcfenv.connect(n.vcf.frequency);
    n.vcf2cv1.connect(n.vcf2.frequency);
    n.vcf2cv2.connect(n.vcf2.frequency);
    n.vcf2env.connect(n.vcf2.frequency);

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
    n.lfo2.connect(n.lfo2Meter);

    // Rate-mod Gain nodes feed directly into each LFO's frequency AudioParam.
    // When no cable is patched (gain=0) this adds exactly 0 Hz — fully transparent.
    n.lfo1modGain.connect(n.lfo.frequency);
    n.lfo2modGain.connect(n.lfo2.frequency);

    // Waveform analyser taps — dead-end, do not affect audio routing.
    n.lfo.connect(n.lfoWaveAnalyser);
    n.lfo2.connect(n.lfo2WaveAnalyser);
    n.env1.connect(n.env1Meter);
    n.env2.connect(n.env2Meter);
    n.env3.connect(n.env3Meter);
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

    // Sequencer 2 loop — independent pitch CV + gate, does not gate seqMasterGate.
    const loop2 = new Tone.Loop((time) => {
      seq2CurrentStepRef.current = (seq2CurrentStepRef.current + 1) % 16;
      const idx2  = seq2CurrentStepRef.current;
      const step2 = seq2StepsRef.current[idx2];
      const hz2   = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step2.voltage);
      n.seq2PitchOut.setValueAtTime(hz2, time);
      if (gateActionsRef.current.size > 0) {
        const stepDur2 = step2.gate ? Tone.Time('8n').toSeconds() : 0;
        for (const [, { env, fromId }] of gateActionsRef.current) {
          if (fromId !== 'seq2-gate-out') continue;
          if (step2.gate) {
            env.triggerAttack(time);
            env.triggerRelease(time + stepDur2 * 0.8);
          } else {
            env.triggerRelease(time);
          }
        }
      }
      if (seq2StepCbRef.current) seq2StepCbRef.current(idx2);
    }, '8n');
    seq2LoopRef.current = loop2;

    // Chord sequencer loop — advances every chordSeqDivisionRef bars/beats.
    // step.rootClass (0-11) → Hz via CHORD_BASE_HZ (C3 * 2^(semitones/12)).
    // Also fires chordSeqChordCbRef so MoogShell can update the quantizer scale
    // to use this chord's interval set (chord-aware melody snapping).
    const chordLoop = new Tone.Loop((time) => {
      chordSeqCurrentStepRef.current = (chordSeqCurrentStepRef.current + 1) % 8;
      const idx  = chordSeqCurrentStepRef.current;
      const step = chordSeqStepsRef.current[idx];
      // Only write root Hz when no CV source is patched — the rAF snapper owns
      // chordSeqPitchOut while an input is active (single-writer rule).
      if (!chordSeqInputActiveRef.current) {
        const hz = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
        n.chordSeqPitchOut.setValueAtTime(hz, time);
      }
      // Root-note output — always the chord root, octave-shifted by the knob, never affected
      // by the CV-in snapping path.  VCO set to minimum + patch this for pure chord root bass.
      const rootHz = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
      n.chordSeqRootOut.setValueAtTime(rootHz * Math.pow(2, chordSeqRootOctaveRef.current), time);

      if (chordSeqStepCbRef.current) chordSeqStepCbRef.current(idx);
      if (chordSeqChordCbRef.current) chordSeqChordCbRef.current(step.rootClass, step.chordType);
      // When chordseq-cv-out → qnt-transpose-in is patched, push the chord's root AND
      // scale directly into the quantizer worklet, overriding the manual QNT selectors.
      // This runs in the Tone.Loop (main thread) so postMessage is safe.
      if (qntChordOverrideRef.current && n.quantizerNode) {
        quantizerParamsRef.current.root  = step.rootClass;
        quantizerParamsRef.current.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
        n.quantizerNode.port.postMessage(quantizerParamsRef.current);
      }
    }, chordSeqDivisionRef.current);

    chordSeqLoopRef.current = chordLoop;

    // Pitch-snapping rAF — reads chordseq-cv-in, snaps incoming Hz to current chord tones,
    // writes snapped pitch to chordSeqPitchOut so a downstream VCO always plays in tune.
    // When no cable is patched the analyser returns ~0 Hz (below 10 Hz threshold) so this
    // loop is a cheap no-op and the chord Tone.Loop resumes ownership of chordSeqPitchOut.
    let chordSnapRafId;
    const chordSnapTick = () => {
      chordSnapRafId = requestAnimationFrame(chordSnapTick);
      const data = n.chordSeqInputAnalyser.getValue();
      if (!data || !data.length) return;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
      const avgHz   = sum / data.length;
      const isActive = avgHz > 10;
      chordSeqInputActiveRef.current = isActive;
      if (isActive && Tone.context.state === 'running') {
        const stepIdx = chordSeqCurrentStepRef.current;
        const step    = chordSeqStepsRef.current[Math.max(0, stepIdx)];
        const snapped = snapToChordHz(avgHz, step.rootClass, step.chordType);
        // Use value setter (immediate) — setValueAtTime with a future-scheduled chord
        // loop tick would otherwise fight this write in the same block.
        n.chordSeqPitchOut.value = snapped;
      }
    };
    chordSnapTick();

    // Quantizer chord-override rAF — continuously holds the quantizer's root+scale to the
    // current chord step at 60fps while qntChordOverrideRef is true.  Running continuously
    // means nothing (QuantizerModule rAF, React effects, manual knob writes) can overwrite
    // the chord seq's chord for more than one frame.  Delta-checked so postMessage only fires
    // when the chord actually changes — not every frame.
    let qntOverrideRafId;
    let lastOverrideRoot  = -1;
    let lastOverrideScale = null;
    const qntOverrideTick = () => {
      qntOverrideRafId = requestAnimationFrame(qntOverrideTick);
      if (!qntChordOverrideRef.current || !n.quantizerNode) return;
      const stepIdx  = chordSeqCurrentStepRef.current;
      const step     = chordSeqStepsRef.current[Math.max(0, stepIdx)];
      const newRoot  = step.rootClass;
      const newScale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
      if (newRoot === lastOverrideRoot && newScale === lastOverrideScale) return;
      lastOverrideRoot  = newRoot;
      lastOverrideScale = newScale;
      quantizerParamsRef.current.root  = newRoot;
      quantizerParamsRef.current.scale = newScale;
      n.quantizerNode.port.postMessage(quantizerParamsRef.current);
    };
    qntOverrideTick();

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
      if (nodesRef.current !== n) return;
      // outputChannelCount: [1] forces mono output — Chrome defaults the output channel
      // count to 2 (matching the AudioContext destination), leaving output[0][1] (right)
      // permanently silent. A 1-channel output upmixes to stereo correctly downstream.
      hardSyncNode = Tone.context.createAudioWorkletNode('hard-sync-processor', { outputChannelCount: [1] });
      n.hardSyncNode = hardSyncNode;

      // SAC-level bridge — both calls are SAC-node to SAC-node, which translates to
      // native-to-native internally and is always reliable.
      //
      // IN:  vco2syncIn.output (SAC GainNode) → worklet audio input[0]
      //      Tone.Oscillator → vco2syncIn is Tone→Tone (works fine via Tone.connect()).
      //      Tone.Oscillator → worklet directly would silent-fail (Tone.js isAudioNode()
      //      returns false for SAC AudioWorkletNodes, so connectSignal() does nothing).
      //
      // OUT: worklet output → vco2syncOut.input (SAC GainNode)
      //      vco2syncOut.gain is 0 until user enables HARD SYNC toggle.
      n.vco2syncIn.output.connect(hardSyncNode);
      hardSyncNode.connect(n.vco2syncOut.input);

      // FM modulation: vco2fm additively drives slaveFreq so envelopes/LFOs patched
      // to vco2-fm modulate both VCO2.frequency and the slave. Non-critical — wrapped
      // in its own try-catch so a failure here cannot affect the core sync path.
      try {
        n.vco2fm.connect(hardSyncNode.parameters.get('slaveFreq'));
      } catch (e) {
        console.warn('[MoogAudio] vco2fm→slaveFreq unavailable:', e.message);
      }
    }).catch(err => {
      console.warn('[MoogAudio] Hard sync worklet unavailable:', err);
    });

    return () => {
      cancelAnimationFrame(chordSnapRafId);
      cancelAnimationFrame(qntOverrideRafId);
      // Null out nodesRef first so any in-flight worklet Promise .then() bails immediately.
      nodesRef.current = null;
      jackMapRef.current = null;
      [n.vco1, n.vco2, n.vco3, n.vco4, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.lfo, n.lfo2, n.chorus].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      if (seqLoopRef.current) {
        try { seqLoopRef.current.stop(); } catch (_) {}
        try { seqLoopRef.current.dispose(); } catch (_) {}
        seqLoopRef.current = null;
      }
      if (seq2LoopRef.current) {
        try { seq2LoopRef.current.stop(); } catch (_) {}
        try { seq2LoopRef.current.dispose(); } catch (_) {}
        seq2LoopRef.current = null;
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
    [n.vco1, n.vco2, n.vco3, n.vco4, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.lfo, n.lfo2, n.chorus].forEach(node => {
      try { node.start(); } catch (_) {}
    });

    // Restore the hard sync crossfade to whatever state the toggle was left in.
    // vco2syncOut was forced to 0 on powerOff to prevent the always-running worklet
    // from producing audio while the synth is off.
    const se = vco2SyncEnabledRef.current;
    n.vco2normalGain.gain.value = se ? 0 : 1;
    n.vco2syncOut.gain.value    = se ? 1 : 0;

    // Start sequencer clocks — reset steps so first tick lands on step 0
    seqCurrentStepRef.current      = -1;
    seq2CurrentStepRef.current     = -1;
    chordSeqCurrentStepRef.current = -1;
    Tone.Transport.start();
    seqLoopRef.current?.start(0);
    seq2LoopRef.current?.start(0);
    chordSeqLoopRef.current?.start(0);

    setIsPowered(true);
  }, []);

  const powerOff = useCallback(() => {
    if (!isPoweredRef.current) return;
    isPoweredRef.current = false;

    const n = nodesRef.current;
    if (!n) return;
    [n.vco1, n.vco2, n.vco3, n.vco4, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.lfo, n.lfo2, n.chorus].forEach(node => {
      try { node.stop(); } catch (_) {}
    });

    // Stop sequencer loops and clear active LEDs
    seqLoopRef.current?.stop();
    seqCurrentStepRef.current = -1;
    if (seqStepCbRef.current) seqStepCbRef.current(-1);
    seq2LoopRef.current?.stop();
    seq2CurrentStepRef.current = -1;
    if (seq2StepCbRef.current) seq2StepCbRef.current(-1);
    chordSeqLoopRef.current?.stop();
    chordSeqCurrentStepRef.current = -1;
    if (chordSeqStepCbRef.current) chordSeqStepCbRef.current(-1);
    Tone.Transport.stop();

    // Gate the hard sync slave to silence. The AudioWorkletProcessor returns true so
    // it keeps running indefinitely — stopping oscillators is not enough. Without this,
    // vco2syncOut (gain=1 when HARD SYNC is ON) lets the worklet sawtooth flow through
    // vco2bus → master → seqMasterGate (which is re-opened below) → speakers.
    n.vco2syncOut.gain.value    = 0;
    n.vco2normalGain.gain.value = 1; // restore normal path (VCO2 is stopped, so silent)

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

    let from = jm[fromId];
    let to   = jm[toId];
    if (!from || !to) return;

    // Normalize cable direction: audio always flows out→in.
    // If the user dragged from an 'in' jack to an 'out' jack, swap so the key
    // and audio wiring are consistent regardless of which end the drag started from.
    let effFrom = fromId, effTo = toId;
    if (from.type === 'in' && to.type === 'out') {
      [effFrom, effTo] = [toId, fromId];
      [from, to] = [to, from];
    }

    const key = `${effFrom}→${effTo}`;
    if (connectionsRef.current.has(key)) return;

    // Gate cable: any isGate out → env?-gate — register programmatic trigger.
    // Keyed by full cable key so kbd-gate and seq-gate can both connect to the
    // same env jack independently without overwriting each other.
    if (from.isGate && to.isGate) {
      const env = n[to.envId];
      if (env) {
        gateActionsRef.current.set(key, { env, fromId: effFrom });
        connectionsRef.current.set(key, { isGate: true, toId: effTo });
      }
      return;
    }

    if (from.type !== 'out' || to.type !== 'in') return;
    if (to.dest === null) return;   // deferred jack — silently no-op
    if (from.node === null) return; // unimplemented output (e.g. seq-clk-out)

    // Set VCO or LFO waveform to match the specific output jack patched.
    // waveformTarget separates the waveform-setting node (e.g. n.vco2) from the
    // routing node (e.g. n.vco2bus) when they differ.
    const waveformNode = from.waveformTarget ?? from.node;
    if (from.waveform) waveformNode.type = from.waveform;

    // Chord-seq → quantizer scale override: when chordseq-cv-out is patched to
    // qnt-transpose-in, the chord loop takes ownership of the quantizer's root+scale.
    // Apply the current chord immediately so the quantizer is correct right away —
    // don't wait for the next bar boundary.
    if (effFrom === 'chordseq-cv-out' && effTo === 'qnt-transpose-in') {
      qntChordOverrideRef.current = true;
      const stepIdx = chordSeqCurrentStepRef.current;
      const step    = chordSeqStepsRef.current[Math.max(0, stepIdx)];
      quantizerParamsRef.current.root  = step.rootClass;
      quantizerParamsRef.current.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
      n.quantizerNode?.port.postMessage(quantizerParamsRef.current);
    }

    // VCO cv-in override: zero the AudioParam base value so the source provides the
    // full pitch Hz. Without this, VCO freq = knob_hz + cv_hz = always wrong.
    if (/^vco\d+-cv$/.test(effTo)) {
      const vcoId = effTo.replace('-cv', '');
      if (n[vcoId]) n[vcoId].frequency.value = 0;
    }

    try {
      from.node.connect(to.dest);
      connectionsRef.current.set(key, { node: from.node, dest: to.dest });
    } catch (e) {
      console.warn(`[MoogAudio] connect ${key}:`, e.message);
    }
  }, []);

  const disconnect = useCallback((fromId, toId) => {
    // Mirror the same direction normalization as connect() so the key matches.
    const jm = jackMapRef.current;
    let effFrom = fromId, effTo = toId;
    if (jm) {
      const f = jm[fromId], t = jm[toId];
      if (f?.type === 'in' && t?.type === 'out') {
        [effFrom, effTo] = [toId, fromId];
      }
    }

    const key  = `${effFrom}→${effTo}`;
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

    // Chord-seq → quantizer override: clear when cable is removed.
    if (effFrom === 'chordseq-cv-out' && effTo === 'qnt-transpose-in') {
      qntChordOverrideRef.current = false;
    }

    // VCO cv-in: restore the knob frequency once no CV source remains connected,
    // so the user gets back manual pitch control without re-touching the knob.
    if (/^vco\d+-cv$/.test(effTo)) {
      const n = nodesRef.current;
      const stillActive = [...connectionsRef.current.keys()].some(k => k.endsWith(`→${effTo}`));
      if (!stillActive && n) {
        const vcoId  = effTo.replace('-cv', '');
        const kHz    = vcoKnobHzRef.current[vcoId];
        if (n[vcoId] && kHz != null) n[vcoId].frequency.value = kHz;
      }
    }
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
      // Always persist the knob value so it can be restored on CV disconnect.
      vcoKnobHzRef.current[vcoId] = safeHz;
      // Suppress the frequency write while a CV source is connected — the source owns
      // the pitch (base is zeroed in connect()), and the knob must not fight it.
      const hasCv = [...connectionsRef.current.keys()].some(k => k.endsWith(`→${vcoId}-cv`));
      if (!hasCv) {
        vco.frequency.setTargetAtTime(safeHz, Tone.now(), 0.02);
        if (vcoId === 'vco2' && n.hardSyncNode) {
          n.hardSyncNode.parameters.get('slaveFreq').setTargetAtTime(safeHz, Tone.now(), 0.02);
        }
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

  const updateVcf2Params = useCallback(({ cutoff, resonance } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (cutoff    !== undefined) n.vcf2.frequency.setTargetAtTime(
      20 * Math.pow(1000, cutoff), Tone.now(), 0.02
    );
    if (resonance !== undefined) safeRamp(n.vcf2.Q, Math.max(0.001, resonance * 20));
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

  const updateVca2Params = useCallback(({ gain } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (gain !== undefined) safeRamp(n.vca2.gain, gain);
  }, []);

  const updateVca3Params = useCallback(({ gain } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (gain !== undefined) safeRamp(n.vca3.gain, gain);
  }, []);

  // Update LFO parameters.
  // rate  (0–1) → exponential 0.1 Hz–30 Hz  (0.1 * 300^rate)
  // depth (0–1) → lfo.amplitude 0–1 (scales the ±1 output swing)
  // type  (string) → lfo.type; UI-driven default, overridden by whichever waveform jack
  //        is patched (the connect() function also sets lfo.type via from.waveform).
  const updateLfoParams = useCallback(({ rate, depth, type, modDepth } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (rate     !== undefined) safeRamp(n.lfo.frequency,  0.1 * Math.pow(300, rate));
    if (depth    !== undefined) safeRamp(n.lfo.amplitude,  depth);
    if (type     !== undefined) n.lfo.type = type;
    // modDepth (0–1) → lfo1modGain.gain (0–10 Hz): incoming CV ±1 swings rate by ±10 Hz max.
    if (modDepth !== undefined) safeRamp(n.lfo1modGain.gain, modDepth * 10);
  }, []);

  const updateLfo2Params = useCallback(({ rate, depth, type, modDepth } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (rate     !== undefined) safeRamp(n.lfo2.frequency, 0.1 * Math.pow(300, rate));
    if (depth    !== undefined) safeRamp(n.lfo2.amplitude, depth);
    if (type     !== undefined) n.lfo2.type = type;
    if (modDepth !== undefined) safeRamp(n.lfo2modGain.gain, modDepth * 10);
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

  const updateReverb2Params = useCallback(({ roomSize, wet } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (roomSize !== undefined) safeRamp(n.reverb2.roomSize, roomSize);
    if (wet      !== undefined) safeRamp(n.reverb2.wet,      wet);
  }, []);

  // Update BBD Chorus parameters.
  // rate  (0–1) → exponential 0.1–5 Hz  (0.1 * 50^rate) — classic chorus sweep range.
  // depth (0–1) → Tone.Chorus.depth plain property (JS setter, not AudioParam — no ramp).
  // wet   (0–1) → dry/wet mix; 0 = unity gain (dry only), transparent when unpatched.
  const updateChorusParams = useCallback(({ rate, depth, wet } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (rate  !== undefined) safeRamp(n.chorus.frequency, 0.1 * Math.pow(50, rate));
    if (depth !== undefined) n.chorus.depth = depth; // plain setter — not an AudioParam
    if (wet   !== undefined) safeRamp(n.chorus.wet, wet);
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

  // Instantaneous LFO phase value [0, 1] for the rate LED — reads the last sample of
  // the waveform analyser buffer rather than a smoothed RMS meter, so the LED pulses
  // at the actual modulated rate (including any incoming FM CV on lfo-fm).
  // Returns 0 when not powered so the LED stays dim when the synth is off.
  const getLfoInstant = useCallback(() => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    if (!n) return 0;
    const data = n.lfoWaveAnalyser.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2; // [-1,1] → [0,1]
  }, []);

  const getLfo2Instant = useCallback(() => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    if (!n) return 0;
    const data = n.lfo2WaveAnalyser.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2;
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

  const updateSeq2Steps = useCallback((steps) => {
    seq2StepsRef.current = steps;
  }, []);

  const setSeq2StepCallback = useCallback((fn) => {
    seq2StepCbRef.current = fn;
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

  // Set the octave offset for the independent chord root output (chordseq-root-out).
  // octave: integer -3..+3
  const setChordSeqRootOctave = useCallback((octave) => {
    chordSeqRootOctaveRef.current = octave;
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

  // Enable or disable VCO2 hard sync.
  // Crossfades vco2normalGain (regular VCO2) and vco2syncOut (worklet slave) over 10 ms.
  // Because both feed vco2bus, the transition is click-free and vco2-saw/sqr/etc. jacks
  // automatically carry the synced signal when ON — no extra patch cables required.
  // State is persisted in vco2SyncEnabledRef so powerOff/powerOn can gate and restore it.
  const setVco2SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current;
    if (!n) return;
    vco2SyncEnabledRef.current = enabled;
    safeRamp(n.vco2normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco2syncOut.gain,    enabled ? 1 : 0, 0.01);
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
    updateVcoParams, updateVcfParams, updateVcf2Params, updateEnvParams, triggerGate,
    updateVcaParams, updateVca2Params, updateVca3Params,
    updateLfoParams, updateLfo2Params, updateIoParams, updateIoChannelVol,
    updateReverbParams, updateReverb2Params, updateChorusParams, getMoogBusNode,
    getOscilloscopeData, getQntTransposeData, getMeterValue, getLfoInstant, getLfo2Instant,
    setTempo, updateSequencerSteps, setSeqStepCallback,
    updateSeq2Steps, setSeq2StepCallback, updateKeyboard,
    updateChordSeqSteps, setChordSeqStepCallback, setChordSeqDivision,
    setChordSeqChordCallback, setChordSeqRootOctave,
    setVco2SyncEnabled,
    updateQuantizerParams, setQuantizerCallback,
  };
}
