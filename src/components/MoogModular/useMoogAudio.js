import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Sequencer pitch range — same as VCO FREQ knob (C1–C6)
const SEQ_HZ_MIN  = 32.703;
const SEQ_HZ_MAX  = 1046.502;
const VCO_IDS     = ['vco1', 'vco2', 'vco3', 'vco4', 'vco5'];
const VCO_IDX_MAP = { vco1: 0, vco2: 1, vco3: 2, vco4: 3, vco5: 4 };

// 914 Fixed Filter Bank — 14 bands: LP shelf + 12 bandpass + HP shelf.
// Frequencies spaced at √2 intervals (2 bands/octave), authentic to the Moog 914.
// LP/HP use shelf filters; bandpass uses BiquadFilter(bandpass) → Gain (parallel sum).
export const FFB_BANDS = [
  { freq: 100,  type: 'lowpass',  Q: 0.7, label: 'LP'   },
  { freq: 125,  type: 'bandpass', Q: 2.8, label: '125'  },
  { freq: 175,  type: 'bandpass', Q: 2.8, label: '175'  },
  { freq: 250,  type: 'bandpass', Q: 2.8, label: '250'  },
  { freq: 350,  type: 'bandpass', Q: 2.8, label: '350'  },
  { freq: 500,  type: 'bandpass', Q: 2.8, label: '500'  },
  { freq: 700,  type: 'bandpass', Q: 2.8, label: '700'  },
  { freq: 1000, type: 'bandpass', Q: 2.8, label: '1k'   },
  { freq: 1400, type: 'bandpass', Q: 2.8, label: '1.4k' },
  { freq: 2000, type: 'bandpass', Q: 2.8, label: '2k'   },
  { freq: 2800, type: 'bandpass', Q: 2.8, label: '2.8k' },
  { freq: 4000, type: 'bandpass', Q: 2.8, label: '4k'   },
  { freq: 5600, type: 'bandpass', Q: 2.8, label: '5.6k' },
  { freq: 8000, type: 'highpass', Q: 0.7, label: 'HP'   },
];

// 16-band Vocoder — log-spaced bandpass bands 100 Hz → 8 kHz (geometric ratio ≈ 1.339).
// Each band exists twice: once in the modulator-analysis bank, once in the carrier-synthesis
// bank. Modulator bands drive the matching carrier band's VCA via an envelope follower.
export const VOC_BANDS = [
  { freq: 100,  Q: 4, label: '100'  },
  { freq: 135,  Q: 4, label: '135'  },
  { freq: 180,  Q: 4, label: '180'  },
  { freq: 240,  Q: 4, label: '240'  },
  { freq: 320,  Q: 4, label: '320'  },
  { freq: 430,  Q: 4, label: '430'  },
  { freq: 580,  Q: 4, label: '580'  },
  { freq: 770,  Q: 4, label: '770'  },
  { freq: 1035, Q: 4, label: '1k'   },
  { freq: 1385, Q: 4, label: '1.4k' },
  { freq: 1855, Q: 4, label: '1.9k' },
  { freq: 2485, Q: 4, label: '2.5k' },
  { freq: 3330, Q: 4, label: '3.3k' },
  { freq: 4460, Q: 4, label: '4.5k' },
  { freq: 5970, Q: 4, label: '6k'   },
  { freq: 8000, Q: 4, label: '8k'   },
];

// Rectifier drive — scales the full-wave-rectified band signal so the envelope follower
// drives the carrier VCA gain into a useful range. Tuned by ear; raise for hotter vocoding.
const VOC_ENV_DRIVE = 8;

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

