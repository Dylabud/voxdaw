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
];

// ── Arp constants ──────────────────────────────────────────────────────────────

const ARP_PATTERN_TYPE = {
  simple:        'upDown',
  complex:       'upDown',
  complexRandom: 'randomWalk',
  simpleRandom:  'random',
  octave:        'upDown',
};

const ARP_MODE_LABEL = {
  off:           'OFF',
  simple:        'SIMPLE',
  complex:       'COMPLEX',
  complexRandom: 'CMPLX RND',
  simpleRandom:  'SMP RND',
  octave:        'OCTAVE',
};

// Maps interval → held note duration (half the step for clean articulation)
const HOLD_MAP = { '4n': '8n', '8n': '16n', '16n': '32n' };

// middle | ring | pinky → mode string
function getArpMode(middleOut, ringOut, pinkyOut) {
  if (!middleOut && !pinkyOut) return 'off';
  if (!middleOut &&  pinkyOut) return 'octave';
  if ( middleOut && !ringOut && !pinkyOut) return 'simple';
  if ( middleOut &&  ringOut && !pinkyOut) return 'complex';
  if ( middleOut &&  ringOut &&  pinkyOut) return 'complexRandom';
  if ( middleOut && !ringOut &&  pinkyOut) return 'simpleRandom';
  return 'off';
}

// Builds a Tone.js note-string array (major triad intervals) relative to rootHz.
function buildArpNotes(rootHz, mode) {
  const root = Tone.Frequency(rootHz).toNote();
  const t = (n, st) => Tone.Frequency(n).transpose(st).toNote();
  switch (mode) {
    case 'simple':        return [root, t(root, 4), t(root, 7)];
    case 'complex':       return [root, t(root,4), t(root,7), t(root,12), t(root,16), t(root,19)];
    case 'complexRandom': return [root, t(root,4), t(root,7), t(root,12), t(root,16), t(root,19)];
    case 'simpleRandom':  return [root, t(root,4), t(root,7)];
    case 'octave':        return [root, t(root,12)];
    default:              return [root];
  }
}

// Maps absolute wrist tilt (degrees from vertical) → Tone.js interval string
function getArpRate(tiltDeg) {
  if (tiltDeg < 20) return '4n';
  if (tiltDeg < 60) return '8n';
  return '16n';
}

// ── Voice factories ────────────────────────────────────────────────────────────

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

