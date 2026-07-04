import { useState, useEffect, useRef, useCallback } from 'react';
import { useMoogPatch } from './MoogPatchContext';
import MoogKnob from './MoogKnob';
import styles from './KeyboardModule.module.css';

// ──────────── Key geometry ────────────
const WW = 20;  // white key width (px, box-sizing: border-box) — narrower to fit 61 keys
const BW = 12;  // black key width (px)
const WH = 116; // white key height (px)
const BH = 74;  // black key height (px)

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Semitone (0–11) → black key left px from octave start (null if white)
// Formula: nextWhiteIdx × WW − BW/2  (WW=20, BW=12 → BW/2=6)
const SEMI_BLACK = [null, 14, null, 34, null, null, 74, null, 94, null, 114, null];

// Computer keyboard shortcut → note name (C4 octave + partial C5)
const KB_MAP = {
  a: 'C4', w: 'C#4', s: 'D4', e: 'D#4', d: 'E4',
  f: 'F4', t: 'F#4', g: 'G4', y: 'G#4', h: 'A4',
  u: 'A#4', j: 'B4', k: 'C5',
};

// Build key descriptors for C2–C7 (5 octaves + top C = 61 keys: 36 white + 25 black)
function buildKeys() {
  const keys = [];
  let wCount = 0;
  for (let oct = 0; oct < 5; oct++) {
    const octNum = 2 + oct; // C2 → B6
    for (let semi = 0; semi < 12; semi++) {
      const name    = NOTE_NAMES[semi] + octNum;
      const midi    = (octNum + 1) * 12 + semi;
      const hz      = 440 * Math.pow(2, (midi - 69) / 12);
      const isBlack = SEMI_BLACK[semi] !== null;
      const left    = isBlack ? oct * 7 * WW + SEMI_BLACK[semi] : wCount * WW;
      if (!isBlack) wCount++;
      const shortcut = Object.entries(KB_MAP).find(([, n]) => n === name)?.[0] ?? null;
      keys.push({ name, hz, isBlack, left, shortcut });
    }
  }
  // 61st key — top C7
  const topMidi = 8 * 12; // C7 = MIDI 96
  const topHz   = 440 * Math.pow(2, (topMidi - 69) / 12);
  keys.push({ name: 'C7', hz: topHz, isBlack: false, left: wCount * WW, shortcut: null });
  wCount++;
  return { keys, totalWhiteWidth: wCount * WW };
}

const { keys: KEYS, totalWhiteWidth: TOTAL_W } = buildKeys();
const WHITE_KEYS = KEYS.filter(k => !k.isBlack);
const BLACK_KEYS = KEYS.filter(k => k.isBlack);

const KB_NOTE_MAP = Object.fromEntries(
  Object.entries(KB_MAP)
    .map(([char, name]) => [char, KEYS.find(k => k.name === name)])
    .filter(([, k]) => k)
);

// ──────────── Component ────────────

