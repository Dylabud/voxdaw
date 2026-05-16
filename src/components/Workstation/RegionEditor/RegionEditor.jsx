import { useRef, useEffect, useState } from 'react';
import * as Tone from 'tone';
import styles from './RegionEditor.module.css';
import { computeGridBg } from '../WorkstationShell';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK = new Set(['C#','D#','F#','G#','A#']);

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
const KEYS          = buildKeys(-2, 8); // C-2..C8 → 132 keys
const KEY_H         = 18;
const PIANO_ROLL_H  = KEYS.length * KEY_H;
const MEASURES      = 24;

const INSTRUMENTS = [
  'fm pluck', 'analog', 'strings', 'am', 'pluck',
  'sine', 'square', 'sawtooth', 'triangle',
];

function makePreviewSynth(instrument) {
  switch (instrument) {
    case 'fm pluck':
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3, modulationIndex: 10,
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
      }).toDestination();
    case 'strings':
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3.5, modulationIndex: 10,
        oscillator: { type: 'sawtooth' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.3, decay: 0.2, sustain: 0.8, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 0.1, sustain: 0.8, release: 0.6 },
      }).toDestination();
    case 'am':
      return new Tone.PolySynth(Tone.AMSynth, {
        harmonicity: 2,
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
      }).toDestination();
    case 'pluck':
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
      }).toDestination();
    case 'sine':
    case 'square':
    case 'sawtooth':
    case 'triangle':
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: instrument },
        envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 },
      }).toDestination();
    case 'analog':
    default:
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.005, decay: 0.12, sustain: 0.3, release: 0.25 },
      }).toDestination();
  }
}

export default function RegionEditor({
  track,
  regions,
  notes,
  onNoteAdd,
  onNoteRemove,
  zoomLevel,
  pixelsPerMeasure,
  pianoRollPlayheadRef,
  pianoScrollRef,
  onGridScroll,
  onLeftColResize,
  onClose,
}) {
  const [instrument, setInstrument] = useState(track?.instrument ?? 'fm pluck');
  const previewSynthRef = useRef(null);
  const activeKeyElRef  = useRef(null);

  // Preview synth lifecycle (re-created when instrument changes)
  useEffect(() => {
    const s = makePreviewSynth(instrument);
    previewSynthRef.current = s;
    return () => s.dispose();
  }, [instrument]);

  // ── Key preview handlers ──────────────────────────────────
  function handleMouseDown(note, e) {
    Tone.start().then(() => previewSynthRef.current?.triggerAttack(note));
    activeKeyElRef.current?.classList.remove(styles.keyActive);
    activeKeyElRef.current = e.currentTarget;
    e.currentTarget.classList.add(styles.keyActive);
  }
  function handleMouseEnter(note, e) {
    if (e.buttons !== 1) return;
    previewSynthRef.current?.releaseAll();
    activeKeyElRef.current?.classList.remove(styles.keyActive);
    activeKeyElRef.current = e.currentTarget;
    e.currentTarget.classList.add(styles.keyActive);
    previewSynthRef.current?.triggerAttack(note);
  }
  function handleMouseUp() {
    previewSynthRef.current?.releaseAll();
    activeKeyElRef.current?.classList.remove(styles.keyActive);
    activeKeyElRef.current = null;
  }

  // ── Grid click — add note ─────────────────────────────────
  function handleGridClick(e) {
    const scroll = pianoScrollRef.current;
    if (!scroll) return;
    const scrollRect = scroll.getBoundingClientRect();
    const keysW = 56;
    const x = (e.clientX - scrollRect.left) + scroll.scrollLeft - keysW;
    const y = (e.clientY - scrollRect.top);
    if (x < 0) return;
    const ppb   = pixelsPerMeasure / 4;
    const beat  = Math.floor(x / ppb);
    const keyIndex = Math.floor(y / KEY_H);
    const noteName = KEYS[keyIndex]?.name;
    if (!noteName) return;
    onNoteAdd({ trackId: track.id, note: noteName, startBeat: beat, durationBeats: 1 });
  }

  const ppb          = pixelsPerMeasure / 4;
  const gridMinWidth = MEASURES * pixelsPerMeasure;

  return (
    <div className={styles.editor}>
      <div className={styles.editorBar} />
      <div className={styles.editorBody}>

      {/* Inspector */}
      <div className={styles.inspector}>
        <div className={styles.header}>
          <span className={styles.trackLabel}>{track?.name ?? 'track'}</span>
          <button className={styles.closeBtn} onClick={onClose} title="Close editor">×</button>
        </div>

        <p className={styles.sub}>
          {track?.instrument ?? '—'}
        </p>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>preview</label>
          <select
            className={styles.select}
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
          >
            {INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
      </div>

      {/* Left-column resizer handle (shared drag handler from shell) */}
      <div className={styles.colResizer} onMouseDown={onLeftColResize} />

      {/* Piano roll */}
      <div
        ref={pianoScrollRef}
        className={styles.pianoRoll}
        onScroll={onGridScroll}
      >
        {/* Keys column (sticky) */}
        <div
          className={styles.keys}
          style={{ minHeight: PIANO_ROLL_H }}
          onMouseLeave={handleMouseUp}
        >
          {KEYS.map((k) => (
            <div
              key={k.name}
              className={`${k.black ? styles.keyBlack : styles.keyWhite}${k.name.startsWith('C') && !k.black ? ` ${styles.keyOctave}` : ''}`}
              onMouseDown={(e) => handleMouseDown(k.name, e)}
              onMouseEnter={(e) => handleMouseEnter(k.name, e)}
              onMouseUp={handleMouseUp}
            >
              <span className={styles.keyLabel}>{k.label}</span>
            </div>
          ))}
        </div>

        {/* Note grid */}
        <div
          className={styles.grid}
          style={{
            minWidth: gridMinWidth,
            minHeight: PIANO_ROLL_H,
            backgroundImage: computeGridBg(pixelsPerMeasure, zoomLevel),
          }}
          onClick={handleGridClick}
        >
          {/* Row shading overlay (accidental/natural, theme-aware) */}
          <div className={styles.gridShading} style={{ minHeight: PIANO_ROLL_H }} />

          {/* Region highlights — clip boundary markers behind MIDI notes */}
          {regions?.map(r => (
            <div
              key={r.id}
              className={styles.regionHighlight}
              style={{
                left:  r.startMeasure     * pixelsPerMeasure,
                width: r.durationMeasures * pixelsPerMeasure,
              }}
            />
          ))}

          {/* Note blocks */}
          {notes.map(n => {
            const keyIndex = KEYS.findIndex(k => k.name === n.note);
            if (keyIndex < 0) return null;
            return (
              <div
                key={n.id}
                className={styles.noteBlock}
                style={{
                  top:    keyIndex * KEY_H,
                  left:   n.startBeat * ppb,
                  width:  Math.max(n.durationBeats * ppb - 1, 2),
                  height: KEY_H - 1,
                }}
                onClick={(e) => { e.stopPropagation(); onNoteRemove(n.id); }}
              />
            );
          })}

          {/* Playhead */}
          <div ref={pianoRollPlayheadRef} className={styles.playhead} />
        </div>
      </div>

      </div>
    </div>
  );
}
