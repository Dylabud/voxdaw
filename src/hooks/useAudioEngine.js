import { useRef, useCallback } from 'react';
import * as Tone from 'tone';
import {
  calculateDistance, calculateDistance2D, mapRange,
  snapToNearest, isFingerExtended, normalizeNote,
  getArpFingerStates, getWristTiltDeg, getArpSpreadDb,
} from '../utils/dsp';
import { SCALES, NOTE_GRID } from '../utils/scales';

// Semitone intervals — explicit counts eliminate ratio approximation ambiguity
const ST_MIN3 = 3;
const ST_MAJ3 = 4;
const ST_P4   = 5;
const ST_DIM5 = 6;
const ST_P5   = 7;
const ST_MIN7 = 10;
const ST_MAJ7 = 11;
const VOICE_DB   = -12;
const VOICE_MUTE = -80;

const INIT_FREQS = [
  440,
  Tone.Frequency(440).transpose(ST_MAJ3).toFrequency(),
  Tone.Frequency(440).transpose(ST_P5).toFrequency(),
  Tone.Frequency(440).transpose(ST_MIN7).toFrequency(),
  Tone.Frequency(440).transpose(12).toFrequency(),
  Tone.Frequency(440).transpose(12 + ST_MAJ3).toFrequency(),
];

// ── Arp constants ──────────────────────────────────────────────────────────────

const ARP_PATTERN_TYPE = {
  simple:          'upDown',
  complex:         'upDown',
  complexRandom:   'randomWalk',
  simpleRandom:    'random',
  octave:          'upDown',
  simpleUp:        'up',
  simpleDown:      'down',
  complexUp:       'up',
  complexDown:     'down',
  complexDownUp:   'downUp',
};

const ARP_MODE_LABEL = {
  off:            'OFF',
  simple:         'SIMPLE',
  complex:        'COMPLEX',
  complexRandom:  'CMPLX RND',
  simpleRandom:   'SMP RND',
  octave:         'OCTAVE',
  simpleUp:       'SMP UP',
  simpleDown:     'SMP DN',
  complexUp:      'CMPLX UP',
  complexDown:    'CMPLX DN',
  complexDownUp:  'CMPLX DN↑',
};

// Maps interval → held note duration (half the step for clean articulation)
const HOLD_MAP = { '4n': '8n', '8n': '16n', '16n': '32n' };

// Builds a Tone.js note-string array relative to rootHz.
// thirdST is ST_MAJ3 (4) or ST_MIN3 (3) — mirrors the live chord quality from the pitch hand.
function buildArpNotes(rootHz, mode, thirdST) {
  const root = Tone.Frequency(rootHz).toNote();
  const t = (n, st) => Tone.Frequency(n).transpose(st).toNote();
  const th = thirdST ?? ST_MAJ3;
  switch (mode) {
    case 'simple':
    case 'simpleUp':
    case 'simpleDown':
    case 'simpleRandom':  return [root, t(root, th), t(root, 7)];
    case 'complex':
    case 'complexUp':
    case 'complexDown':
    case 'complexDownUp':
    case 'complexRandom': return [root, t(root, th), t(root, 7), t(root, 12), t(root, 12 + th), t(root, 19)];
    case 'octave':        return [root, t(root, 12)];
    default:              return [root];
  }
}

// ── Trigger routing ────────────────────────────────────────────────────────────

const CHORD_DEST_LABELS = {
  chord_root:      'ROOT',
  chord_minor:     'MIN',
  chord_major:     'MAJ',
  chord_root_7:    'ROOT+7',
  chord_root_maj7: 'ROOT+M7',
  chord_minor_7:   'MIN 7',
  chord_major_7:   'MAJ 7',
  chord_sus4:      'SUS 4',
  chord_dim:       'DIM',
  chord_maj_oct:   'MAJ +8va',
  chord_min_oct:   'MIN +8va',
  chord_maj_sub:   'MAJ -8va',
  chord_min_sub:   'MIN -8va',
  chord_root_sub2: 'ROOT -2oct',
  chord_poly_maj:  'POLY MAJ',
  chord_poly_min:  'POLY MIN',
  chord_maj_9:     'MAJ 9',
  chord_min_9:     'MIN 9',
};

const ARP_DEST_TO_MODE = {
  arp_off:              'off',
  arp_octave:           'octave',
  arp_simple:           'simple',
  arp_complex:          'complex',
  arp_complex_random:   'complexRandom',
  arp_simple_random:    'simpleRandom',
  arp_simple_up:        'simpleUp',
  arp_simple_down:      'simpleDown',
  arp_complex_up:       'complexUp',
  arp_complex_down:     'complexDown',
  arp_complex_down_up:  'complexDownUp',
};

const ARP_DEST_TO_RATE = {
  arp_rate_4n:  '4n',
  arp_rate_8n:  '8n',
  arp_rate_16n: '16n',
};

