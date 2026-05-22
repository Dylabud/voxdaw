import { useRef, useEffect, useState } from 'react';
import * as Tone from 'tone';
import styles from './RegionEditor.module.css';
import { computeGridBg } from '../WorkstationShell';
import { KEYS, KEY_H, PIANO_ROLL_H } from '../pitchKeys';

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
  totalMeasures,
  pianoRollPlayheadRef,
  pianoScrollRef,
  onGridScroll,
  onLeftColResize,
  onClose,
  scrollMemoryRef,
}) {
  const [instrument, setInstrument] = useState(track?.instrument ?? 'fm pluck');
  const [activeTab, setActiveTab] = useState('notes');
  const previewSynthRef = useRef(null);
  const activeKeyElRef  = useRef(null);

  // Preview synth lifecycle (re-created when instrument changes)
  useEffect(() => {
    const s = makePreviewSynth(instrument);
    previewSynthRef.current = s;
    return () => s.dispose();
  }, [instrument]);

  // Restore saved scroll position, or default to C4 at bottom on first open
  useEffect(() => {
    const container = pianoScrollRef.current;
    if (!container) return;
    if (scrollMemoryRef?.current !== null) {
      container.scrollTop = scrollMemoryRef.current;
      return;
    }
    const c4Index = KEYS.findIndex(k => k.name === 'C4');
    if (c4Index < 0) return;
    container.scrollTop = c4Index * KEY_H - container.clientHeight + KEY_H;
  }, [track?.id]); // fires on mount + whenever track changes (no remount on track switch)

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
    const y = (e.clientY - scrollRect.top) + scroll.scrollTop;
    if (x < 0) return;
    const ppb   = pixelsPerMeasure / 4;
    const beat  = Math.floor(x / ppb);
    const keyIndex = Math.floor(y / KEY_H);
    const noteName = KEYS[keyIndex]?.name;
    if (!noteName) return;
    onNoteAdd({ trackId: track.id, note: noteName, startBeat: beat, durationBeats: 1 });
  }

  const ppb          = pixelsPerMeasure / 4;
  const gridMinWidth = totalMeasures * pixelsPerMeasure;

  return (
    <div className={styles.editor} style={{ '--track-color': track?.color }}>
      <div className={styles.editorBar}>
        {['notes', 'instrument', 'effects'].map(tab => (
          <button
            key={tab}
            className={`${styles.tabBtn}${activeTab === tab ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'notes' ? 'piano roll' : tab}
          </button>
        ))}
      </div>
      <div className={styles.editorBody}>

      {/* Inspector — always visible */}
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

      {/* Piano roll scroll container — always mounted (preserves scrollTop natively) */}
      <div
        ref={pianoScrollRef}
        className={styles.pianoRoll}
        onScroll={onGridScroll}
      >
        {/* Keys column — always visible across all tabs */}
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

        {/* Note grid (notes tab) or placeholder (instrument/effects tabs) */}
        {activeTab === 'notes' ? (
          <div
            className={styles.grid}
            style={{
              width: gridMinWidth,
              minHeight: PIANO_ROLL_H,
              backgroundImage: computeGridBg(pixelsPerMeasure, zoomLevel),
            }}
            onClick={handleGridClick}
          >
            {/* Row shading overlay (accidental/natural, theme-aware) */}
            <div className={styles.gridShading} style={{ minHeight: PIANO_ROLL_H }} />

            {/* Region highlights + loop tint (Phase 110) */}
            {regions?.flatMap(r => {
              const out = [
                <div key={`hl-${r.id}`} className={styles.regionHighlight}
                  style={{
                    left:  r.startMeasure     * pixelsPerMeasure,
                    width: r.durationMeasures * pixelsPerMeasure,
                  }} />
              ];
              if ((r.loopInterval ?? null) !== null && r.durationMeasures > r.loopInterval) {
                out.push(
                  <div key={`tint-${r.id}`} className={styles.loopTintEditor}
                    style={{
                      left:  (r.startMeasure + r.loopInterval) * pixelsPerMeasure,
                      width: (r.durationMeasures - r.loopInterval) * pixelsPerMeasure,
                    }} />
                );
              }
              return out;
            })}

            {/* Note blocks — bottle-local startBeat converted to global pixels.
                Looped regions emit one copy per iteration (Phase 110); ghosts (i > 0) are
                dimmed and pointer-events: none. */}
            {notes.flatMap(n => {
              const r = regions?.find(rg => rg.id === n.regionId);
              if (!r) return [];
              const keyIndex = KEYS.findIndex(k => k.name === n.note);
              if (keyIndex < 0) return [];
              const clipOffset       = r.clipOffset ?? 0;
              const baseLoop         = (r.loopInterval ?? null) !== null ? r.loopInterval : r.durationMeasures;
              const windowStartBeat  = clipOffset * 4;
              const windowEndBeat    = (clipOffset + baseLoop) * 4;
              if (n.startBeat < windowStartBeat || n.startBeat >= windowEndBeat) return [];
              const bottleOriginBeat   = (r.startMeasure - clipOffset) * 4;
              const baseGlobalLeftBeat = bottleOriginBeat + n.startBeat;
              const iterations = (r.loopInterval ?? null) !== null
                ? Math.ceil(r.durationMeasures / r.loopInterval)
                : 1;
              const out = [];
              const regionEndBeat = (r.startMeasure + r.durationMeasures) * 4;
              for (let i = 0; i < iterations; i++) {
                const iterOffsetBeats = i * (r.loopInterval ?? 0) * 4;
                const globalLeftBeat  = baseGlobalLeftBeat + iterOffsetBeats;
                if (globalLeftBeat >= regionEndBeat) break;
                out.push(
                  <div
                    key={`${n.id}-${i}`}
                    className={`${styles.noteBlock}${i > 0 ? ` ${styles.noteBlockGhost}` : ''}`}
                    style={{
                      top:    keyIndex * KEY_H,
                      left:   globalLeftBeat * ppb,
                      width:  Math.max(n.durationBeats * ppb - 1, 2),
                      height: KEY_H - 1,
                    }}
                    onClick={i === 0 ? (e) => { e.stopPropagation(); onNoteRemove(n.id); } : undefined}
                  />
                );
              }
              return out;
            })}

            {/* Playhead */}
            <div ref={pianoRollPlayheadRef} className={styles.playhead} />
          </div>
        ) : (
          <div className={styles.placeholder}>
            <span className={styles.placeholderText}>
              {activeTab === 'instrument' ? 'instrument — coming soon' : 'effects — coming soon'}
            </span>
          </div>
        )}
      </div>

      </div>
    </div>
  );
}
