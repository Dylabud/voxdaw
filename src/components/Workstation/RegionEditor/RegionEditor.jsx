import styles from './RegionEditor.module.css';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK = new Set(['C#','D#','F#','G#','A#']);

// Build keys top-down (high → low) so the visual matches a vertical piano roll.
function buildKeys(loOct, hiOct) {
  const keys = [];
  for (let oct = hiOct; oct >= loOct; oct--) {
    for (let i = 11; i >= 0; i--) {
      const name = NOTE_NAMES[i];
      keys.push({
        name: `${name}${oct}`,
        label: name === 'C' ? `C${oct}` : '',
        black: BLACK.has(name),
      });
    }
  }
  return keys;
}
const KEYS = buildKeys(1, 6); // C1..C6 → 72 keys
const KEY_H = 18;
const PIANO_ROLL_H = KEYS.length * KEY_H;

const INSTRUMENTS = [
  'fm pluck',
  'analog',
  'strings',
  'am',
  'pluck',
];

export default function RegionEditor({ region, track, onClose }) {
  return (
    <div className={styles.editor}>

      {/* Inspector */}
      <div className={styles.inspector}>
        <div className={styles.header}>
          <span className={styles.regionLabel}>region {region.id}</span>
          <button className={styles.closeBtn} onClick={onClose} title="Close editor">×</button>
        </div>

        <p className={styles.sub}>
          {track?.name ?? 'unknown'} <span className={styles.dot}>·</span> {track?.instrument ?? '—'}
        </p>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>instrument</label>
          <select className={styles.select} defaultValue={track?.instrument ?? 'fm pluck'}>
            {INSTRUMENTS.map(i => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>

        <p className={styles.hint}>
          piano roll · visual only
        </p>
      </div>

      {/* Piano roll shell */}
      <div className={styles.pianoRoll}>
        <div className={styles.keys} style={{ minHeight: PIANO_ROLL_H }}>
          {KEYS.map((k) => (
            <div
              key={k.name}
              className={`${k.black ? styles.keyBlack : styles.keyWhite}${k.name.startsWith('C') && !k.black ? ` ${styles.keyOctave}` : ''}`}
            >
              <span className={styles.keyLabel}>{k.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.grid} style={{ minHeight: PIANO_ROLL_H }}>
          {/* Row guides per note + beat lines drawn via CSS gradients on .grid */}
        </div>
      </div>

    </div>
  );
}
