import { forwardRef, useImperativeHandle, useRef } from 'react';
import { NOTE_GRID } from '../../utils/scales';
import styles from './PianoRoll.module.css';

// ── Key layout derived from NOTE_GRID (C5 → C3) ──────────────────────────
const WHITE_KEY_COUNT = NOTE_GRID.filter(k => !k.isBlack).length; // 15
const BLACK_KEY_HEIGHT_PCT = 0.6 / WHITE_KEY_COUNT * 100;

const WHITE_KEYS     = [];
const BLACK_KEY_DATA = [];
let whiteCount = 0;

NOTE_GRID.forEach(({ note, isBlack }) => {
  if (!isBlack) {
    WHITE_KEYS.push(note);
    whiteCount++;
  } else {
    // Black key sits 70% of the way into the white key above it
    const topPct = ((whiteCount - 1) + 0.7) / WHITE_KEY_COUNT * 100;
    BLACK_KEY_DATA.push({ note, topPct });
  }
});

// ── Component ─────────────────────────────────────────────────────────────
const PianoRoll = forwardRef(function PianoRoll(_, ref) {
  const keyMapRef    = useRef(new Map());
  const activeSetRef = useRef(new Set());

  useImperativeHandle(ref, () => ({
    setNotes(noteNames) {
      const next = new Set(noteNames);
      const prev = activeSetRef.current;
      const map  = keyMapRef.current;
      for (const n of prev) { if (!next.has(n)) map.get(n)?.classList.remove(styles.active); }
      for (const n of next) { if (!prev.has(n)) map.get(n)?.classList.add(styles.active); }
      activeSetRef.current = next;
    },
  }), []);

  const setKeyRef = (note) => (el) => {
    if (el) keyMapRef.current.set(note, el);
  };

  return (
    <div className={styles.pianoRoll}>
      <div className={styles.whiteKeys}>
        {WHITE_KEYS.map((note) => (
          <div key={note} ref={setKeyRef(note)} className={styles.whiteKey} />
        ))}
      </div>
      <div className={styles.blackKeys}>
        {BLACK_KEY_DATA.map(({ note, topPct }) => (
          <div
            key={note}
            ref={setKeyRef(note)}
            className={styles.blackKey}
            style={{ top: `${topPct}%`, height: `${BLACK_KEY_HEIGHT_PCT}%` }}
          />
        ))}
      </div>
    </div>
  );
});

export default PianoRoll;