export default function KeyboardModule({ onUpdate, onGlideChange, onVibratoChange }) {
  const { registerJack, unregisterJack, startDrag } = useMoogPatch();

  const [pressedNote, setPressedNote] = useState(null);
  const [glide,       setGlide]       = useState(0);
  const [vibrato,      setVibrato]      = useState(0);
  const [vibratoRate,  setVibratoRate]  = useState(0.57); // 0–1 → 0.5–10 Hz; default ≈ 5 Hz
  const [vibratoDelay, setVibratoDelay] = useState(0); // 0–1 → 0–4 s ramp time
  const rootRef           = useRef(null);   // page-visibility guard for the window key listeners
  const pressedNoteRef    = useRef(null);
  const pressedHzRef      = useRef(null);
  // Tracks whether the currently active note was triggered by pointer (vs MIDI),
  // so pointerup doesn't accidentally cancel a held MIDI note.
  const pressedByMouseRef = useRef(false);

  // ── MIDI state ──
  const [midiConnected, setMidiConnected] = useState(false);
  const midiConnectedRef = useRef(false);   // mirror for timeout callbacks (stale-closure safe)
  const midiLedRef       = useRef(null);    // DOM ref for direct LED mutation
  const midiFlashRef     = useRef(null);    // timeout ID for flash decay
  // Mono-legato stack: holds MIDI note numbers currently pressed on the physical keyboard.
  // Last element = currently sounding note; on note-off the previous note is restored.
  const heldMidiNotesRef = useRef([]);

  // Stable ref so MIDI listener never needs to be re-attached when onUpdate identity changes.
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);

  // Propagate glide to audio engine (0-1 knob → 0-1.5s, matching sequencer mapping)
  useEffect(() => { onGlideChange?.(glide * 1.5); }, [glide, onGlideChange]);

  // Propagate vibrato params: depth 0–20 Hz, rate 0.5–10 Hz, delay 0–4 s
  useEffect(() => {
    onVibratoChange?.({ depth: vibrato * 20, rate: 0.5 + vibratoRate * 9.5, delay: vibratoDelay * 4 });
  }, [vibrato, vibratoRate, vibratoDelay, onVibratoChange]);

  const pitchJackRef = useRef(null);
  const gateJackRef  = useRef(null);

  // Register keyboard jacks in the patch context
  useEffect(() => {
    registerJack('kbd-pitch-out', pitchJackRef.current);
    registerJack('kbd-gate-out',  gateJackRef.current);
    return () => {
      unregisterJack('kbd-pitch-out');
      unregisterJack('kbd-gate-out');
    };
  }, [registerJack, unregisterJack]);

  // ── MIDI LED: sync base appearance when connection state changes ──
  useEffect(() => {
    midiConnectedRef.current = midiConnected;
    const el = midiLedRef.current;
    if (!el) return;
    if (midiConnected) {
      el.style.background = 'rgba(93, 202, 165, 0.40)';
      el.style.boxShadow  = '0 0 4px rgba(93, 202, 165, 0.55)';
    } else {
      el.style.background = 'rgba(93, 202, 165, 0.10)';
      el.style.boxShadow  = 'none';
    }
  }, [midiConnected]);

  // Brief LED flash on note-on events — direct DOM write, no React state
  const flashMidiLed = useCallback(() => {
    const el = midiLedRef.current;
    if (!el) return;
    el.style.background = '#5DCAA5';
    el.style.boxShadow  = '0 0 6px #5DCAA5, 0 0 2px rgba(93,202,165,0.9)';
    clearTimeout(midiFlashRef.current);
    midiFlashRef.current = setTimeout(() => {
      if (!midiLedRef.current) return;
      const connected = midiConnectedRef.current;
      midiLedRef.current.style.background = connected ? 'rgba(93,202,165,0.40)' : 'rgba(93,202,165,0.10)';
      midiLedRef.current.style.boxShadow  = connected ? '0 0 4px rgba(93,202,165,0.55)' : 'none';
    }, 80);
  }, []);

  // ── MIDI message handler (mono legato) ──
  const handleMidiMessage = useCallback((event) => {
    const [status, note, velocity] = event.data;
    const type = status & 0xF0; // strip channel nibble

    if (type === 0x90 && velocity > 0) {
      // Note On
      const hz   = 440 * Math.pow(2, (note - 69) / 12);
      const name = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
      heldMidiNotesRef.current = [...heldMidiNotesRef.current.filter(n => n !== note), note];
      pressedByMouseRef.current = false;
      pressedNoteRef.current = name;
      pressedHzRef.current   = hz;
      setPressedNote(name);
      onUpdateRef.current?.(hz, true);
      flashMidiLed();

    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      // Note Off
      heldMidiNotesRef.current = heldMidiNotesRef.current.filter(n => n !== note);
      const name = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);

      // Only act if this note was actually sounding
      if (pressedNoteRef.current === name) {
        if (heldMidiNotesRef.current.length > 0) {
          // Legato: restore the most recently pressed remaining note
          const last     = heldMidiNotesRef.current[heldMidiNotesRef.current.length - 1];
          const lastHz   = 440 * Math.pow(2, (last - 69) / 12);
          const lastName = NOTE_NAMES[last % 12] + (Math.floor(last / 12) - 1);
          pressedNoteRef.current = lastName;
          pressedHzRef.current   = lastHz;
          setPressedNote(lastName);
          onUpdateRef.current?.(lastHz, true);
        } else {
          // All notes released
          const relHz = pressedHzRef.current ?? 220;
          pressedNoteRef.current = null;
          pressedHzRef.current   = null;
          setPressedNote(null);
          onUpdateRef.current?.(relHz, false);
        }
      }
    }
  }, [flashMidiLed]);

  // ── Web MIDI API setup ──
  useEffect(() => {
    if (!navigator.requestMIDIAccess) return; // graceful degrade — mouse/keyboard still work

    let midiAccess = null;
    let cancelled  = false;

    const attach = (input) => { input.onmidimessage = handleMidiMessage; };
    const detach = (input) => { input.onmidimessage = null; };

    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      if (cancelled) return;
      midiAccess = access;
      for (const input of access.inputs.values()) attach(input);
      setMidiConnected(access.inputs.size > 0);

      access.onstatechange = (e) => {
        if (cancelled || e.port.type !== 'input') return;
        if (e.port.state === 'connected') {
          attach(e.port);
          setMidiConnected(true);
        } else {
          detach(e.port);
          setMidiConnected([...access.inputs.values()].some(i => i.state === 'connected'));
        }
      };
    }).catch(() => {}); // permission denied or unsupported — silent degrade

    return () => {
      cancelled = true;
      clearTimeout(midiFlashRef.current);
      if (midiAccess) {
        for (const input of midiAccess.inputs.values()) detach(input);
        midiAccess.onstatechange = null;
      }
    };
  }, [handleMidiMessage]);

  // ── Mouse / touch note control ──

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    const name = e.currentTarget.dataset.noteName;
    const hz   = parseFloat(e.currentTarget.dataset.noteHz);
    pressedByMouseRef.current = true;
    pressedNoteRef.current = name;
    pressedHzRef.current   = hz;
    setPressedNote(name);
    onUpdate?.(hz, true);
  }, [onUpdate]);

  // Window-level pointer-up — guarded so it won't cancel a MIDI-held note
  useEffect(() => {
    const release = () => {
      if (!pressedNoteRef.current || !pressedByMouseRef.current) return;
      pressedByMouseRef.current = false;
      const hz = pressedHzRef.current ?? 220;
      pressedNoteRef.current = null;
      pressedHzRef.current   = null;
      setPressedNote(null);
      onUpdate?.(hz, false);
    };
    window.addEventListener('pointerup', release);
    return () => window.removeEventListener('pointerup', release);
  }, [onUpdate]);

  // ── Computer keyboard note control ──

  useEffect(() => {
    const down = (e) => {
      // Root keeps visited pages mounted under display:none — don't play the
      // hidden Moog while typing on another page (offsetParent is null under
      // a display:none ancestor; the module is never position:fixed).
      if (rootRef.current?.offsetParent === null) return;
      if (e.repeat) return;
      if (e.target.closest('input,textarea,select')) return;
      const noteData = KB_NOTE_MAP[e.key.toLowerCase()];
      if (!noteData || pressedNoteRef.current === noteData.name) return;
      pressedByMouseRef.current = true;
      pressedNoteRef.current = noteData.name;
      pressedHzRef.current   = noteData.hz;
      setPressedNote(noteData.name);
      onUpdate?.(noteData.hz, true);
    };
    const up = (e) => {
      if (rootRef.current?.offsetParent === null) return;
      const noteData = KB_NOTE_MAP[e.key.toLowerCase()];
      if (!noteData || pressedNoteRef.current !== noteData.name) return;
      pressedByMouseRef.current = false;
      pressedNoteRef.current = null;
      pressedHzRef.current   = null;
      setPressedNote(null);
      onUpdate?.(noteData.hz, false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup',   up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup',   up);
    };
  }, [onUpdate]);

  return (
    <div ref={rootRef} className={styles.keyboard}>

      {/* ── Control strip — jacks + label ── */}
      <div className={styles.controlStrip}>
        <div className={styles.titleBlock}>
          <span className={styles.kbdModel}>953</span>
          <div className={styles.titleLines}>
            <span className={styles.kbdTitle}>KEYBOARD CONTROLLER</span>
            <span className={styles.kbdSub}>PITCH CV · GATE · 5 OCTAVES · 61 KEYS</span>
          </div>
        </div>

        {/* MIDI LINK indicator — blinks on incoming note events, steady when connected */}
        <div className={styles.midiLinkGroup}>
          <div ref={midiLedRef} className={styles.midiLed} />
          <span className={styles.midiLinkLabel}>MIDI</span>
        </div>

        <div className={styles.jackRow}>
          <div className={styles.jackGroup}>
            <div
              ref={pitchJackRef}
              className={styles.jack}
              data-jack-id="kbd-pitch-out"
              style={{ cursor: 'crosshair' }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startDrag('kbd-pitch-out'); }}
            />
            <span className={styles.jackLabel}>PITCH</span>
          </div>
          <div className={styles.jackGroup}>
            <div
              ref={gateJackRef}
              className={styles.jack}
              data-jack-id="kbd-gate-out"
              style={{ cursor: 'crosshair' }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startDrag('kbd-gate-out'); }}
            />
            <span className={styles.jackLabel}>GATE</span>
          </div>
        </div>

        <MoogKnob
          label="GLIDE"
          size="sm"
          value={glide}
          onChange={setGlide}
          defaultValue={0}
        />

        <MoogKnob
          label="VIBRATO"
          size="sm"
          value={vibrato}
          onChange={setVibrato}
          defaultValue={0}
        />

        <MoogKnob
          label="VIB RATE"
          size="sm"
          value={vibratoRate}
          onChange={setVibratoRate}
          defaultValue={0.57}
        />

        <MoogKnob
          label="VIB DLY"
          size="sm"
          value={vibratoDelay}
          onChange={setVibratoDelay}
          defaultValue={0}
        />

        <div className={styles.kbdHint}>
          <span className={styles.kbdHintText}>A–K · W E T Y U · computer keys play C4–C5</span>
        </div>
      </div>

      {/* ── Key area ── */}
      <div className={styles.keyArea}>
        <div
          className={styles.keyBed}
          style={{ width: TOTAL_W, height: WH }}
        >
          {WHITE_KEYS.map(k => (
            <div
              key={k.name}
              className={`${styles.whiteKey}${pressedNote === k.name ? ` ${styles.keyPressed}` : ''}`}
              data-note-name={k.name}
              data-note-hz={k.hz}
              onPointerDown={handlePointerDown}
            >
              {k.shortcut && (
                <span className={styles.keyShortcut}>{k.shortcut.toUpperCase()}</span>
              )}
              {k.name.startsWith('C') && (
                <span className={styles.keyNote}>{k.name}</span>
              )}
            </div>
          ))}

          {BLACK_KEYS.map(k => (
            <div
              key={k.name}
              className={`${styles.blackKey}${pressedNote === k.name ? ` ${styles.keyPressed}` : ''}`}
              style={{ left: k.left, width: BW, height: BH }}
              data-note-name={k.name}
              data-note-hz={k.hz}
              onPointerDown={handlePointerDown}
            />
          ))}
        </div>
      </div>

    </div>
  );
}
