import { useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { calculateDistance, calculateDistance2D, mapRange, snapToNearest, isFingerExtended, normalizeNote } from '../utils/dsp';
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

function makeAnalogVoice(oscType, initDb = VOICE_DB) {
  return new Tone.Synth({
    oscillator: { type: oscType },
    envelope:   { attack: 0.02, decay: 0, sustain: 1, release: 0.5 },
    volume:     initDb,
  });
}

function makeStringsVoice(initDb = VOICE_DB) {
  return new Tone.FMSynth({
    harmonicity:        1,   // modulator at fundamental — harmonic, not metallic
    modulationIndex:    1.5, // minimal phase scrape → rosin friction, not FM laser
    oscillator:         { type: 'sawtooth' }, // Helmholtz slip-stick waveform
    modulation:         { type: 'sine' },
    envelope:           { attack: 0.4, decay: 0.2, sustain: 0.8, release: 1.2 },
    modulationEnvelope: { attack: 0.6, decay: 0.2, sustain: 0.5, release: 1.2 },
    volume:             initDb,
  });
}

export default function useAudioEngine(hudRefs) {
  const hudRefsRef = useRef(hudRefs);
  hudRefsRef.current = hudRefs;

  const analogVoicesRef  = useRef(null); // [root, 3rd, 5th, 7th] — Tone.Synth
  const stringsVoicesRef = useRef(null); // [root, 3rd, 5th, 7th] — Tone.FMSynth
  const activeVoicesRef  = useRef(null); // points to the active set
  const filterRef        = useRef(null);
  const vibratoRef       = useRef(null);
  const reverbRef        = useRef(null);
  const volumeRef        = useRef(null);
  const oscTypeRef       = useRef('sine');
  const scaleRef         = useRef(SCALES.cMajor);
  const instrumentNameRef = useRef('analog');
  const currentRootRef   = useRef(440);
  const isStartedRef     = useRef(false);
  const disposeTimerRef  = useRef(null);

  const startAudio = useCallback(async () => {
    if (disposeTimerRef.current !== null) {
      clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }

    await Tone.start();

    if (!analogVoicesRef.current) {
      // Shared effects chain — all voices from both instruments sum at the filter input
      const vol = new Tone.Volume(-6).toDestination();

      const reverb = new Tone.Reverb({ decay: 3, wet: 0 });
      await reverb.generate();
      reverb.connect(vol);

      const vibrato = new Tone.Vibrato({ frequency: 5, depth: 0, wet: 1 });
      vibrato.connect(reverb);

      const filter = new Tone.Filter({ frequency: 5000, type: 'lowpass', rolloff: -24 });
      filter.connect(vibrato);

      // Analog: root at VOICE_DB, harmonics muted (chord-gated)
      const analogVoices = [
        makeAnalogVoice(oscTypeRef.current),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
        makeAnalogVoice(oscTypeRef.current, VOICE_MUTE),
      ];

      // Strings: all muted until instrument is switched to (analog is default)
      const stringsVoices = [
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
        makeStringsVoice(VOICE_MUTE),
      ];

      [...analogVoices, ...stringsVoices].forEach(v => v.connect(filter));

      filterRef.current        = filter;
      vibratoRef.current       = vibrato;
      reverbRef.current        = reverb;
      volumeRef.current        = vol;
      analogVoicesRef.current  = analogVoices;
      stringsVoicesRef.current = stringsVoices;

      // Set active set from cached instrument choice
      activeVoicesRef.current = instrumentNameRef.current === 'strings'
        ? stringsVoices
        : analogVoices;

      // Prime all 8 voices — envelopes are initialised, only volume determines audibility
      const activeSet   = activeVoicesRef.current;
      const inactiveSet = activeSet === analogVoices ? stringsVoices : analogVoices;
      activeSet.forEach((v, i)   => v.triggerAttack(INIT_FREQS[i]));
      inactiveSet.forEach((v, i) => v.triggerAttack(INIT_FREQS[i]));

      // Root of the active set is the only audible voice on startup
      activeSet[0].volume.value = VOICE_DB;
    } else {
      // Re-engage: re-trigger all voices at startup frequencies
      const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
      allVoices.forEach((v, i) => v.triggerAttack(INIT_FREQS[i % 4]));
      activeVoicesRef.current[0].volume.value = VOICE_DB;
    }

    isStartedRef.current = true;
  }, []);

  const stopAudio = useCallback(() => {
    if (!isStartedRef.current || !analogVoicesRef.current) return;
    const allVoices = [...analogVoicesRef.current, ...stringsVoicesRef.current];
    allVoices.forEach(v => v.triggerRelease());
    hudRefsRef.current?.pianoRoll?.current?.setNotes([]);
    isStartedRef.current = false;

    // 1600ms allows the strings 1.2s release to fully complete before disposal
    disposeTimerRef.current = setTimeout(() => {
      allVoices.forEach(v => v.dispose());
      filterRef.current?.dispose();
      vibratoRef.current?.dispose();
      reverbRef.current?.dispose();
      volumeRef.current?.dispose();
      analogVoicesRef.current  = null;
      stringsVoicesRef.current = null;
      activeVoicesRef.current  = null;
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

      // CSS scaleX(-1) mirrors the display; MediaPipe reads the raw frame.
      // User's right hand is on the LEFT in the raw frame → MediaPipe labels "Left".
      const label = handednesses[i][0].categoryName;

      if (label === 'Left') {
        pitchHandFound = true;

        // ── RIGHT HAND: pitch + cascading chord voicing + Z-filter + volume ──
        // Safe zone [0.15, 0.7]: bottom tightened (was 0.85) because the user's
        // wrist physically tops out around y≈0.74 — anything beyond is unreachable.
        // 0.7 puts C3 (idx 24) at wrist.y≈0.7 with margin to spare.
        const SAFE_TOP    = 0.15;
        const SAFE_BOTTOM = 0.7;
        const safeY    = Math.max(0, Math.min(1, (wrist.y - SAFE_TOP) / (SAFE_BOTTOM - SAFE_TOP)));
        const gridIdx  = Math.min(Math.floor(safeY * NOTE_GRID.length), NOTE_GRID.length - 1);
        const rawPitch = Tone.Frequency(NOTE_GRID[gridIdx].note).toFrequency();
        const root     = snapToNearest(rawPitch, scaleRef.current);
        currentRootRef.current = root;

        // Optical depth: wrist→midMCP 2D distance grows as hand nears camera
        const midMCP   = hand[9];
        const handSize = calculateDistance2D(wrist, midMCP);
        const cutoff   = mapRange(handSize, 0.08, 0.35, 400, 10000);
        filterRef.current.frequency.rampTo(cutoff, 0.05);

        // Normalize pinch by hand size so velocity is stable at any distance
        const normalizedPinch = calculateDistance2D(thumbTip, indexTip) / handSize;
        const db = mapRange(normalizedPinch, 0.2, 1.2, -40, 0);
        volumeRef.current.volume.rampTo(db, 0.05);

        // ── Cascading chord gates ──────────────────────────────────────
        // MCP landmark pairs: middle=12/9, ring=16/13, pinky=20/17
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

        if (hud?.pitch?.current)
          hud.pitch.current.textContent = `${Math.round(root)} Hz`;
        if (hud?.filter?.current)
          hud.filter.current.textContent = `${Math.round(cutoff)} Hz`;
        if (hud?.velocity?.current)
          hud.velocity.current.textContent = `${Math.round(mapRange(normalizedPinch, 0.2, 1.2, 0, 100))}%`;
        if (hud?.chord?.current)
          hud.chord.current.textContent = chordName;

        // ── Piano roll note names ──────────────────────────────────────
        const activeNoteNames = [normalizeNote(Tone.Frequency(root).toNote())];
        if (middleUp) {
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(thirdST).toNote()));
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(ST_P5).toNote()));
        }
        if (pinkyUp) {
          activeNoteNames.push(normalizeNote(Tone.Frequency(root).transpose(seventhST).toNote()));
        }
        hud?.pianoRoll?.current?.setNotes(activeNoteNames);

      } else {
        // ── LEFT HAND: reverb wet + vibrato depth ───────────────────────
        const wet   = mapRange(dist, 0.03, 0.20, 0, 1);
        const depth = mapRange(wrist.y, 0, 1, 0.8, 0);
        reverbRef.current.wet.rampTo(wet, 0.05);
        vibratoRef.current.depth.rampTo(depth, 0.05);

        if (hud?.reverb?.current)
          hud.reverb.current.textContent = `${Math.round(wet * 100)}%`;
        if (hud?.vibrato?.current)
          hud.vibrato.current.textContent = `${Math.round(depth * 100)}%`;
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

    // Crossfade: mute outgoing set, unmute root of incoming set
    oldVoices.forEach(v => v.volume.rampTo(VOICE_MUTE, 0.1));
    newVoices[0].volume.rampTo(VOICE_DB, 0.1);
    // Voices 1–3 of the new set will be gated correctly by the next rAF frame

    // Snap frequencies of the incoming set to the current root immediately
    const root = currentRootRef.current;
    newVoices[0].frequency.rampTo(root, 0.05);
    newVoices[1].frequency.rampTo(Tone.Frequency(root).transpose(ST_MAJ3).toFrequency(), 0.05);
    newVoices[2].frequency.rampTo(Tone.Frequency(root).transpose(ST_P5).toFrequency(), 0.05);
    newVoices[3].frequency.rampTo(Tone.Frequency(root).transpose(ST_MIN7).toFrequency(), 0.05);

    activeVoicesRef.current = newVoices;
  }, []);

  const setOscType = useCallback((type) => {
    oscTypeRef.current = type;
    // Only applies to analog voices — FMSynth strings use a fixed preset
    analogVoicesRef.current?.forEach(v => { v.oscillator.type = type; });
  }, []);

  const setScale = useCallback((key) => {
    scaleRef.current = SCALES[key];
  }, []);

  return { startAudio, stopAudio, updateParams, setOscType, setScale, setInstrument, volumeRef };
}