// Resolves a chord destination ID to an interval array (semitone offsets from root,
// may be negative for sub-octave) and thirdST (arp quality mirror).
function resolveChord(dest) {
  switch (dest) {
    case 'chord_root':      return { intervals: [0],                                             thirdST: ST_MAJ3 };
    case 'chord_minor':     return { intervals: [0, ST_MIN3, ST_P5],                            thirdST: ST_MIN3 };
    case 'chord_major':     return { intervals: [0, ST_MAJ3, ST_P5],                            thirdST: ST_MAJ3 };
    case 'chord_root_7':    return { intervals: [0, ST_MIN7],                                   thirdST: ST_MIN3 };
    case 'chord_root_maj7': return { intervals: [0, ST_MAJ7],                                   thirdST: ST_MAJ3 };
    case 'chord_minor_7':   return { intervals: [0, ST_MIN3, ST_P5, ST_MIN7],                   thirdST: ST_MIN3 };
    case 'chord_major_7':   return { intervals: [0, ST_MAJ3, ST_P5, ST_MAJ7],                   thirdST: ST_MAJ3 };
    case 'chord_sus4':      return { intervals: [0, ST_P4, ST_P5],                              thirdST: ST_MAJ3 };
    case 'chord_dim':       return { intervals: [0, ST_MIN3, ST_DIM5],                          thirdST: ST_MIN3 };
    case 'chord_maj_oct':   return { intervals: [0, ST_MAJ3, ST_P5, 12],                        thirdST: ST_MAJ3 };
    case 'chord_min_oct':   return { intervals: [0, ST_MIN3, ST_P5, 12],                        thirdST: ST_MIN3 };
    case 'chord_maj_sub':   return { intervals: [-12, 0, ST_MAJ3, ST_P5],                       thirdST: ST_MAJ3 };
    case 'chord_min_sub':   return { intervals: [-12, 0, ST_MIN3, ST_P5],                       thirdST: ST_MIN3 };
    case 'chord_root_sub2': return { intervals: [-24, 0],                                       thirdST: ST_MAJ3 };
    case 'chord_poly_maj':  return { intervals: [0, ST_MAJ3, ST_P5, 12, 12+ST_MAJ3, 12+ST_P5],  thirdST: ST_MAJ3 };
    case 'chord_poly_min':  return { intervals: [0, ST_MIN3, ST_P5, 12, 12+ST_MIN3, 12+ST_P5],  thirdST: ST_MIN3 };
    case 'chord_maj_9':     return { intervals: [0, ST_MAJ3, ST_P5, ST_MAJ7, 14],               thirdST: ST_MAJ3 };
    case 'chord_min_9':     return { intervals: [0, ST_MIN3, ST_P5, ST_MIN7, 14],               thirdST: ST_MIN3 };
    default:                return { intervals: [0],                                              thirdST: ST_MAJ3 };
  }
}

// ── Voice factories ────────────────────────────────────────────────────────────

function makeArpVoice(name) {
  switch (name) {
    case 'fm':    return new Tone.FMSynth({ harmonicity: 3, modulationIndex: 10, envelope: { attack: 0.005, decay: 0.15, sustain: 0.1, release: 0.3  }, volume: 0 });
    case 'am':    return new Tone.AMSynth({ harmonicity: 2,                      envelope: { attack: 0.005, decay: 0.2,  sustain: 0.1, release: 0.3  }, volume: 0 });
    case 'pluck': return new Tone.PluckSynth({ attackNoise: 1, dampening: 4000, resonance: 0.7 });
    default:      return new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.005, decay: 0.12, sustain: 0.3, release: 0.25 }, volume: 0 });
  }
}

function applyArpDecay(voice, value) {
  if (!voice) return;
  if (voice instanceof Tone.PluckSynth) {
    voice.resonance = Math.min(0.98, value * 0.49);
  } else {
    voice.envelope.decay   = value;
    voice.envelope.release = Math.min(3.0, value * 1.5);
  }
}

function makeAnalogVoice(oscType, initDb = VOICE_DB) {
  return new Tone.Synth({
    oscillator: { type: oscType },
    envelope:   { attack: 0.02, decay: 0, sustain: 1, release: 0.5 },
    volume:     initDb,
  });
}

