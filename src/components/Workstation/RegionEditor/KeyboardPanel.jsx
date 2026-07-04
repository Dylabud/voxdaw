import { useEffect, useRef } from 'react';
import styles from './InstrumentPanel.module.css';

/**
 * Playable 2-octave keyboard (C3–C5) for the instrument tab. Mouse only —
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

const LO_OCT = 3;
const N_WHITE = 15; // two octaves + top C
const WHITE_W = 100 / N_WHITE;
const BLACK_W = WHITE_W * 0.6;

const buildKeyboard = () => {
  const whites = [];
  const blacks = [];
  for (let oct = 0; oct < 2; oct++) {
    for (let i = 0; i < 7; i++) whites.push(`${WHITE[i]}${LO_OCT + oct}`);
    for (const b of BLACKS) {
      blacks.push({
        note: `${b.n}${LO_OCT + oct}`,
        left: (oct * 7 + b.after + 1) * WHITE_W - BLACK_W / 2,
      });
    }
  }
  whites.push(`C${LO_OCT + 2}`);
  return { whites, blacks };
};
const KEYBOARD = buildKeyboard();

export default function KeyboardPanel({ octaveBase, onNoteOn, onNoteOff, hotkeys = {} }) {
  const mouseNoteRef = useRef(null);

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

  const letterFor = (note) => (note.endsWith(String(octaveBase)) || note === `C${octaveBase + 1}` ? hotkeys[note] : null);

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
