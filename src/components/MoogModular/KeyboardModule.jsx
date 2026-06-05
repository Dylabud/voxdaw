import { useState, useEffect, useRef, useCallback } from 'react';
import { useMoogPatch } from './MoogPatchContext';
import styles from './KeyboardModule.module.css';

// ──────────── Key geometry ────────────
const WW = 28;  // white key width (px, box-sizing: border-box)
const BW = 17;  // black key width (px)
const WH = 116; // white key height (px)
const BH = 74;  // black key height (px)

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Semitone (0–11) → white key index within octave, null if black
const SEMI_WHITE = [0, null, 1, null, 2, 3, null, 4, null, 5, null, 6];
// Semitone (0–11) → black key left px from octave start (null if white)
// Formula: (nextWhiteIdx) × WW − BW/2, rounded
const SEMI_BLACK = [null, 19, null, 47, null, null, 103, null, 131, null, 159, null];

// Computer keyboard shortcut → note name (C4 octave + partial C5)
const KB_MAP = {
  a: 'C4', w: 'C#4', s: 'D4', e: 'D#4', d: 'E4',
  f: 'F4', t: 'F#4', g: 'G4', y: 'G#4', h: 'A4',
  u: 'A#4', j: 'B4', k: 'C5',
};

// Build key descriptors for C3–B5 (3 octaves = 21 white + 15 black keys)
function buildKeys() {
  const keys = [];
  let wCount = 0;
  for (let oct = 0; oct < 3; oct++) {
    const octNum = 3 + oct; // C3, C4, C5
    for (let semi = 0; semi < 12; semi++) {
      const name    = NOTE_NAMES[semi] + octNum;
      const midi    = (octNum + 1) * 12 + semi; // C3=48, C4=60
      const hz      = 440 * Math.pow(2, (midi - 69) / 12);
      const isBlack = SEMI_BLACK[semi] !== null;
      const left    = isBlack ? oct * 7 * WW + SEMI_BLACK[semi] : wCount * WW;
      if (!isBlack) wCount++;
      const shortcut = Object.entries(KB_MAP).find(([, n]) => n === name)?.[0] ?? null;
      keys.push({ name, hz, isBlack, left, shortcut });
    }
  }
  return { keys, totalWhiteWidth: wCount * WW };
}

const { keys: KEYS, totalWhiteWidth: TOTAL_W } = buildKeys();
const WHITE_KEYS = KEYS.filter(k => !k.isBlack);
const BLACK_KEYS = KEYS.filter(k => k.isBlack);

// Pre-build a key lookup by computer keyboard character
const KB_NOTE_MAP = Object.fromEntries(
  Object.entries(KB_MAP)
    .map(([char, name]) => [char, KEYS.find(k => k.name === name)])
    .filter(([, k]) => k)
);

// ──────────── Component ────────────

export default function KeyboardModule({ onUpdate }) {
  const { registerJack, unregisterJack, startDrag } = useMoogPatch();

  const [pressedNote, setPressedNote] = useState(null);
  const pressedNoteRef = useRef(null);
  const pressedHzRef   = useRef(null);

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

  // ── Mouse / touch note control ──

  // Single shared handler — reads note data from data attributes to avoid per-key closures
  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    const name = e.currentTarget.dataset.noteName;
    const hz   = parseFloat(e.currentTarget.dataset.noteHz);
    pressedNoteRef.current = name;
    pressedHzRef.current   = hz;
    setPressedNote(name);
    onUpdate?.(hz, true);
  }, [onUpdate]);

  // Window-level pointer-up releases the note even if the pointer leaves the key
  useEffect(() => {
    const release = () => {
      if (!pressedNoteRef.current) return;
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
      if (e.repeat) return;
      if (e.target.closest('input,textarea,select')) return;
      const noteData = KB_NOTE_MAP[e.key.toLowerCase()];
      if (!noteData || pressedNoteRef.current === noteData.name) return;
      pressedNoteRef.current = noteData.name;
      pressedHzRef.current   = noteData.hz;
      setPressedNote(noteData.name);
      onUpdate?.(noteData.hz, true);
    };
    const up = (e) => {
      const noteData = KB_NOTE_MAP[e.key.toLowerCase()];
      if (!noteData || pressedNoteRef.current !== noteData.name) return;
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
    <div className={styles.keyboard}>

      {/* ── Control strip — jacks + label ── */}
      <div className={styles.controlStrip}>
        <div className={styles.titleBlock}>
          <span className={styles.kbdModel}>953</span>
          <div className={styles.titleLines}>
            <span className={styles.kbdTitle}>KEYBOARD CONTROLLER</span>
            <span className={styles.kbdSub}>PITCH CV · GATE · 3 OCTAVES</span>
          </div>
        </div>

        <div className={styles.jackRow}>
          {/* PITCH jack */}
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
          {/* GATE jack */}
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
          {/* White keys */}
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

          {/* Black keys — absolutely positioned on top */}
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