// Per-chord-type voice intervals for the polyphonic CV outputs (voices 2–4).
// Triads get an octave as their 4th voice; 4-note chords use all four tones.
const CHORD_VOICE_INTERVALS = {
  CMAJ:  [0, 4,  7, 12],
  CMIN:  [0, 3,  7, 12],
  CDOM:  [0, 4,  7, 10],
  CMAJ7: [0, 4,  7, 11],
  CMIN7: [0, 3,  7, 10],
  CSUS4: [0, 5,  7, 12],
  CDIM:  [0, 3,  6,  9],
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
    'vco1-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco1-fm':  { type: 'in',  dest: n.vco1fm },
    'vco1-sin': { type: 'out', node: n.vco1bus, waveform: 'sine',      waveformTarget: n.vco1 },
    'vco1-tri': { type: 'out', node: n.vco1bus, waveform: 'triangle',  waveformTarget: n.vco1 },
    'vco1-saw': { type: 'out', node: n.vco1bus, waveform: 'sawtooth',  waveformTarget: n.vco1 },
    'vco1-sqr': { type: 'out', node: n.vco1bus, waveform: 'square',    waveformTarget: n.vco1 },
    'vco1-sync-in':  { type: 'in',  dest: n.vco1syncIn  },
    'vco1-sync-out': { type: 'out', node: n.vco1syncOut },
    // ── VCO 2 ──
    'vco2-cv':  { type: 'in',  dest: null, isVcoCv: true },
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
    'vco3-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco3-fm':  { type: 'in',  dest: n.vco3fm },
    'vco3-sin': { type: 'out', node: n.vco3bus, waveform: 'sine',      waveformTarget: n.vco3 },
    'vco3-tri': { type: 'out', node: n.vco3bus, waveform: 'triangle',  waveformTarget: n.vco3 },
    'vco3-saw': { type: 'out', node: n.vco3bus, waveform: 'sawtooth',  waveformTarget: n.vco3 },
    'vco3-sqr': { type: 'out', node: n.vco3bus, waveform: 'square',    waveformTarget: n.vco3 },
    'vco3-sync-in':  { type: 'in',  dest: n.vco3syncIn  },
    'vco3-sync-out': { type: 'out', node: n.vco3syncOut },
    // ── VCO 4 ──
    'vco4-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco4-fm':  { type: 'in',  dest: n.vco4fm },
    'vco4-sin': { type: 'out', node: n.vco4bus, waveform: 'sine',      waveformTarget: n.vco4 },
    'vco4-tri': { type: 'out', node: n.vco4bus, waveform: 'triangle',  waveformTarget: n.vco4 },
    'vco4-saw': { type: 'out', node: n.vco4bus, waveform: 'sawtooth',  waveformTarget: n.vco4 },
    'vco4-sqr': { type: 'out', node: n.vco4bus, waveform: 'square',    waveformTarget: n.vco4 },
    'vco4-sync-in':  { type: 'in',  dest: n.vco4syncIn  },
    'vco4-sync-out': { type: 'out', node: n.vco4syncOut },
    // ── VCO 5 ──
    'vco5-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco5-fm':  { type: 'in',  dest: n.vco5fm },
    'vco5-sin': { type: 'out', node: n.vco5bus, waveform: 'sine',      waveformTarget: n.vco5 },
    'vco5-tri': { type: 'out', node: n.vco5bus, waveform: 'triangle',  waveformTarget: n.vco5 },
    'vco5-saw': { type: 'out', node: n.vco5bus, waveform: 'sawtooth',  waveformTarget: n.vco5 },
    'vco5-sqr': { type: 'out', node: n.vco5bus, waveform: 'square',    waveformTarget: n.vco5 },
    'vco5-sync-in':  { type: 'in',  dest: n.vco5syncIn  },
    'vco5-sync-out': { type: 'out', node: n.vco5syncOut },
    // ── Noise ──
    'noise-wht':  { type: 'out', node: n.noiseW },
    'noise-pnk':  { type: 'out', node: n.noiseP },
    'noise2-wht': { type: 'out', node: n.noise2W },
    'noise2-pnk': { type: 'out', node: n.noise2P },
    'noise3-wht': { type: 'out', node: n.noise3W },
    'noise3-pnk': { type: 'out', node: n.noise3P },
    // ── Kick ──
    'kick-out': { type: 'out', node: n.kickOut },
    // ── 914 FFB ──
    'ffb-in':  { type: 'in',  dest: n.ffbIn    },
    'ffb-out': { type: 'out', node: n.ffbMaster },
    // ── 16-band Vocoder ── modulator + carrier audio inputs, vocoded output.
    'voc-mod-in':  { type: 'in',  dest: n.vocModRaw },
    'voc-carr-in': { type: 'in',  dest: n.vocCarrIn },
    'voc-out':     { type: 'out', node: n.vocVolume },
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
    'vca-out':  { type: 'out', node: n.seqGateNode  }, // seq1-gated VCA tap
    'vca-out2': { type: 'out', node: n.seq2GateNode }, // seq2-gated VCA tap
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
    // ── Kick gate ── fires kickSynth.triggerAttackRelease on each gate-on event.
    // isKick:true distinguishes it from ENV gates in the loop and connect() handler.
    'kick-gate-in':  { type: 'in', dest: null, isGate: true, isKick: true },
    // ── Kick click CV ── audio-rate CV into kickClickGain.gain for accent modulation.
    'kick-click-in': { type: 'in', dest: n.kickClickGain.gain },
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
    'chordseq-cv-out':     { type: 'out', node: n.chordSeqPitchOut  },
    'chordseq-root-out':   { type: 'out', node: n.chordSeqRootOut   },
    'chordseq-3rd-out':    { type: 'out', node: n.chordSeqThirdOut },
    'chordseq-5th-out':    { type: 'out', node: n.chordSeqFifthOut },
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
  const vco1SyncEnabledRef  = useRef(false);
  const vco2SyncEnabledRef  = useRef(false);     // tracks HARD SYNC toggle state across power cycles
  const vco3SyncEnabledRef  = useRef(false);
  const vco4SyncEnabledRef  = useRef(false);
  const vco5SyncEnabledRef  = useRef(false);
  const extMicRef           = useRef(null);      // Tone.UserMedia mic instance (lazy, on enable)
  // Vocoder spectral-shift state — read by the shift rAF loop, written by updateVocoderParams.
  const vocShiftBaseRef     = useRef(1.0);       // base ratio (1 = no shift)
  const vocShiftLfoRateRef  = useRef(0.7);       // Hz
  const vocShiftLfoAmpRef   = useRef(0);         // octaves of swing
  const vocShiftLastRatioRef = useRef(0);        // delta gate so a static shift settles to 0 writes
  // Glide time in seconds (0 = off). Written by the UI knob, read by the Tone.Loop.
  const seqGlideRef   = useRef(0);
  const seq2GlideRef  = useRef(0);
  const kbdGlideRef   = useRef(0);
  // Keyboard vibrato — depth in Hz, rate in Hz. Driven by a rAF loop inside useEffect.
  const kbdVibratoDepthRef = useRef(0);
  const kbdVibratoRateRef  = useRef(5);
  const kbdVibratoDelayRef = useRef(0);     // delay ramp time in seconds (0 = instant)
  const kbdBaseHzRef       = useRef(220);   // last note Hz from keyboard, for vibrato center
  const kbdNoteOnsetRef    = useRef(null);  // AudioContext time of last note-on (null = no note yet)
  const kbdVibratoResetRef = useRef(false); // set true on note-on; rAF consumes it with its own `now`
  const kbdCurrentHzRef    = useRef(220);   // smoothly-interpolated Hz (glide state, base only)
  const kbdLastOutputHzRef = useRef(220);   // actual last-written Hz including swing — glide seeds from here
  const kbdPrevRafTimeRef  = useRef(null);  // last rAF AudioContext time for delta-time glide
  const seqLoopRef          = useRef(null);
  const seqStepsRef         = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 })));
  const seqCurrentStepRef   = useRef(-1);
  const seqStepCbRef        = useRef(null);   // UI callback for sequencer LED animation
  const seq2LoopRef         = useRef(null);
  const seq2StepsRef        = useRef(Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 })));
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
  const vcoKnobHzRef      = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  // Tracks which source jack is actively driving each VCO cv-in (null = knob only).
  // Written by connect/disconnect; read by step loops and quantizer callback.
  const vcoActiveCvRef   = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  const quantizerStepCbRef    = useRef(null);   // UI callback for quantizer LED animation
  const lastQuantizedMidiRef  = useRef(69);     // A4 default — updated on each note change
  // Persists latest quantizer config so it can be flushed when the worklet finishes loading.
  const quantizerParamsRef    = useRef({ scale: SCALE_DEFS.MAJ, root: 0, octShift: 0, bypass: false });

  useEffect(() => {
    const n = {
      // frequency: 0 — the glideBus Signal (below) is the sole pitch writer.
      // This keeps vco.frequency.value permanently at 0 so glideBus + FM add cleanly.
      vco1:        new Tone.Oscillator({ type: 'sawtooth', frequency: 0 }),
      vco2:        new Tone.Oscillator({ type: 'sawtooth', frequency: 0 }),
      vco3:        new Tone.Oscillator({ type: 'sawtooth', frequency: 0 }),
      vco4:        new Tone.Oscillator({ type: 'sawtooth', frequency: 0 }),
      vco5:        new Tone.Oscillator({ type: 'sawtooth', frequency: 0 }),
      // Per-VCO slew bus — sits between any CV source and vco.frequency.
      // Sole writer to vco.frequency (FM adds on top via vcoNfm).
      // setValueAtTime → instant pitch; setTargetAtTime(hz, t, τ) → exponential glide.
      // Init to ~185 Hz (middle of VCO range, matching freqBase=0.5 in VcoModule).
      // This ensures the oscillator is audible immediately on power-on even if
      // updateVcoParams fires before nodesRef.current is set (child effects run first).
      vco1GlideBus: new Tone.Signal(185),
      vco2GlideBus: new Tone.Signal(185),
      vco3GlideBus: new Tone.Signal(185),
      vco4GlideBus: new Tone.Signal(185),
      vco5GlideBus: new Tone.Signal(185),
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
      chordSeqThirdOut:      new Tone.Signal(SEQ_HZ_MIN), // 3rd of chord CV
      chordSeqFifthOut:      new Tone.Signal(SEQ_HZ_MIN), // 5th of chord CV
      chordSeqInputAnalyser: new Tone.Analyser('waveform', 256), // detects patched pitch CV input

      // Studio reverb — Freeverb (proven in this codebase via VoxTool arpReverb).
      // wet starts at 0 so patching in the reverb doesn't colour sound until MIX is raised.
      reverb:  new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),
      reverb2: new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),

      // Bucket Brigade Chorus — internal LFOs require explicit start()/stop() in powerOn/powerOff.
      // wet:0 on init so patching is transparent until MIX is raised (unity gain at Mix=0).
      chorus: new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.0 }),

      // Per-sequencer gate nodes — sit between n.vca and the seq?-vca-out jacks.
      // Sole writers are the seq1/seq2 Tone.Loop callbacks. Gate-off silences only
      // signals explicitly routed through seq-vca-out / seq2-vca-out, not global audio.
      seqGateNode:  new Tone.Gain(1),
      seq2GateNode: new Tone.Gain(1),

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

      // Built-in vocoder mic — Tone.UserMedia (opened on enable) → extMicGain (MIC IN level)
      // → vocModRaw (the vocoder modulator pre-chain). extMicMeter taps post-gain for the
      // SIG LED (getMeterValue('extMic')).
      extMicGain:  new Tone.Gain(1),
      extMicMeter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),

      // Hard sync signal path (replicated per VCO).
      // Each VCO gets an input buffer (syncIn), worklet output buffer (syncOut),
      // a normal-path gate (normalGain), and a mixing bus (bus). The worklet is
      // wired syncIn.output → worklet → syncOut.input in the .then() block.
      // syncOut.gain crossfades 0→1 (normalGain 1→0) when HARD SYNC is enabled.
      vco1syncIn:     new Tone.Gain(1),
      vco1syncOut:    new Tone.Gain(0),
      vco1normalGain: new Tone.Gain(1),
      vco1bus:        new Tone.Gain(1),
      vco2syncIn:     new Tone.Gain(1),
      vco2syncOut:    new Tone.Gain(0),
      vco2normalGain: new Tone.Gain(1),
      vco2bus:        new Tone.Gain(1),
      vco3syncIn:     new Tone.Gain(1),
      vco3syncOut:    new Tone.Gain(0),
      vco3normalGain: new Tone.Gain(1),
      vco3bus:        new Tone.Gain(1),
      vco4syncIn:     new Tone.Gain(1),
      vco4syncOut:    new Tone.Gain(0),
      vco4normalGain: new Tone.Gain(1),
      vco5syncIn:     new Tone.Gain(1),
      vco5syncOut:    new Tone.Gain(0),
      vco5normalGain: new Tone.Gain(1),
      vco5bus:        new Tone.Gain(1),
      vco4bus:        new Tone.Gain(1),

      // Quantizer output wrapper — gain 1 (always pass-through).
      // AudioWorkletNode (quantizerNode) connects to .input after worklet loads.
      // Tone.Gain so that downstream Tone.js nodes (vco.frequency) can receive it.
      quantizerOut:    new Tone.Gain(1),
      // Silent keepalive — quantizerOut must stay connected to the audio graph or
      // Chrome's tail-time optimisation stops calling the worklet's process(), which
      // silences port.postMessage() and breaks the managed glideBus path.
      qntKeepAlive: new Tone.Gain(0),

      // Transposition CV analyser — taps the incoming TRANSPOSE CV signal so the
      // QuantizerModule's rAF loop can read the current Hz value and derive a note class.
      // Tone.Analyser with 'waveform' type calls getFloatTimeDomainData, which returns
      // the actual float values (Hz) from the ConstantSourceNode inside Tone.Signal.
      // When nothing is connected the analyser returns all zeros → avgHz = 0 < 10 → inactive.
      qntTransposeAnalyser: new Tone.Analyser('waveform', 256),

      // Level meters — dead-end side taps for LED feedback (no effect on audio routing).
      // smoothing controls the RMS window: higher = more averaged, lower = more transient-responsive.
      vco1Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco3Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco4Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco5Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
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
      vco5fm: new Tone.Gain(500),
      vcfcv1: new Tone.Gain(5000),
      vcfcv2: new Tone.Gain(5000),
      vcfenv: new Tone.Gain(1000),
      vcf2cv1: new Tone.Gain(5000),
      vcf2cv2: new Tone.Gain(5000),
      vcf2env: new Tone.Gain(1000),

      // 914 Fixed Filter Bank — parallel bandpass architecture.
      // ffbIn fans out to 14 filters; each filter → Gain (slider-controlled); all Gains → ffbSum → ffbMaster.
      // LP/HP use shelf filters; bandpass use Tone.Filter(bandpass). The Gain nodes (not filter.gain)
      // control amplitude — BiquadFilter bandpass type has no gain parameter.
      // Kick drum engine — MembraneSynth (pitch-drop oscillator + envelope) in parallel
      // with a NoiseSynth click transient through a 2 kHz highpass.
      // kickOut is the jack output; kickClickGain scales the transient independently.
      kickSynth:      new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 5,
                          envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } }),
      kickClickSynth: new Tone.NoiseSynth({ noise: { type: 'white' },
                          envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } }),
      kickClickFilter: new Tone.Filter({ frequency: 2000, type: 'highpass', rolloff: -12 }),
      kickClickGain:   new Tone.Gain(0.25),
      kickOut:         new Tone.Gain(1),

      // 914 Fixed Filter Bank — parallel bandpass architecture.
      ffbIn:       new Tone.Gain(1),
      ffbSum:      new Tone.Gain(1),
      ffbMaster:   new Tone.Gain(1),
      ffbAnalyser: new Tone.Analyser('fft', 512),
      ...Object.fromEntries(FFB_BANDS.map((b, i) => [`ffbFilter${i}`, new Tone.Filter({ type: b.type, frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      ...Object.fromEntries(FFB_BANDS.map((_, i) => [`ffbGain${i}`,   new Tone.Gain(0.75)])),

      // 16-band Vocoder — modulator analysis bank gates a carrier synthesis bank.
      // vocModIn fans to 16 modulator bands: BPF → full-wave rectifier (WaveShaper, drive
      // baked in) → ~20 Hz envelope-follower LP. Each envelope LP connects to the matching
      // carrier band's VCA gain (audio-rate, zero polling). MIX crossfades carrier-dry
      // (vocDry) ↔ vocoded-wet (vocWet) into vocOut. vocAnalyser taps vocModIn for the meter.
      vocModIn:    new Tone.Gain(1),
      vocCarrIn:   new Tone.Gain(1),
      vocSum:      new Tone.Gain(1),
      vocWet:      new Tone.Gain(1),
      vocDry:      new Tone.Gain(0),
      vocOut:      new Tone.Gain(3),  // fixed internal makeup (the band bank is quiet); user level is VOLUME
      vocAnalyser: new Tone.Analyser('fft', 512),
      // Carrier bank feed — patched carrier + HISS/BUZZ excitation sum here before the
      // filter bank. vocDry taps vocCarrIn (raw carrier) directly, so HISS/BUZZ never
      // leak into the dry path — they only appear in the vocoded (wet) signal.
      vocCarrBank: new Tone.Gain(1),
      // Internal carrier oscillator (FREQ + PWIDTH) crossfaded with the external
      // voc-carr-in by CARR MIX. vocCarrSum = mixed carrier (no noise) → feeds both the
      // band bank and vocDry. A pulse wave is a harmonically rich, classic vocoder carrier.
      vocCarrOsc:     new Tone.PulseOscillator({ frequency: 130, width: 0 }),
      vocCarrOscGain: new Tone.Gain(0),  // internal-osc level (CARR MIX)
      vocCarrExtGain: new Tone.Gain(1),  // external-carrier level (CARR MIX)
      vocCarrSum:     new Tone.Gain(1),  // mixed carrier bus
      vocVolume:      new Tone.Gain(1),  // final module output (VOLUME) — the voc-out jack node
      // HISS — high-passed white noise added to the carrier so unvoiced consonants
      // (s, sh, t, f) surface through the high bands. Gain owned by updateVocoderParams.
      vocHissNoise: new Tone.Noise({ type: 'white' }),
      vocHissHP:    new Tone.Filter({ type: 'highpass', frequency: 3500, rolloff: -12 }),
      vocHissGain:  new Tone.Gain(0),
      // BUZZ — low-passed pink noise added to the carrier for low-end body/thump,
      // thickening vowels. Gain owned by updateVocoderParams.
      vocBuzzNoise: new Tone.Noise({ type: 'pink' }),
      vocBuzzLP:    new Tone.Filter({ type: 'lowpass', frequency: 250, rolloff: -12 }),
      vocBuzzGain:  new Tone.Gain(0),
      // CLARITY — high-passed (~1.5 kHz) dry modulator (the real voice's consonants/
      // sibilance) blended straight into the output for word intelligibility. Bypasses
      // the band bank entirely (it is the actual voice, not vocoded). Gain owned by
      // updateVocoderParams. The headline intelligibility control.
      vocClarityHP:   new Tone.Filter({ type: 'highpass', frequency: 1500, rolloff: -12 }),
      vocClarityGain: new Tone.Gain(0),
      // Modulator pre-processing chain (always on, voice-optimized): the voc-mod-in jack
      // lands on vocModRaw → highpass (rumble/plosive removal; voice intelligibility lives
      // in formants >300 Hz so the lost lows don't matter) → compressor (even drive into the
      // envelope followers = consistent, "pro" vocoding) → vocModIn (existing fan-out).
      vocModRaw:  new Tone.Gain(1),
      vocModHP:   new Tone.Filter({ type: 'highpass', frequency: 150, rolloff: -12 }),
      vocModComp: new Tone.Compressor({ threshold: -28, ratio: 4, attack: 0.003, release: 0.12 }),
      // PRESENCE — peaking EQ (~2.7 kHz) on the vocoded output so the robot voice cuts
      // through. Gain (dB) owned by updateVocoderParams; sits vocOut → vocPresence → vocVolume.
      vocPresence: new Tone.Filter({ type: 'peaking', frequency: 2700, Q: 1, gain: 0 }),
      ...Object.fromEntries(VOC_BANDS.map((b, i) => [`vocModBPF${i}`,  new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocModRect${i}`, new Tone.WaveShaper((x) => Math.min(1, Math.abs(x) * VOC_ENV_DRIVE))])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocModEnv${i}`,  new Tone.Filter({ type: 'lowpass', frequency: 20, Q: 0.5, rolloff: -12 })])),
      ...Object.fromEntries(VOC_BANDS.map((b, i) => [`vocCarrBPF${i}`, new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocCarrVCA${i}`, new Tone.Gain(0)])),
    };

    // VCO output buses — each VCO routes through its bus so the HARD SYNC crossfade
    // is transparent. normalGain (1) and syncOut (0) both feed the bus; setVcoNSyncEnabled
    // crossfades between them so exactly one carries signal at a time.
    n.vco1.connect(n.vco1normalGain);
    n.vco1normalGain.connect(n.vco1bus);
    n.vco1syncOut.connect(n.vco1bus);

    n.vco2.connect(n.vco2normalGain);
    n.vco2normalGain.connect(n.vco2bus);
    n.vco2syncOut.connect(n.vco2bus);

    n.vco3.connect(n.vco3normalGain);
    n.vco3normalGain.connect(n.vco3bus);
    n.vco3syncOut.connect(n.vco3bus);

    n.vco4.connect(n.vco4normalGain);
    n.vco4normalGain.connect(n.vco4bus);
    n.vco4syncOut.connect(n.vco4bus);

    n.vco5.connect(n.vco5normalGain);
    n.vco5normalGain.connect(n.vco5bus);
    n.vco5syncOut.connect(n.vco5bus);

    // GlideBus → vco.frequency: the sole pitch writer per VCO.
    // vco.frequency.value stays 0; glideBus provides the Hz; FM adds on top.
    n.vco1GlideBus.connect(n.vco1.frequency);
    n.vco2GlideBus.connect(n.vco2.frequency);
    n.vco3GlideBus.connect(n.vco3.frequency);
    n.vco4GlideBus.connect(n.vco4.frequency);
    n.vco5GlideBus.connect(n.vco5.frequency);

    // CV scaler hardwires — permanent front-doors for modulation inputs.
    // Sources patched to the FM / CV1 / CV2 / ENV jacks flow through these gains
    // before reaching the AudioParam; the scaler itself is never a patch destination.
    n.vco1fm.connect(n.vco1.frequency);
    n.vco2fm.connect(n.vco2.frequency);
    n.vco3fm.connect(n.vco3.frequency);
    n.vco4fm.connect(n.vco4.frequency);
    n.vco5fm.connect(n.vco5.frequency);

    // Keyboard vibrato — additive pitch modulation on all VCOs.

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
    n.extMicGain.connect(n.extMicMeter); // dead-end level tap for the mic LED
    // Built-in mic → vocoder modulator. The mic feeds the same pre-chain front (vocModRaw)
    // as the MOD jack, so enabling the mic + a carrier vocodes instantly (no patching), and
    // an external MOD patch still sums in. extMicGain is silent until the mic is enabled.
    n.extMicGain.connect(n.vocModRaw);
    n.vco1bus.connect(n.vco1Meter);
    n.vco2bus.connect(n.vco2Meter);
    n.vco3bus.connect(n.vco3Meter);
    n.vco4bus.connect(n.vco4Meter);
    n.vco5bus.connect(n.vco5Meter);

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
    // Quantizer keepalive: gain(0) ensures quantizerOut stays connected to the
    // audio graph so Chrome never stops calling the worklet's process() callback.
    n.quantizerOut.connect(n.qntKeepAlive);
    n.qntKeepAlive.connect(Tone.Destination);

    // Kick engine — MembraneSynth and click transient both feed kickOut
    n.kickSynth.connect(n.kickOut);
    n.kickClickSynth.connect(n.kickClickFilter);
    n.kickClickFilter.connect(n.kickClickGain);
    n.kickClickGain.connect(n.kickOut);

    // 914 FFB — parallel bandpass sum
    FFB_BANDS.forEach((_, i) => {
      n.ffbIn.connect(n[`ffbFilter${i}`]);
      n[`ffbFilter${i}`].connect(n[`ffbGain${i}`]);
      n[`ffbGain${i}`].connect(n.ffbSum);
    });
    n.ffbSum.connect(n.ffbMaster);
    n.ffbIn.connect(n.ffbAnalyser);

    // 16-band Vocoder — modulator envelope followers gate carrier band VCAs.
    // Single writer per node: each vocCarrVCA.gain is driven only by its env follower
    // (audio connection into the AudioParam); vocWet/vocDry.gain owned by updateVocoderParams.
    VOC_BANDS.forEach((_, i) => {
      n.vocModIn.connect(n[`vocModBPF${i}`]);
      n[`vocModBPF${i}`].connect(n[`vocModRect${i}`]);
      n[`vocModRect${i}`].connect(n[`vocModEnv${i}`]);
      n[`vocModEnv${i}`].connect(n[`vocCarrVCA${i}`].gain); // audio-rate env → VCA gain
      n.vocCarrBank.connect(n[`vocCarrBPF${i}`]);
      n[`vocCarrBPF${i}`].connect(n[`vocCarrVCA${i}`]);
      n[`vocCarrVCA${i}`].connect(n.vocSum);
    });
    // Carrier sum — external (voc-carr-in) + internal pulse osc, blended by CARR MIX.
    // Feeds both the band bank (vocoded) and vocDry (passthrough). HISS/BUZZ go to the
    // bank only, so they never leak into vocDry.
    n.vocCarrIn.connect(n.vocCarrExtGain);
    n.vocCarrExtGain.connect(n.vocCarrSum);
    n.vocCarrOsc.connect(n.vocCarrOscGain);
    n.vocCarrOscGain.connect(n.vocCarrSum);
    n.vocCarrSum.connect(n.vocCarrBank); // mixed carrier → band bank (vocoded path)
    n.vocCarrSum.connect(n.vocDry);      // dry = mixed carrier passthrough (no HISS/BUZZ)
    // HISS/BUZZ excitation → bank only, shaped by the modulator envelope.
    n.vocHissNoise.connect(n.vocHissHP);
    n.vocHissHP.connect(n.vocHissGain);
    n.vocHissGain.connect(n.vocCarrBank);
    n.vocBuzzNoise.connect(n.vocBuzzLP);
    n.vocBuzzLP.connect(n.vocBuzzGain);
    n.vocBuzzGain.connect(n.vocCarrBank);
    // Modulator pre-processing — jack lands on vocModRaw; HP + compressor condition the
    // voice before it fans out (vocModIn keeps all its existing downstream connections).
    n.vocModRaw.connect(n.vocModHP);
    n.vocModHP.connect(n.vocModComp);
    n.vocModComp.connect(n.vocModIn);
    // Output stage: vocoded (wet) + carrier (dry) → vocOut (OUT makeup) → vocPresence (EQ).
    n.vocSum.connect(n.vocWet);
    n.vocWet.connect(n.vocOut);
    n.vocDry.connect(n.vocOut);
    n.vocOut.connect(n.vocPresence);
    // CLARITY — high-passed real voice to the volume stage (bypasses OUT makeup + presence).
    n.vocModIn.connect(n.vocClarityHP);
    n.vocClarityHP.connect(n.vocClarityGain);
    n.vocClarityGain.connect(n.vocVolume);
    // Final master volume (VOL) → voc-out jack.
    n.vocPresence.connect(n.vocVolume);
    n.vocModIn.connect(n.vocAnalyser); // FFT tap for the 16-segment meter

    // seqGateNode sits between VCA and the vca-out jack — secondary gate for vca-out path.
    n.vca.connect(n.seqGateNode);
    n.vca.connect(n.seq2GateNode);

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

      // seqPitchOut always jumps instantly — it drives the quantizer and other
      // non-VCO destinations. Glide is applied at each VCO's glideBus so it
      // happens AFTER any quantizer in the path, never producing a staircase.
      const hz    = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step.voltage);
      const glide = seqGlideRef.current;
      n.seqPitchOut.setValueAtTime(hz, time);
      // Apply glide on every VCO that has seq-pitch-out directly connected to its cv-in.
      for (const vcoId of VCO_IDS) {
        if (vcoActiveCvRef.current[vcoId] !== 'seq-pitch-out') continue;
        const gb = n[`${vcoId}GlideBus`];
        if (glide < 0.001) gb.setValueAtTime(hz, time);
        else               gb.rampTo(hz, glide, time);
        n.hardSyncNodes?.[VCO_IDX_MAP[vcoId]]?.parameters.get('slaveFreq')
          .setTargetAtTime(hz, time, Math.max(glide / 3, 0.001));
      }

      const fires = step.gate && Math.random() < step.prob;
      const gateVal = fires ? 1 : 0;
      // Gate only VCOs connected to seq1's pitch output and the vca-out path.
      // seqMasterGate is NOT written — it would silence seq2's audio.
      // Use native AudioParam directly: Tone.Param's setValueAtTime goes through
      // its own event queue which can conflict with rampTo calls on the same chain.
      n.seqGateNode.gain._param.setValueAtTime(gateVal, time);
      for (const vcoId of VCO_IDS) {
        if (vcoActiveCvRef.current[vcoId] === 'seq-pitch-out')
          n[`${vcoId}bus`].gain._param.setValueAtTime(gateVal, time);
      }

      if (gateActionsRef.current.size > 0) {
        const stepDur = fires ? Tone.Time('8n').toSeconds() : 0;
        for (const [, action] of gateActionsRef.current) {
          if (action.fromId !== 'seq-gate-out') continue;
          if (action.isKick) {
            if (fires) {
              n.kickSynth.triggerAttackRelease(kickTuneRef.current, kickDecayRef.current, time);
              n.kickClickSynth.triggerAttackRelease(kickDecayRef.current * 0.1, time);
              kickTrigCbRef.current?.();
            }
          } else {
            if (fires) {
              action.env.triggerAttack(time);
              action.env.triggerRelease(time + stepDur * 0.8);
            } else {
              action.env.triggerRelease(time);
            }
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
      const hz2    = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step2.voltage);
      const glide2 = seq2GlideRef.current;
      n.seq2PitchOut.setValueAtTime(hz2, time);
      for (const vcoId of VCO_IDS) {
        if (vcoActiveCvRef.current[vcoId] !== 'seq2-pitch-out') continue;
        const gb = n[`${vcoId}GlideBus`];
        if (glide2 < 0.001) gb.setValueAtTime(hz2, time);
        else                gb.rampTo(hz2, glide2, time);
        n.hardSyncNodes?.[VCO_IDX_MAP[vcoId]]?.parameters.get('slaveFreq')
          .setTargetAtTime(hz2, time, Math.max(glide2 / 3, 0.001));
      }
      const fires2 = step2.gate && Math.random() < step2.prob;
      const gateVal2 = fires2 ? 1 : 0;
      n.seq2GateNode.gain._param.setValueAtTime(gateVal2, time);
      for (const vcoId of VCO_IDS) {
        if (vcoActiveCvRef.current[vcoId] === 'seq2-pitch-out')
          n[`${vcoId}bus`].gain._param.setValueAtTime(gateVal2, time);
      }
      if (gateActionsRef.current.size > 0) {
        const stepDur2 = fires2 ? Tone.Time('8n').toSeconds() : 0;
        for (const [, action] of gateActionsRef.current) {
          if (action.fromId !== 'seq2-gate-out') continue;
          if (action.isKick) {
            if (fires2) {
              n.kickSynth.triggerAttackRelease(kickTuneRef.current, kickDecayRef.current, time);
              n.kickClickSynth.triggerAttackRelease(kickDecayRef.current * 0.1, time);
              kickTrigCbRef.current?.();
            }
          } else {
            if (fires2) {
              action.env.triggerAttack(time);
              action.env.triggerRelease(time + stepDur2 * 0.8);
            } else {
              action.env.triggerRelease(time);
            }
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
      const chordHz = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
      if (!chordSeqInputActiveRef.current) {
        n.chordSeqPitchOut.setValueAtTime(chordHz, time);
        // Drive glideBus for VCOs connected from chordseq-cv-out (no external CV active).
        // No glide ref for the chord seq itself — instant jumps at the chord boundary.
        for (const vcoId of VCO_IDS) {
          if (vcoActiveCvRef.current[vcoId] === 'chordseq-cv-out')
            n[`${vcoId}GlideBus`]?.setValueAtTime(chordHz, time);
        }
      }
      // Polyphonic voice outputs — all 4 voices always fire regardless of cv-in state.
      // Voice intervals come from CHORD_VOICE_INTERVALS, applied relative to shifted root.
      const oct         = Math.pow(2, chordSeqRootOctaveRef.current);
      const shiftedRoot = chordHz * oct;
      const intervals   = CHORD_VOICE_INTERVALS[step.chordType] ?? CHORD_VOICE_INTERVALS.CMAJ;
      const voiceHz     = intervals.map(st => shiftedRoot * Math.pow(2, st / 12));
      n.chordSeqRootOut.setValueAtTime(voiceHz[0], time);
      n.chordSeqThirdOut.setValueAtTime(voiceHz[1], time);
      n.chordSeqFifthOut.setValueAtTime(voiceHz[2], time);
      for (const vcoId of VCO_IDS) {
        const src = vcoActiveCvRef.current[vcoId];
        if (src === 'chordseq-root-out') n[`${vcoId}GlideBus`]?.setValueAtTime(voiceHz[0], time);
        if (src === 'chordseq-3rd-out')  n[`${vcoId}GlideBus`]?.setValueAtTime(voiceHz[1], time);
        if (src === 'chordseq-5th-out')  n[`${vcoId}GlideBus`]?.setValueAtTime(voiceHz[2], time);
      }

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
    let prevChordSnap = null; // delta gate — only trigger glideBus ramp when pitch changes
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
        // Drive glideBus for VCOs connected from chordseq-cv-out.
        // Delta-gated so rampTo is only called once per pitch change, not every rAF frame.
        if (snapped !== prevChordSnap) {
          prevChordSnap = snapped;
          // Glide amount: look up the source feeding chordseq-cv-in and use its glide ref.
          const cvKey = [...connectionsRef.current.keys()].find(k => k.endsWith('→chordseq-cv-in'));
          const cvSrc = cvKey?.split('→')[0];
          const cvGlide = cvSrc === 'seq-pitch-out'  ? seqGlideRef.current
                        : cvSrc === 'seq2-pitch-out' ? seq2GlideRef.current
                        : cvSrc === 'kbd-pitch-out'  ? kbdGlideRef.current
                        : 0;
          for (const vcoId of VCO_IDS) {
            if (vcoActiveCvRef.current[vcoId] !== 'chordseq-cv-out') continue;
            const gb = n[`${vcoId}GlideBus`];
            if (!gb) continue;
            if (cvGlide < 0.001) gb.setValueAtTime(snapped, Tone.now());
            else                  gb.rampTo(snapped, cvGlide, Tone.now());
          }
        }
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

    // Keyboard vibrato rAF — writes baseHz + depth*sin(2π*rate*t) to the glideBus
    // of every VCO connected from kbd-pitch-out. Uses the same native _param path
    // as the glide system — guaranteed to reach the actual AudioParam.
    let vibratoRafId;
    // Combined glide + vibrato rAF — the single writer for kbd-connected VCO glideBuses.
    // Glide is handled here via exponential lerp so setValueAtTime never conflicts with
    // a scheduled LinearRamp (which any setValueAtTime call would cancel).
    const vibratoTick = () => {
      vibratoRafId = requestAnimationFrame(vibratoTick);
      const now = Tone.context.rawContext.currentTime;

      // Consume note-on reset flag — stamp onset with THIS frame's `now` so elapsed is exactly 0.
      // Seed kbdCurrentHzRef from kbdLastOutputHzRef (actual pitch including any vibrato swing)
      // so the glide starts from the true current pitch with zero discontinuity.
      if (kbdVibratoResetRef.current) {
        kbdNoteOnsetRef.current  = now;
        kbdCurrentHzRef.current  = kbdLastOutputHzRef.current;
        kbdVibratoResetRef.current = false;
      }

      // Delta time for exponential glide lerp
      const prev = kbdPrevRafTimeRef.current ?? now;
      const dt   = Math.min(now - prev, 0.1); // cap at 100ms (e.g. tab backgrounding)
      kbdPrevRafTimeRef.current = now;

      // Glide: exponentially approach target Hz
      const glide = kbdGlideRef.current;
      const targetHz = kbdBaseHzRef.current;
      if (glide < 0.001) {
        kbdCurrentHzRef.current = targetHz;
      } else {
        const alpha = 1 - Math.exp(-dt / glide);
        kbdCurrentHzRef.current += alpha * (targetHz - kbdCurrentHzRef.current);
      }

      // Vibrato swing
      const depth     = kbdVibratoDepthRef.current;
      const delayTime = kbdVibratoDelayRef.current;
      const elapsed   = kbdNoteOnsetRef.current === null ? 0 : now - kbdNoteOnsetRef.current;
      const effectiveDepth = depth < 0.001 ? 0 : delayTime < 0.01
        ? depth
        : depth * Math.min(1, Math.max(0, elapsed / delayTime));
      const swing = effectiveDepth < 0.001
        ? 0
        : effectiveDepth * Math.sin(2 * Math.PI * kbdVibratoRateRef.current * now);

      // Write once per frame — no scheduled events, no conflicts
      const hz = Math.max(1, kbdCurrentHzRef.current + swing);
      kbdLastOutputHzRef.current = hz;
      for (const vcoId of VCO_IDS) {
        if (vcoActiveCvRef.current[vcoId] !== 'kbd-pitch-out') continue;
        n[`${vcoId}GlideBus`]?._param.setValueAtTime(hz, now);
      }
    };
    vibratoTick();

    // Vocoder spectral-shift rAF — scales the 16 carrier bandpass center freqs by
    // ratio = base · 2^(ampOct · sin(2π·rate·t)). base ← SHIFT knob; LFO ← SH RATE / SH AMP.
    // Sole writer of vocCarrBPF*.frequency. Delta-gated so a static shift settles to 0 writes.
    let vocShiftRafId;
    const vocShiftTick = () => {
      vocShiftRafId = requestAnimationFrame(vocShiftTick);
      const now  = Tone.context.rawContext.currentTime;
      const amp  = vocShiftLfoAmpRef.current;
      const lfo  = amp < 0.001 ? 1 : Math.pow(2, amp * Math.sin(2 * Math.PI * vocShiftLfoRateRef.current * now));
      const ratio = vocShiftBaseRef.current * lfo;
      if (Math.abs(ratio - vocShiftLastRatioRef.current) < 1e-4) return; // unchanged — skip
      vocShiftLastRatioRef.current = ratio;
      for (let i = 0; i < VOC_BANDS.length; i++) {
        const f = n[`vocCarrBPF${i}`];
        if (!f) continue;
        f.frequency.setValueAtTime(Math.max(20, Math.min(18000, VOC_BANDS[i].freq * ratio)), now);
      }
    };
    vocShiftTick();

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
        // Drive glideBus for any VCO connected from qnt-cv-out — the quantizer
        // produces an instant quantized target; the glideBus applies the glide
        // AFTER quantization so the slide is always between two in-scale notes.
        if (data.midiNote !== undefined && nodesRef.current) {
          const hz = 440 * Math.pow(2, (data.midiNote - 69) / 12);
          // Determine glide τ by tracing what drives qnt-cv-in.
          const qntSource = [...connectionsRef.current.keys()]
            .find(k => k.endsWith('→qnt-cv-in'))?.split('→')[0];
          const rawGlide = qntSource === 'seq-pitch-out'  ? seqGlideRef.current
                         : qntSource === 'seq2-pitch-out' ? seq2GlideRef.current
                         : qntSource === 'kbd-pitch-out'  ? kbdGlideRef.current
                         : 0;
          for (const vcoId of VCO_IDS) {
            if (vcoActiveCvRef.current[vcoId] !== 'qnt-cv-out') continue;
            const gb = nodesRef.current[`${vcoId}GlideBus`];
            if (!gb) continue;
            if (rawGlide < 0.001) gb.setValueAtTime(hz, Tone.now());
            else                  gb.rampTo(hz, rawGlide, Tone.now());
            nodesRef.current.hardSyncNodes?.[VCO_IDX_MAP[vcoId]]
              ?.parameters.get('slaveFreq').setTargetAtTime(hz, Tone.now(), Math.max(rawGlide / 3, 0.001));
          }
        }
      };

      // Rebuild jackMap so qnt-cv-in is now live (was dest:null before worklet loaded).
      jackMapRef.current = buildJackMap(n);
    }).catch(err => {
      console.warn('[MoogAudio] Quantizer worklet unavailable:', err);
    });

    // Load the hard sync AudioWorklet asynchronously.
    // One worklet node is created per VCO. If the load fails the sync jacks remain
    // no-ops and everything else works normally.
    // outputChannelCount:[1] forces mono — Chrome defaults to 2ch, leaving the right
    // channel permanently silent; mono upmixes correctly downstream.
    const hardSyncNodes = [];
    rawCtx.audioWorklet.addModule('/hard-sync-worklet.js').then(() => {
      if (nodesRef.current !== n) return;

      const wire = (syncIn, syncOut, fmGain) => {
        const node = Tone.context.createAudioWorkletNode('hard-sync-processor', { outputChannelCount: [1] });
        syncIn.output.connect(node);
        node.connect(syncOut.input);
        try { fmGain.connect(node.parameters.get('slaveFreq')); } catch (_) {}
        return node;
      };

      hardSyncNodes.push(
        wire(n.vco1syncIn, n.vco1syncOut, n.vco1fm),
        wire(n.vco2syncIn, n.vco2syncOut, n.vco2fm),
        wire(n.vco3syncIn, n.vco3syncOut, n.vco3fm),
        wire(n.vco4syncIn, n.vco4syncOut, n.vco4fm),
        wire(n.vco5syncIn, n.vco5syncOut, n.vco5fm),
      );
      n.hardSyncNodes = hardSyncNodes;
    }).catch(err => {
      console.warn('[MoogAudio] Hard sync worklet unavailable:', err);
    });

    return () => {
      cancelAnimationFrame(chordSnapRafId);
      cancelAnimationFrame(qntOverrideRafId);
      cancelAnimationFrame(vibratoRafId);
      cancelAnimationFrame(vocShiftRafId);
      // Release the mic device if it was opened, so the OS mic indicator clears on unmount.
      if (extMicRef.current) {
        try { extMicRef.current.close(); } catch (_) {}
        try { extMicRef.current.dispose(); } catch (_) {}
        extMicRef.current = null;
      }
      // Null out nodesRef first so any in-flight worklet Promise .then() bails immediately.
      nodesRef.current = null;
      jackMapRef.current = null;
      [n.vco1, n.vco2, n.vco3, n.vco4, n.vco5, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
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
      hardSyncNodes.forEach(node => { try { node.disconnect(); } catch (_) {} });
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
    [n.vco1, n.vco2, n.vco3, n.vco4, n.vco5, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
      try { node.start(); } catch (_) {}
    });

    // Restore hard sync crossfade for all VCOs. syncOut was forced to 0 on powerOff
    // to prevent always-running worklets from producing audio while the synth is off.
    [[n.vco1normalGain, n.vco1syncOut, vco1SyncEnabledRef],
     [n.vco2normalGain, n.vco2syncOut, vco2SyncEnabledRef],
     [n.vco3normalGain, n.vco3syncOut, vco3SyncEnabledRef],
     [n.vco4normalGain, n.vco4syncOut, vco4SyncEnabledRef],
     [n.vco5normalGain, n.vco5syncOut, vco5SyncEnabledRef],
    ].forEach(([normalGain, syncOut, ref]) => {
      const se = ref.current;
      normalGain.gain.value = se ? 0 : 1;
      syncOut.gain.value    = se ? 1 : 0;
    });

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
    [n.vco1, n.vco2, n.vco3, n.vco4, n.vco5, n.noiseW, n.noiseP, n.noise2W, n.noise2P, n.noise3W, n.noise3P, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
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
    [n.vco1syncOut, n.vco2syncOut, n.vco3syncOut, n.vco4syncOut, n.vco5syncOut].forEach(g => { g.gain.value = 0; });
    [n.vco1normalGain, n.vco2normalGain, n.vco3normalGain, n.vco4normalGain, n.vco5normalGain].forEach(g => { g.gain.value = 1; });

    // Re-open both gates so keyboard / manual playing is audible after sequencer stops.
    // Last gate-off step may have left them closed.
    n.seqMasterGate.gain.value = 1;
    n.seqGateNode.gain.value   = 1;
    n.seq2GateNode.gain.value  = 1;

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
      if (to.isKick) {
        // Kick gate — store without an env ref; loop handlers detect isKick.
        gateActionsRef.current.set(key, { isKick: true, fromId: effFrom });
        connectionsRef.current.set(key, { isGate: true, toId: effTo });
      } else {
        const env = n[to.envId];
        if (env) {
          gateActionsRef.current.set(key, { env, fromId: effFrom });
          connectionsRef.current.set(key, { isGate: true, toId: effTo });
        }
      }
      return;
    }

    if (from.type !== 'out' || to.type !== 'in') return;
    if (from.node === null) return; // unimplemented output (e.g. seq-clk-out)

    // VCO cv-in — managed by glideBus, never audio-connected directly.
    // "Managed" sources (seq/kbd/qnt) are written by step loops/callbacks.
    // "Pass-through" sources (chord seq, other audio) audio-connect to the glideBus
    // which passes the signal through transparently (offset stays 0).
    if (to.isVcoCv) {
      const vcoId     = effTo.replace('-cv', '');
      const glideBus  = n[`${vcoId}GlideBus`];
      if (!glideBus) return;
      vcoActiveCvRef.current[vcoId] = effFrom;
      // Managed sources: no audio cable — step loops / rAF / port.onmessage write to glideBus.
      const MANAGED = new Set(['seq-pitch-out','seq2-pitch-out','kbd-pitch-out',
                               'qnt-cv-out','chordseq-cv-out','chordseq-root-out',
                               'chordseq-3rd-out','chordseq-5th-out']);
      if (MANAGED.has(effFrom)) {
        // No audio cable — step loops/quantizer callback write to glideBus on each event.
        // Seed the glideBus with the source's current value so there's no jump on connect.
        const seedHz = effFrom === 'seq-pitch-out'     ? (n.seqPitchOut.value       ?? SEQ_HZ_MIN)
                     : effFrom === 'seq2-pitch-out'    ? (n.seq2PitchOut.value      ?? SEQ_HZ_MIN)
                     : effFrom === 'kbd-pitch-out'     ? (n.kbdPitchOut.value       ?? SEQ_HZ_MIN)
                     : effFrom === 'qnt-cv-out'        ? 440 * Math.pow(2, (lastQuantizedMidiRef.current - 69) / 12)
                     : effFrom === 'chordseq-cv-out'     ? (n.chordSeqPitchOut.value  ?? SEQ_HZ_MIN)
                     : effFrom === 'chordseq-root-out'   ? (n.chordSeqRootOut.value   ?? SEQ_HZ_MIN)
                     : effFrom === 'chordseq-3rd-out'    ? (n.chordSeqThirdOut.value  ?? SEQ_HZ_MIN)
                     : effFrom === 'chordseq-5th-out'    ? (n.chordSeqFifthOut.value  ?? SEQ_HZ_MIN)
                     : SEQ_HZ_MIN;
        glideBus.setValueAtTime(seedHz, Tone.now());
      } else {
        // Pass-through: audio-connect so the source flows to the glideBus offset-addition.
        // Zero the offset so only the source drives the bus (no double-counting).
        glideBus.setValueAtTime(0, Tone.now());
        try { from.node.connect(glideBus); } catch (e) {
          console.warn(`[MoogAudio] vco-cv pass-through connect ${key}:`, e.message);
        }
      }
      connectionsRef.current.set(key, { isVcoCv: true, vcoId, sourceId: effFrom,
        audioNode: MANAGED.has(effFrom) ? null : from.node });
      return;
    }

    if (to.dest === null) return;   // deferred jack — silently no-op

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

    // VCO cv-in disconnect — restore glideBus to knob value, clear source tracking.
    if (conn.isVcoCv) {
      const n = nodesRef.current;
      if (!n) { connectionsRef.current.delete(key); return; }
      const { vcoId, audioNode } = conn;
      // Disconnect pass-through audio cable if present.
      if (audioNode) {
        try { audioNode.disconnect(n[`${vcoId}GlideBus`]); } catch (_) {}
      }
      vcoActiveCvRef.current[vcoId] = null;
      connectionsRef.current.delete(key);
      // Restore knob Hz to the glideBus (instant — no glide on cable-remove).
      const kHz = vcoKnobHzRef.current[vcoId];
      if (kHz != null) {
        n[`${vcoId}GlideBus`].setValueAtTime(kHz, Tone.now());
        n.hardSyncNodes?.[VCO_IDX_MAP[vcoId]]?.parameters.get('slaveFreq').setValueAtTime(kHz, Tone.now());
      }
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
    const syncNode = n.hardSyncNodes?.[VCO_IDX_MAP[vcoId]];
    if (hz !== undefined) {
      const safeHz = Math.max(0.1, hz);
      vcoKnobHzRef.current[vcoId] = safeHz;
      // Only write when no CV source is connected — glideBus is the sole pitch writer.
      const hasCv = vcoActiveCvRef.current[vcoId] != null;
      if (!hasCv) {
        const gb = n[`${vcoId}GlideBus`];
        if (Tone.context.state === 'running') gb.rampTo(safeHz, 0.02);
        else                                  gb.value = safeHz;
        syncNode?.parameters.get('slaveFreq').setTargetAtTime(safeHz, Tone.now(), 0.02);
      }
    }
    if (detune !== undefined) {
      vco.detune.setTargetAtTime(detune, Tone.now(), 0.02);
      syncNode?.parameters.get('slaveDetune').setTargetAtTime(detune, Tone.now(), 0.02);
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
  // Glide setters — single writers for each glide ref. Value is seconds (0 = off).
  // Kick drum params — single writer, called by KickModule knobs.
  // tune: Hz (40–200), pitchEnv: octave drop (0–5), decay: seconds (0.05–2), click: gain (0–1).
  const kickTuneRef   = useRef(55);
  const kickDecayRef  = useRef(0.4);
  const kickTrigCbRef = useRef(null); // UI flash callback — registered by KickModule

  const updateKickParams = useCallback(({ tune, pitchEnv, decay, click } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (tune      !== undefined) kickTuneRef.current  = tune;
    if (decay     !== undefined) {
      kickDecayRef.current = decay;
      n.kickSynth.envelope.decay   = decay;
      n.kickSynth.envelope.release = decay * 0.25;
    }
    if (pitchEnv  !== undefined) n.kickSynth.octaves     = pitchEnv;
    if (click     !== undefined) safeRamp(n.kickClickGain.gain, click, 0.02);
  }, []);

  const triggerKick = useCallback((onFlash) => {
    const n = nodesRef.current;
    if (!n) return;
    const now = Tone.now();
    n.kickSynth.triggerAttackRelease(kickTuneRef.current, kickDecayRef.current, now);
    n.kickClickSynth.triggerAttackRelease(kickDecayRef.current * 0.1, now);
    onFlash?.();
  }, []);

  // Keyboard vibrato — depth in Hz (0–20), rate in Hz, delay bool. Drives the rAF loop refs.
  const setKbdVibrato = useCallback(({ depth, rate, delay } = {}) => {
    if (depth !== undefined) kbdVibratoDepthRef.current = depth;
    if (rate  !== undefined) kbdVibratoRateRef.current  = rate;
    if (delay !== undefined) kbdVibratoDelayRef.current = delay; // delay = time in seconds
  }, []);

  const setSeqGlide  = useCallback((v) => { seqGlideRef.current  = v; }, []);
  const setSeq2Glide = useCallback((v) => { seq2GlideRef.current = v; }, []);
  const setKbdGlide  = useCallback((v) => { kbdGlideRef.current  = v; }, []);

  // 914 FFB — single writer per band gain node; master owns ffbMaster.gain.
  const updateFFBParams = useCallback(({ bands, master } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (bands) {
      bands.forEach((v, i) => {
        const g = n[`ffbGain${i}`];
        if (g) safeRamp(g.gain, Math.max(0, Math.min(1.5, v)), 0.02);
      });
    }
    if (master !== undefined) safeRamp(n.ffbMaster.gain, Math.max(0, master), 0.02);
  }, []);

  const getFFBAnalyserData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.ffbAnalyser.getValue();
  }, []);

  // 16-band Vocoder — MIX crossfades carrier-dry (vocDry) ↔ vocoded-wet (vocWet).
  // HISS/BUZZ scale the high-passed / low-passed noise injected into the carrier bank.
  // OUT is post-mix makeup gain (the bank is intrinsically quiet); CLARITY blends the
  // high-passed real voice for word intelligibility.
  // Single writer: this owns vocWet/vocDry/vocHissGain/vocBuzzGain/vocOut/vocClarityGain;
  // the env followers own the per-band VCA gains.
  const updateVocoderParams = useCallback((p = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    const { mix, hiss, buzz, clarity,
            pwidth, carrierMix, shift, res, shiftRate, shiftAmp, decay, volume, presence } = p;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    if (mix !== undefined) {
      const m = clamp01(mix);
      safeRamp(n.vocWet.gain, m, 0.05);
      safeRamp(n.vocDry.gain, 1 - m, 0.05);
    }
    // Knob 0–1 → conservative gain ceilings so the excitation supports rather than swamps.
    if (hiss !== undefined)    safeRamp(n.vocHissGain.gain,    clamp01(hiss) * 0.5, 0.05);
    if (buzz !== undefined)    safeRamp(n.vocBuzzGain.gain,    clamp01(buzz) * 0.7, 0.05);
    // Voice clarity: knob 0–1 → 0–0.9× of the high-passed dry voice.
    if (clarity !== undefined) safeRamp(n.vocClarityGain.gain, clamp01(clarity) * 0.9, 0.05);

    // Internal carrier oscillator (fixed pitch — set at construction).
    // PWIDTH: knob 0–1 → width −0.95..0.95 (0.5 = square). Tone.PulseOscillator.width.
    if (pwidth !== undefined)  safeRamp(n.vocCarrOsc.width, (clamp01(pwidth) * 2 - 1) * 0.95, 0.05);
    // CARR MIX: knob 0 = external carrier only, 1 = internal osc only.
    if (carrierMix !== undefined) {
      const cm = clamp01(carrierMix);
      safeRamp(n.vocCarrExtGain.gain, 1 - cm, 0.05);
      safeRamp(n.vocCarrOscGain.gain, cm, 0.05);
    }
    // RES: carrier band Q. knob 0–1 → Q 1–7 (0.5 ≈ 4, the base VOC_BANDS Q).
    if (res !== undefined) {
      const q = 1 + clamp01(res) * 6;
      for (let i = 0; i < VOC_BANDS.length; i++) safeRamp(n[`vocCarrBPF${i}`].Q, q, 0.05);
    }
    // DECAY: envelope-follower LP cutoff. knob 0–1 → ~56 Hz (snappy) … ~7 Hz (smeary), 0.5 ≈ 20 Hz.
    if (decay !== undefined) {
      const cutoff = 20 * Math.pow(2, (0.5 - clamp01(decay)) * 3);
      for (let i = 0; i < VOC_BANDS.length; i++) safeRamp(n[`vocModEnv${i}`].frequency, cutoff, 0.05);
    }
    // SHIFT / SH RATE / SH AMP — ref writes consumed by the spectral-shift rAF loop.
    if (shift !== undefined)     vocShiftBaseRef.current    = Math.pow(2, (clamp01(shift) - 0.5) * 2); // ±1 octave
    if (shiftRate !== undefined) vocShiftLfoRateRef.current = 0.05 * Math.pow(2, clamp01(shiftRate) * 7.64); // 0.05–10 Hz
    if (shiftAmp !== undefined)  vocShiftLfoAmpRef.current  = clamp01(shiftAmp); // 0–1 octave swing
    // VOLUME: final module output level. knob 0–1 → 0–2× (0.5 = nominal; combines with the
    // fixed 3× makeup on vocOut → up to 6× total). Also scales the CLARITY blend (it sums here).
    if (volume !== undefined)  safeRamp(n.vocVolume.gain, clamp01(volume) * 2, 0.05);
    // PRESENCE: peaking EQ gain at ~2.7 kHz. knob 0–1 → 0..+12 dB (boost only).
    if (presence !== undefined) safeRamp(n.vocPresence.gain, clamp01(presence) * 12, 0.05);
  }, []);

  const getVocAnalyserData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.vocAnalyser.getValue();
  }, []);

  // Built-in vocoder mic — opens a Tone.UserMedia stream (requires a user gesture for the
  // browser permission prompt) and routes it into extMicGain, which feeds the vocoder
  // modulator (vocModRaw). Returns true on success, false if permission denied / unavailable.
  // Idempotent: a second call while already open is a no-op success.
  const enableMic = useCallback(async () => {
    const n = nodesRef.current;
    if (!n) return false;
    if (extMicRef.current) return true;
    try {
      await Tone.start(); // resume context + satisfy autoplay policy
      const mic = new Tone.UserMedia();
      await mic.open();
      mic.connect(n.extMicGain);
      extMicRef.current = mic;
      return true;
    } catch (e) {
      console.warn('[MoogAudio] mic enable failed:', e?.message ?? e);
      return false;
    }
  }, []);

  const disableMic = useCallback(() => {
    const mic = extMicRef.current;
    if (!mic) return;
    try { mic.close(); } catch (_) {}
    try { mic.dispose(); } catch (_) {}
    extMicRef.current = null;
  }, []);

  // External mic INPUT gain — single writer (this owns extMicGain.gain).
  const updateExtMicParams = useCallback(({ gain } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (gain !== undefined) safeRamp(n.extMicGain.gain, Math.max(0, gain), 0.05);
  }, []);

  // Crossfades normalGain ↔ syncOut over 10 ms per VCO.
  // State persisted in ref so powerOff/powerOn can gate and restore it.
  const setVco1SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco1SyncEnabledRef.current = enabled;
    safeRamp(n.vco1normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco1syncOut.gain,    enabled ? 1 : 0, 0.01);
  }, []);
  const setVco2SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco2SyncEnabledRef.current = enabled;
    safeRamp(n.vco2normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco2syncOut.gain,    enabled ? 1 : 0, 0.01);
  }, []);
  const setVco3SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco3SyncEnabledRef.current = enabled;
    safeRamp(n.vco3normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco3syncOut.gain,    enabled ? 1 : 0, 0.01);
  }, []);
  const setVco4SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco4SyncEnabledRef.current = enabled;
    safeRamp(n.vco4normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco4syncOut.gain,    enabled ? 1 : 0, 0.01);
  }, []);
  const setVco5SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco5SyncEnabledRef.current = enabled;
    safeRamp(n.vco5normalGain.gain, enabled ? 0 : 1, 0.01);
    safeRamp(n.vco5syncOut.gain,    enabled ? 1 : 0, 0.01);
  }, []);

  // Keyboard pitch + gate control.
  // hz: the note frequency in Hz (e.g. Tone.Frequency("C4").toFrequency()).
  // isGateDown: true = note on (triggerAttack), false = note off (triggerRelease).
  // Only envelopes connected via kbd-gate-out are triggered; seq-gate-out is unaffected.
  const updateKeyboard = useCallback((hz, isGateDown) => {
    const n = nodesRef.current;
    if (!n) return;
    // Update refs — the vibratoTick rAF owns all glideBus writes for kbd-connected VCOs.
    // kbdPitchOut drives quantizer and other non-VCO destinations (instant, no glide needed).
    kbdBaseHzRef.current = hz;
    if (isGateDown) kbdVibratoResetRef.current = true; // rAF will stamp its own `now` as onset
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
    setVco1SyncEnabled, setVco2SyncEnabled, setVco3SyncEnabled, setVco4SyncEnabled, setVco5SyncEnabled,
    setSeqGlide, setSeq2Glide, setKbdGlide, setKbdVibrato,
    updateFFBParams, getFFBAnalyserData,
    updateVocoderParams, getVocAnalyserData,
    enableMic, disableMic, updateExtMicParams,
    updateKickParams, triggerKick,
    setKickTrigCallback: (fn) => { kickTrigCbRef.current = fn; },
    updateQuantizerParams, setQuantizerCallback,
  };
}
