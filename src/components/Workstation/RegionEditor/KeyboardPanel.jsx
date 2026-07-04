import { useEffect, useMemo, useRef } from 'react';
import styles from './InstrumentPanel.module.css';

/**
 * Playable 2-octave keyboard for the instrument tab, transposed by octaveBase
 * (a sliding window — the whole keyboard shifts, like a hardware controller).
 * Mouse only —
 * QWERTY input lives in InstrumentPanel (single listener for both panel
 * kinds). Pure presentation: audio + pressed-class work happens in the
 * parent's onNoteOn/onNoteOff, targeting the data-note attributes here.
 *
 * Mouse model mirrors the piano-roll key preview: down = attack, drag across
 * keys = glissando (release previous, attack entered), window mouseup =
 * release. The active mouse note is tracked separately from QWERTY holds.
 *
 * @param {number} octaveBase                 — octave whose keys show QWERTY letters
 * @param {(note: string) => void} onNoteOn
 * @param {(note: string) => void} onNoteOff
 * @param {Record<string,string>} hotkeys     — note → QWERTY letter
 */

const WHITE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// Black key sits after this white index within the octave (C#=0, D#=1, F#=3…).
const BLACKS = [{ n: 'C#', after: 0 }, { n: 'D#', after: 1 }, { n: 'F#', after: 3 }, { n: 'G#', after: 4 }, { n: 'A#', after: 5 }];

const N_WHITE = 15; // two octaves + top C
const WHITE_W = 100 / N_WHITE;
const BLACK_W = WHITE_W * 0.6;

// Geometry is a function of octaveBase so the keyboard transposes as a whole.
// `left` is positional (0/1 index within the span), independent of the octave.
const buildKeyboard = (octaveBase) => {
  const whites = [];
  const blacks = [];
  for (let oct = 0; oct < 2; oct++) {
    for (let i = 0; i < 7; i++) whites.push(`${WHITE[i]}${octaveBase + oct}`);
    for (const b of BLACKS) {
      blacks.push({
        note: `${b.n}${octaveBase + oct}`,
        left: (oct * 7 + b.after + 1) * WHITE_W - BLACK_W / 2,
      });
    }
  }
  whites.push(`C${octaveBase + 2}`);
  return { whites, blacks };
};

export default function KeyboardPanel({ octaveBase, onNoteOn, onNoteOff, hotkeys = {} }) {
  const mouseNoteRef = useRef(null);
  const KEYBOARD = useMemo(() => buildKeyboard(octaveBase), [octaveBase]);

  useEffect(() => {
    const up = () => {
      const n = mouseNoteRef.current;
      if (n) { mouseNoteRef.current = null; onNoteOff(n); }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [onNoteOff]);

  const down = (note) => (e) => {
    e.preventDefault(); // no text-selection drag
    mouseNoteRef.current = note;
    onNoteOn(note);
  };
  const enter = (note) => (e) => {
    if (e.buttons !== 1) return; // glissando only while held
    if (mouseNoteRef.current === note) return;
    if (mouseNoteRef.current) onNoteOff(mouseNoteRef.current);
    mouseNoteRef.current = note;
    onNoteOn(note);
  };

  // Show the QWERTY letter on any mapped key. `hotkeys` (= noteToKey) is
  // octave-qualified and built with the same octaveBase, so this stays correct
  // under the sliding window and covers the extended second-octave keys.
  const letterFor = (note) => hotkeys[note] ?? null;

  return (
    <div className={styles.kbd}>
      {KEYBOARD.whites.map(note => (
        <div
          key={note}
          data-note={note}
          className={styles.whiteKey}
          title={note}
          onMouseDown={down(note)}
          onMouseEnter={enter(note)}
        >
          {letterFor(note) && <span className={styles.keyLetter}>{letterFor(note)}</span>}
        </div>
      ))}
      {KEYBOARD.blacks.map(({ note, left }) => (
        <div
          key={note}
          data-note={note}
          className={styles.blackKey}
          style={{ left: `${left}%`, width: `${BLACK_W}%` }}
          title={note}
          onMouseDown={down(note)}
          onMouseEnter={enter(note)}
        >
          {letterFor(note) && <span className={styles.keyLetter}>{letterFor(note)}</span>}
        </div>
      ))}
    </div>
  );
}
