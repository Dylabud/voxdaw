import { useRef, useEffect, useState, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './RegionEditor.module.css';
import { computeGridBg, getSnapIncrement } from '../WorkstationShell';
import { KEYS, KEY_H, PIANO_ROLL_H } from '../pitchKeys';
import { SYNTH_INSTRUMENTS, SAMPLED_INSTRUMENT_NAMES, makeSynth } from '../synthFactory';

// Process-wide preview-synth cache, keyed by instrument name. Keeps sampler
// buffers warm across editor opens / instrument switches so we don't pay a
// network re-download per interaction. Synth-type voices are also cached for
// uniformity (they're cheap so this is incidental). Routed direct to Destination —
// distinct from the per-region playback synths owned by useWorkstationAudio (single-writer rule).
const previewSynthCache = new Map();
function getPreviewSynth(name) {
  const cached = previewSynthCache.get(name);
  if (cached) return cached;
  const s = makeSynth(name).toDestination();
  previewSynthCache.set(name, s);
  return s;
}

// 'grid' resolves dynamically against the visible piano-roll grid (Phase 116 bug 2).
// 'off' = no snap. Fixed-fraction options listed here.
const SNAP_BEATS = { '1/6': 2 / 3, '1/12': 1 / 3 };
const SNAP_DIVISIONS = ['grid', '1/6', '1/12', 'off'];
const DRAG_THRESHOLD = 4;
const RESIZE_EDGE_PX = 4;

function regionWindow(r) {
  const clipOffset = r.clipOffset ?? 0;
  const baseLoop = (r.loopInterval ?? null) !== null ? r.loopInterval : r.durationMeasures;
  return { windowStart: clipOffset * 4, windowEnd: (clipOffset + baseLoop) * 4 };
}

const noteKeyIndex = (name) => KEYS.findIndex(k => k.name === name);

export default function RegionEditor({
  track,
  regions,
  notes,
  onNoteAdd,
  onNoteRemove,
  onCommitNoteEdits,
  onNotesDelete,
  onNoteSelectionChange,
  exposeSelectionSetter,
  zoomLevel,
  pixelsPerMeasure,
  totalMeasures,
  pianoRollPlayheadRef,
  pianoScrollRef,
  onGridScroll,
  onLeftColResize,
  onClose,
  scrollMemoryRef,
  magnetOn,
  onInstrumentChange,
}) {
  const [instrument,        setInstrument]        = useState(track?.instrument ?? 'fm pluck');
  const [activeTab,         setActiveTab]         = useState('notes');
  const [selectedNoteIds,   setSelectedNoteIds]   = useState(() => new Set());
  const [noteSnapDivision,  setNoteSnapDivision]  = useState('grid');

  const previewSynthRef       = useRef(null);
  const activeKeyElRef        = useRef(null);
  const gridRef               = useRef(null);
  const noteMarqueeElRef      = useRef(null);
  const noteDragRef           = useRef(null);
  const noteMarqueeRef        = useRef(null);
  const editorRootRef         = useRef(null);
  const pianoMousePosRef      = useRef({ x: 0, y: 0 });
  const pianoAutoScrollFrameRef = useRef(null);

  const notesRef              = useRef(notes);              notesRef.current = notes;
  const regionsRef            = useRef(regions);            regionsRef.current = regions;
  const selectedNoteIdsRef    = useRef(selectedNoteIds);    selectedNoteIdsRef.current = selectedNoteIds;
  const noteSnapRef           = useRef(noteSnapDivision);   noteSnapRef.current = noteSnapDivision;
  const magnetOnRef           = useRef(magnetOn);           magnetOnRef.current = magnetOn;
  const pixelsPerMeasureRef   = useRef(pixelsPerMeasure);   pixelsPerMeasureRef.current = pixelsPerMeasure;

  // Effective snap value (beats per snap unit) or null when no snap.
  // - magnet off  → null (no snap regardless of dropdown)
  // - 'off'       → null (explicit user choice)
  // - 'grid'      → dynamic, mirrors the visible grid via getSnapIncrement (measures → beats)
  // - '1/6','1/12' → fixed fractions from SNAP_BEATS
  const getSnapBeats = () => {
    if (!magnetOnRef.current) return null;
    const div = noteSnapRef.current;
    if (div === 'off')  return null;
    if (div === 'grid') return getSnapIncrement(pixelsPerMeasureRef.current) * 4;
    return SNAP_BEATS[div] ?? null;
  };

  // Sync local instrument state from track.instrument when the prop changes
  // (e.g., another editor for the same track wrote back).
  useEffect(() => {
    if (track?.instrument && track.instrument !== instrument) {
      setInstrument(track.instrument);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.instrument]);

  // Preview synth — read from the module-level cache so samplers don't redownload
  // on instrument switch or editor reopen. No dispose: instances live for the
  // process lifetime, which is acceptable for a small fixed set of instruments.
  useEffect(() => {
    previewSynthRef.current = getPreviewSynth(instrument);
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
  }, [track?.id]);

  // Clear selection when active track changes
  useEffect(() => { setSelectedNoteIds(new Set()); }, [track?.id]);

  // Propagate selection to shell (for clipboard scope)
  useEffect(() => {
    onNoteSelectionChange?.(selectedNoteIds);
  }, [selectedNoteIds, onNoteSelectionChange]);

  // Expose imperative selection setter to shell (so shell can clear after delete/paste)
  useEffect(() => {
    if (!exposeSelectionSetter) return;
    exposeSelectionSetter({
      clear:  () => setSelectedNoteIds(new Set()),
      setIds: (ids) => setSelectedNoteIds(new Set(ids)),
    });
    return () => exposeSelectionSetter(null);
  }, [exposeSelectionSetter]);

  // Click-away deselect — any left-click that isn't on a note or the bare grid
  // (where the marquee handler owns selection) clears note selection. Covers:
  // arrangement regions/grid, track headers, editor tabs (notes/instrument/effects),
  // inspector column, snap dropdown, etc. Note mousedown and grid marquee both
  // manage their own selection state, so we skip those.
  useEffect(() => {
    const onDocDown = (e) => {
      if (e.button !== 0) return;
      if (noteDragRef.current || noteMarqueeRef.current) return;
      const onNote = e.target.closest && e.target.closest('[data-note-id]');
      if (onNote) return;
      if (gridRef.current && e.target === gridRef.current) return;
      // Opt-out: divider/resizer drags (height + width handles for piano roll, region grid, track grid).
      if (e.target.closest && e.target.closest('[data-no-note-deselect]')) return;
      if (selectedNoteIdsRef.current.size === 0) return;
      setSelectedNoteIds(new Set());
    };
    // Capture phase so region/lane handlers' stopPropagation can't suppress us.
    window.addEventListener('mousedown', onDocDown, true);
    return () => window.removeEventListener('mousedown', onDocDown, true);
  }, []);

  // Piano-roll edge auto-scroll while dragging notes or drawing the marquee.
  // Mirrors WorkstationShell's arrangement auto-scroll; scoped to pianoScrollRef.
  const stopPianoAutoScroll = useCallback(() => {
    if (pianoAutoScrollFrameRef.current != null) {
      cancelAnimationFrame(pianoAutoScrollFrameRef.current);
      pianoAutoScrollFrameRef.current = null;
    }
  }, []);
  const startPianoAutoScroll = useCallback(() => {
    if (pianoAutoScrollFrameRef.current != null) return;
    const THRESHOLD = 80;
    const MAX_SPEED = 15;
    const tick = () => {
      const el = pianoScrollRef?.current;
      if (!el) { pianoAutoScrollFrameRef.current = null; return; }
      const b  = el.getBoundingClientRect();
      const { x: mx, y: my } = pianoMousePosRef.current;
      let dx = 0, dy = 0;
      const dRight = b.right  - mx; const dLeft = mx - b.left;
      const dBot   = b.bottom - my; const dTop  = my - b.top;
      if (dRight < THRESHOLD) dx =  MAX_SPEED * Math.min(1, 1 - dRight / THRESHOLD);
      if (dLeft  < THRESHOLD) dx = -MAX_SPEED * Math.min(1, 1 - dLeft  / THRESHOLD);
      if (dBot   < THRESHOLD) dy =  MAX_SPEED * Math.min(1, 1 - dBot   / THRESHOLD);
      if (dTop   < THRESHOLD) dy = -MAX_SPEED * Math.min(1, 1 - dTop   / THRESHOLD);
      if (dx !== 0) {
        const maxX = el.scrollWidth - el.clientWidth;
        el.scrollLeft = Math.max(0, Math.min(maxX, el.scrollLeft + dx));
      }
      if (dy !== 0) {
        const maxY = el.scrollHeight - el.clientHeight;
        el.scrollTop = Math.max(0, Math.min(maxY, el.scrollTop + dy));
      }
      if (dx !== 0 || dy !== 0) {
        const { x, y } = pianoMousePosRef.current;
        window.dispatchEvent(new MouseEvent('mousemove', {
          clientX: x, clientY: y, bubbles: true, buttons: 1, cancelable: true,
        }));
      }
      pianoAutoScrollFrameRef.current = requestAnimationFrame(tick);
    };
    pianoAutoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [pianoScrollRef]);

  // Esc / Cmd+A
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const inInput = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;
      if (e.key === 'Escape') {
        if (inInput) return;
        setSelectedNoteIds(new Set());
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        if (inInput) return;
        e.preventDefault();
        setSelectedNoteIds(new Set(notesRef.current.map(n => n.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // ── Marquee hit testing (base notes only — ghosts excluded by iterating state) ──
  // Restricted to notes whose regionId matches the marquee's starting region (bug 1).
  function computeMarqueeHits(minX, maxX, minY, maxY, startingRegionId) {
    if (!startingRegionId) return [];
    const ppb = pixelsPerMeasureRef.current / 4;
    const hits = [];
    for (const n of notesRef.current) {
      if (n.regionId !== startingRegionId) continue;
      const r = regionsRef.current.find(rg => rg.id === n.regionId);
      if (!r) continue;
      const { windowStart, windowEnd } = regionWindow(r);
      if (n.startBeat < windowStart || n.startBeat >= windowEnd) continue;
      const ki = noteKeyIndex(n.note);
      if (ki < 0) continue;
      const bottleOriginBeat = (r.startMeasure - (r.clipOffset ?? 0)) * 4;
      const noteX = (bottleOriginBeat + n.startBeat) * ppb;
      const noteW = Math.max(n.durationBeats * ppb - 1, 2);
      const noteY = ki * KEY_H;
      const noteH = KEY_H - 1;
      if (noteX + noteW < minX || noteX > maxX) continue;
      if (noteY + noteH < minY || noteY > maxY) continue;
      hits.push(n.id);
    }
    return hits;
  }

  // ── Cluster delta math for move / resize ──
  function computeDragUpdates(d, dBeats, dKey) {
    const snap = getSnapBeats();
    const minDur = snap ?? 0.25;

    // For MOVE only, we joint-clamp X (windowStart low only; high cap removed per bug 6)
    // and Y (pitch). resize-right / resize-left are clamped per-note so the smallest note
    // hitting minDur doesn't freeze the cluster (bug 2).
    let dbLow = -Infinity;
    let dkLow = -Infinity, dkHigh = Infinity;

    if (d.mode === 'move') {
      for (const id of d.clusterIds) {
        const init = d.initByID.get(id);
        if (!init) continue;
        const n = notesRef.current.find(x => x.id === id);
        if (!n) continue;
        const r = regionsRef.current.find(rg => rg.id === n.regionId);
        if (!r) continue;
        const { windowStart } = regionWindow(r);
        dbLow = Math.max(dbLow, windowStart - init.startBeat);
        const ki = noteKeyIndex(init.note);
        dkLow  = Math.max(dkLow,  0 - ki);
        dkHigh = Math.min(dkHigh, (KEYS.length - 1) - ki);
      }
    }

    const cdBeats = d.mode === 'move' ? Math.max(dbLow, dBeats) : dBeats;
    const cdKey   = d.mode === 'move' ? Math.max(dkLow, Math.min(dkHigh, dKey)) : 0;

    const updates = [];
    for (const id of d.clusterIds) {
      const init = d.initByID.get(id);
      if (!init) continue;
      const n = notesRef.current.find(x => x.id === id);
      if (!n) continue;
      const r = regionsRef.current.find(rg => rg.id === n.regionId);
      if (!r) continue;
      const { windowStart } = regionWindow(r);

      if (d.mode === 'move') {
        const ki = noteKeyIndex(init.note) + cdKey;
        updates.push({
          id, regionId: n.regionId,
          startBeat: init.startBeat + cdBeats,
          durationBeats: init.durationBeats,
          note: KEYS[ki]?.name ?? init.note,
        });
      } else if (d.mode === 'resize-right') {
        // Per-note clamp: duration ≥ minDur. No window-end cap (bug 6).
        const candidateDur = Math.max(minDur, init.durationBeats + cdBeats);
        updates.push({
          id, regionId: n.regionId,
          startBeat: init.startBeat,
          durationBeats: candidateDur,
          note: init.note,
        });
      } else if (d.mode === 'resize-left') {
        // Per-note: newStart ≥ windowStart; newDur ≥ minDur.
        const low  = windowStart - init.startBeat;
        const high = init.durationBeats - minDur;
        const clamped = Math.max(low, Math.min(high, cdBeats));
        updates.push({
          id, regionId: n.regionId,
          startBeat: init.startBeat + clamped,
          durationBeats: init.durationBeats - clamped,
          note: init.note,
        });
      }
    }
    return updates;
  }

  // ── Global mousemove / mouseup for drag + marquee ──
  useEffect(() => {
    const onMove = (e) => {
      pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
      // Drag path
      const dD = noteDragRef.current;
      if (dD) {
        const dx = e.clientX - dD.startX;
        const dy = e.clientY - dD.startY;
        if (!dD.dragStarted && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dD.dragStarted) {
          dD.dragStarted = true;
          document.body.classList.add('is-note-dragging');
        }
        const ppb = pixelsPerMeasureRef.current / 4;
        const snap = getSnapBeats();
        let deltaBeats = dx / ppb;
        if (snap !== null) deltaBeats = Math.round(deltaBeats / snap) * snap;
        const dKey = Math.round(dy / KEY_H);

        const updates = computeDragUpdates(dD, deltaBeats, dKey);
        dD.pendingUpdates = updates;
        for (const u of updates) {
          const r = regionsRef.current.find(rg => rg.id === u.regionId);
          if (!r) continue;
          const bottleOriginBeat = (r.startMeasure - (r.clipOffset ?? 0)) * 4;
          const ki = noteKeyIndex(u.note);
          const widthPx = `${Math.max(u.durationBeats * ppb - 1, 2)}px`;
          const topPx   = `${ki * KEY_H}px`;
          // Write to all iterations of this note so ghost copies follow live (bug 11).
          const els = gridRef.current?.querySelectorAll(`[data-note-id="${u.id}"]`);
          els?.forEach(el => {
            const iter = +el.dataset.noteIter;
            const iterOffsetBeats = iter * (r.loopInterval ?? 0) * 4;
            const lb = bottleOriginBeat + u.startBeat + iterOffsetBeats;
            el.style.left  = `${lb * ppb}px`;
            el.style.top   = topPx;
            el.style.width = widthPx;
          });
        }
        return;
      }

      // Marquee path
      const dM = noteMarqueeRef.current;
      if (dM) {
        const grid = gridRef.current;
        if (!grid) return;
        const rect = grid.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        if (!dM.active && Math.hypot(currentX - dM.startX, currentY - dM.startY) < DRAG_THRESHOLD) return;
        dM.active = true;
        dM.currentX = currentX;
        dM.currentY = currentY;
        const left = Math.min(dM.startX, currentX);
        const top  = Math.min(dM.startY, currentY);
        const width  = Math.abs(currentX - dM.startX);
        const height = Math.abs(currentY - dM.startY);
        const mel = noteMarqueeElRef.current;
        if (mel) {
          mel.style.left = `${left}px`;
          mel.style.top  = `${top}px`;
          mel.style.width  = `${width}px`;
          mel.style.height = `${height}px`;
          mel.style.opacity = '1';
        }
        // Live highlight
        const hits = computeMarqueeHits(
          Math.min(dM.startX, currentX), Math.max(dM.startX, currentX),
          Math.min(dM.startY, currentY), Math.max(dM.startY, currentY),
          dM.startingRegionId,
        );
        const prev = dM.lastHits || [];
        const hitSet = new Set(hits);
        for (const id of prev) {
          if (hitSet.has(id)) continue;
          const el = grid.querySelector(`[data-note-id="${id}"][data-note-iter="0"]`);
          if (el) el.classList.remove(styles.noteSelectedLive);
        }
        const prevSet = new Set(prev);
        for (const id of hits) {
          if (prevSet.has(id)) continue;
          const el = grid.querySelector(`[data-note-id="${id}"][data-note-iter="0"]`);
          if (el) el.classList.add(styles.noteSelectedLive);
        }
        dM.lastHits = hits;
      }
    };

    const onUp = () => {
      // Drag end
      const dD = noteDragRef.current;
      if (dD) {
        noteDragRef.current = null;
        document.body.classList.remove('is-note-dragging');
        stopPianoAutoScroll();
        if (dD.dragStarted && dD.pendingUpdates && dD.pendingUpdates.length) {
          onCommitNoteEdits?.(dD.pendingUpdates);
        }
        return;
      }
      // Marquee end
      const dM = noteMarqueeRef.current;
      if (dM) {
        stopPianoAutoScroll();
        noteMarqueeRef.current = null;
        const mel = noteMarqueeElRef.current;
        if (mel) {
          mel.style.opacity = '0';
          mel.style.width = '0'; mel.style.height = '0';
          mel.style.left = ''; mel.style.top = '';
        }
        // Clear live highlights
        for (const id of dM.lastHits || []) {
          const el = gridRef.current?.querySelector(`[data-note-id="${id}"][data-note-iter="0"]`);
          if (el) el.classList.remove(styles.noteSelectedLive);
        }

        if (!dM.active) {
          // Pure click — add note at start position
          const ppb = pixelsPerMeasureRef.current / 4;
          const snap = getSnapBeats();
          const xBeat = dM.startX / ppb;
          let startBeat = snap !== null ? Math.floor(xBeat / snap) * snap : xBeat;
          if (startBeat < 0) startBeat = 0;
          const keyIndex = Math.floor(dM.startY / KEY_H);
          const noteName = KEYS[keyIndex]?.name;
          if (!noteName || dM.startX < 0) return;
          const durationBeats = snap !== null ? snap : 1;
          const newId = onNoteAdd?.({
            trackId: track.id, note: noteName, startBeat, durationBeats,
          });
          if (newId) setSelectedNoteIds(new Set([newId]));
          return;
        }
        // Commit marquee hits
        const hits = computeMarqueeHits(
          Math.min(dM.startX, dM.currentX), Math.max(dM.startX, dM.currentX),
          Math.min(dM.startY, dM.currentY), Math.max(dM.startY, dM.currentY),
          dM.startingRegionId,
        );
        setSelectedNoteIds(new Set(hits));
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      stopPianoAutoScroll();
    };
  }, [onCommitNoteEdits, onNoteAdd, track?.id, stopPianoAutoScroll]);

  // ── Note mousedown — selection + drag arming ──
  function handleNoteMouseDown(e, note) {
    if (e.button !== 0) return;
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    const xInNote = e.clientX - rect.left;
    const noteW = rect.width;
    let mode = 'move';
    if (noteW >= 14) {
      if (xInNote < RESIZE_EDGE_PX) mode = 'resize-left';
      else if (xInNote > noteW - RESIZE_EDGE_PX) mode = 'resize-right';
    }

    // Selection
    let nextSelection;
    const cur = selectedNoteIdsRef.current;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      nextSelection = new Set(cur);
      if (nextSelection.has(note.id)) nextSelection.delete(note.id);
      else nextSelection.add(note.id);
    } else if (!cur.has(note.id)) {
      nextSelection = new Set([note.id]);
    } else {
      nextSelection = new Set(cur);
    }
    setSelectedNoteIds(nextSelection);

    // Snapshot cluster (use the post-mousedown selection)
    const initByID = new Map();
    for (const id of nextSelection) {
      const n = notesRef.current.find(x => x.id === id);
      if (!n) continue;
      initByID.set(id, {
        startBeat: n.startBeat,
        durationBeats: n.durationBeats,
        note: n.note,
      });
    }
    noteDragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      dragStarted: false,
      clusterIds: [...nextSelection],
      initByID,
      anchorId: note.id,
      pendingUpdates: null,
    };
    pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
    startPianoAutoScroll();
  }

  // Cursor hint on hover
  function handleNoteHover(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const xIn = e.clientX - rect.left;
    const w = rect.width;
    if (w >= 14 && (xIn < RESIZE_EDGE_PX || xIn > w - RESIZE_EDGE_PX)) {
      e.currentTarget.style.cursor = 'ew-resize';
    } else {
      e.currentTarget.style.cursor = 'grab';
    }
  }

  // ── Grid mousedown — arm marquee or click-create ──
  function handleGridMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0) return;
    // Resolve starting region from click x — marquee will only select notes from this region (bug 1).
    const ppb = pixelsPerMeasureRef.current / 4;
    const xBeat = x / ppb;
    const startingRegion = regionsRef.current.find(r =>
      xBeat >= r.startMeasure * 4 &&
      xBeat <  (r.startMeasure + r.durationMeasures) * 4
    );
    noteMarqueeRef.current = {
      startX: x, startY: y,
      currentX: x, currentY: y,
      active: false,
      lastHits: [],
      startingRegionId: startingRegion?.id ?? null,
    };
    pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
    startPianoAutoScroll();
  }

  const ppb          = pixelsPerMeasure / 4;
  const gridMinWidth = totalMeasures * pixelsPerMeasure;

  return (
    <div ref={editorRootRef} className={styles.editor} style={{ '--track-color': track?.color }}>
      <div className={styles.editorBar}>
        <div className={styles.editorTabs}>
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
        {activeTab === 'notes' && (
          <div className={styles.editorTools}>
            <label className={styles.snapLabel}>snap</label>
            <select
              className={`${styles.snapSelect}${magnetOn ? '' : ` ${styles.snapSelectDisabled}`}`}
              // Magnet off forces the displayed value to 'off' without losing the user's
              // saved division — restored when magnet is re-enabled (Phase 116 bug 4).
              value={magnetOn ? noteSnapDivision : 'off'}
              onChange={(e) => setNoteSnapDivision(e.target.value)}
              title={magnetOn ? 'Snap division' : 'Magnet is off — snap forced off'}
            >
              {SNAP_DIVISIONS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
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
            onChange={(e) => {
              setInstrument(e.target.value);
              if (onInstrumentChange && track?.id) onInstrumentChange(track.id, e.target.value);
            }}
          >
            <optgroup label="synth">
              {SYNTH_INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
            </optgroup>
            <optgroup label="sampled">
              {SAMPLED_INSTRUMENT_NAMES.map(i => <option key={i} value={i}>{i}</option>)}
            </optgroup>
          </select>
        </div>
      </div>

      {/* Left-column resizer */}
      <div data-no-note-deselect className={styles.colResizer} onMouseDown={onLeftColResize} />

      {/* Piano roll scroll container — always mounted */}
      <div
        ref={pianoScrollRef}
        className={styles.pianoRoll}
        onScroll={onGridScroll}
      >
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

        {/* Grid is always mounted so scrollLeft survives tab switches (bug 12).
            On non-notes tabs, the placeholder overlay sits on top, sticky to the viewport. */}
        {(
          <div
            ref={gridRef}
            className={`${styles.grid}${activeTab !== 'notes' ? ` ${styles.gridHiddenContent}` : ''}`}
            style={{
              width: gridMinWidth,
              minHeight: PIANO_ROLL_H,
              backgroundImage: computeGridBg(pixelsPerMeasure, zoomLevel),
            }}
            onMouseDown={handleGridMouseDown}
          >
            <div className={styles.gridShading} style={{ minHeight: PIANO_ROLL_H }} />

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

            {/* Sort: larger durations first (so smaller notes paint on top via DOM order);
                tie-break by ascending startBeat so later notes overlap earlier ones (bug 10.1/10.2). */}
            {[...notes]
              .sort((a, b) => {
                if (a.durationBeats !== b.durationBeats) return b.durationBeats - a.durationBeats;
                return a.startBeat - b.startBeat;
              })
              .flatMap(n => {
              const r = regions?.find(rg => rg.id === n.regionId);
              if (!r) return [];
              const keyIndex = noteKeyIndex(n.note);
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
              const regionStartBeat = r.startMeasure * 4;
              const regionEndBeat   = (r.startMeasure + r.durationMeasures) * 4;
              const isSelected = selectedNoteIds.has(n.id);
              for (let i = 0; i < iterations; i++) {
                const iterOffsetBeats = i * (r.loopInterval ?? 0) * 4;
                const globalLeftBeat  = baseGlobalLeftBeat + iterOffsetBeats;
                const noteEndBeat     = globalLeftBeat + n.durationBeats;
                // Clip to region bounds (bugs 7.1/7.2). If fully past or fully before, skip.
                const visibleLeft  = Math.max(globalLeftBeat, regionStartBeat);
                const visibleRight = Math.min(noteEndBeat, regionEndBeat);
                if (visibleRight <= visibleLeft) {
                  // Fully outside region; if past the right edge, no later iter helps → break.
                  if (globalLeftBeat >= regionEndBeat) break;
                  continue;
                }
                const ghost = i > 0;
                out.push(
                  <div
                    key={`${n.id}-${i}`}
                    data-note-id={n.id}
                    data-note-iter={i}
                    className={`${styles.noteBlock}${ghost ? ` ${styles.noteBlockGhost}` : ''}${!ghost && isSelected ? ` ${styles.noteSelected}` : ''}`}
                    style={{
                      top:    keyIndex * KEY_H,
                      left:   visibleLeft * ppb,
                      width:  Math.max((visibleRight - visibleLeft) * ppb - 1, 2),
                      height: KEY_H - 1,
                    }}
                    onMouseDown={ghost ? undefined : (e) => handleNoteMouseDown(e, n)}
                    onMouseMove={ghost ? undefined : handleNoteHover}
                  />
                );
              }
              return out;
            })}

            <div ref={noteMarqueeElRef} className={styles.noteMarquee} />
            <div ref={pianoRollPlayheadRef} className={styles.playhead} />
          </div>
        )}
      </div>

      {/* Placeholder overlay — outside the scroll container so it never affects scrollWidth (bug 12) */}
      {activeTab !== 'notes' && (
        <div className={styles.placeholderOverlay}>
          <span className={styles.placeholderText}>
            {activeTab === 'instrument' ? 'instrument — coming soon' : 'effects — coming soon'}
          </span>
        </div>
      )}

      </div>
    </div>
  );
}