function makeStringsVoice(initDb = VOICE_DB) {
  return new Tone.FMSynth({
    harmonicity:        1,
    modulationIndex:    1.5,
    oscillator:         { type: 'sawtooth' },
    modulation:         { type: 'sine' },
    envelope:           { attack: 0.4, decay: 0.2, sustain: 0.8, release: 1.2 },
    modulationEnvelope: { attack: 0.6, decay: 0.2, sustain: 0.5, release: 1.2 },
    volume:             initDb,
  });
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export default function useAudioEngine(hudRefs, sendMidi, updateVocoder, mappingsRef, triggerMappingsRef) {
  const hudRefsRef       = useRef(hudRefs);       hudRefsRef.current       = hudRefs;
  const sendMidiRef      = useRef(sendMidi);      sendMidiRef.current      = sendMidi;
  const updateVocoderRef = useRef(updateVocoder); updateVocoderRef.current = updateVocoder;

  const analogVoicesRef   = useRef(null);
  const stringsVoicesRef  = useRef(null);
  const activeVoicesRef   = useRef(null);
  const filterRef         = useRef(null);
  const vibratoRef        = useRef(null);
  const reverbRef         = useRef(null);
  const volumeRef         = useRef(null);
  const oscTypeRef        = useRef('sine');
  const scaleRef          = useRef(SCALES.cMajor);
  const instrumentNameRef = useRef('analog');
  const currentRootRef    = useRef(440);
  const bpmRef            = useRef(120);
  const globalOctaveRef   = useRef(0);    // semitone transpose in octave steps (-2 to +2)
  const arpOctaveShiftRef = useRef(false); // forces arp root one octave above chord root
  const isStartedRef      = useRef(false);
  const disposeTimerRef   = useRef(null);

  // MIDI tracking refs
  const chordMidiRef   = useRef(new Set()); // chord MIDI notes currently on (for diff)
  const arpMidiTimers  = useRef([]);        // arp noteoff setTimeout IDs
  const arpVelocityRef = useRef(100);       // live arp velocity from spread gesture

  // Arp refs
  const arpInstrumentNameRef = useRef('analog');
  const arpDecayRef          = useRef(0.12);
  const arpVoiceRef        = useRef(null);
  const arpVolRef          = useRef(null);
  const arpBaseVolRef      = useRef(null);
  const arpBypassGainRef   = useRef(null); // dry path → Destination
  const arpFxGainRef       = useRef(null); // wet path → filter chain
  const arpFxEnabledRef    = useRef(false);
  const arpDelayRef        = useRef(null);
  const arpReverbRef       = useRef(null);
  const arpReverbWetRef    = useRef(0);
  const arpSpeedSnapRef      = useRef(true);
  const smoothedFluidIntervalRef = useRef(0.5);
  const fluidUpdateReadyRef      = useRef(false);
  const arpPatternRef        = useRef(null);
  const arpModeRef         = useRef('off');
  const arpRateRef         = useRef('8n');
  const currentArpFreqRef  = useRef(null); // last note fired by the arp Pattern
  // Delta-check refs — pattern is only rewritten when these values change
  const appliedArpModeRef  = useRef(null);
  const appliedArpRootRef  = useRef(null);
  const appliedArpRateRef  = useRef(null);
  const appliedArpThirdRef = useRef(null);
  // Tracks the current chord quality so the arp mirrors it
  const arpThirdSTRef      = useRef(ST_MAJ3);

  const startAudio = useCallback(async () => {
    if (disposeTimerRef.current !== null) {
      clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }

    await Tone.start();

    if (!analogVoicesRef.current) {
      // Shared effects chain
      const vol = new Tone.Volume(-6).toDestination();

      const reverb = new Tone.Reverb({ decay: 3, wet: 0 });
      await reverb.generate();
      reverb.connect(vol);

      const vibrato = new Tone.Vibrato({ frequency: 5, depth: 0, wet: 1 });
      vibrato.connect(reverb);

      const filter = new Tone.Filter({ frequency: 5000, type: 'lowpass', rolloff: -24 });
      filter.connect(vibrato);

      // Analog chord voices (6 for complex chord support; voice 0 audible, rest muted)
      const analogVoices = [
        makeAnalogVoice(oscTypeRef.current),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
      ];

      // Strings chord voices (all muted until instrument switch)
      const stringsVoices = [
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
      ];

      [...analogVoices, ...stringsVoices].forEach(v => v.connect(filter));

      // Arp voice — parallel routing: bypass path goes directly to Destination;
      // fx path enters the filter chain. Toggle between them via setArpFx().
      const arpVol = new Tone.Volume(-12); // gesture-controlled; sits upstream of both paths

      const arpBypassGain = new Tone.Gain(1).toDestination(); // default: bypass active
      const arpFxGain     = new Tone.Gain(0);                 // default: fx path silent
      arpFxGain.connect(filter);

      // arpBaseVol is the static slider-controlled gain; sits between gesture vol and delay
      const arpBaseVol = new Tone.Volume(0);
      arpVol.connect(arpBaseVol);

      // FeedbackDelay sits between arpBaseVol and the reverb; wet=0 at init (transparent)
      const arpDelay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0 });
      // Freeverb (synchronous init) sits between delay and the bypass/fx split
      const arpReverb = new Tone.Freeverb({ roomSize: 0.84, dampening: 3000 });
      arpReverb.wet.value = arpReverbWetRef.current;
      arpDelay.connect(arpReverb);
      arpReverb.connect(arpBypassGain);
      arpReverb.connect(arpFxGain);
      arpBaseVol.connect(arpDelay);

      const arpVoice = makeArpVoice(arpInstrumentNameRef.current);
      applyArpDecay(arpVoice, arpDecayRef.current);
      arpVoice.connect(arpVol);

      // Pattern always runs on the transport; gated by arpModeRef inside the callback.
      const arpPattern = new Tone.Pattern((time, note) => {
        if (arpModeRef.current === 'off') return;
        let gateLength;
        if (arpSpeedSnapRef.current) {
          gateLength = HOLD_MAP[arpRateRef.current] ?? '16n';
        } else {
          const fluidTime = smoothedFluidIntervalRef.current;
          gateLength = fluidTime * 0.5;
          fluidUpdateReadyRef.current = true;
        }
        arpVoiceRef.current?.triggerAttackRelease(note, gateLength, time);
        hudRefsRef.current?.pianoRoll?.current?.flashNote(normalizeNote(note), 180);

        // Track live arp frequency so the vocoder carrier can follow the melodic line
        currentArpFreqRef.current = Tone.Frequency(note).toFrequency();

        const midiNote = Math.round(Tone.Frequency(note).toMidi());
        sendMidiRef.current?.('noteon', midiNote, arpVelocityRef.current);
        const holdMs = Tone.Transport.toSeconds(HOLD_MAP[arpRateRef.current] ?? '16n') * 1000;
        const tid = setTimeout(() => sendMidiRef.current?.('noteoff', midiNote, 0), holdMs);
        arpMidiTimers.current.push(tid);
      }, ['C4'], 'upDown');
      arpPattern.interval = '8n';
      arpPattern.start(0);

      filterRef.current        = filter;
      vibratoRef.current       = vibrato;
      reverbRef.current        = reverb;
      volumeRef.current        = vol;
      analogVoicesRef.current  = analogVoices;
      stringsVoicesRef.current = stringsVoices;
      arpVoiceRef.current      = arpVoice;
      arpVolRef.current        = arpVol;
      arpBaseVolRef.current    = arpBaseVol;
      arpDelayRef.current      = arpDelay;
      arpReverbRef.current     = arpReverb;
      arpBypassGainRef.current = arpBypassGain;
      arpFxGainRef.current     = arpFxGain;
      arpPatternRef.current    = arpPattern;

      activeVoicesRef.current = instrumentNameRef.current === 'strings'
        ? stringsVoices
        : analogVoices;

      const activeSet   = activeVoicesRef.current;
      const inactiveSet = activeSet === analogVoices ? stringsVoices : analogVoices;
      activeSet.forEach((v, i)   => v.triggerAttack(INIT_FREQS[i]));
      inactiveSet.forEach((v, i) => v.triggerAttack(INIT_FREQS[i]));
      activeSet[0].volume.value = VOICE_DB;

      Tone.Transport.bpm.value = bpmRef.current;
      Tone.Transport.start();
    } else {
      // Re-engage: voices still alive (dispose timer was cleared)
      const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
      allVoices.forEach((v, i) => v.triggerAttack(INIT_FREQS[i]));
      activeVoicesRef.current[0].volume.value = VOICE_DB;

      // Restore arp routing state
      const fxOn = arpFxEnabledRef.current;
      if (arpBypassGainRef.current) arpBypassGainRef.current.gain.value = fxOn ? 0 : 1;
      if (arpFxGainRef.current)     arpFxGainRef.current.gain.value     = fxOn ? 1 : 0;

      arpModeRef.current = 'off';
      Tone.Transport.start();
    }

    isStartedRef.current = true;
  }, []);

  const stopAudio = useCallback(() => {
    if (!isStartedRef.current || !analogVoicesRef.current) return;

    const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
    allVoices.forEach(v => v.triggerRelease());

    // Cancel pending arp MIDI noteoff timers and flush active chord MIDI notes
    arpMidiTimers.current.forEach(clearTimeout);
    arpMidiTimers.current = [];
    const sm = sendMidiRef.current;
    if (sm) chordMidiRef.current.forEach(n => sm('noteoff', n));
    chordMidiRef.current = new Set();

    // Stop arp pattern immediately (before dispose timer)
    if (arpPatternRef.current) {
      arpPatternRef.current.mute = true;
      arpPatternRef.current.stop();
    }
    arpModeRef.current         = 'off';
    currentArpFreqRef.current  = null;
    appliedArpModeRef.current  = null;
    appliedArpRateRef.current  = null;
    appliedArpRootRef.current  = null;
    appliedArpThirdRef.current = null;
    smoothedFluidIntervalRef.current = 0.5;
    fluidUpdateReadyRef.current = false;
    Tone.Transport.stop();

    hudRefsRef.current?.pianoRoll?.current?.setNotes([]);
    isStartedRef.current = false;

    disposeTimerRef.current = setTimeout(() => {
      allVoices.forEach(v => v.dispose());
      arpPatternRef.current?.dispose();
      arpVoiceRef.current?.dispose();
      arpVolRef.current?.dispose();
      arpBaseVolRef.current?.dispose();
      arpDelayRef.current?.dispose();
      arpReverbRef.current?.dispose();
      arpBypassGainRef.current?.dispose();
      arpFxGainRef.current?.dispose();
      filterRef.current?.dispose();
      vibratoRef.current?.dispose();
      reverbRef.current?.dispose();
      volumeRef.current?.dispose();

      analogVoicesRef.current  = null;
      stringsVoicesRef.current = null;
      activeVoicesRef.current  = null;
      arpPatternRef.current    = null;
      arpVoiceRef.current      = null;
      arpVolRef.current        = null;
      arpBaseVolRef.current    = null;
      arpDelayRef.current      = null;
      arpReverbRef.current     = null;
      arpBypassGainRef.current = null;
      arpFxGainRef.current     = null;
      filterRef.current        = null;
      vibratoRef.current       = null;
      reverbRef.current        = null;
      volumeRef.current        = null;
      disposeTimerRef.current  = null;
    }, 1600);
  }, []);

  // Called every rAF frame — no React state touched, all writes go to audio nodes or DOM refs
  const updateParams = useCallback((landmarks, handednesses) => {
    if (!isStartedRef.current || !activeVoicesRef.current) return;

    const hud    = hudRefsRef.current;
    const voices = activeVoicesRef.current;

    // Build trigger lookup once per frame (source → destination).
    const triggerMap = new Map((triggerMappingsRef?.current ?? []).map(m => [m.trigger, m.destination]));

    // ── Phase 1: Gather ──────────────────────────────────────────────────────────
    // Loop both hands. Collect active trigger IDs and continuous signals.
    // No Tone.js calls here — pure data extraction.
    const signals        = {};
    const activeTriggers = [];

    let pitchHandFound = false;
    let arpHandFound   = false;

    // Hoisted right-hand values consumed in the execution phase
    let root = 440, chordVel = 64;

    // Hoisted left-hand values consumed in the execution phase
    let arpHand = null, arpFingerStates = null, arpHandSize = 0, tilt = 0;

    for (let i = 0; i < landmarks.length; i++) {
      const hand = landmarks[i];
      const wrist    = hand[0];
      const thumbTip = hand[4];
      const indexTip = hand[8];
      const dist = calculateDistance(thumbTip, indexTip);

      const label = handednesses[i][0].categoryName;

      if (label === 'Left') {
        // ── RIGHT HAND: pitch root + right-hand combo ───────────────────
        pitchHandFound = true;

        const SAFE_TOP    = 0.15;
        const SAFE_BOTTOM = 0.88;
        const safeY    = Math.max(0, Math.min(1, (wrist.y - SAFE_TOP) / (SAFE_BOTTOM - SAFE_TOP)));
        const gridIdx  = Math.min(Math.floor(safeY * NOTE_GRID.length), NOTE_GRID.length - 1);
        const rawPitch = Tone.Frequency(NOTE_GRID[gridIdx].note).transpose(globalOctaveRef.current * 12).toFrequency();
        root           = snapToNearest(rawPitch, scaleRef.current);
        currentRootRef.current = root;

        const midMCP          = hand[9];
        const handSize        = calculateDistance2D(wrist, midMCP);
        const normalizedPinch = calculateDistance2D(thumbTip, indexTip) / handSize;
        chordVel = Math.max(1, Math.min(127, Math.round(mapRange(normalizedPinch, 0.2, 1.2, 0, 127))));

        signals.right_hand_size  = Math.max(0, Math.min(1, mapRange(handSize, 0.08, 0.35, 0, 1)));
        signals.right_pinch_norm = Math.max(0, Math.min(1, mapRange(normalizedPinch, 0.2, 1.2, 0, 1)));

        const middleUp = isFingerExtended(hand, 12, 9);
        const ringUp   = isFingerExtended(hand, 16, 13);
        const pinkyUp  = isFingerExtended(hand, 20, 17);

        let activeRightCombo;
        if      (!middleUp && !ringUp && !pinkyUp) activeRightCombo = 'right_no_fingers';
        else if ( middleUp && !ringUp && !pinkyUp) activeRightCombo = 'right_middle';
        else if ( middleUp &&  ringUp && !pinkyUp) activeRightCombo = 'right_middle_ring';
        else if (!middleUp && !ringUp &&  pinkyUp) activeRightCombo = 'right_pinky';
        else if (!middleUp &&  ringUp &&  pinkyUp) activeRightCombo = 'right_ring_pinky';
        else if ( middleUp && !ringUp &&  pinkyUp) activeRightCombo = 'right_middle_pinky';
        else if ( middleUp &&  ringUp &&  pinkyUp) activeRightCombo = 'right_middle_ring_pinky';
        else                                       activeRightCombo = 'right_no_fingers';

        activeTriggers.push(activeRightCombo);

      } else {
        // ── LEFT HAND: arp hand data + left-hand combos + tilt band ─────
        arpHandFound   = true;
        arpHand        = hand;
        arpHandSize    = calculateDistance2D(wrist, hand[9]);
        arpFingerStates = getArpFingerStates(hand);
        const { middleOut, ringOut, pinkyOut } = arpFingerStates;

        let activeLeftCombo;
        if      (!middleOut && !ringOut && !pinkyOut) activeLeftCombo = 'left_no_fingers';
        else if (!middleOut && !ringOut &&  pinkyOut) activeLeftCombo = 'left_pinky';
        else if (!middleOut &&  ringOut &&  pinkyOut) activeLeftCombo = 'left_ring_pinky';
        else if ( middleOut && !ringOut && !pinkyOut) activeLeftCombo = 'left_middle';
        else if ( middleOut &&  ringOut && !pinkyOut) activeLeftCombo = 'left_middle_ring';
        else if ( middleOut &&  ringOut &&  pinkyOut) activeLeftCombo = 'left_middle_ring_pinky';
        else if ( middleOut && !ringOut &&  pinkyOut) activeLeftCombo = 'left_middle_pinky';
        else                                          activeLeftCombo = 'left_no_fingers';

        activeTriggers.push(activeLeftCombo);

        tilt = getWristTiltDeg(hand);
        let activeTiltBand;
        if      (tilt < 20) activeTiltBand = 'left_tilt_low';
        else if (tilt < 60) activeTiltBand = 'left_tilt_mid';
        else                activeTiltBand = 'left_tilt_high';

        activeTriggers.push(activeTiltBand);

        signals.left_pinch_dist = Math.max(0, Math.min(1, mapRange(dist, 0.03, 0.20, 0, 1)));
        signals.left_wrist_y    = wrist.y;
        signals.left_wrist_tilt = Math.max(0, Math.min(1, mapRange(tilt, 0, 90, 0, 1)));
      }
    }

    // ── Phase 2: Resolve ─────────────────────────────────────────────────────────
    // Each active trigger ID is looked up in triggerMap. Destinations are bucketed
    // by type — any trigger from either hand can now route to any destination category.
    let targetChord   = 'chord_root';
    let targetArpMode = 'arp_off';
    let targetArpRate = 'arp_rate_8n';

    for (const triggerId of activeTriggers) {
      const dest = triggerMap.get(triggerId);
      if (!dest) continue;
      if (dest in CHORD_DEST_LABELS)     targetChord   = dest;
      else if (dest in ARP_DEST_TO_RATE) targetArpRate = dest;
      else if (dest in ARP_DEST_TO_MODE) targetArpMode = dest;
    }

    // ── Phase 3: Execute ─────────────────────────────────────────────────────────

    // Chord execution — only when the pitch hand is visible
    if (pitchHandFound) {
      const { intervals, thirdST } = resolveChord(targetChord);
      arpThirdSTRef.current = thirdST;

      const activeNoteNames = [];
      const vocoderFreqs    = [];
      const newMidiSet      = new Set();

      for (let i = 0; i < 6; i++) {
        if (i < intervals.length) {
          const freq = Tone.Frequency(root).transpose(intervals[i]).toFrequency();
          voices[i].frequency.rampTo(freq, 0.05);
          voices[i].volume.rampTo(VOICE_DB, 0.05);
          activeNoteNames.push(normalizeNote(Tone.Frequency(freq).toNote()));
          vocoderFreqs.push(freq);
          newMidiSet.add(Math.round(Tone.Frequency(freq).toMidi()));
        } else {
          voices[i].volume.rampTo(VOICE_MUTE, 0.05);
        }
      }

      if (arpModeRef.current !== 'off' && currentArpFreqRef.current !== null) {
        vocoderFreqs.push(currentArpFreqRef.current);
      }

      hud?.pianoRoll?.current?.setNotes(activeNoteNames);
      updateVocoderRef.current?.(vocoderFreqs);

      if (hud?.chord?.current)
        hud.chord.current.textContent = CHORD_DEST_LABELS[targetChord] ?? 'ROOT';
      if (hud?.pitch?.current)
        hud.pitch.current.textContent = `${Math.round(root)} Hz`;

      const smChord = sendMidiRef.current;
      if (smChord) {
        chordMidiRef.current.forEach(n => { if (!newMidiSet.has(n)) smChord('noteoff', n); });
        newMidiSet.forEach(n => { if (!chordMidiRef.current.has(n)) smChord('noteon', n, chordVel); });
      }
      chordMidiRef.current = newMidiSet;
    }

    // Arp execution — only when the arp hand is visible
    if (arpHandFound) {
      const mode = ARP_DEST_TO_MODE[targetArpMode] ?? 'off';
      const rate = ARP_DEST_TO_RATE[targetArpRate] ?? '8n';
      arpRateRef.current = rate;

      const pat = arpPatternRef.current;
      let spreadDb = 3;
      if (mode !== 'off') {
        spreadDb = getArpSpreadDb(arpHand, arpFingerStates, arpHandSize);
        arpVelocityRef.current = Math.max(1, Math.min(127, Math.round(mapRange(spreadDb, -12, 3, 1, 127))));

        const rootNow          = currentRootRef.current;
        const effectiveArpRoot = arpOctaveShiftRef.current
          ? Tone.Frequency(rootNow).transpose(12).toFrequency()
          : rootNow;
        const thirdNow = arpThirdSTRef.current;
        if (
          mode             !== appliedArpModeRef.current  ||
          effectiveArpRoot !== appliedArpRootRef.current  ||
          thirdNow         !== appliedArpThirdRef.current
        ) {
          if (pat) {
            pat.values  = buildArpNotes(effectiveArpRoot, mode, thirdNow);
            pat.pattern = ARP_PATTERN_TYPE[mode];
          }
          appliedArpModeRef.current  = mode;
          appliedArpRootRef.current  = effectiveArpRoot;
          appliedArpThirdRef.current = thirdNow;
        }

        if (arpSpeedSnapRef.current) {
          if (rate !== appliedArpRateRef.current) {
            if (pat) pat.interval = rate;
            appliedArpRateRef.current = rate;
          }
        } else {
          const targetInterval = mapRange(tilt, 0, 90, 0.5, 0.05);
          smoothedFluidIntervalRef.current +=
            (targetInterval - smoothedFluidIntervalRef.current) * 0.08;
          if (pat && fluidUpdateReadyRef.current) {
            pat.interval = smoothedFluidIntervalRef.current;
            fluidUpdateReadyRef.current = false;
          }
          appliedArpRateRef.current = null;
        }

        signals.left_arp_spread = Math.max(0, Math.min(1, mapRange(spreadDb, -12, 3, 0, 1)));
      }
      arpModeRef.current = mode;

      if (hud?.arp?.current)
        hud.arp.current.textContent = mode === 'off'
          ? 'OFF'
          : `${ARP_MODE_LABEL[mode]} ${rate}`;
      if (hud?.arpVol?.current)
        hud.arpVol.current.textContent = mode === 'off' ? '--' : `${Math.round(spreadDb)} dB`;
    }

    // ── Phase 4: Apply continuous signal mappings ────────────────────────────────
    // Each mapping reads a 0–1 signal, optionally inverts it, then ramps the
    // destination audio node. HUD updates happen here so they always reflect
    // whatever is actually mapped (not just the default layout).
    for (const mapping of (mappingsRef?.current ?? [])) {
      if (!(mapping.source in signals)) continue;
      const raw = signals[mapping.source];
      const s   = mapping.invert ? 1 - raw : raw;

      switch (mapping.destination) {
        case 'filter_cutoff': {
          const hz = mapRange(s, 0, 1, 400, 10000);
          filterRef.current?.frequency.rampTo(hz, 0.05);
          if (hud?.filter?.current)
            hud.filter.current.textContent = `${Math.round(hz)} Hz`;
          break;
        }
        case 'reverb_wet': {
          reverbRef.current?.wet.rampTo(s, 0.05);
          if (hud?.reverb?.current)
            hud.reverb.current.textContent = `${Math.round(s * 100)}%`;
          break;
        }
        case 'vibrato_depth': {
          const depth = mapRange(s, 0, 1, 0, 0.8);
          vibratoRef.current?.depth.rampTo(depth, 0.05);
          if (hud?.vibrato?.current)
            hud.vibrato.current.textContent = `${Math.round(depth * 100)}%`;
          break;
        }
        case 'volume': {
          const db = mapRange(s, 0, 1, -40, 0);
          volumeRef.current?.volume.rampTo(db, 0.05);
          if (hud?.velocity?.current)
            hud.velocity.current.textContent = `${Math.round(s * 100)}%`;
          break;
        }
        case 'arp_volume': {
          const db = mapRange(s, 0, 1, -12, 3);
          arpVolRef.current?.volume.rampTo(db, 0.05);
          break;
        }
        default: break;
      }
    }

    if (!pitchHandFound) {
      hud?.pianoRoll?.current?.setNotes([]);
      const smLost = sendMidiRef.current;
      if (smLost) chordMidiRef.current.forEach(n => smLost('noteoff', n));
      chordMidiRef.current = new Set();
      updateVocoderRef.current?.([]);
    }

    if (!arpHandFound && arpModeRef.current !== 'off') {
      arpModeRef.current         = 'off';
      currentArpFreqRef.current  = null;
      // Reset delta-check refs so re-detection always rebuilds the pattern
      appliedArpModeRef.current  = null;
      appliedArpRateRef.current  = null;
      appliedArpRootRef.current  = null;
      appliedArpThirdRef.current = null;
      arpVoiceRef.current?.triggerRelease();
      if (hud?.arp?.current)    hud.arp.current.textContent    = 'OFF';
      if (hud?.arpVol?.current) hud.arpVol.current.textContent = '--';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTempo = useCallback((bpm) => {
    bpmRef.current = bpm;
    Tone.Transport.bpm.rampTo(bpm, 0.1);
  }, []);

  const setGlobalOctave = useCallback((val) => {
    globalOctaveRef.current = val;
  }, []);

  const setArpOctaveShift = useCallback((bool) => {
    arpOctaveShiftRef.current = bool;
    // Force the delta check to rebuild the pattern on the next frame
    appliedArpRootRef.current = null;
  }, []);

  const setInstrument = useCallback((name) => {
    instrumentNameRef.current = name;
    if (!isStartedRef.current || !analogVoicesRef.current) return;

    const newVoices = name === 'strings' ? stringsVoicesRef.current : analogVoicesRef.current;
    const oldVoices = activeVoicesRef.current;
    if (newVoices === oldVoices) return;

    oldVoices.forEach(v => v.volume.rampTo(VOICE_MUTE, 0.1));
    newVoices[0].volume.rampTo(VOICE_DB, 0.1);

    const root = currentRootRef.current;
    const semitones = [0, ST_MAJ3, ST_P5, ST_MIN7, 12, 12 + ST_MAJ3];
    for (let i = 0; i < newVoices.length; i++) {
      newVoices[i].frequency.rampTo(
        Tone.Frequency(root).transpose(semitones[i]).toFrequency(), 0.05
      );
    }

    activeVoicesRef.current = newVoices;
  }, []);

  const setOscType = useCallback((type) => {
    oscTypeRef.current = type;
    analogVoicesRef.current?.forEach(v => { v.oscillator.type = type; });
  }, []);

  const setScale = useCallback((key) => {
    scaleRef.current = SCALES[key];
  }, []);

  const setArpDelayTime = useCallback((subdivision) => {
    if (arpDelayRef.current) arpDelayRef.current.delayTime.value = subdivision;
  }, []);

  const setArpDelayMix = useCallback((value) => {
    if (arpDelayRef.current) arpDelayRef.current.wet.rampTo(value, 0.05);
  }, []);

  const setArpSpeedSnap = useCallback((bool) => {
    arpSpeedSnapRef.current = bool;
    appliedArpRateRef.current = null; // force interval reapply on next frame
  }, []);

  const setArpFx = useCallback((enabled) => {
    arpFxEnabledRef.current = enabled;
    if (!arpBypassGainRef.current) return;
    arpBypassGainRef.current.gain.rampTo(enabled ? 0 : 1, 0.05);
    arpFxGainRef.current.gain.rampTo(enabled ? 1 : 0, 0.05);
  }, []);

  const setArpInstrument = useCallback((name) => {
    arpInstrumentNameRef.current = name;
    if (!isStartedRef.current || !arpVolRef.current) return;
    const oldVoice = arpVoiceRef.current;
    const newVoice = makeArpVoice(name);
    applyArpDecay(newVoice, arpDecayRef.current);
    newVoice.connect(arpVolRef.current);
    arpVoiceRef.current = newVoice;
    oldVoice?.disconnect();
    oldVoice?.dispose();
  }, []);

  const setArpDecay = useCallback((value) => {
    arpDecayRef.current = value;
    applyArpDecay(arpVoiceRef.current, value);
  }, []);

  const setArpBaseVolume = useCallback((db) => {
    if (arpBaseVolRef.current) arpBaseVolRef.current.volume.rampTo(db, 0.1);
  }, []);

  const setArpReverb = useCallback((value) => {
    arpReverbWetRef.current = value;
    if (arpReverbRef.current) arpReverbRef.current.wet.rampTo(value, 0.1);
  }, []);

  return { startAudio, stopAudio, updateParams, setOscType, setScale, setInstrument, setTempo, setGlobalOctave, setArpOctaveShift, setArpFx, setArpDelayTime, setArpDelayMix, setArpSpeedSnap, setArpInstrument, setArpDecay, setArpBaseVolume, setArpReverb, volumeRef };
}