export default function useAudioEngine(hudRefs) {
  const hudRefsRef = useRef(hudRefs);
  hudRefsRef.current = hudRefs;

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
  const isStartedRef      = useRef(false);
  const disposeTimerRef   = useRef(null);

  // Arp refs
  const arpVoiceRef   = useRef(null);
  const arpVolRef     = useRef(null);
  const arpPatternRef = useRef(null);
  const arpModeRef    = useRef('off');
  const arpRateRef    = useRef('8n');

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

      // Analog chord voices
      const analogVoices = [
        makeAnalogVoice(oscTypeRef.current),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
      ];

      // Strings chord voices
      const stringsVoices = [
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
      ];

      [...analogVoices, ...stringsVoices].forEach(v => v.connect(filter));

      // Arp voice — routes directly to Destination, fully independent of the
      // pinch-controlled master volume that governs the chord/filter chain.
      const arpVol = new Tone.Volume(6).toDestination();

      const arpVoice = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope:   { attack: 0.005, decay: 0.12, sustain: 0.3, release: 0.25 },
        volume:     0,
      });
      arpVoice.connect(arpVol);

      // Pattern always runs on the transport; gated by arpModeRef inside the callback.
      const arpPattern = new Tone.Pattern((time, note) => {
        if (arpModeRef.current === 'off') return;
        arpVoiceRef.current?.triggerAttackRelease(
          note,
          HOLD_MAP[arpRateRef.current] ?? '16n',
          time,
        );
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
      arpPatternRef.current    = arpPattern;

      activeVoicesRef.current = instrumentNameRef.current === 'strings'
        ? stringsVoices
        : analogVoices;

      const activeSet   = activeVoicesRef.current;
      const inactiveSet = activeSet === analogVoices ? stringsVoices : analogVoices;
      activeSet.forEach((v, i)   => v.triggerAttack(INIT_FREQS[i]));
      inactiveSet.forEach((v, i) => v.triggerAttack(INIT_FREQS[i]));
      activeSet[0].volume.value = VOICE_DB;

      Tone.Transport.bpm.value = 120;
      Tone.Transport.start();
    } else {
      // Re-engage: voices still alive (dispose timer was cleared)
      const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
      allVoices.forEach((v, i) => v.triggerAttack(INIT_FREQS[i % 4]));
      activeVoicesRef.current[0].volume.value = VOICE_DB;

      arpModeRef.current = 'off';
      Tone.Transport.start();
    }

    isStartedRef.current = true;
  }, []);

  const stopAudio = useCallback(() => {
    if (!isStartedRef.current || !analogVoicesRef.current) return;

    const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
    allVoices.forEach(v => v.triggerRelease());

    // Stop arp pattern immediately (before dispose timer)
    if (arpPatternRef.current) {
      arpPatternRef.current.mute = true;
      arpPatternRef.current.stop();
    }
    arpModeRef.current = 'off';
    Tone.Transport.stop();

    hudRefsRef.current?.pianoRoll?.current?.setNotes([]);
    isStartedRef.current = false;

    disposeTimerRef.current = setTimeout(() => {
      allVoices.forEach(v => v.dispose());
      arpPatternRef.current?.dispose();
      arpVoiceRef.current?.dispose();
      arpVolRef.current?.dispose();
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

    let pitchHandFound = false;

    for (let i = 0; i < landmarks.length; i++) {
      const hand = landmarks[i];
      const wrist    = hand[0];
      const thumbTip = hand[4];
      const indexTip = hand[8];
      const dist = calculateDistance(thumbTip, indexTip);

      const label = handednesses[i][0].categoryName;

      if (label === 'Left') {
        // ── RIGHT HAND: pitch + chord voicing + Z-filter + volume ──────
        pitchHandFound = true;

        const SAFE_TOP    = 0.15;
        const SAFE_BOTTOM = 0.7;
        const safeY    = Math.max(0, Math.min(1, (wrist.y - SAFE_TOP) / (SAFE_BOTTOM - SAFE_TOP)));
        const gridIdx  = Math.min(Math.floor(safeY * NOTE_GRID.length), NOTE_GRID.length - 1);
        const rawPitch = Tone.Frequency(NOTE_GRID[gridIdx].note).toFrequency();
        const root     = snapToNearest(rawPitch, scaleRef.current);
        currentRootRef.current = root;

        const midMCP   = hand[9];
        const handSize = calculateDistance2D(wrist, midMCP);
        const cutoff   = mapRange(handSize, 0.08, 0.35, 400, 10000);
        filterRef.current.frequency.rampTo(cutoff, 0.05);

        const normalizedPinch = calculateDistance2D(thumbTip, indexTip) / handSize;
        const db = mapRange(normalizedPinch, 0.2, 1.2, -40, 0);
        volumeRef.current.volume.rampTo(db, 0.05);

        const arpActive = arpModeRef.current !== 'off';

        // ── Chord gate logic (always runs — arp layers on top) ──────────
        const middleUp = isFingerExtended(hand, 12, 9);
        const ringUp   = isFingerExtended(hand, 16, 13);
        const pinkyUp  = isFingerExtended(hand, 20, 17);

        const thirdST   = ringUp ? ST_MAJ3 : ST_MIN3;
        const seventhST = ringUp ? ST_MAJ7 : ST_MIN7;

        const thirdFreq   = Tone.Frequency(root).transpose(thirdST).toFrequency();
        const fifthFreq   = Tone.Frequency(root).transpose(ST_P5).toFrequency();
        const seventhFreq = Tone.Frequency(root).transpose(seventhST).toFrequency();

        voices[0].frequency.rampTo(root, 0.05);

        if (middleUp) {
          voices[1].frequency.rampTo(thirdFreq, 0.05);
          voices[2].frequency.rampTo(fifthFreq, 0.05);
          voices[1].volume.rampTo(VOICE_DB, 0.05);
          voices[2].volume.rampTo(VOICE_DB, 0.05);
        } else {
          voices[1].volume.rampTo(VOICE_MUTE, 0.05);
          voices[2].volume.rampTo(VOICE_MUTE, 0.05);
        }

        voices[3].frequency.rampTo(seventhFreq, 0.05);
        voices[3].volume.rampTo(pinkyUp ? VOICE_DB : VOICE_MUTE, 0.05);

        let chordName;
        if      (!middleUp && !pinkyUp)             chordName = 'ROOT';
        else if (!middleUp &&  pinkyUp)             chordName = 'ROOT+7';
        else if ( middleUp && !ringUp  && !pinkyUp) chordName = 'MIN';
        else if ( middleUp &&  ringUp  && !pinkyUp) chordName = 'MAJ';
        else if ( middleUp && !ringUp  &&  pinkyUp) chordName = 'MIN 7';
        else                                        chordName = 'MAJ 7';

        if (hud?.chord?.current)
          hud.chord.current.textContent = chordName;

        const activeNoteNames = [normalizeNote(Tone.Frequency(root).toNote())];
        if (middleUp) {
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(thirdST).toNote()));
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(ST_P5).toNote()));
        }
        if (pinkyUp) {
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(seventhST).toNote()));
        }
        hud?.pianoRoll?.current?.setNotes(activeNoteNames);

        // Update arp pattern root in real time (no-op when muted)
        if (arpActive) {
          const pat = arpPatternRef.current;
          if (pat) pat.values = buildArpNotes(root, arpModeRef.current);
        }

        if (hud?.pitch?.current)
          hud.pitch.current.textContent = `${Math.round(root)} Hz`;
        if (hud?.filter?.current)
          hud.filter.current.textContent = `${Math.round(cutoff)} Hz`;
        if (hud?.velocity?.current)
          hud.velocity.current.textContent = `${Math.round(mapRange(normalizedPinch, 0.2, 1.2, 0, 100))}%`;

      } else {
        // ── LEFT HAND: reverb + vibrato + arp control ───────────────────

        const wet   = mapRange(dist, 0.03, 0.20, 0, 1);
        const depth = mapRange(wrist.y, 0, 1, 0.8, 0);
        reverbRef.current.wet.rampTo(wet, 0.05);
        vibratoRef.current.depth.rampTo(depth, 0.05);

        // Hand size on the arp hand — normalizes spread against camera distance
        const arpHandSize = calculateDistance2D(wrist, hand[9]);

        // Arp mode (rotation-robust finger detection)
        const { middleOut, ringOut, pinkyOut } = getArpFingerStates(hand);
        const mode     = getArpMode(middleOut, ringOut, pinkyOut);
        const tilt     = getWristTiltDeg(hand);
        const rate     = getArpRate(tilt);
        const prevMode = arpModeRef.current;

        arpRateRef.current = rate;

        const pat = arpPatternRef.current;
        let spreadDb = 3;
        if (mode !== 'off') {
          spreadDb = getArpSpreadDb(hand, { middleOut, ringOut, pinkyOut }, arpHandSize);
          arpVolRef.current?.volume.rampTo(spreadDb, 0.05);
          if (pat) {
            pat.values   = buildArpNotes(currentRootRef.current, mode);
            pat.pattern  = ARP_PATTERN_TYPE[mode];
            pat.interval = rate;
          }
        }
        arpModeRef.current = mode;

        if (hud?.reverb?.current)
          hud.reverb.current.textContent = `${Math.round(wet * 100)}%`;
        if (hud?.vibrato?.current)
          hud.vibrato.current.textContent = `${Math.round(depth * 100)}%`;
        if (hud?.arp?.current)
          hud.arp.current.textContent = mode === 'off'
            ? 'OFF'
            : `${ARP_MODE_LABEL[mode]} ${rate}`;
        if (hud?.arpVol?.current)
          hud.arpVol.current.textContent = mode === 'off'
            ? '--'
            : `${Math.round(spreadDb)} dB`;
      }
    }

    if (!pitchHandFound) hud?.pianoRoll?.current?.setNotes([]);
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
    newVoices[0].frequency.rampTo(root, 0.05);
    newVoices[1].frequency.rampTo(Tone.Frequency(root).transpose(ST_MAJ3).toFrequency(), 0.05);
    newVoices[2].frequency.rampTo(Tone.Frequency(root).transpose(ST_P5).toFrequency(), 0.05);
    newVoices[3].frequency.rampTo(Tone.Frequency(root).transpose(ST_MIN7).toFrequency(), 0.05);

    activeVoicesRef.current = newVoices;
  }, []);

  const setOscType = useCallback((type) => {
    oscTypeRef.current = type;
    analogVoicesRef.current?.forEach(v => { v.oscillator.type = type; });
  }, []);

  const setScale = useCallback((key) => {
    scaleRef.current = SCALES[key];
  }, []);

  return { startAudio, stopAudio, updateParams, setOscType, setScale, setInstrument, volumeRef };
}
