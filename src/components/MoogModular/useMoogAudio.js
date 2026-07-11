import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Sequencer pitch range — same as VCO FREQ knob (C1–C6)
const SEQ_HZ_MIN  = 32.703;
const SEQ_HZ_MAX  = 1046.502;
const VCO_IDS     = ['vco1', 'vco2', 'vco3', 'vco4', 'vco5'];
// Dynamic instance-id prefixes that differ from their type name (jack-prefix
// compatibility with the static modules: reverb2-in, chorus2-in).
const DYN_ID_PREFIX = { rev: 'reverb', bbd: 'chorus' };

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

// JS mirror of the quantizer worklet's snap logic — used by knob-stepper mode
// (Phase 57), where the VCO FREQ knob itself is quantized without any audio-rate
// CV passing through the worklet. Snaps hz to the nearest MIDI note whose pitch
// class (relative to root) is in the scale, then applies the octave shift.
// bypass passes the input through untouched (knob reverts to continuous).
function quantizeHzJs(inputHz, { scale, root, octShift, bypass }) {
  if (bypass) return inputHz;
  const midi = 69 + 12 * Math.log2(Math.max(0.001, inputHz) / 440);
  let best = Math.round(midi), bestDist = Infinity;
  for (let m = best - 12; m <= best + 12; m++) {
    if (!scale.includes((((m - root) % 12) + 12) % 12)) continue;
    const d = Math.abs(m - midi);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return 440 * Math.pow(2, (best + octShift * 12 - 69) / 12);
}

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
    'chordseq-cv-in':   { type: 'in',  dest: n.chordseqInputAnalyser },
    'chordseq-cv-out':     { type: 'out', node: n.chordseqPitchOut  },
    'chordseq-root-out':   { type: 'out', node: n.chordseqRootOut   },
    'chordseq-3rd-out':    { type: 'out', node: n.chordseqThirdOut },
    'chordseq-5th-out':    { type: 'out', node: n.chordseqFifthOut },
    // ── Keyboard ──
    'kbd-pitch-out': { type: 'out', node: n.kbdPitchOut },
    'kbd-gate-out':  { type: 'out', node: null, isGate: true },
    // ── Quantizer ──
    // qnt-cv-in        → AudioWorkletNode audio input (null until worklet loads)
    // qnt-cv-out       → Tone.Gain wrapper (always live)
    // qnt-transpose-in → waveform analyser; rAF loop in QuantizerModule reads Hz → note class
    'qnt-cv-in':        { type: 'in',  dest: n.qntNodes?.qnt ?? null   },
    'qnt-cv-out':       { type: 'out', node: n.qntOut             },
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
  // Vocoder spectral-shift state — id-keyed maps (Phase 60e part 3): 'voc' is
  // the static module, 'voc2'+ are dynamic instances. Node names compose from
  // the id (`${vid}CarrBPF3`, `${vid}Wet`…). vocIdsRef is the instance list the
  // shift rAF iterates.
  const vocIdsRef             = useRef(['voc']);
  const vocShiftBaseRefs      = useRef({ voc: 1.0 });  // base ratio (1 = no shift)
  const vocShiftLfoRateRefs   = useRef({ voc: 0.7 });  // Hz
  const vocShiftLfoAmpRefs    = useRef({ voc: 0 });    // octaves of swing
  const vocShiftLastRatioRefs = useRef({});            // delta gates — static shift settles to 0 writes
  // Glide time in seconds (0 = off). Written by the UI knob, read by the Tone.Loop.
  const kbdGlideRef   = useRef(0);
  const chordSeqGlideRefs = useRef({ chordseq: 0 }); // csId → glide (s) for root/3rd/5th CV outs
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
  // 960 sequencer state — id-keyed maps (Phase 60e). 'seq' / 'seq2' are the
  // static modules; dynamic instances are 'seq3'+. Node names compose from the
  // id (`${seqId}PitchOut`, `${seqId}GateNode`) and every map is read by the
  // shared loop body at fire time, so a dynamic seq is just four map entries
  // plus a Tone.Loop from buildSeqLoop().
  const defaultSeqSteps = () =>
    Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 }));
  const seqLoopsRef        = useRef({});                       // seqId → Tone.Loop
  const seqStepsRefs       = useRef({ seq: defaultSeqSteps(), seq2: defaultSeqSteps() });
  const seqCurrentStepRefs = useRef({ seq: -1, seq2: -1 });
  const seqStepCbRefs      = useRef({});                       // seqId → UI LED callback
  const seqGlideRefs       = useRef({ seq: 0, seq2: 0 });      // seconds (0 = off)
  const gateActionsRef      = useRef(new Map()); // toJackId → Tone.Envelope

  // Chord sequencer — separate slower-clocked 8-step pitch CV source.
  // Each step stores { rootClass: 0-11, chordType: keyof SCALE_DEFS }.
  // On step fire: outputs root Hz via `${csId}PitchOut` AND calls the instance's
  // chord callback so MoogShell can sync the quantizer scale / chord label.
  // All state is id-keyed (Phase 60e part 2): 'chordseq' = the static module,
  // 'chordseq2'+ are dynamic instances. Node names compose from the id.
  const defaultChordSteps = () =>
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i], // Am Am F F C C E E
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }));
  const chordSeqIdsRef          = useRef(['chordseq']);   // registered instances (snap rAF iterates)
  const chordSeqLoopsRef        = useRef({});             // csId → Tone.Loop
  const chordSeqStepsRefs       = useRef({ chordseq: defaultChordSteps() });
  const chordSeqCurrentStepRefs = useRef({ chordseq: -1 });
  const chordSeqStepCbRefs      = useRef({});
  const chordSeqChordCbRefs     = useRef({});             // fn(rootClass, chordType) per instance
  const chordSeqDivisionRefs    = useRef({ chordseq: '1m' }); // default: advance every 1 bar
  const chordSeqRootOctaveRefs  = useRef({ chordseq: 0 }); // octave offset for `${csId}-root-out` (-3..+3)
  const chordSeqInputActiveRefs = useRef({});              // csId → true when CV patched to its cv-in
  // Per-quantizer chord override (Phase 60e part 4): qid → the chordseq
  // instance id whose cv-out is patched to that quantizer's transpose-in.
  // Each quantizer has exactly one owner (Single Writer per instance).
  const qntChordOverrideRef    = useRef({});
  // Stores the last Hz value from each VCO knob so it can be restored when a CV cable is removed.
  const vcoKnobHzRef      = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  // Tracks which source jack is actively driving each VCO cv-in (null = knob only).
  // Written by connect/disconnect; read by step loops and quantizer callback.
  const vcoActiveCvRef   = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  // Quantizer state — id-keyed maps (Phase 60e part 4): 'qnt' is the static
  // module, 'qnt2'+ are dynamic instances. Worklet nodes live in n.qntNodes
  // (assigned synchronously, keyed like hardSyncNodes); wireQntRef holds the
  // per-instance wiring closure once the worklet module loads.
  const qntIdsRef             = useRef(['qnt']);
  const wireQntRef            = useRef(null);
  const quantizerStepCbRefs   = useRef({});          // qid → UI LED/display callback
  const lastQuantizedMidiRefs = useRef({ qnt: 69 }); // A4 default — updated on each note change
  // Inline-synced mirror of applyQuantizerParams (declared later, after the
  // knob-stepper helpers it depends on) so updateDynModuleParams can dispatch
  // dynamic 'qnt' params without a TDZ-breaking dependency.
  const applyQuantizerParamsRef = useRef(null);
  const vcoQuantizedCbRef     = useRef(null);   // UI callback: (vcoIds[]) in knob-stepper mode

  // ── Dynamic module instances (Phase 60b) ──
  // Pilot types: 'vco' | 'noise'. Instance nodes live in nodesRef.current under
  // the same name-composition scheme as the static graph (`vco6`, `vco6GlideBus`,
  // `vco6Meter`…) so every existing name-composed lookup (updateVcoParams,
  // getMeterValue, connect()'s glideBus resolution) works unchanged.
  // dynInstancesRef records ownership for disposal; allVcoIdsRef is the combined
  // static+dynamic VCO list read by the step loops / vibrato rAF / qnt fanouts.
  const dynInstancesRef = useRef(new Map()); // id → { type, num, nodeNames, sourceNames, jackIds }
  const allVcoIdsRef    = useRef([...VCO_IDS]);
  // Monotonic per-type counters — minted eagerly, never reused. Start above the
  // static instances so ids can never collide (vcf1/vcf2 static → dynamic from 3, etc.).
  const nextInstNumRef  = useRef({ vco: 6, noise: 4, vcf: 3, lfo: 3, vca: 4, env: 4, rev: 3, bbd: 2, kick: 2, ffb: 2, seq: 3, chordseq: 2, voc: 2, qnt: 2 });
  // Per-instance hard sync (Phase 60d): wireHardSyncRef holds the wire() closure
  // once the worklet module loads (null before load / after unmount) so addModule
  // can mint a worklet for VCOs added later. dynVcoSyncRef tracks each dynamic
  // VCO's HARD SYNC toggle across power cycles (the static VCOs use 5 dedicated refs).
  const wireHardSyncRef = useRef(null);
  const dynVcoSyncRef   = useRef({});
  // Persists each quantizer's latest config (keyed by qid) so it can be flushed
  // when its worklet node is created. baseHz — modulation-mode center for the
  // worklet (Phase 58): the FREQ knob of the qnt-patched VCO. Last-moved knob
  // wins when several VCOs share one quantizer's cv-out.
  const defaultQntParams   = () => ({ scale: SCALE_DEFS.MAJ, root: 0, octShift: 0, bypass: false, baseHz: 220 });
  const quantizerParamsRefs = useRef({ qnt: defaultQntParams() });

  // Glide τ for a managed pitch source — used wherever a downstream module
  // (chord snap, quantizer port) traces which source feeds it. seq ids are
  // open-ended ('seq', 'seq2', 'seq3'+ dynamics — Phase 60e).
  const glideForPitchSource = useCallback((srcId) => {
    if (srcId === 'kbd-pitch-out') return kbdGlideRef.current;
    if (srcId && /^seq\d*-pitch-out$/.test(srcId))
      return seqGlideRefs.current[srcId.replace('-pitch-out', '')] ?? 0;
    return 0;
  }, []);

  // One 960 loop body for every instance (Phase 60e) — reads all per-seq state
  // from the id-keyed maps at fire time. Advances the step, writes the pitch
  // Signal (instant — it feeds quantizer/analyser paths), applies glide at each
  // connected VCO's glideBus, gates the seq's VCA tap + connected VCO buses,
  // and fires env/kick gate actions registered from `${seqId}-gate-out`.
  // seqMasterGate is NOT written — it would silence the other sequencers.
  const buildSeqLoop = useCallback((seqId) => new Tone.Loop((time) => {
    const n = nodesRef.current;
    const steps = seqStepsRefs.current[seqId];
    if (!n || !steps) return;
    seqCurrentStepRefs.current[seqId] = (seqCurrentStepRefs.current[seqId] + 1) % 16;
    const idx  = seqCurrentStepRefs.current[seqId];
    const step = steps[idx];
    const hz    = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step.voltage);
    const glide = seqGlideRefs.current[seqId] ?? 0;
    const pitchSrc = `${seqId}-pitch-out`;
    n[`${seqId}PitchOut`].setValueAtTime(hz, time);
    // Glide on every VCO that has this seq's pitch out connected to its cv-in.
    for (const vcoId of allVcoIdsRef.current) {
      if (vcoActiveCvRef.current[vcoId] !== pitchSrc) continue;
      const gb = n[`${vcoId}GlideBus`];
      if (glide < 0.001) gb.setValueAtTime(hz, time);
      else               gb.rampTo(hz, glide, time);
      n.hardSyncNodes?.[vcoId]?.parameters.get('slaveFreq')
        .setTargetAtTime(hz, time, Math.max(glide / 3, 0.001));
    }
    const fires = step.gate && Math.random() < step.prob;
    const gateVal = fires ? 1 : 0;
    // Static seqs gate a VCA tap (vca-out/vca-out2 jacks); dynamic seqs have no
    // tap — the optional chain makes the write a no-op for them.
    // Native AudioParam directly: Tone.Param's event queue conflicts with rampTo.
    n[`${seqId}GateNode`]?.gain._param.setValueAtTime(gateVal, time);
    for (const vcoId of allVcoIdsRef.current) {
      if (vcoActiveCvRef.current[vcoId] === pitchSrc)
        n[`${vcoId}bus`].gain._param.setValueAtTime(gateVal, time);
    }
    if (gateActionsRef.current.size > 0) {
      const stepDur  = fires ? Tone.Time('8n').toSeconds() : 0;
      const gateSrc  = `${seqId}-gate-out`;
      for (const [, action] of gateActionsRef.current) {
        if (action.fromId !== gateSrc) continue;
        if (action.isKick) {
          const kid = action.kickId ?? 'kick';
          if (fires && n[`${kid}Synth`]) {
            n[`${kid}Synth`].triggerAttackRelease(kickTuneRef.current[kid] ?? 55, kickDecayRef.current[kid] ?? 0.4, time);
            n[`${kid}ClickSynth`]?.triggerAttackRelease((kickDecayRef.current[kid] ?? 0.4) * 0.1, time);
            kickTrigCbRef.current[kid]?.();
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
    seqStepCbRefs.current[seqId]?.(idx);
  }, '8n'), []);

  // One chord-seq loop body for every instance (Phase 60e part 2) — the chord
  // analog of buildSeqLoop. Advances the 8-step chord program, writes the root
  // CV (unless the instance's cv-in snapper owns it), fires the polyphonic
  // root/3rd/5th voice outs with glide at each connected VCO's glideBus, and
  // pushes root+scale into the quantizer when THIS instance owns the
  // qnt-transpose-in override.
  const buildChordSeqLoop = useCallback((csId) => new Tone.Loop((time) => {
    const n = nodesRef.current;
    const steps = chordSeqStepsRefs.current[csId];
    if (!n || !steps) return;
    chordSeqCurrentStepRefs.current[csId] = (chordSeqCurrentStepRefs.current[csId] + 1) % 8;
    const idx  = chordSeqCurrentStepRefs.current[csId];
    const step = steps[idx];
    // Only write root Hz when no CV source is patched — the rAF snapper owns
    // the PitchOut while an input is active (single-writer rule).
    const chordHz  = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
    const cvOutSrc = `${csId}-cv-out`;
    if (!chordSeqInputActiveRefs.current[csId]) {
      n[`${csId}PitchOut`].setValueAtTime(chordHz, time);
      // No glide for the raw cv-out — instant jumps at the chord boundary.
      for (const vcoId of allVcoIdsRef.current) {
        if (vcoActiveCvRef.current[vcoId] === cvOutSrc)
          n[`${vcoId}GlideBus`]?.setValueAtTime(chordHz, time);
      }
    }
    // Polyphonic voice outputs — always fire regardless of cv-in state.
    const oct         = Math.pow(2, chordSeqRootOctaveRefs.current[csId] ?? 0);
    const shiftedRoot = chordHz * oct;
    const intervals   = CHORD_VOICE_INTERVALS[step.chordType] ?? CHORD_VOICE_INTERVALS.CMAJ;
    const voiceHz     = intervals.map(st => shiftedRoot * Math.pow(2, st / 12));
    n[`${csId}RootOut`].setValueAtTime(voiceHz[0], time);
    n[`${csId}ThirdOut`].setValueAtTime(voiceHz[1], time);
    n[`${csId}FifthOut`].setValueAtTime(voiceHz[2], time);
    // Glide (portamento) for the voice CV outs — applied at each VCO's glideBus,
    // matching the seq-pitch-out convention (instant signal jump, ramp at the bus).
    const chordGlide = chordSeqGlideRefs.current[csId] ?? 0;
    const VOICE_HZ = {
      [`${csId}-root-out`]: voiceHz[0],
      [`${csId}-3rd-out`]:  voiceHz[1],
      [`${csId}-5th-out`]:  voiceHz[2],
    };
    for (const vcoId of allVcoIdsRef.current) {
      const src = vcoActiveCvRef.current[vcoId];
      const vhz = VOICE_HZ[src];
      if (vhz === undefined) continue;
      const gb = n[`${vcoId}GlideBus`];
      if (!gb) continue;
      if (chordGlide < 0.001) gb.setValueAtTime(vhz, time);
      else                    gb.rampTo(vhz, chordGlide, time);
    }

    chordSeqStepCbRefs.current[csId]?.(idx);
    chordSeqChordCbRefs.current[csId]?.(step.rootClass, step.chordType);
    // Push root+scale into every quantizer whose transpose-in THIS instance's
    // cv-out is patched to (override owner per quantizer — Single Writer).
    for (const [qid, owner] of Object.entries(qntChordOverrideRef.current)) {
      if (owner !== csId || !n.qntNodes?.[qid]) continue;
      const qp = quantizerParamsRefs.current[qid];
      if (!qp) continue;
      qp.root  = step.rootClass;
      qp.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
      n.qntNodes[qid].port.postMessage(qp);
    }
  }, chordSeqDivisionRefs.current[csId] ?? '1m'), []);

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
      chordseqPitchOut:      new Tone.Signal(SEQ_HZ_MIN), // chord sequencer root CV out — same rule
      chordseqRootOut:       new Tone.Signal(SEQ_HZ_MIN), // independent root-note CV out (octave-shifted)
      chordseqThirdOut:      new Tone.Signal(SEQ_HZ_MIN), // 3rd of chord CV
      chordseqFifthOut:      new Tone.Signal(SEQ_HZ_MIN), // 5th of chord CV
      chordseqInputAnalyser: new Tone.Analyser('waveform', 256), // detects patched pitch CV input

      // Studio reverb — Freeverb (proven in this codebase via VoxTool arpReverb).
      // wet starts at 0 so patching in the reverb doesn't colour sound until MIX is raised.
      reverb:  new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),
      reverb2: new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),

      // Aura display FFT taps (Phase 56) — dead-end side connections on each
      // reverb's OUTPUT (not input) so the halo keeps shimmering through the
      // tail after the source stops — that's what reads as "reverb" on screen.
      reverbAnalyser:  new Tone.Analyser('fft', 256),
      reverb2Analyser: new Tone.Analyser('fft', 256),

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
      qntOut:    new Tone.Gain(1),
      // Silent keepalive — qntOut must stay connected to the audio graph or
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
    // Quantizer keepalive: gain(0) ensures qntOut stays connected to the
    // audio graph so Chrome never stops calling the worklet's process() callback.
    n.qntOut.connect(n.qntKeepAlive);
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

    // Aura display taps — dead-end, post-reverb (see node creation note).
    n.reverb.connect(n.reverbAnalyser);
    n.reverb2.connect(n.reverb2Analyser);

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

    // 960 sequencer loops — 8th-note clocks driven by Tone.Transport. Both
    // statics share the generic buildSeqLoop body (Phase 60e); dynamic
    // instances get theirs from addModule('seq').
    seqLoopsRef.current.seq  = buildSeqLoop('seq');
    seqLoopsRef.current.seq2 = buildSeqLoop('seq2');

    // Chord sequencer loop — the static instance shares the generic
    // buildChordSeqLoop body (Phase 60e part 2); dynamics get theirs from
    // addModule('chordseq').
    chordSeqLoopsRef.current.chordseq = buildChordSeqLoop('chordseq');

    // Pitch-snapping rAF — for EVERY registered chord seq (Phase 60e part 2):
    // reads each instance's cv-in analyser, snaps incoming Hz to that instance's
    // current chord tones, writes the snapped pitch to its PitchOut so a
    // downstream VCO always plays in tune. When no cable is patched an analyser
    // returns ~0 Hz (below the 10 Hz threshold) so that instance is a cheap
    // no-op and its chord Tone.Loop resumes ownership of the PitchOut.
    let chordSnapRafId;
    const prevChordSnaps = {}; // csId → delta gate — ramp only when pitch changes
    const chordSnapTick = () => {
      chordSnapRafId = requestAnimationFrame(chordSnapTick);
      for (const csId of chordSeqIdsRef.current) {
        const analyser = n[`${csId}InputAnalyser`];
        const data = analyser?.getValue();
        if (!data || !data.length) continue;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        const avgHz   = sum / data.length;
        const isActive = avgHz > 10;
        chordSeqInputActiveRefs.current[csId] = isActive;
        if (isActive && Tone.context.state === 'running') {
          const stepIdx = chordSeqCurrentStepRefs.current[csId];
          const step    = chordSeqStepsRefs.current[csId][Math.max(0, stepIdx)];
          const snapped = snapToChordHz(avgHz, step.rootClass, step.chordType);
          // Use value setter (immediate) — setValueAtTime with a future-scheduled
          // chord loop tick would otherwise fight this write in the same block.
          n[`${csId}PitchOut`].value = snapped;
          // Drive glideBus for VCOs connected from this instance's cv-out.
          // Delta-gated so rampTo fires once per pitch change, not every frame.
          if (snapped !== prevChordSnaps[csId]) {
            prevChordSnaps[csId] = snapped;
            // Glide amount: look up the source feeding this cv-in and use its glide ref.
            const cvKey = [...connectionsRef.current.keys()].find(k => k.endsWith(`→${csId}-cv-in`));
            const cvGlide = glideForPitchSource(cvKey?.split('→')[0]);
            const cvOutSrc = `${csId}-cv-out`;
            for (const vcoId of allVcoIdsRef.current) {
              if (vcoActiveCvRef.current[vcoId] !== cvOutSrc) continue;
              const gb = n[`${vcoId}GlideBus`];
              if (!gb) continue;
              if (cvGlide < 0.001) gb.setValueAtTime(snapped, Tone.now());
              else                  gb.rampTo(snapped, cvGlide, Tone.now());
            }
          }
        }
      }
    };
    chordSnapTick();

    // Quantizer chord-override rAF — continuously holds each overridden
    // quantizer's root+scale to its OWNING chord seq's current step at 60fps
    // (qntChordOverrideRef maps qid → owning csId). Running continuously means
    // nothing (QuantizerModule rAF, React effects, manual knob writes) can
    // overwrite the chord seq's chord for more than one frame. Per-qid
    // delta-checks so postMessage only fires when a chord actually changes.
    let qntOverrideRafId;
    const lastOverrideRoots  = {};
    const lastOverrideScales = {};
    const qntOverrideTick = () => {
      qntOverrideRafId = requestAnimationFrame(qntOverrideTick);
      for (const [qid, csId] of Object.entries(qntChordOverrideRef.current)) {
        const node  = n.qntNodes?.[qid];
        const steps = chordSeqStepsRefs.current[csId];
        const qp    = quantizerParamsRefs.current[qid];
        if (!node || !steps || !qp) continue;
        const stepIdx  = chordSeqCurrentStepRefs.current[csId];
        const step     = steps[Math.max(0, stepIdx)];
        const newRoot  = step.rootClass;
        const newScale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
        if (newRoot === lastOverrideRoots[qid] && newScale === lastOverrideScales[qid]) continue;
        lastOverrideRoots[qid]  = newRoot;
        lastOverrideScales[qid] = newScale;
        qp.root  = newRoot;
        qp.scale = newScale;
        node.port.postMessage(qp);
      }
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

      // Write once per frame. During glide (glide > 0) we linearly ramp to the new
      // Hz over ~2 frames instead of a setValueAtTime hold — a bare setValueAtTime is
      // a zero-order hold, so the ~60 fps target updates render as an audible staircase
      // during a portamento sweep. linearRampToValueAtTime interpolates at audio rate,
      // giving a pure continuous glide (and smoother vibrato on held notes). Glide-off
      // keeps the instant setValueAtTime so note attacks stay snappy (no 32 ms slur).
      // This rAF is the sole writer of these glideBuses, so the ramps chain cleanly.
      const hz = Math.max(1, kbdCurrentHzRef.current + swing);
      kbdLastOutputHzRef.current = hz;
      const rampAhead = Math.max(dt * 2, 1 / 30); // stay ahead of the next frame so the param never holds flat
      const gliding = glide >= 0.001;
      for (const vcoId of allVcoIdsRef.current) {
        if (vcoActiveCvRef.current[vcoId] !== 'kbd-pitch-out') continue;
        const p = n[`${vcoId}GlideBus`]?._param;
        if (!p) continue;
        if (gliding) p.linearRampToValueAtTime(hz, now + rampAhead);
        else         p.setValueAtTime(hz, now);
      }
    };
    vibratoTick();

    // Vocoder spectral-shift rAF — for EVERY registered vocoder instance
    // (Phase 60e part 3): scales its 16 carrier bandpass center freqs by
    // ratio = base · 2^(ampOct · sin(2π·rate·t)). base ← SHIFT knob; LFO ← SH RATE / SH AMP.
    // Sole writer of `${vid}CarrBPF*`.frequency. Per-id delta gates — a static
    // shift settles to 0 writes.
    let vocShiftRafId;
    const vocShiftTick = () => {
      vocShiftRafId = requestAnimationFrame(vocShiftTick);
      const now = Tone.context.rawContext.currentTime;
      for (const vid of vocIdsRef.current) {
        const amp   = vocShiftLfoAmpRefs.current[vid] ?? 0;
        const lfo   = amp < 0.001 ? 1 : Math.pow(2, amp * Math.sin(2 * Math.PI * (vocShiftLfoRateRefs.current[vid] ?? 0.7) * now));
        const ratio = (vocShiftBaseRefs.current[vid] ?? 1) * lfo;
        if (Math.abs(ratio - (vocShiftLastRatioRefs.current[vid] ?? 0)) < 1e-4) continue; // unchanged — skip
        vocShiftLastRatioRefs.current[vid] = ratio;
        for (let i = 0; i < VOC_BANDS.length; i++) {
          const f = n[`${vid}CarrBPF${i}`];
          if (!f) continue;
          f.frequency.setValueAtTime(Math.max(20, Math.min(18000, VOC_BANDS[i].freq * ratio)), now);
        }
      }
    };
    vocShiftTick();

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    // rawCtx must be declared before either worklet load block — both share it.
    const rawCtx = Tone.context.rawContext;

    // Load the quantizer AudioWorklet asynchronously (parallel to hard sync load).
    // One worklet node per quantizer instance, keyed by qid in n.qntNodes
    // (Phase 60e part 4 — same registry pattern as hardSyncNodes; assigned
    // synchronously so lookups always share it, keys appear at load).
    const qntNodes = {};
    n.qntNodes = qntNodes;
    rawCtx.audioWorklet.addModule('/quantizer-worklet.js').then(() => {
      if (nodesRef.current !== n) return;

      // Idempotent per-instance wiring: creates the worklet node, connects it to
      // the instance's Out wrapper, flushes buffered config, installs the port
      // handler, and makes the `${qid}-cv-in` jack live.
      const wire = (qid) => {
        if (qntNodes[qid] || !n[`${qid}Out`]) return;
        // Use Tone.context.createAudioWorkletNode() — NOT `new AudioWorkletNode(rawCtx, ...)`.
        // Tone.js wraps all nodes in standardized-audio-context (SAC). SAC's connect() throws
        // InvalidAccessError when connecting TO any node created outside its own registry
        // (i.e. native AudioWorkletNode). Tone.context.createAudioWorkletNode() creates a
        // SAC-wrapped node that is accepted by every SAC connect() call in the graph.
        const node = Tone.context.createAudioWorkletNode('quantizer-processor');
        qntNodes[qid] = node;

        // Connect worklet output to the Tone.Gain wrapper via its native GainNode.
        // (Same pattern as hard sync: native AudioWorkletNode.connect() needs native AudioNode.)
        node.connect(n[`${qid}Out`].input);

        // Flush the latest scale/root config that may have been set before the worklet loaded.
        node.port.postMessage(quantizerParamsRefs.current[qid] ?? defaultQntParams());

        // Route port messages to this instance's UI callback (delta-checked in
        // the worklet). noteClass/midiNote → LED + display; hasSignal → IN LED
        // (fires only on cable connect/disconnect). Callback signature is
        // (noteClass, midiNote, hasSignal); null noteClass = signal-state-only.
        node.port.onmessage = ({ data }) => {
          if (data.midiNote !== undefined) lastQuantizedMidiRefs.current[qid] = data.midiNote;
          const cb = quantizerStepCbRefs.current[qid];
          if (cb) {
            if (data.noteClass !== undefined) cb(data.noteClass, data.midiNote, undefined);
            if (data.hasSignal !== undefined) cb(null, null, data.hasSignal);
          }
          // Drive glideBus for any VCO connected from this instance's cv-out —
          // the quantizer produces an instant quantized target; the glideBus
          // applies the glide AFTER quantization so the slide is always between
          // two in-scale notes.
          if (data.midiNote !== undefined && nodesRef.current) {
            const hz = 440 * Math.pow(2, (data.midiNote - 69) / 12);
            // Determine glide τ by tracing what drives this instance's cv-in.
            const qntSource = [...connectionsRef.current.keys()]
              .find(k => k.endsWith(`→${qid}-cv-in`))?.split('→')[0];
            const rawGlide = glideForPitchSource(qntSource);
            const cvOutSrc = `${qid}-cv-out`;
            for (const vcoId of allVcoIdsRef.current) {
              if (vcoActiveCvRef.current[vcoId] !== cvOutSrc) continue;
              const gb = nodesRef.current[`${vcoId}GlideBus`];
              if (!gb) continue;
              if (rawGlide < 0.001) gb.setValueAtTime(hz, Tone.now());
              else                  gb.rampTo(hz, rawGlide, Tone.now());
              nodesRef.current.hardSyncNodes?.[vcoId]
                ?.parameters.get('slaveFreq').setTargetAtTime(hz, Tone.now(), Math.max(rawGlide / 3, 0.001));
            }
          }
        };

        // Make this instance's cv-in jack live (was dest:null before the worklet).
        // Uniform for statics and dynamics, added before OR after load.
        jackMapRef.current = { ...jackMapRef.current, [`${qid}-cv-in`]: { type: 'in', dest: node } };
      };

      // Statics + any dynamic quantizers added before the module finished
      // loading (the shell's localStorage restore runs on mount, ahead of this).
      qntIdsRef.current.forEach(wire);
      // Dynamic quantizers added from now on wire inline in addModule.
      wireQntRef.current = wire;

      // Rebuild jackMap so the static qnt-cv-in is live via buildJackMap too.
      // Preserve dynamic-instance entries (Phase 60e bug fix): instances restored
      // from localStorage register their jacks during mount, BEFORE this async
      // load resolves — a bare rebuild wiped them, so cables to restored modules
      // silently no-op'd in connect().
      const dynEntries = {};
      for (const inst of dynInstancesRef.current.values()) {
        inst.jackIds.forEach(j => {
          if (jackMapRef.current?.[j]) dynEntries[j] = jackMapRef.current[j];
        });
      }
      jackMapRef.current = { ...buildJackMap(n), ...dynEntries };
    }).catch(err => {
      console.warn('[MoogAudio] Quantizer worklet unavailable:', err);
    });

    // Load the hard sync AudioWorklet asynchronously.
    // One worklet node is created per VCO, keyed by vcoId (Phase 60d — dynamic
    // VCOs mint per-instance worklets too). If the load fails the sync jacks
    // remain no-ops and everything else works normally.
    // outputChannelCount:[1] forces mono — Chrome defaults to 2ch, leaving the right
    // channel permanently silent; mono upmixes correctly downstream.
    // The registry object is assigned synchronously so addModule and the loops
    // always share it; keys appear once the worklet module loads.
    const hardSyncNodes = {};
    n.hardSyncNodes = hardSyncNodes;
    rawCtx.audioWorklet.addModule('/hard-sync-worklet.js').then(() => {
      if (nodesRef.current !== n) return;

      // Idempotent per-VCO wiring: syncIn.output → worklet → syncOut.input,
      // fm scaler dual-feeds the worklet's slaveFreq (FM drives both paths).
      const wire = (vcoId) => {
        if (hardSyncNodes[vcoId] || !n[`${vcoId}syncIn`]) return;
        const node = Tone.context.createAudioWorkletNode('hard-sync-processor', { outputChannelCount: [1] });
        n[`${vcoId}syncIn`].output.connect(node);
        node.connect(n[`${vcoId}syncOut`].input);
        try { n[`${vcoId}fm`].connect(node.parameters.get('slaveFreq')); } catch (_) {}
        hardSyncNodes[vcoId] = node;
      };

      // Statics + any dynamic VCOs added before the module finished loading
      // (the shell's localStorage restore runs on mount, ahead of this .then()).
      allVcoIdsRef.current.forEach(wire);
      // Dynamic VCOs added from now on wire inline in addModule.
      wireHardSyncRef.current = wire;
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
      Object.values(seqLoopsRef.current).forEach(loop => {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      });
      seqLoopsRef.current = {};
      Object.values(chordSeqLoopsRef.current).forEach(loop => {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      });
      chordSeqLoopsRef.current = {};
      chordSeqIdsRef.current = ['chordseq'];
      try { Tone.Transport.stop(); } catch (_) {}
      // Disconnect AudioWorkletNodes (not Tone.js nodes — no .dispose()).
      wireHardSyncRef.current = null; // a remount must never wire against this mount's disposed nodes
      Object.values(hardSyncNodes).forEach(node => { try { node.disconnect(); } catch (_) {} });
      wireQntRef.current = null; // a remount must never wire against this mount's disposed nodes
      Object.values(qntNodes).forEach(node => { try { node.disconnect(); } catch (_) {} });
      Object.values(n).forEach(node => {
        try { node.dispose(); } catch (_) {}
      });
      connectionsRef.current.clear();
      gateActionsRef.current.clear();
      // Dynamic instances (Phase 60b): their nodes were disposed by the
      // Object.values(n) sweep above; reset the registries so a StrictMode
      // remount starts clean.
      dynInstancesRef.current.clear();
      allVcoIdsRef.current = [...VCO_IDS];
      dynVcoSyncRef.current = {};
      kickTuneRef.current   = { kick: 55 };
      kickDecayRef.current  = { kick: 0.4 };
      kickTrigCbRef.current = {};
      vocIdsRef.current             = ['voc'];
      vocShiftBaseRefs.current      = { voc: 1.0 };
      vocShiftLfoRateRefs.current   = { voc: 0.7 };
      vocShiftLfoAmpRefs.current    = { voc: 0 };
      vocShiftLastRatioRefs.current = {};
      qntIdsRef.current             = ['qnt'];
      quantizerParamsRefs.current   = { qnt: defaultQntParams() };
      lastQuantizedMidiRefs.current = { qnt: 69 };
      quantizerStepCbRefs.current   = {};
      qntChordOverrideRef.current   = {};
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
    // Dynamic instances' sound sources (Phase 60b)
    dynInstancesRef.current.forEach(inst =>
      inst.sourceNames.forEach(sn => { try { n[sn]?.start(); } catch (_) {} }));

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
    // Dynamic VCOs — same restore, toggle state lives in dynVcoSyncRef (Phase 60d).
    dynInstancesRef.current.forEach((inst, id) => {
      if (inst.type !== 'vco' || !n[`${id}syncOut`]) return;
      const se = !!dynVcoSyncRef.current[id];
      n[`${id}normalGain`].gain.value = se ? 0 : 1;
      n[`${id}syncOut`].gain.value    = se ? 1 : 0;
    });

    // Start sequencer clocks — reset steps so first tick lands on step 0
    for (const id of Object.keys(seqLoopsRef.current)) seqCurrentStepRefs.current[id] = -1;
    for (const id of Object.keys(chordSeqLoopsRef.current)) chordSeqCurrentStepRefs.current[id] = -1;
    Tone.Transport.start();
    Object.values(seqLoopsRef.current).forEach(loop => { try { loop.start(0); } catch (_) {} });
    Object.values(chordSeqLoopsRef.current).forEach(loop => { try { loop.start(0); } catch (_) {} });

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
    // Dynamic instances' sound sources (Phase 60b)
    dynInstancesRef.current.forEach(inst =>
      inst.sourceNames.forEach(sn => { try { n[sn]?.stop(); } catch (_) {} }));

    // Stop sequencer loops and clear active LEDs
    for (const [id, loop] of Object.entries(seqLoopsRef.current)) {
      try { loop.stop(); } catch (_) {}
      seqCurrentStepRefs.current[id] = -1;
      seqStepCbRefs.current[id]?.(-1);
    }
    for (const [id, loop] of Object.entries(chordSeqLoopsRef.current)) {
      try { loop.stop(); } catch (_) {}
      chordSeqCurrentStepRefs.current[id] = -1;
      chordSeqStepCbRefs.current[id]?.(-1);
    }
    Tone.Transport.stop();

    // Gate the hard sync slave to silence. The AudioWorkletProcessor returns true so
    // it keeps running indefinitely — stopping oscillators is not enough. Without this,
    // vco2syncOut (gain=1 when HARD SYNC is ON) lets the worklet sawtooth flow through
    // vco2bus → master → seqMasterGate (which is re-opened below) → speakers.
    [n.vco1syncOut, n.vco2syncOut, n.vco3syncOut, n.vco4syncOut, n.vco5syncOut].forEach(g => { g.gain.value = 0; });
    [n.vco1normalGain, n.vco2normalGain, n.vco3normalGain, n.vco4normalGain, n.vco5normalGain].forEach(g => { g.gain.value = 1; });
    // Dynamic VCOs — their always-running worklets must be gated too (Phase 60d).
    dynInstancesRef.current.forEach((inst, id) => {
      if (inst.type !== 'vco' || !n[`${id}syncOut`]) return;
      n[`${id}syncOut`].gain.value    = 0;
      n[`${id}normalGain`].gain.value = 1;
    });

    // Re-open both gates so keyboard / manual playing is audible after sequencer stops.
    // Last gate-off step may have left them closed.
    n.seqMasterGate.gain.value = 1;
    for (const id of Object.keys(seqLoopsRef.current)) {
      const gn = n[`${id}GateNode`];
      if (gn) gn.gain.value = 1;
    }

    setIsPowered(false);
  }, []);

  // Kick drum state — keyed by kick id ('kick' = the static module; 'kick2'+ are
  // dynamic instances). Tune/decay are read by the seq-loop gate handlers at
  // fire time; trig callbacks flash each module's LED (registered by KickModule).
  const kickTuneRef   = useRef({ kick: 55 });
  const kickDecayRef  = useRef({ kick: 0.4 });
  const kickTrigCbRef = useRef({});

  // Single writer for a kick instance's synth params.
  // tune: Hz (40–200), pitchEnv: octave drop (0–5), decay: seconds (0.05–2), click: gain (0–1).
  const applyKickParams = useCallback((kid, { tune, pitchEnv, decay, click } = {}) => {
    const n = nodesRef.current;
    const synth = n?.[`${kid}Synth`];
    if (!synth) return;
    if (tune  !== undefined) kickTuneRef.current[kid] = tune;
    if (decay !== undefined) {
      kickDecayRef.current[kid] = decay;
      synth.envelope.decay   = decay;
      synth.envelope.release = decay * 0.25;
    }
    if (pitchEnv !== undefined) synth.octaves = pitchEnv;
    if (click    !== undefined) safeRamp(n[`${kid}ClickGain`].gain, click, 0.02);
  }, []);

  // Single writer for a vocoder instance's params (Phase 60e part 3) — MIX
  // crossfades carrier-dry ↔ vocoded-wet; HISS/BUZZ scale the noise excitation;
  // CLARITY blends the high-passed real voice; SHIFT trio writes the rAF refs.
  // vid: 'voc' (static) | 'voc2'+ (dynamic). All node names compose from vid.
  const applyVocoderParams = useCallback((vid, p = {}) => {
    const n = nodesRef.current;
    if (!n || !n[`${vid}Wet`]) return;
    const { mix, hiss, buzz, clarity,
            pwidth, carrierMix, shift, res, shiftRate, shiftAmp, decay, volume, presence } = p;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    if (mix !== undefined) {
      const m = clamp01(mix);
      safeRamp(n[`${vid}Wet`].gain, m, 0.05);
      safeRamp(n[`${vid}Dry`].gain, 1 - m, 0.05);
    }
    // Knob 0–1 → conservative gain ceilings so the excitation supports rather than swamps.
    if (hiss !== undefined)    safeRamp(n[`${vid}HissGain`].gain,    clamp01(hiss) * 0.5, 0.05);
    if (buzz !== undefined)    safeRamp(n[`${vid}BuzzGain`].gain,    clamp01(buzz) * 0.7, 0.05);
    // Voice clarity: knob 0–1 → 0–0.9× of the high-passed dry voice.
    if (clarity !== undefined) safeRamp(n[`${vid}ClarityGain`].gain, clamp01(clarity) * 0.9, 0.05);

    // Internal carrier oscillator (fixed pitch — set at construction).
    // PWIDTH: knob 0–1 → width −0.95..0.95 (0.5 = square). Tone.PulseOscillator.width.
    if (pwidth !== undefined)  safeRamp(n[`${vid}CarrOsc`].width, (clamp01(pwidth) * 2 - 1) * 0.95, 0.05);
    // CARR MIX: knob 0 = external carrier only, 1 = internal osc only.
    if (carrierMix !== undefined) {
      const cm = clamp01(carrierMix);
      safeRamp(n[`${vid}CarrExtGain`].gain, 1 - cm, 0.05);
      safeRamp(n[`${vid}CarrOscGain`].gain, cm, 0.05);
    }
    // RES: carrier band Q. knob 0–1 → Q 1–7 (0.5 ≈ 4, the base VOC_BANDS Q).
    if (res !== undefined) {
      const q = 1 + clamp01(res) * 6;
      for (let i = 0; i < VOC_BANDS.length; i++) safeRamp(n[`${vid}CarrBPF${i}`].Q, q, 0.05);
    }
    // DECAY: envelope-follower LP cutoff. knob 0–1 → ~56 Hz (snappy) … ~7 Hz (smeary), 0.5 ≈ 20 Hz.
    if (decay !== undefined) {
      const cutoff = 20 * Math.pow(2, (0.5 - clamp01(decay)) * 3);
      for (let i = 0; i < VOC_BANDS.length; i++) safeRamp(n[`${vid}ModEnv${i}`].frequency, cutoff, 0.05);
    }
    // SHIFT / SH RATE / SH AMP — ref writes consumed by the spectral-shift rAF loop.
    if (shift !== undefined)     vocShiftBaseRefs.current[vid]    = Math.pow(2, (clamp01(shift) - 0.5) * 2); // ±1 octave
    if (shiftRate !== undefined) vocShiftLfoRateRefs.current[vid] = 0.05 * Math.pow(2, clamp01(shiftRate) * 7.64); // 0.05–10 Hz
    if (shiftAmp !== undefined)  vocShiftLfoAmpRefs.current[vid]  = clamp01(shiftAmp); // 0–1 octave swing
    // VOLUME: final module output level. knob 0–1 → 0–2× (0.5 = nominal; combines with the
    // fixed 3× makeup on the Out gain → up to 6× total). Also scales the CLARITY blend (it sums here).
    if (volume !== undefined)  safeRamp(n[`${vid}Volume`].gain, clamp01(volume) * 2, 0.05);
    // PRESENCE: peaking EQ gain at ~2.7 kHz. knob 0–1 → 0..+12 dB (boost only).
    if (presence !== undefined) safeRamp(n[`${vid}Presence`].gain, clamp01(presence) * 12, 0.05);
  }, []);

  // ── Dynamic module add/remove (Phase 60b — pilot: 'vco' | 'noise') ──
  // addModule mirrors the static graph's per-instance recipe exactly; nodes are
  // registered into nodesRef.current by composed name so all existing lookups
  // (updateVcoParams / getMeterValue / connect's glideBus path) work unchanged.
  // desiredNum (Phase 60f): the restore path passes the PERSISTED instance
  // number so jack ids — and therefore persisted cables — stay valid across
  // reloads. Honored only when free (duplicate ids are catastrophic for
  // jack/cable keying — the Workstation projectIO lesson); the mint counter is
  // bumped past it either way. User adds keep minting monotonically.
  // Returns { id, num } or null.
  const addModule = useCallback((type, desiredNum = null) => {
    const n = nodesRef.current;
    if (!n || !nextInstNumRef.current[type]) return null;
    let num;
    if (Number.isInteger(desiredNum) && desiredNum >= 2 &&
        !dynInstancesRef.current.has(`${DYN_ID_PREFIX[type] ?? type}${desiredNum}`)) {
      num = desiredNum;
      nextInstNumRef.current[type] = Math.max(nextInstNumRef.current[type], desiredNum + 1);
    } else {
      num = nextInstNumRef.current[type]++;
    }

    if (type === 'vco') {
      const id = `vco${num}`;
      n[id]                = new Tone.Oscillator({ type: 'sawtooth', frequency: 0 });
      n[`${id}GlideBus`]   = new Tone.Signal(185);
      n[`${id}normalGain`] = new Tone.Gain(1);
      n[`${id}bus`]        = new Tone.Gain(1);
      n[`${id}Meter`]      = new Tone.Meter({ normalRange: true, smoothing: 0.15 });
      n[`${id}fm`]         = new Tone.Gain(500);
      // Hard sync buffers (Phase 60d) — same crossfade topology as the statics:
      // normalGain(1) and syncOut(0) both feed the bus; setVcoSyncEnabledById
      // crossfades. The worklet bridges syncIn → syncOut once wired (below).
      n[`${id}syncIn`]     = new Tone.Gain(1);
      n[`${id}syncOut`]    = new Tone.Gain(0);
      n[id].connect(n[`${id}normalGain`]);
      n[`${id}normalGain`].connect(n[`${id}bus`]);
      n[`${id}syncOut`].connect(n[`${id}bus`]);
      n[`${id}GlideBus`].connect(n[id].frequency);
      n[`${id}fm`].connect(n[id].frequency);
      n[`${id}bus`].connect(n[`${id}Meter`]);
      if (isPoweredRef.current) { try { n[id].start(); } catch (_) {} }
      vcoKnobHzRef.current[id]   = null;
      vcoActiveCvRef.current[id] = null;
      dynVcoSyncRef.current[id]  = false;
      allVcoIdsRef.current = [...allVcoIdsRef.current, id];
      const jackEntries = {
        [`${id}-cv`]:  { type: 'in',  dest: null, isVcoCv: true },
        [`${id}-fm`]:  { type: 'in',  dest: n[`${id}fm`] },
        [`${id}-sync-in`]:  { type: 'in',  dest: n[`${id}syncIn`]  },
        [`${id}-sync-out`]: { type: 'out', node: n[`${id}syncOut`] },
        [`${id}-sin`]: { type: 'out', node: n[`${id}bus`], waveform: 'sine',     waveformTarget: n[id] },
        [`${id}-tri`]: { type: 'out', node: n[`${id}bus`], waveform: 'triangle', waveformTarget: n[id] },
        [`${id}-saw`]: { type: 'out', node: n[`${id}bus`], waveform: 'sawtooth', waveformTarget: n[id] },
        [`${id}-sqr`]: { type: 'out', node: n[`${id}bus`], waveform: 'square',   waveformTarget: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, {
        type, num,
        nodeNames:   [id, `${id}GlideBus`, `${id}normalGain`, `${id}bus`, `${id}Meter`, `${id}fm`,
                      `${id}syncIn`, `${id}syncOut`],
        sourceNames: [id],
        jackIds:     Object.keys(jackEntries),
      });
      // Worklet module already loaded → mint this instance's sync worklet now;
      // otherwise the load .then() sweeps allVcoIdsRef and picks it up.
      wireHardSyncRef.current?.(id);
      return { id, num };
    }

    if (type === 'noise') {
      const id = `noise${num}`;
      n[`${id}W`] = new Tone.Noise({ type: 'white' });
      n[`${id}P`] = new Tone.Noise({ type: 'pink'  });
      if (isPoweredRef.current) {
        try { n[`${id}W`].start(); } catch (_) {}
        try { n[`${id}P`].start(); } catch (_) {}
      }
      const jackEntries = {
        [`${id}-wht`]: { type: 'out', node: n[`${id}W`] },
        [`${id}-pnk`]: { type: 'out', node: n[`${id}P`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, {
        type, num,
        nodeNames:   [`${id}W`, `${id}P`],
        sourceNames: [`${id}W`, `${id}P`],
        jackIds:     Object.keys(jackEntries),
      });
      return { id, num };
    }

    if (type === 'vcf') {
      const id = `vcf${num}`;
      n[id]          = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 });
      n[`${id}cv1`]  = new Tone.Gain(5000);
      n[`${id}cv2`]  = new Tone.Gain(5000);
      n[`${id}env`]  = new Tone.Gain(1000);
      n[`${id}cv1`].connect(n[id].frequency);
      n[`${id}cv2`].connect(n[id].frequency);
      n[`${id}env`].connect(n[id].frequency);
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-cv1`]: { type: 'in',  dest: n[`${id}cv1`] },
        [`${id}-cv2`]: { type: 'in',  dest: n[`${id}cv2`] },
        [`${id}-env`]: { type: 'in',  dest: n[`${id}env`] },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}cv1`, `${id}cv2`, `${id}env`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'vca') {
      const id = `vca${num}`;
      n[id] = new Tone.Gain(1.0);
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-cv`]:  { type: 'in',  dest: n[id].gain },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'env') {
      const id = `env${num}`;
      n[id]          = new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 });
      n[`${id}Meter`] = new Tone.Meter({ normalRange: true, smoothing: 0.25 });
      n[id].connect(n[`${id}Meter`]);
      const jackEntries = {
        [`${id}-gate`]: { type: 'in',  dest: null, isGate: true, envId: id },
        [`${id}-trig`]: { type: 'in',  dest: null },
        [`${id}-out`]:  { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}Meter`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'lfo') {
      const id = `lfo${num}`;
      n[id]                  = new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 });
      n[`${id}modGain`]      = new Tone.Gain(0);
      n[`${id}WaveAnalyser`] = new Tone.Analyser('waveform', 32);
      n[`${id}modGain`].connect(n[id].frequency);
      n[id].connect(n[`${id}WaveAnalyser`]);
      if (isPoweredRef.current) { try { n[id].start(); } catch (_) {} }
      const jackEntries = {
        [`${id}-sync`]: { type: 'in',  dest: null },
        [`${id}-fm`]:   { type: 'in',  dest: n[`${id}modGain`] },
        [`${id}-sin`]:  { type: 'out', node: n[id], waveform: 'sine'     },
        [`${id}-tri`]:  { type: 'out', node: n[id], waveform: 'triangle' },
        [`${id}-sqr`]:  { type: 'out', node: n[id], waveform: 'square'   },
        [`${id}-saw`]:  { type: 'out', node: n[id], waveform: 'sawtooth' },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}modGain`, `${id}WaveAnalyser`],
        sourceNames: [id], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'rev') {
      const id = `reverb${num}`; // id doubles as jack prefix — matches ReverbModule's naming
      n[id]              = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 });
      n[`${id}Analyser`] = new Tone.Analyser('fft', 256); // Aura tap — post-reverb (Phase 56 rule)
      n[id].connect(n[`${id}Analyser`]);
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}Analyser`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'bbd') {
      const id = `chorus${num}`;
      n[id] = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.0 });
      if (isPoweredRef.current) { try { n[id].start(); } catch (_) {} }
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id], sourceNames: [id], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'kick') {
      const id = `kick${num}`;
      n[`${id}Synth`]       = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 5,
                                  envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } });
      n[`${id}ClickSynth`]  = new Tone.NoiseSynth({ noise: { type: 'white' },
                                  envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } });
      n[`${id}ClickFilter`] = new Tone.Filter({ frequency: 2000, type: 'highpass', rolloff: -12 });
      n[`${id}ClickGain`]   = new Tone.Gain(0.25);
      n[`${id}Out`]         = new Tone.Gain(1);
      n[`${id}Synth`].connect(n[`${id}Out`]);
      n[`${id}ClickSynth`].connect(n[`${id}ClickFilter`]);
      n[`${id}ClickFilter`].connect(n[`${id}ClickGain`]);
      n[`${id}ClickGain`].connect(n[`${id}Out`]);
      // Seed tune/decay so a gate cable patched before the module's first knob
      // write still triggers at sane values (KickModule's mount effect overwrites).
      kickTuneRef.current[id]  = 55;
      kickDecayRef.current[id] = 0.4;
      const jackEntries = {
        [`${id}-gate-in`]:  { type: 'in',  dest: null, isGate: true, isKick: true, kickId: id },
        [`${id}-click-in`]: { type: 'in',  dest: n[`${id}ClickGain`].gain },
        [`${id}-out`]:      { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}Synth`, `${id}ClickSynth`, `${id}ClickFilter`, `${id}ClickGain`, `${id}Out`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'ffb') {
      const id = `ffb${num}`;
      n[`${id}In`]       = new Tone.Gain(1);
      n[`${id}Sum`]      = new Tone.Gain(1);
      n[`${id}Master`]   = new Tone.Gain(1);
      n[`${id}Analyser`] = new Tone.Analyser('fft', 512);
      FFB_BANDS.forEach((b, i) => {
        n[`${id}Filter${i}`] = new Tone.Filter({ type: b.type, frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}Gain${i}`]   = new Tone.Gain(0.75);
        n[`${id}In`].connect(n[`${id}Filter${i}`]);
        n[`${id}Filter${i}`].connect(n[`${id}Gain${i}`]);
        n[`${id}Gain${i}`].connect(n[`${id}Sum`]);
      });
      n[`${id}Sum`].connect(n[`${id}Master`]);
      n[`${id}In`].connect(n[`${id}Analyser`]);
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[`${id}In`] },
        [`${id}-out`]: { type: 'out', node: n[`${id}Master`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}In`, `${id}Sum`, `${id}Master`, `${id}Analyser`,
                    ...FFB_BANDS.flatMap((_, i) => [`${id}Filter${i}`, `${id}Gain${i}`])],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'seq') {
      const id = `seq${num}`;
      n[`${id}PitchOut`] = new Tone.Signal(SEQ_HZ_MIN); // never 0 — exponential-ramp rule
      seqStepsRefs.current[id]       = defaultSeqSteps();
      seqCurrentStepRefs.current[id] = -1;
      seqGlideRefs.current[id]       = 0;
      const loop = buildSeqLoop(id);
      seqLoopsRef.current[id] = loop;
      // Transport is already running while powered — join it immediately.
      if (isPoweredRef.current) { try { loop.start(0); } catch (_) {} }
      const jackEntries = {
        [`${id}-pitch-out`]: { type: 'out', node: n[`${id}PitchOut`] },
        [`${id}-gate-out`]:  { type: 'out', node: null, isGate: true },
        [`${id}-clk-in`]:    { type: 'in',  dest: null },  // no-op, parity with statics
        [`${id}-clk-out`]:   { type: 'out', node: null },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}PitchOut`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'chordseq') {
      const id = `chordseq${num}`;
      n[`${id}PitchOut`]      = new Tone.Signal(SEQ_HZ_MIN); // never 0 — exponential-ramp rule
      n[`${id}RootOut`]       = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}ThirdOut`]      = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}FifthOut`]      = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}InputAnalyser`] = new Tone.Analyser('waveform', 256);
      chordSeqStepsRefs.current[id]       = defaultChordSteps();
      chordSeqCurrentStepRefs.current[id] = -1;
      chordSeqDivisionRefs.current[id]    = '1m';
      chordSeqRootOctaveRefs.current[id]  = 0;
      chordSeqGlideRefs.current[id]       = 0;
      chordSeqInputActiveRefs.current[id] = false;
      chordSeqIdsRef.current = [...chordSeqIdsRef.current, id];
      const loop = buildChordSeqLoop(id);
      chordSeqLoopsRef.current[id] = loop;
      // Transport is already running while powered — join it immediately.
      if (isPoweredRef.current) { try { loop.start(0); } catch (_) {} }
      const jackEntries = {
        [`${id}-cv-in`]:    { type: 'in',  dest: n[`${id}InputAnalyser`] },
        [`${id}-cv-out`]:   { type: 'out', node: n[`${id}PitchOut`] },
        [`${id}-root-out`]: { type: 'out', node: n[`${id}RootOut`]  },
        [`${id}-3rd-out`]:  { type: 'out', node: n[`${id}ThirdOut`] },
        [`${id}-5th-out`]:  { type: 'out', node: n[`${id}FifthOut`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}PitchOut`, `${id}RootOut`, `${id}ThirdOut`, `${id}FifthOut`, `${id}InputAnalyser`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'voc') {
      const id = `voc${num}`;
      // Mirror the static 16-band vocoder recipe exactly (~70 nodes).
      n[`${id}ModIn`]       = new Tone.Gain(1);
      n[`${id}CarrIn`]      = new Tone.Gain(1);
      n[`${id}Sum`]         = new Tone.Gain(1);
      n[`${id}Wet`]         = new Tone.Gain(1);
      n[`${id}Dry`]         = new Tone.Gain(0);
      n[`${id}Out`]         = new Tone.Gain(3); // fixed internal makeup; user level is VOLUME
      n[`${id}Analyser`]    = new Tone.Analyser('fft', 512);
      n[`${id}CarrBank`]    = new Tone.Gain(1);
      n[`${id}CarrOsc`]     = new Tone.PulseOscillator({ frequency: 130, width: 0 });
      n[`${id}CarrOscGain`] = new Tone.Gain(0);
      n[`${id}CarrExtGain`] = new Tone.Gain(1);
      n[`${id}CarrSum`]     = new Tone.Gain(1);
      n[`${id}Volume`]      = new Tone.Gain(1); // the `${id}-out` jack node
      n[`${id}HissNoise`]   = new Tone.Noise({ type: 'white' });
      n[`${id}HissHP`]      = new Tone.Filter({ type: 'highpass', frequency: 3500, rolloff: -12 });
      n[`${id}HissGain`]    = new Tone.Gain(0);
      n[`${id}BuzzNoise`]   = new Tone.Noise({ type: 'pink' });
      n[`${id}BuzzLP`]      = new Tone.Filter({ type: 'lowpass', frequency: 250, rolloff: -12 });
      n[`${id}BuzzGain`]    = new Tone.Gain(0);
      n[`${id}ClarityHP`]   = new Tone.Filter({ type: 'highpass', frequency: 1500, rolloff: -12 });
      n[`${id}ClarityGain`] = new Tone.Gain(0);
      n[`${id}ModRaw`]      = new Tone.Gain(1);
      n[`${id}ModHP`]       = new Tone.Filter({ type: 'highpass', frequency: 150, rolloff: -12 });
      n[`${id}ModComp`]     = new Tone.Compressor({ threshold: -28, ratio: 4, attack: 0.003, release: 0.12 });
      n[`${id}Presence`]    = new Tone.Filter({ type: 'peaking', frequency: 2700, Q: 1, gain: 0 });
      VOC_BANDS.forEach((b, i) => {
        n[`${id}ModBPF${i}`]  = new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}ModRect${i}`] = new Tone.WaveShaper((x) => Math.min(1, Math.abs(x) * VOC_ENV_DRIVE));
        n[`${id}ModEnv${i}`]  = new Tone.Filter({ type: 'lowpass', frequency: 20, Q: 0.5, rolloff: -12 });
        n[`${id}CarrBPF${i}`] = new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}CarrVCA${i}`] = new Tone.Gain(0);
        n[`${id}ModIn`].connect(n[`${id}ModBPF${i}`]);
        n[`${id}ModBPF${i}`].connect(n[`${id}ModRect${i}`]);
        n[`${id}ModRect${i}`].connect(n[`${id}ModEnv${i}`]);
        n[`${id}ModEnv${i}`].connect(n[`${id}CarrVCA${i}`].gain); // audio-rate env → VCA gain
        n[`${id}CarrBank`].connect(n[`${id}CarrBPF${i}`]);
        n[`${id}CarrBPF${i}`].connect(n[`${id}CarrVCA${i}`]);
        n[`${id}CarrVCA${i}`].connect(n[`${id}Sum`]);
      });
      n[`${id}CarrIn`].connect(n[`${id}CarrExtGain`]);
      n[`${id}CarrExtGain`].connect(n[`${id}CarrSum`]);
      n[`${id}CarrOsc`].connect(n[`${id}CarrOscGain`]);
      n[`${id}CarrOscGain`].connect(n[`${id}CarrSum`]);
      n[`${id}CarrSum`].connect(n[`${id}CarrBank`]);
      n[`${id}CarrSum`].connect(n[`${id}Dry`]);
      n[`${id}HissNoise`].connect(n[`${id}HissHP`]);
      n[`${id}HissHP`].connect(n[`${id}HissGain`]);
      n[`${id}HissGain`].connect(n[`${id}CarrBank`]);
      n[`${id}BuzzNoise`].connect(n[`${id}BuzzLP`]);
      n[`${id}BuzzLP`].connect(n[`${id}BuzzGain`]);
      n[`${id}BuzzGain`].connect(n[`${id}CarrBank`]);
      n[`${id}ModRaw`].connect(n[`${id}ModHP`]);
      n[`${id}ModHP`].connect(n[`${id}ModComp`]);
      n[`${id}ModComp`].connect(n[`${id}ModIn`]);
      n[`${id}Sum`].connect(n[`${id}Wet`]);
      n[`${id}Wet`].connect(n[`${id}Out`]);
      n[`${id}Dry`].connect(n[`${id}Out`]);
      n[`${id}Out`].connect(n[`${id}Presence`]);
      n[`${id}ModIn`].connect(n[`${id}ClarityHP`]);
      n[`${id}ClarityHP`].connect(n[`${id}ClarityGain`]);
      n[`${id}ClarityGain`].connect(n[`${id}Volume`]);
      n[`${id}Presence`].connect(n[`${id}Volume`]);
      n[`${id}ModIn`].connect(n[`${id}Analyser`]);
      // Shared mic fan-out — the singleton Tone.UserMedia feeds every instance's
      // modulator pre-chain (matching the static hardwire); silent until enabled.
      n.extMicGain.connect(n[`${id}ModRaw`]);
      if (isPoweredRef.current) {
        [n[`${id}HissNoise`], n[`${id}BuzzNoise`], n[`${id}CarrOsc`]].forEach(s => { try { s.start(); } catch (_) {} });
      }
      vocShiftBaseRefs.current[id]    = 1.0;
      vocShiftLfoRateRefs.current[id] = 0.7;
      vocShiftLfoAmpRefs.current[id]  = 0;
      vocIdsRef.current = [...vocIdsRef.current, id];
      const jackEntries = {
        [`${id}-mod-in`]:  { type: 'in',  dest: n[`${id}ModRaw`] },
        [`${id}-carr-in`]: { type: 'in',  dest: n[`${id}CarrIn`] },
        [`${id}-out`]:     { type: 'out', node: n[`${id}Volume`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [
          `${id}ModIn`, `${id}CarrIn`, `${id}Sum`, `${id}Wet`, `${id}Dry`, `${id}Out`, `${id}Analyser`,
          `${id}CarrBank`, `${id}CarrOsc`, `${id}CarrOscGain`, `${id}CarrExtGain`, `${id}CarrSum`, `${id}Volume`,
          `${id}HissNoise`, `${id}HissHP`, `${id}HissGain`, `${id}BuzzNoise`, `${id}BuzzLP`, `${id}BuzzGain`,
          `${id}ClarityHP`, `${id}ClarityGain`, `${id}ModRaw`, `${id}ModHP`, `${id}ModComp`, `${id}Presence`,
          ...VOC_BANDS.flatMap((_, i) =>
            [`${id}ModBPF${i}`, `${id}ModRect${i}`, `${id}ModEnv${i}`, `${id}CarrBPF${i}`, `${id}CarrVCA${i}`]),
        ],
        sourceNames: [`${id}HissNoise`, `${id}BuzzNoise`, `${id}CarrOsc`],
        jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'qnt') {
      const id = `qnt${num}`;
      n[`${id}Out`]              = new Tone.Gain(1); // worklet → Out wrapper; the `${id}-cv-out` jack node
      n[`${id}KeepAlive`]        = new Tone.Gain(0); // silent keepalive — see the static qntKeepAlive note
      n[`${id}TransposeAnalyser`] = new Tone.Analyser('waveform', 256);
      n[`${id}Out`].connect(n[`${id}KeepAlive`]);
      n[`${id}KeepAlive`].connect(Tone.Destination);
      quantizerParamsRefs.current[id]   = defaultQntParams();
      lastQuantizedMidiRefs.current[id] = 69;
      qntIdsRef.current = [...qntIdsRef.current, id];
      const jackEntries = {
        [`${id}-cv-in`]:        { type: 'in',  dest: n.qntNodes?.[id] ?? null }, // live after wire()
        [`${id}-cv-out`]:       { type: 'out', node: n[`${id}Out`] },
        [`${id}-transpose-in`]: { type: 'in',  dest: n[`${id}TransposeAnalyser`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}Out`, `${id}KeepAlive`, `${id}TransposeAnalyser`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      // Worklet module already loaded → mint this instance's worklet now (also
      // patches the cv-in jack live); otherwise the load .then() sweeps qntIdsRef.
      wireQntRef.current?.(id);
      return { id, num };
    }

    // Unreachable for known types (every type has a branch above); defensive
    // only. Nothing to roll back — the counter was max()'d or incremented and
    // monotonic counters are never reused by design.
    return null;
  }, [buildSeqLoop, buildChordSeqLoop]);

  // Generic param dispatch for dynamic instances (Phase 60c) — mirrors each
  // static updater's mapping exactly. UI passes the same param objects the
  // static modules send; shell binds `(p) => updateDynModuleParams(id, p)`.
  const updateDynModuleParams = useCallback((id, params = {}) => {
    const inst = dynInstancesRef.current.get(id);
    const n    = nodesRef.current;
    // No bare n[id] guard — kick/ffb instances compose all node names
    // (`kick2Synth`, `ffb2In`…); the registry entry guarantees the nodes exist.
    if (!inst || !n) return;
    switch (inst.type) {
      case 'vcf':
        if (params.cutoff    !== undefined) n[id].frequency.setTargetAtTime(20 * Math.pow(1000, params.cutoff), Tone.now(), 0.02);
        if (params.resonance !== undefined) safeRamp(n[id].Q, Math.max(0.001, params.resonance * 20));
        break;
      case 'vca':
        if (params.gain !== undefined) safeRamp(n[id].gain, params.gain);
        break;
      case 'lfo':
        if (params.rate     !== undefined) safeRamp(n[id].frequency, 0.1 * Math.pow(300, params.rate));
        if (params.depth    !== undefined) safeRamp(n[id].amplitude, params.depth);
        if (params.type     !== undefined) n[id].type = params.type;
        if (params.modDepth !== undefined) safeRamp(n[`${id}modGain`].gain, params.modDepth * 10);
        break;
      case 'rev':
        if (params.roomSize !== undefined) safeRamp(n[id].roomSize, params.roomSize);
        if (params.wet      !== undefined) safeRamp(n[id].wet,      params.wet);
        break;
      case 'bbd':
        if (params.rate  !== undefined) safeRamp(n[id].frequency, 0.1 * Math.pow(50, params.rate));
        if (params.depth !== undefined) n[id].depth = params.depth; // plain setter — not an AudioParam
        if (params.wet   !== undefined) safeRamp(n[id].wet, params.wet);
        break;
      case 'kick':
        applyKickParams(id, params);
        break;
      case 'voc':
        applyVocoderParams(id, params);
        break;
      case 'qnt':
        applyQuantizerParamsRef.current?.(id, params);
        break;
      case 'ffb':
        if (params.bands) {
          params.bands.forEach((v, i) => {
            const g = n[`${id}Gain${i}`];
            if (g) safeRamp(g.gain, Math.max(0, Math.min(1.5, v)), 0.02);
          });
        }
        if (params.master !== undefined) safeRamp(n[`${id}Master`].gain, Math.max(0, params.master), 0.02);
        break;
      default: break; // vco uses updateVcoParams, env uses updateEnvParams (both id-keyed already)
    }
  }, [applyKickParams, applyVocoderParams]);

  // Instantaneous LFO phase by instance id — generic name composition covers
  // static ('lfo'/'lfo2') and dynamic ('lfo3'+) analysers alike.
  const getLfoInstantById = useCallback((id) => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    const data = n?.[`${id}WaveAnalyser`]?.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2;
  }, []);

  // Caller (LibraryModal) MUST strip the instance's cables first — disposal
  // while an audio connection exists is the Phase 60 risk #1.
  const removeModule = useCallback((id) => {
    const inst = dynInstancesRef.current.get(id);
    const n    = nodesRef.current;
    if (!inst || !n) return;
    const jm = { ...jackMapRef.current };
    inst.jackIds.forEach(j => delete jm[j]);
    jackMapRef.current = jm;
    // Per-instance hard sync worklet (Phase 60d): a native AudioWorkletNode —
    // disconnect only (no dispose), and BEFORE its syncIn/syncOut neighbors go.
    const hs = n.hardSyncNodes?.[id];
    if (hs) {
      try { hs.disconnect(); } catch (_) {}
      delete n.hardSyncNodes[id];
    }
    // Vocoder: sever the shared mic fan-out INTO this instance BEFORE disposal —
    // node.disconnect() only drops a node's own outputs, never its inputs, so a
    // disposed ModRaw would leave a dangling edge on the singleton extMicGain.
    if (inst.type === 'voc') {
      try { n.extMicGain.disconnect(n[`${id}ModRaw`]); } catch (_) {}
    }
    // Quantizer: its worklet is a native AudioWorkletNode — disconnect only
    // (no dispose), and BEFORE its Out/KeepAlive neighbors are disposed.
    if (inst.type === 'qnt') {
      const qn = n.qntNodes?.[id];
      if (qn) {
        try { qn.disconnect(); } catch (_) {}
        delete n.qntNodes[id];
      }
    }
    inst.nodeNames.forEach(name => {
      const node = n[name];
      if (!node) return;
      try { node.stop?.(); }       catch (_) {}
      try { node.disconnect(); }   catch (_) {}
      try { node.dispose(); }      catch (_) {}
      delete n[name];
    });
    if (inst.type === 'vco') {
      allVcoIdsRef.current = allVcoIdsRef.current.filter(v => v !== id);
      delete vcoKnobHzRef.current[id];
      delete vcoActiveCvRef.current[id];
      delete dynVcoSyncRef.current[id];
    }
    if (inst.type === 'kick') {
      delete kickTuneRef.current[id];
      delete kickDecayRef.current[id];
      delete kickTrigCbRef.current[id];
    }
    if (inst.type === 'seq') {
      const loop = seqLoopsRef.current[id];
      if (loop) {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      }
      delete seqLoopsRef.current[id];
      delete seqStepsRefs.current[id];
      delete seqCurrentStepRefs.current[id];
      delete seqStepCbRefs.current[id];
      delete seqGlideRefs.current[id];
    }
    if (inst.type === 'voc') {
      delete vocShiftBaseRefs.current[id];
      delete vocShiftLfoRateRefs.current[id];
      delete vocShiftLfoAmpRefs.current[id];
      delete vocShiftLastRatioRefs.current[id];
      vocIdsRef.current = vocIdsRef.current.filter(v => v !== id);
    }
    if (inst.type === 'chordseq') {
      const loop = chordSeqLoopsRef.current[id];
      if (loop) {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      }
      delete chordSeqLoopsRef.current[id];
      delete chordSeqStepsRefs.current[id];
      delete chordSeqCurrentStepRefs.current[id];
      delete chordSeqStepCbRefs.current[id];
      delete chordSeqChordCbRefs.current[id];
      delete chordSeqDivisionRefs.current[id];
      delete chordSeqRootOctaveRefs.current[id];
      delete chordSeqGlideRefs.current[id];
      delete chordSeqInputActiveRefs.current[id];
      chordSeqIdsRef.current = chordSeqIdsRef.current.filter(c => c !== id);
      // Any quantizer this chord seq was overriding reverts to manual control.
      for (const [qid, owner] of Object.entries(qntChordOverrideRef.current))
        if (owner === id) delete qntChordOverrideRef.current[qid];
    }
    if (inst.type === 'qnt') {
      delete quantizerParamsRefs.current[id];
      delete lastQuantizedMidiRefs.current[id];
      delete quantizerStepCbRefs.current[id];
      delete qntChordOverrideRef.current[id];
      qntIdsRef.current = qntIdsRef.current.filter(q => q !== id);
    }
    dynInstancesRef.current.delete(id);
  }, []);

  // ── VCO knob-stepper mode (Phase 57, id-keyed since 60e part 4) ──
  // Active for a VCO when some quantizer's cv-out → vcoN-cv is patched AND
  // nothing feeds THAT quantizer's cv-in. With a melody source patched into the
  // quantizer, its worklet's port.onmessage owns the glideBus (melody-quantize
  // path); with no input, ownership falls to the FREQ knob, snapped through
  // quantizeHzJs against that instance's config. The two writers are mutually
  // exclusive by construction (Single Writer rule, per instance).
  const qntHasCvInput = useCallback((qid = 'qnt') =>
    [...connectionsRef.current.keys()].some(k => k.endsWith(`→${qid}-cv-in`)), []);

  // The quantizer id driving a VCO's cv-in, or null ('qnt' | 'qnt2' | …).
  const qntIdForVco = useCallback((vcoId) =>
    vcoActiveCvRef.current[vcoId]?.match(/^(qnt\d*)-cv-out$/)?.[1] ?? null, []);

  // VCOs currently snapping their FREQ knob (bypass counts as mode-off for the UI glow).
  const knobQuantizedVcoIds = useCallback(() =>
    allVcoIdsRef.current.filter(id => {
      const qid = qntIdForVco(id);
      return qid && !qntHasCvInput(qid) && !quantizerParamsRefs.current[qid]?.bypass;
    }), [qntHasCvInput, qntIdForVco]);

  const notifyKnobQuantize = useCallback(() => {
    vcoQuantizedCbRef.current?.(knobQuantizedVcoIds());
  }, [knobQuantizedVcoIds]);

  // Write the FREQ knob's Hz — snapped, or raw when bypassed — to a qnt-patched
  // VCO's glideBus, and mirror the snapped note onto that QNT's display/LEDs.
  const applyVcoKnobQuantize = useCallback((vcoId) => {
    const n = nodesRef.current;
    if (!n) return;
    const kHz = vcoKnobHzRef.current[vcoId];
    if (kHz == null) return;
    const qid = qntIdForVco(vcoId);
    const q   = qid && quantizerParamsRefs.current[qid];
    if (!q) return;
    const hz = quantizeHzJs(kHz, q);
    const gb = n[`${vcoId}GlideBus`];
    if (!gb) return;
    if (Tone.context.state === 'running') gb.rampTo(hz, 0.02);
    else                                  gb.value = hz;
    n.hardSyncNodes?.[vcoId]?.parameters.get('slaveFreq').setTargetAtTime(hz, Tone.now(), 0.02);
    if (!q.bypass && quantizerStepCbRefs.current[qid]) {
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      lastQuantizedMidiRefs.current[qid] = midi;
      quantizerStepCbRefs.current[qid](((midi % 12) + 12) % 12, midi, undefined);
    }
  }, [qntIdForVco]);

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
        // Kick gate — store without an env ref; loop handlers detect isKick and
        // resolve the target instance via kickId ('kick' = the static module).
        gateActionsRef.current.set(key, { isKick: true, kickId: to.kickId ?? 'kick', fromId: effFrom });
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
      const MANAGED = new Set(['kbd-pitch-out']);
      // Any 960's pitch out / chord seq's CV outs / quantizer's cv-out are
      // managed — instance ids are open-ended (Phase 60e). Node names compose
      // from the jack id: chordseq2-3rd-out → n.chordseq2ThirdOut.
      const isSeqPitch   = /^seq\d*-pitch-out$/.test(effFrom);
      const chordOutKind = effFrom.match(/^(chordseq\d*)-(cv|root|3rd|5th)-out$/);
      const qntOutMatch  = effFrom.match(/^(qnt\d*)-cv-out$/);
      const CHORD_OUT_SUFFIX = { cv: 'PitchOut', root: 'RootOut', '3rd': 'ThirdOut', '5th': 'FifthOut' };
      if (MANAGED.has(effFrom) || isSeqPitch || chordOutKind || qntOutMatch) {
        // No audio cable — step loops/quantizer callback write to glideBus on each event.
        // Seed the glideBus with the source's current value so there's no jump on connect.
        const seedHz = isSeqPitch    ? (n[`${effFrom.replace('-pitch-out', '')}PitchOut`]?.value ?? SEQ_HZ_MIN)
                     : chordOutKind  ? (n[`${chordOutKind[1]}${CHORD_OUT_SUFFIX[chordOutKind[2]]}`]?.value ?? SEQ_HZ_MIN)
                     : qntOutMatch   ? 440 * Math.pow(2, ((lastQuantizedMidiRefs.current[qntOutMatch[1]] ?? 69) - 69) / 12)
                     : effFrom === 'kbd-pitch-out'     ? (n.kbdPitchOut.value       ?? SEQ_HZ_MIN)
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
        audioNode: (MANAGED.has(effFrom) || isSeqPitch || chordOutKind || qntOutMatch) ? null : from.node });
      // Knob-stepper mode: quantizer idle (no CV input) — snap the knob's value
      // immediately (overrides the generic seed) and light the FREQ knob glow.
      // Either way, seed the worklet's modulation-mode base from this knob.
      if (qntOutMatch) {
        const qid = qntOutMatch[1];
        const kHz = vcoKnobHzRef.current[vcoId];
        if (kHz != null && quantizerParamsRefs.current[qid]) {
          quantizerParamsRefs.current[qid].baseHz = kHz;
          n.qntNodes?.[qid]?.port.postMessage({ baseHz: kHz });
        }
        if (!qntHasCvInput(qid)) applyVcoKnobQuantize(vcoId);
        notifyKnobQuantize();
      }
      return;
    }

    if (to.dest === null) return;   // deferred jack — silently no-op

    // Set VCO or LFO waveform to match the specific output jack patched.
    // waveformTarget separates the waveform-setting node (e.g. n.vco2) from the
    // routing node (e.g. n.vco2bus) when they differ.
    const waveformNode = from.waveformTarget ?? from.node;
    if (from.waveform) waveformNode.type = from.waveform;

    // Chord-seq → quantizer scale override: when any chord seq's cv-out is
    // patched to qnt-transpose-in, THAT instance's loop takes ownership of the
    // quantizer's root+scale (last patch wins). Apply the current chord
    // immediately so the quantizer is correct right away — don't wait for the
    // next bar boundary.
    const trpMatch = effTo.match(/^(qnt\d*)-transpose-in$/);
    if (/^chordseq\d*-cv-out$/.test(effFrom) && trpMatch) {
      const csId = effFrom.replace('-cv-out', '');
      const qid  = trpMatch[1];
      qntChordOverrideRef.current[qid] = csId;
      const stepIdx = chordSeqCurrentStepRefs.current[csId] ?? -1;
      const step    = chordSeqStepsRefs.current[csId]?.[Math.max(0, stepIdx)];
      const qp      = quantizerParamsRefs.current[qid];
      if (step && qp) {
        qp.root  = step.rootClass;
        qp.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
        n.qntNodes?.[qid]?.port.postMessage(qp);
      }
    }

    try {
      from.node.connect(to.dest);
      connectionsRef.current.set(key, { node: from.node, dest: to.dest });
    } catch (e) {
      console.warn(`[MoogAudio] connect ${key}:`, e.message);
    }

    // A CV source now feeds a quantizer — its worklet takes over qnt-driven
    // VCO pitch; any knob-stepper glow on that instance's VCOs turns off.
    if (/^qnt\d*-cv-in$/.test(effTo)) notifyKnobQuantize();
  }, [qntHasCvInput, applyVcoKnobQuantize, notifyKnobQuantize]);

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
        n.hardSyncNodes?.[vcoId]?.parameters.get('slaveFreq').setValueAtTime(kHz, Tone.now());
      }
      if (/^qnt\d*-cv-out$/.test(conn.sourceId)) notifyKnobQuantize(); // glow off for this VCO
      return;
    }

    try {
      conn.node.disconnect(conn.dest);
    } catch (e) {
      console.warn(`[MoogAudio] disconnect ${key}:`, e.message);
    }
    connectionsRef.current.delete(key);

    // Chord-seq → quantizer override: clear when the OWNING chord seq's cable
    // to that quantizer is removed (a stale cable from another chord seq must
    // not clear a newer owner).
    const trpOff = effTo.match(/^(qnt\d*)-transpose-in$/);
    if (trpOff &&
        qntChordOverrideRef.current[trpOff[1]] === effFrom.replace('-cv-out', '')) {
      delete qntChordOverrideRef.current[trpOff[1]];
    }

    // A quantizer's CV input removed — pitch ownership of ITS qnt-patched VCOs
    // falls back to their FREQ knobs (snapped); re-apply and re-light the glow.
    const cvInOff = effTo.match(/^(qnt\d*)-cv-in$/);
    if (cvInOff) {
      const cvOutSrc = `${cvInOff[1]}-cv-out`;
      for (const id of allVcoIdsRef.current)
        if (vcoActiveCvRef.current[id] === cvOutSrc) applyVcoKnobQuantize(id);
      notifyKnobQuantize();
    }
  }, [applyVcoKnobQuantize, notifyKnobQuantize]);

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
    const syncNode = n.hardSyncNodes?.[vcoId];
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
      } else {
        const qid = qntIdForVco(vcoId);
        if (qid && quantizerParamsRefs.current[qid]) {
          // The knob is that quantizer's center (Phase 58): post as its worklet's
          // modulation-mode base so LFO-through-QNT sweeps track the knob…
          quantizerParamsRefs.current[qid].baseHz = safeHz;
          n.qntNodes?.[qid]?.port.postMessage({ baseHz: safeHz });
          // …and in knob-stepper mode (no CV into that quantizer, Phase 57) snap
          // it to the scale now (raw when bypassed).
          if (!qntHasCvInput(qid)) applyVcoKnobQuantize(vcoId);
        }
      }
    }
    if (detune !== undefined) {
      vco.detune.setTargetAtTime(detune, Tone.now(), 0.02);
      syncNode?.parameters.get('slaveDetune').setTargetAtTime(detune, Tone.now(), 0.02);
    }
    if (type !== undefined) vco.type = type;
  }, [qntHasCvInput, applyVcoKnobQuantize, qntIdForVco]);

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

  // Returns the FFT snapshot (Float32Array of dB values) from a reverb's Aura
  // analyser tap, or null before nodes are created. num: 1 | 2 selects the module.
  // num: 1 | 2 for the static reverbs, or a dynamic instance id ('reverb3'+).
  const getReverbAuraData = useCallback((num = 1) => {
    const n = nodesRef.current;
    if (!n) return null;
    const analyser = num === 1 ? n.reverbAnalyser
                   : num === 2 ? n.reverb2Analyser
                   : n[`${num}Analyser`];
    return analyser?.getValue() ?? null;
  }, []);

  // Returns the raw waveform data from the TRANSPOSE CV analyser.
  // The average absolute value of these samples is the DC level = Hz from the patched source.
  // Returns Float32Array of 256 samples, or null before nodes are created.
  // id-generic (Phase 60e part 4): 'qnt' (static, default) or a dynamic
  // instance id — name composition covers both ('qntTransposeAnalyser' /
  // 'qnt2TransposeAnalyser').
  const getQntTransposeData = useCallback((qid = 'qnt') => {
    const n = nodesRef.current;
    return n?.[`${qid}TransposeAnalyser`]?.getValue() ?? null;
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

  // Push latest step data into the audio loop maps — no React state involved.
  // id-keyed (Phase 60e): 'seq' / 'seq2' statics, 'seq3'+ dynamics.
  const updateSeqStepsById = useCallback((seqId, steps) => {
    seqStepsRefs.current[seqId] = steps;
  }, []);

  // Register the UI step-advance callback (called inside Tone.Loop, main thread).
  // Pass null to deregister. The callback receives: (stepIndex: 0–15) | -1 (clear all).
  const setSeqStepCallbackById = useCallback((seqId, fn) => {
    seqStepCbRefs.current[seqId] = fn;
  }, []);

  const setSeqGlideById = useCallback((seqId, v) => {
    seqGlideRefs.current[seqId] = v;
  }, []);

  // Legacy static-module wrappers — the shell's seq1/seq2 call sites use these.
  const updateSequencerSteps = useCallback((steps) => updateSeqStepsById('seq', steps),  [updateSeqStepsById]);
  const setSeqStepCallback   = useCallback((fn)    => setSeqStepCallbackById('seq', fn), [setSeqStepCallbackById]);
  const updateSeq2Steps      = useCallback((steps) => updateSeqStepsById('seq2', steps), [updateSeqStepsById]);
  const setSeq2StepCallback  = useCallback((fn)    => setSeqStepCallbackById('seq2', fn), [setSeqStepCallbackById]);

  // Update a quantizer's scale and/or root note (id-keyed, Phase 60e part 4).
  // scale (string key: 'CHR' | 'MAJ' | 'MIN' | 'PMAJ' | 'PMIN')
  // root  (0–11: 0=C, 1=C#, …, 11=B)
  // Params are buffered per instance so they are sent correctly even if
  // called before its AudioWorkletNode exists.
  const applyQuantizerParams = useCallback((qid, { scale, root, octShift, bypass } = {}) => {
    const qp = quantizerParamsRefs.current[qid];
    if (!qp) return;
    if (scale    !== undefined) qp.scale    = SCALE_DEFS[scale] ?? SCALE_DEFS.MAJ;
    if (root     !== undefined) qp.root     = root;
    if (octShift !== undefined) qp.octShift = octShift;
    if (bypass   !== undefined) qp.bypass   = bypass;
    // Knob-stepper mode (Phase 57): config changes re-snap the VCO knobs THIS
    // quantizer drives (bypass ON writes the raw knob Hz — reverts to continuous).
    if (!qntHasCvInput(qid)) {
      const cvOutSrc = `${qid}-cv-out`;
      for (const id of allVcoIdsRef.current)
        if (vcoActiveCvRef.current[id] === cvOutSrc) applyVcoKnobQuantize(id);
    }
    if (bypass !== undefined) notifyKnobQuantize(); // glow follows bypass state
    nodesRef.current?.qntNodes?.[qid]?.port.postMessage(qp);
  }, [qntHasCvInput, applyVcoKnobQuantize, notifyKnobQuantize]);
  // Inline ref sync (the App.js mappingsRef pattern): updateDynModuleParams is
  // declared before the knob-stepper helpers this depends on, so it dispatches
  // dynamic 'qnt' params through this ref instead of a direct dependency.
  applyQuantizerParamsRef.current = applyQuantizerParams;

  // Legacy static-module wrapper — the shell's static QuantizerModule call site.
  const updateQuantizerParams = useCallback((p = {}) => applyQuantizerParams('qnt', p), [applyQuantizerParams]);

  // Chord sequencer setters — id-keyed (Phase 60e part 2): 'chordseq' static,
  // 'chordseq2'+ dynamics. The legacy no-id exports below wrap the static id.
  const updateChordSeqStepsById = useCallback((csId, steps) => {
    chordSeqStepsRefs.current[csId] = steps;
  }, []);

  // Register a chord sequencer LED step callback (same pattern as setSeqStepCallbackById).
  const setChordSeqStepCallbackById = useCallback((csId, fn) => {
    chordSeqStepCbRefs.current[csId] = fn;
  }, []);

  // Register a callback fired on each chord step advance: fn(rootClass: 0-11, chordType: string).
  // MoogShell uses the static instance's to update the QNT chord-type label.
  const setChordSeqChordCallbackById = useCallback((csId, fn) => {
    chordSeqChordCbRefs.current[csId] = fn;
  }, []);

  // Set the octave offset for an instance's independent chord root output.
  // octave: integer -3..+3
  const setChordSeqRootOctaveById = useCallback((csId, octave) => {
    chordSeqRootOctaveRefs.current[csId] = octave;
  }, []);

  // Change a chord sequencer's clock division — takes effect immediately.
  // interval: Tone.js time string ('2n' | '1m' | '2m' | '4m')
  const setChordSeqDivisionById = useCallback((csId, interval) => {
    chordSeqDivisionRefs.current[csId] = interval;
    const loop = chordSeqLoopsRef.current[csId];
    if (loop) loop.interval = interval;
  }, []);

  const setChordSeqGlideById = useCallback((csId, v) => {
    chordSeqGlideRefs.current[csId] = v;
  }, []);

  // Legacy static-module wrappers — the shell's static ChordSeqModule call sites.
  const updateChordSeqSteps      = useCallback((steps)  => updateChordSeqStepsById('chordseq', steps),   [updateChordSeqStepsById]);
  const setChordSeqStepCallback  = useCallback((fn)     => setChordSeqStepCallbackById('chordseq', fn),  [setChordSeqStepCallbackById]);
  const setChordSeqChordCallback = useCallback((fn)     => setChordSeqChordCallbackById('chordseq', fn), [setChordSeqChordCallbackById]);
  const setChordSeqRootOctave    = useCallback((octave) => setChordSeqRootOctaveById('chordseq', octave), [setChordSeqRootOctaveById]);
  const setChordSeqDivision      = useCallback((interval) => setChordSeqDivisionById('chordseq', interval), [setChordSeqDivisionById]);

  // Register the quantizer LED callback (called from quantizer port.onmessage, main thread).
  // The callback receives: (noteClass: 0–11, midiNote: int) when the quantized note changes.
  const setQuantizerCallbackById = useCallback((qid, fn) => {
    quantizerStepCbRefs.current[qid] = fn;
  }, []);
  const setQuantizerCallback = useCallback((fn) => setQuantizerCallbackById('qnt', fn), [setQuantizerCallbackById]);

  // Register the knob-stepper UI callback: fn(vcoIds[]) — the VCOs whose FREQ
  // knob is currently quantized (MoogShell lights those knobs' glow).
  // Fires immediately with the current state so a re-mounting UI syncs up.
  const setVcoQuantizedCallback = useCallback((fn) => {
    vcoQuantizedCbRef.current = fn;
    fn?.(knobQuantizedVcoIds());
  }, [knobQuantizedVcoIds]);

  // Returns a quantizer's last quantized frequency in Hz (A4 = 440 Hz default).
  // Used by VcoModule's TUNE button to back-compute the correct FREQ knob position.
  const getLastQuantizedHz = useCallback((qid = 'qnt') => {
    return 440 * Math.pow(2, ((lastQuantizedMidiRefs.current[qid] ?? 69) - 69) / 12);
  }, []);

  // Kick triggers — id-keyed (Phase 60d). The static KickModule uses the
  // 'kick'-bound wrappers; dynamic instances bind their own id in MoogShell.
  const triggerKickById = useCallback((kid, onFlash) => {
    const n = nodesRef.current;
    const synth = n?.[`${kid}Synth`];
    if (!synth) return;
    const now = Tone.now();
    synth.triggerAttackRelease(kickTuneRef.current[kid] ?? 55, kickDecayRef.current[kid] ?? 0.4, now);
    n[`${kid}ClickSynth`]?.triggerAttackRelease((kickDecayRef.current[kid] ?? 0.4) * 0.1, now);
    onFlash?.();
  }, []);

  const updateKickParams = useCallback((p = {}) => applyKickParams('kick', p), [applyKickParams]);
  const triggerKick      = useCallback((onFlash) => triggerKickById('kick', onFlash), [triggerKickById]);
  const setKickTrigCallbackById = useCallback((kid, fn) => { kickTrigCbRef.current[kid] = fn; }, []);

  // Keyboard vibrato — depth in Hz (0–20), rate in Hz, delay bool. Drives the rAF loop refs.
  const setKbdVibrato = useCallback(({ depth, rate, delay } = {}) => {
    if (depth !== undefined) kbdVibratoDepthRef.current = depth;
    if (rate  !== undefined) kbdVibratoRateRef.current  = rate;
    if (delay !== undefined) kbdVibratoDelayRef.current = delay; // delay = time in seconds
  }, []);

  const setSeqGlide  = useCallback((v) => setSeqGlideById('seq', v),  [setSeqGlideById]);
  const setChordSeqGlide = useCallback((v) => setChordSeqGlideById('chordseq', v), [setChordSeqGlideById]);
  const setSeq2Glide = useCallback((v) => setSeqGlideById('seq2', v), [setSeqGlideById]);
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

  // id-generic (Phase 60d): 'ffb' (static, default) or a dynamic instance id
  // ('ffb2'…) — name composition covers both ('ffbAnalyser' / 'ffb2Analyser').
  const getFFBAnalyserData = useCallback((id = 'ffb') => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
  }, []);

  // 16-band Vocoder — legacy static-module wrapper (the full mapping lives in
  // applyVocoderParams, id-keyed since Phase 60e part 3).
  const updateVocoderParams = useCallback((p = {}) => applyVocoderParams('voc', p), [applyVocoderParams]);

  // id-generic: 'voc' (static, default) or a dynamic instance id ('voc2'…).
  const getVocAnalyserData = useCallback((id = 'voc') => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
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
  // Dynamic-instance variant (Phase 60d) — same crossfade, state in dynVcoSyncRef
  // so powerOff/powerOn can gate and restore per instance.
  const setVcoSyncEnabledById = useCallback((vcoId, enabled) => {
    const n = nodesRef.current;
    if (!n || !n[`${vcoId}syncOut`]) return;
    dynVcoSyncRef.current[vcoId] = enabled;
    safeRamp(n[`${vcoId}normalGain`].gain, enabled ? 0 : 1, 0.01);
    safeRamp(n[`${vcoId}syncOut`].gain,    enabled ? 1 : 0, 0.01);
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
    updateReverbParams, updateReverb2Params, getReverbAuraData, updateChorusParams, getMoogBusNode,
    getOscilloscopeData, getQntTransposeData, getMeterValue, getLfoInstant, getLfo2Instant,
    setTempo, updateSequencerSteps, setSeqStepCallback,
    updateSeq2Steps, setSeq2StepCallback, updateKeyboard,
    updateSeqStepsById, setSeqStepCallbackById, setSeqGlideById,
    updateChordSeqSteps, setChordSeqStepCallback, setChordSeqDivision,
    setChordSeqChordCallback, setChordSeqRootOctave, setChordSeqGlide,
    updateChordSeqStepsById, setChordSeqStepCallbackById, setChordSeqDivisionById,
    setChordSeqRootOctaveById, setChordSeqGlideById,
    setVco1SyncEnabled, setVco2SyncEnabled, setVco3SyncEnabled, setVco4SyncEnabled, setVco5SyncEnabled,
    setSeqGlide, setSeq2Glide, setKbdGlide, setKbdVibrato,
    updateFFBParams, getFFBAnalyserData,
    updateVocoderParams, getVocAnalyserData,
    enableMic, disableMic, updateExtMicParams,
    updateKickParams, triggerKick, triggerKickById, setKickTrigCallbackById,
    setKickTrigCallback: (fn) => { kickTrigCbRef.current.kick = fn; },
    setVcoSyncEnabledById,
    updateQuantizerParams, setQuantizerCallback, setQuantizerCallbackById, setVcoQuantizedCallback,
    addModule, removeModule, updateDynModuleParams, getLfoInstantById,
  };
}
