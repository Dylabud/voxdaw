import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './RegionEditor.module.css';
import { drawGrid, getSnapIncrement } from '../WorkstationShell';
import { KEYS, KEY_H, PIANO_ROLL_H } from '../pitchKeys';
import { firstLoopOffsetMeasures } from '../loopMath';
import { SYNTH_INSTRUMENTS, SAMPLED_MELODIC_NAMES, DRUM_KIT_NAMES, isDrumKit } from '../synthFactory';
import { customInstrumentList } from '../customInstruments';
import {
  normalizeGlide, indexNotesByStartTick, resolveGlideTarget,
  svgPathFor, tensionHandlePoint, keyIndexOf, TENSION_LIMIT,
} from '../glideMath';
import EffectsList from './EffectsList';
import EffectsRack from './EffectsRack';
import InstrumentPanel from './InstrumentPanel';

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

// Sticky keys-column width (matches .keys flex-basis) — grid lines start after it.
const KEYS_W = 56;

export default function RegionEditor({
  track,
  regions,
  notes,
  onNoteAdd,
  onNoteRemove,
  onCommitNoteEdits,
  onNotesDelete,
  onNoteContextMenu,
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
  onVolumeChange,
  onEnvelopeChange,
  onEffectAdd,
  onEffectRemove,
  onEffectToggleBypass,
  onEffectUpdate,
  automatedFxKeys,
  isDarkMode,
  performanceQuality,
  loadingTrackIds,
  auditionAttack,
  auditionRelease,
  auditionReleaseAll,
  auditionPrime,
}) {
  const [instrument,        setInstrument]        = useState(track?.instrument ?? 'fm pluck');
  const [activeTab,         setActiveTab]         = useState('notes');
  const [selectedNoteIds,   setSelectedNoteIds]   = useState(() => new Set());
  const [noteSnapDivision,  setNoteSnapDivision]  = useState('grid');
  // 'editor' = move/resize/draw; 'velocity' = vertical drag edits note velocity;
  // 'glide' = per-note pitch-glide handles (notes frozen). Selection (click /
  // shift-click / marquee) is identical in all three.
  const [toolMode,          setToolMode]          = useState('editor');
  // Selected connection claws (glide mode) — mutually exclusive with note
  // selection so the Delete key is unambiguous (claw delete = disconnect).
  const [selectedClawIds,   setSelectedClawIds]   = useState(() => new Set());

  const activeKeyElRef        = useRef(null);
  const gridRef               = useRef(null);
  const gridCanvasRef         = useRef(null);   // pinned grid-line canvas over the piano-roll viewport
  const noteMarqueeElRef      = useRef(null);
  const velReadoutElRef       = useRef(null);   // singleton velocity readout (marquee pattern)
  const noteDragRef           = useRef(null);
  const noteMarqueeRef        = useRef(null);
  const editorRootRef         = useRef(null);
  const pianoMousePosRef      = useRef({ x: 0, y: 0 });
  const pianoAutoScrollFrameRef = useRef(null);

  const notesRef              = useRef(notes);              notesRef.current = notes;
  const regionsRef            = useRef(regions);            regionsRef.current = regions;
  const selectedNoteIdsRef    = useRef(selectedNoteIds);    selectedNoteIdsRef.current = selectedNoteIds;
  const noteSnapRef           = useRef(noteSnapDivision);   noteSnapRef.current = noteSnapDivision;
  const toolModeRef           = useRef(toolMode);           toolModeRef.current = toolMode;
  const selectedClawIdsRef    = useRef(selectedClawIds);    selectedClawIdsRef.current = selectedClawIds;
  const magnetOnRef           = useRef(magnetOn);           magnetOnRef.current = magnetOn;
  const pixelsPerMeasureRef   = useRef(pixelsPerMeasure);   pixelsPerMeasureRef.current = pixelsPerMeasure;

  // ── Grid-line canvas ─────────────────────────────────────────
  // Per-line whole-pixel-snapped grid for the piano roll (smooth zoom + crisp lines).
  // leftInset = sticky keys-column width so lines never draw under the keys.
  const drawPianoGrid = useCallback(() => {
    const el = pianoScrollRef.current;
    if (!el) return;
    drawGrid(gridCanvasRef.current, {
      scrollLeft: el.scrollLeft,
      viewW: el.clientWidth,
      viewH: el.clientHeight,
      ppm: pixelsPerMeasure,
      zoomLevel,
      leftInset: KEYS_W,
    });
  }, [pixelsPerMeasure, zoomLevel, pianoScrollRef]);

  // Redraw on zoom/theme/tab/totalMeasures (layout phase). Scroll redraws ride the
  // .pianoRoll onScroll wrapper; resize redraws ride the ResizeObserver below.
  useLayoutEffect(() => { drawPianoGrid(); }, [drawPianoGrid, isDarkMode, totalMeasures, activeTab]);
  useEffect(() => {
    const el = pianoScrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => drawPianoGrid());
    obs.observe(el);
    return () => obs.disconnect();
  }, [drawPianoGrid, pianoScrollRef]);

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

  // Prime the per-track audition synth (useWorkstationAudio) so sampled
  // instruments start their buffer download on editor open / instrument switch
  // instead of dead-clicking on the first preview. Idempotent (cache hit is a
  // no-op) and feeds the existing 'audition:<trackId>' loading indicator.
  useEffect(() => {
    if (track?.id) auditionPrime?.(track.id);
  }, [track?.id, track?.instrument, auditionPrime]);

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
        // Mid-drag the snapshot (clusterIds/initByID) keeps operating on the
        // selection — clearing it here would desync selection from the drag.
        if (noteDragRef.current) return;
        setSelectedNoteIds(new Set());
        setSelectedClawIds(new Set());
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

  // Drums are one-shots — glide is meaningless; kick back to the editor if
  // the instrument flips to a kit while the glide tool is active. (Custom
  // instruments DO support glide — a mono glide composite reproduces their tone.)
  const isDrumTrack = isDrumKit(track?.instrument);
  useEffect(() => {
    if (isDrumTrack && toolMode === 'glide') setToolMode('editor');
  }, [isDrumTrack, toolMode]);

  // Claw delete — CAPTURE phase so it wins deterministically over the shell's
  // bubble-phase note-delete listener (a selected claw means "disconnect",
  // never "delete notes"). endPitch is retained: the host keeps gliding, the
  // freed next note simply re-attacks.
  useEffect(() => {
    const onKeyCapture = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const claws = selectedClawIdsRef.current;
      if (!claws.size) return;
      const el = document.activeElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      e.stopPropagation();
      e.preventDefault();
      const updates = [];
      for (const id of claws) {
        const n = notesRef.current.find(x => x.id === id);
        if (!n?.glide) continue;
        updates.push({ id, glide: normalizeGlide({ ...n.glide, connected: false }, n.note) });
      }
      if (updates.length) onCommitNoteEdits?.(updates);
      setSelectedClawIds(new Set());
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, [onCommitNoteEdits]);

  // ── Key preview handlers ──────────────────────────────────
  // Previews go through the hook's per-track audition synth, which is connected
  // to the track's volume node — so they ride volume → pan → FX → mute exactly
  // like region playback. Drum choke, one-shot skip-release, and the unloaded-
  // sampler guard all live inside the audition API.
  const previewAttack = (note, velocity) => auditionAttack?.(track?.id, note, velocity);
  const previewRelease = () => auditionReleaseAll?.(track?.id);
  function handleMouseDown(note, e) {
    Tone.start().then(() => previewAttack(note));
    activeKeyElRef.current?.classList.remove(styles.keyActive);
    activeKeyElRef.current = e.currentTarget;
    e.currentTarget.classList.add(styles.keyActive);
  }
  function handleMouseEnter(note, e) {
    if (e.buttons !== 1) return;
    previewRelease();
    activeKeyElRef.current?.classList.remove(styles.keyActive);
    activeKeyElRef.current = e.currentTarget;
    e.currentTarget.classList.add(styles.keyActive);
    previewAttack(note);
  }
  function handleMouseUp() {
    previewRelease();
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

  // Redraw one note's glide overlay (path + handles, base + ghost iterations)
  // from a draft glide — direct SVG attribute mutation only (Zero-Re-render).
  // Geometry (left/width/noteY) was stamped on each <g> at render time.
  function redrawGlideNote(id, draft) {
    const groups = gridRef.current?.querySelectorAll(`[data-glide-note-id="${id}"]`);
    if (!groups) return;
    const y1 = keyIndexOf(draft.endPitch) * KEY_H + (KEY_H - 1) / 2;
    groups.forEach(gEl => {
      const left  = Number(gEl.dataset.left)  || 0;
      const width = Number(gEl.dataset.width) || 1;
      const y0    = Number(gEl.dataset.noteY) || 0;
      const x0 = left + draft.startOffset * width;
      const x1 = left + width;
      gEl.querySelector('[data-glide-path]')?.setAttribute('d',
        svgPathFor({ xFlat: left, x0, y0, x1, y1, tension: draft.tension }));
      // querySelectorAll: each handle is a visible circle + its invisible
      // hit twin sharing the data attribute — both must track the drag.
      gEl.querySelectorAll('[data-glide-left]').forEach(l => {
        l.setAttribute('cx', x0); l.setAttribute('cy', y0);
      });
      gEl.querySelectorAll('[data-glide-right]').forEach(r => {
        r.setAttribute('cx', x1); r.setAttribute('cy', y1);
      });
      gEl.querySelectorAll('[data-glide-claw]').forEach(c => {
        c.setAttribute('cx', x1); c.setAttribute('cy', y1);
      });
      const tp = tensionHandlePoint({ x0, y0, x1, y1, tension: draft.tension });
      gEl.querySelectorAll('[data-glide-tension]').forEach(tEl => {
        tEl.setAttribute('cx', tp.x); tEl.setAttribute('cy', tp.y);
        tEl.style.display = y1 === y0 ? 'none' : '';
      });
    });
  }

  // ── Glide handle mousedown — arm a glide drag (left/right/tension) ──
  function handleGlideHandleDown(e, note, handle) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    // Selection mirrors the note-body rule: an unselected note collapses the
    // selection to itself; a selected one keeps the cluster (group deltas).
    const cur = selectedNoteIdsRef.current;
    const nextSelection = cur.has(note.id) ? new Set(cur) : new Set([note.id]);
    setSelectedNoteIds(nextSelection);
    if (selectedClawIdsRef.current.size) setSelectedClawIds(new Set());

    const endPitch0 = note.glide?.endPitch ?? note.note;
    if (handle === 'glide-right') {
      // Audition the glide target on grab; row crossings re-fire (glissando).
      Tone.start().then(() => previewAttack(endPitch0, (note.velocity ?? 100) / 120));
    }

    const initByID = new Map();
    for (const id of nextSelection) {
      const n = notesRef.current.find(x => x.id === id);
      if (!n) continue;
      const gEl = gridRef.current?.querySelector(`[data-glide-note-id="${n.id}"][data-note-iter="0"]`);
      initByID.set(id, {
        note: n.note,
        velocity: n.velocity ?? 100,
        startOffset: n.glide?.startOffset ?? 0,
        endKi: keyIndexOf(n.glide?.endPitch ?? n.note),
        tension: n.glide?.tension ?? 0,
        connected: n.glide?.connected ?? false,
        left:  Number(gEl?.dataset.left)  || 0,
        width: Number(gEl?.dataset.width) || 1,
        noteY: Number(gEl?.dataset.noteY) || 0,
      });
    }
    noteDragRef.current = {
      mode: handle, // 'glide-left' | 'glide-right' | 'glide-tension'
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: pianoScrollRef.current?.scrollLeft ?? 0,
      startScrollTop:  pianoScrollRef.current?.scrollTop  ?? 0,
      dragStarted: false,
      clusterIds: [...nextSelection],
      initByID,
      anchorId: note.id,
      shiftKey: e.shiftKey || e.metaKey || e.ctrlKey,
      lastAuditionedNote: handle === 'glide-right' ? endPitch0 : null,
      pendingUpdates: null,
    };
    pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
    // No auto-scroll: handle drags are screen-space gestures (velocity pattern).
  }

  // ── Global mousemove / mouseup for drag + marquee ──
  useEffect(() => {
    // Connect-on-drop (right-anchor release): each edited note connects iff a
    // UNIQUE note starts exactly at its end tick with pitch === the dropped
    // endPitch — drag-onto connects, drag-away disconnects, the claw never
    // lies. Shared tickOf quantization = the compiler's adjacency rule.
    const resolveConnectOnDrop = (updates) => {
      const PPQ = Tone.Transport.PPQ;
      const idxByRegion = new Map();
      return updates.map(u => {
        const n = notesRef.current.find(x => x.id === u.id);
        if (!n) return u;
        const endPitch = u.glide?.endPitch ?? n.note;
        if (!idxByRegion.has(n.regionId)) {
          idxByRegion.set(n.regionId,
            indexNotesByStartTick(notesRef.current.filter(x => x.regionId === n.regionId), PPQ));
        }
        const probe = { ...n, glide: { startOffset: 0, tension: 0, ...(u.glide ?? {}), endPitch, connected: true } };
        const connected = !!resolveGlideTarget(probe, idxByRegion.get(n.regionId), PPQ);
        return { id: u.id, glide: normalizeGlide({
          startOffset: u.glide?.startOffset ?? 0,
          endPitch,
          tension: u.glide?.tension ?? 0,
          connected,
        }, n.note) };
      });
    };

    const onMove = (e) => {
      pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
      // Drag path
      const dD = noteDragRef.current;
      // Glide tool: note bodies are frozen — selection only, no movement.
      if (dD && dD.mode === 'glide-select') return;
      if (dD && (dD.mode === 'glide-left' || dD.mode === 'glide-right' || dD.mode === 'glide-tension')) {
        // Screen-space deltas (no auto-scroll in glide drags). The anchor's
        // delta applies uniformly to the whole cluster, clamped per note.
        const dx = e.clientX - dD.startX;
        const dy = e.clientY - dD.startY;
        if (!dD.dragStarted && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!dD.dragStarted) {
          dD.dragStarted = true;
          document.body.classList.add('is-glide-dragging');
        }
        const anchorInit = dD.initByID.get(dD.anchorId);
        if (!anchorInit) return;
        // Per-mode anchor delta.
        const dRows = Math.round(dy / KEY_H); // KEYS is high→low: down = +index
        const dOffset = dx / Math.max(anchorInit.width, 1);
        let dTension = 0;
        if (dD.mode === 'glide-tension') {
          // Handle sits at y0 + (y1−y0)(0.5 + tension/4) ⇒ tension = 4·(yH−mid)/(y1−y0).
          const y1a = anchorInit.endKi * KEY_H + (KEY_H - 1) / 2;
          let span = y1a - anchorInit.noteY;
          if (Math.abs(span) < 2 * KEY_H) span = Math.sign(span || 1) * 2 * KEY_H;
          dTension = (4 * dy) / span;
        }
        const updates = [];
        for (const id of dD.clusterIds) {
          const init = dD.initByID.get(id);
          if (!init) continue;
          let so = init.startOffset, ki = init.endKi, tn = init.tension;
          if (dD.mode === 'glide-left')       so = Math.max(0, Math.min(1, init.startOffset + dOffset));
          else if (dD.mode === 'glide-right') ki = Math.max(0, Math.min(KEYS.length - 1, init.endKi + dRows));
          else                                tn = Math.max(-TENSION_LIMIT, Math.min(TENSION_LIMIT, init.tension + dTension));
          const draft = { startOffset: so, endPitch: KEYS[ki].name, tension: tn, connected: init.connected };
          updates.push({ id, glide: normalizeGlide(draft, init.note) });
          redrawGlideNote(id, draft);
        }
        dD.pendingUpdates = updates;
        if (dD.mode === 'glide-right') {
          // Glissando audition on row crossings + endPitch readout at the anchor.
          const anchorKi = Math.max(0, Math.min(KEYS.length - 1, anchorInit.endKi + dRows));
          const pitch = KEYS[anchorKi].name;
          if (pitch !== dD.lastAuditionedNote) {
            auditionRelease?.(track?.id, dD.lastAuditionedNote);
            auditionAttack?.(track?.id, pitch, (anchorInit.velocity ?? 100) / 120);
            dD.lastAuditionedNote = pitch;
          }
          const ro = velReadoutElRef.current;
          if (ro) {
            ro.style.left = `${anchorInit.left + anchorInit.width + 6}px`;
            ro.style.top  = `${anchorKi * KEY_H - 16}px`;
            ro.style.opacity = '1';
            ro.textContent = pitch;
          }
        }
        return;
      }
      if (dD && dD.mode === 'velocity') {
        // Velocity drag: pure screen-space dy (no auto-scroll in this mode, so
        // no scroll compensation). Up = louder; 1 px = 1 velocity unit — the
        // full 1–120 sweep fits in ~120 px. Same integer delta to the whole
        // cluster, clamped per note. DOM-only during the drag (bar width % is
        // iteration-agnostic, so one write covers base + region-clipped
        // ghosts); one commit on mouseup.
        const dy = dD.startY - e.clientY;
        if (!dD.dragStarted && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (!dD.dragStarted) {
          dD.dragStarted = true;
          document.body.classList.add('is-note-dragging', 'is-velocity-dragging');
        }
        const delta = Math.round(dy);
        const updates = [];
        for (const id of dD.clusterIds) {
          const init = dD.initByID.get(id);
          if (!init) continue;
          const v = Math.max(1, Math.min(120, init.velocity + delta));
          updates.push({ id, velocity: v });
          gridRef.current?.querySelectorAll(`[data-note-id="${id}"]`)?.forEach(el => {
            const bar = el.querySelector('[data-vel-bar]');
            if (bar) bar.style.width = `${(v / 120) * 100}%`;
          });
        }
        dD.pendingUpdates = updates;
        // Numeric readout above the anchor note's base iteration.
        const anchorV = updates.find(u => u.id === dD.anchorId)?.velocity;
        const ro = velReadoutElRef.current;
        const anchorEl = gridRef.current?.querySelector(
          `[data-note-id="${dD.anchorId}"][data-note-iter="0"]`);
        if (ro && anchorEl && anchorV != null) {
          ro.style.left = anchorEl.style.left;
          ro.style.top  = `${(parseInt(anchorEl.style.top, 10) || 0) - 16}px`;
          ro.style.opacity = '1';
          ro.textContent = anchorV;
        }
        return;
      }
      if (dD) {
        // Compensate for auto-scroll: while the cursor holds still at an edge, the
        // grid content scrolls underneath it, so the lane/beat under the cursor
        // changes even though clientX/Y don't. Adding the scroll delta makes dx/dy
        // grid-content-relative so the note tracks the cursor during auto-scroll.
        const sc = pianoScrollRef.current;
        const sdx = (sc?.scrollLeft ?? 0) - dD.startScrollLeft;
        const sdy = (sc?.scrollTop  ?? 0) - dD.startScrollTop;
        const dx = (e.clientX - dD.startX) + sdx;
        const dy = (e.clientY - dD.startY) + sdy;
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
        // Live pitch preview: when the anchor note crosses a key row, swap the
        // audition voice to the new pitch. The pitch-change gate is the throttle
        // (fires once per row crossing, not per mousemove). Resize modes clamp
        // cdKey to 0 so only 'move' can retrigger. Drum kits: release is a
        // no-op (one-shot), so each row crossing fires the new piece —
        // matching side-key glissando behavior.
        if (dD.mode === 'move') {
          const anchor = updates.find(u => u.id === dD.anchorId);
          if (anchor && anchor.note !== dD.lastAuditionedNote) {
            auditionRelease?.(track?.id, dD.lastAuditionedNote);
            auditionAttack?.(track?.id, anchor.note);
            dD.lastAuditionedNote = anchor.note;
          }
        }
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
      // Release any note auditioned on grid/note mousedown (precedes the early
      // returns below so it fires for placement, note-drag, and marquee paths).
      // Drum one-shots are a no-op inside auditionReleaseAll.
      auditionReleaseAll?.(track?.id);
      // Drag end
      const dD = noteDragRef.current;
      if (dD) {
        noteDragRef.current = null;
        document.body.classList.remove('is-note-dragging', 'is-velocity-dragging', 'is-glide-dragging');
        const ro = velReadoutElRef.current;
        if (ro) { ro.style.opacity = '0'; ro.textContent = ''; }
        stopPianoAutoScroll();
        // Right-anchor release: resolve connections (drag-onto = claw grabs,
        // drag-away = disconnect) before the commit.
        if (dD.mode === 'glide-right' && dD.dragStarted && dD.pendingUpdates) {
          dD.pendingUpdates = resolveConnectOnDrop(dD.pendingUpdates);
        }
        // Claw click (sub-threshold press on a connected right anchor):
        // select the claw for Delete-to-disconnect. Mutually exclusive with
        // note selection so Delete is unambiguous.
        if (dD.mode === 'glide-right' && !dD.dragStarted) {
          const n = notesRef.current.find(x => x.id === dD.anchorId);
          if (n?.glide?.connected) {
            const PPQ = Tone.Transport.PPQ;
            const idx = indexNotesByStartTick(
              notesRef.current.filter(x => x.regionId === n.regionId), PPQ);
            if (resolveGlideTarget(n, idx, PPQ)) {
              setSelectedClawIds(prev => {
                const next = dD.shiftKey ? new Set(prev) : new Set();
                next.add(dD.anchorId);
                return next;
              });
              setSelectedNoteIds(new Set());
              return;
            }
          }
        }
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
          // Velocity/glide tools: empty-grid click only deselects — creating
          // notes that then can't be moved would be a foot-gun.
          if (toolModeRef.current === 'velocity' || toolModeRef.current === 'glide') {
            setSelectedNoteIds(new Set());
            return;
          }
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
  }, [onCommitNoteEdits, onNoteAdd, track?.id, stopPianoAutoScroll,
      auditionAttack, auditionRelease, auditionReleaseAll]);

  // ── Note mousedown — selection + drag arming ──
  function handleNoteMouseDown(e, note) {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Audition the grabbed note's pitch at its own velocity (released in the
    // window mouseup below).
    Tone.start().then(() => previewAttack(note.note, (note.velocity ?? 100) / 120));

    const rect = e.currentTarget.getBoundingClientRect();
    const xInNote = e.clientX - rect.left;
    const noteW = rect.width;
    let mode = 'move';
    if (toolModeRef.current === 'velocity') {
      // Velocity tool: no move/resize — vertical drag edits velocity.
      mode = 'velocity';
    } else if (toolModeRef.current === 'glide') {
      // Glide tool: notes are frozen — the note body only selects; edits go
      // through the SVG handles (handleGlideHandleDown).
      mode = 'glide-select';
    } else if (noteW >= 14) {
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
    if (selectedClawIdsRef.current.size) setSelectedClawIds(new Set());

    // Snapshot cluster (use the post-mousedown selection)
    const initByID = new Map();
    for (const id of nextSelection) {
      const n = notesRef.current.find(x => x.id === id);
      if (!n) continue;
      initByID.set(id, {
        startBeat: n.startBeat,
        durationBeats: n.durationBeats,
        note: n.note,
        velocity: n.velocity ?? 100,
      });
    }
    noteDragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      // Scroll origin so onMove can keep the drag delta grid-content-relative
      // (the note follows the cursor while auto-scroll moves the content).
      startScrollLeft: pianoScrollRef.current?.scrollLeft ?? 0,
      startScrollTop:  pianoScrollRef.current?.scrollTop  ?? 0,
      dragStarted: false,
      clusterIds: [...nextSelection],
      initByID,
      anchorId: note.id,
      // Seed for the live drag pitch preview (mousedown already auditioned this).
      lastAuditionedNote: note.note,
      pendingUpdates: null,
    };
    pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
    // Velocity drags are pure screen-space dy — nothing moves in grid content,
    // so edge auto-scroll would only fight the gesture.
    if (mode !== 'velocity') startPianoAutoScroll();
  }

  // Cursor hint on hover
  function handleNoteHover(e) {
    if (toolModeRef.current === 'velocity') {
      e.currentTarget.style.cursor = 'ns-resize';
      return;
    }
    if (toolModeRef.current === 'glide') {
      e.currentTarget.style.cursor = 'default'; // frozen — edits go through the handles
      return;
    }
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
    // Audition the pitch under the cursor (press-and-hold; released in the window
    // mouseup below). Reuses the key-preview synth → track's instrument.
    const auditionName = KEYS[Math.floor(y / KEY_H)]?.name;
    if (auditionName) Tone.start().then(() => previewAttack(auditionName));
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
    if (selectedClawIdsRef.current.size) setSelectedClawIds(new Set());
    pianoMousePosRef.current = { x: e.clientX, y: e.clientY };
    startPianoAutoScroll();
  }

  // ── Grid contextmenu — right-click anywhere in the grid opens the note
  // menu for the current selection. Catches empty grid, region highlights,
  // glide curves, and the SVG anchor circles (all of which bubble here —
  // note bodies and claw hit-circles stopPropagation with their own
  // handlers). No target filter on purpose: bubbled events are the point.
  function handleGridContextMenu(e) {
    e.preventDefault();
    // Stale-id guard: the selection ref can briefly hold just-deleted ids.
    let anchorId = null;
    for (const id of selectedNoteIdsRef.current) {
      if (notesRef.current.some(n => n.id === id)) { anchorId = id; break; }
    }
    if (!anchorId) return; // no live selection — just suppress the browser menu
    onNoteContextMenu?.(e.clientX, e.clientY, anchorId, toolModeRef.current);
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
            <div className={styles.toolToggle}>
              {['editor', 'velocity', 'glide'].map(m => {
                const glideBlocked = m === 'glide' && isDrumTrack;
                const titles = {
                  editor:   'Editor — move / resize / draw notes',
                  velocity: 'Velocity tool — drag notes vertically to set velocity (1–120)',
                  glide:    glideBlocked
                    ? 'Drums are one-shots — glide unavailable'
                    : 'Glide — shape per-note pitch glides; drop the right point on the next note to connect (legato)',
                };
                return (
                  <button
                    key={m}
                    className={`${styles.toolBtn}${toolMode === m ? ` ${styles.toolBtnActive}` : ''}`}
                    onClick={() => setToolMode(m)}
                    disabled={glideBlocked}
                    title={titles[m]}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
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
              {SAMPLED_MELODIC_NAMES.map(i => <option key={i} value={i}>{i}</option>)}
            </optgroup>
            <optgroup label="drums">
              {DRUM_KIT_NAMES.map(i => <option key={i} value={i}>{i}</option>)}
            </optgroup>
            {customInstrumentList().length > 0 && (
              <optgroup label="custom">
                {customInstrumentList().map(ci => <option key={ci.id} value={ci.id}>{ci.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>

        <EffectsList
          effects={track?.effects ?? []}
          trackId={track?.id}
          onAdd={onEffectAdd}
          onRemove={onEffectRemove}
          onToggleBypass={onEffectToggleBypass}
        />
      </div>

      {/* Left-column resizer */}
      <div data-no-note-deselect className={styles.colResizer} onMouseDown={onLeftColResize} />

      {/* Piano roll scroll container — always mounted */}
      <div
        ref={pianoScrollRef}
        className={styles.pianoRoll}
        onScroll={(e) => { drawPianoGrid(); onGridScroll?.(e); }}
      >
        {/* Grid lines: canvas pinned to the scroll viewport, per-line-snapped on
            scroll/zoom/resize/theme. Behind the keys + grid content. */}
        <div className={styles.gridCanvasHolder}><canvas ref={gridCanvasRef} /></div>
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
            }}
            onMouseDown={handleGridMouseDown}
            onContextMenu={handleGridContextMenu}
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
              if (!(baseLoop > 0)) return [];
              // Phase-aware loop unroll: occurrences at firstOffset + j*baseLoop (loopMath),
              // wrapping the home cycle by the region's loopPhase. phase 0 ⇒ old i*baseLoop.
              const phase = (r.loopInterval ?? null) !== null ? (r.loopPhase ?? 0) : 0;
              const homeLocalMeasures = n.startBeat / 4 - clipOffset;
              const firstOff = firstLoopOffsetMeasures(homeLocalMeasures, phase, baseLoop);
              const out = [];
              const regionStartBeat = r.startMeasure * 4;
              const regionEndBeat   = (r.startMeasure + r.durationMeasures) * 4;
              const isSelected = selectedNoteIds.has(n.id);
              // Dim + desaturate to match the grayed-out parent region (per-region
              // mute) or a cascading track mute — mirrors the arrangement's
              // `r.isMuted || t.isMuted` rule. Purely visual; notes stay editable.
              const muted = !!(r.isMuted || track?.isMuted);
              for (let j = 0; ; j++) {
                const globalLeftBeat  = regionStartBeat + (firstOff + j * baseLoop) * 4;
                // No later occurrence helps once we're past the region's right edge.
                if (globalLeftBeat >= regionEndBeat) break;
                const noteEndBeat     = globalLeftBeat + n.durationBeats;
                // Clip to region bounds (bugs 7.1/7.2).
                const visibleLeft  = Math.max(globalLeftBeat, regionStartBeat);
                const visibleRight = Math.min(noteEndBeat, regionEndBeat);
                if (visibleRight <= visibleLeft) continue;
                const ghost = j > 0;
                out.push(
                  <div
                    key={`${n.id}-${j}`}
                    data-note-id={n.id}
                    data-note-iter={j}
                    className={`${styles.noteBlock}${ghost ? ` ${styles.noteBlockGhost}` : ''}${!ghost && isSelected ? ` ${styles.noteSelected}` : ''}${muted ? ` ${styles.noteMuted}` : ''}${toolMode === 'glide' ? ` ${styles.noteDimmed}` : ''}`}
                    style={{
                      top:    keyIndex * KEY_H,
                      // Round to a whole pixel so a note on a beat lands exactly on the
                      // (now crisp) grid beat line instead of ~0.75px off it.
                      left:   Math.round(visibleLeft * ppb),
                      width:  Math.max((visibleRight - visibleLeft) * ppb - 1, 2),
                      height: KEY_H - 1,
                    }}
                    onMouseDown={ghost ? undefined : (e) => handleNoteMouseDown(e, n)}
                    onMouseMove={ghost ? undefined : handleNoteHover}
                    onContextMenu={ghost ? undefined : (e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (!selectedNoteIdsRef.current.has(n.id)) setSelectedNoteIds(new Set([n.id]));
                      // Glide mode opens the compact glide menu (connect / glide-to).
                      onNoteContextMenu?.(e.clientX, e.clientY, n.id, toolModeRef.current);
                    }}
                  >
                    {/* Velocity gauge — left-anchored, width = velocity/120 of the
                        rendered (clipped) note. Percentage width keeps one drag
                        write valid for base + ghost iterations alike. */}
                    {toolMode === 'velocity' && (
                      <div
                        data-vel-bar
                        className={styles.velBar}
                        style={{ width: `${((n.velocity ?? 100) / 120) * 100}%` }}
                      />
                    )}
                  </div>
                );
              }
              return out;
            })}

            {/* Glide overlay — one SVG over the whole grid (pointer-events:
                none; handles opt back in), rendered only in glide mode.
                Ghost loop iterations get non-interactive path copies. Each
                <g> is stamped with its geometry so drag redraws (direct
                attribute mutation) never re-derive region math. */}
            {activeTab === 'notes' && toolMode === 'glide' && (
              <svg
                className={styles.glideSvg}
                width={gridMinWidth}
                height={PIANO_ROLL_H}
                // Opt out of the click-away deselect (capture-phase window
                // mousedown): the handles/claws are NOT inside [data-note-id]
                // divs, so without this a handle grab wipes the selection
                // before handleGlideHandleDown can snapshot the cluster.
                data-no-note-deselect=""
              >
                {(() => {
                  const PPQ = Tone.Transport.PPQ;
                  const byRegion = new Map();
                  for (const n of notes) {
                    if (!byRegion.has(n.regionId)) byRegion.set(n.regionId, []);
                    byRegion.get(n.regionId).push(n);
                  }
                  const idxByRegion = new Map(
                    [...byRegion].map(([rid, arr]) => [rid, indexNotesByStartTick(arr, PPQ)]));
                  // Claws render in a TOP layer after every note group: a
                  // connected host's right anchor coincides with its target's
                  // left anchor (that's what "connected" means), so the
                  // later-painted target group would otherwise win every
                  // click. The claw is a ring whose STROKE is the hit area
                  // (pointer-events: visibleStroke) — ring edge selects/drags
                  // the claw; the ring hole still reaches the target's left
                  // anchor underneath.
                  const claws = [];
                  const groups = notes.flatMap(n => {
                    const r = regions?.find(rg => rg.id === n.regionId);
                    if (!r) return [];
                    const ki0 = keyIndexOf(n.note);
                    if (ki0 < 0) return [];
                    const clipOffset      = r.clipOffset ?? 0;
                    const baseLoop        = (r.loopInterval ?? null) !== null ? r.loopInterval : r.durationMeasures;
                    const windowStartBeat = clipOffset * 4;
                    const windowEndBeat   = (clipOffset + baseLoop) * 4;
                    if (n.startBeat < windowStartBeat || n.startBeat >= windowEndBeat) return [];
                    if (!(baseLoop > 0)) return [];
                    const phase = (r.loopInterval ?? null) !== null ? (r.loopPhase ?? 0) : 0;
                    const firstOff = firstLoopOffsetMeasures(n.startBeat / 4 - clipOffset, phase, baseLoop);
                    const regionStartBeat = r.startMeasure * 4;
                    const regionEndBeat   = (r.startMeasure + r.durationMeasures) * 4;
                    const g  = n.glide;
                    const so = g?.startOffset ?? 0;
                    const endPitch = g?.endPitch ?? n.note;
                    const tn = g?.tension ?? 0;
                    const ki1 = keyIndexOf(endPitch);
                    const y0 = ki0 * KEY_H + (KEY_H - 1) / 2;
                    const y1 = (ki1 < 0 ? ki0 : ki1) * KEY_H + (KEY_H - 1) / 2;
                    const connectedResolved = !!(g?.connected
                      && resolveGlideTarget(n, idxByRegion.get(n.regionId), PPQ));
                    const clawSelected = selectedClawIds.has(n.id);
                    const out = [];
                    for (let j = 0; ; j++) {
                      const globalLeftBeat = regionStartBeat + (firstOff + j * baseLoop) * 4;
                      if (globalLeftBeat >= regionEndBeat) break;
                      const noteEndBeat  = globalLeftBeat + n.durationBeats;
                      const visibleLeft  = Math.max(globalLeftBeat, regionStartBeat);
                      const visibleRight = Math.min(noteEndBeat, regionEndBeat);
                      if (visibleRight <= visibleLeft) continue;
                      const ghost = j > 0;
                      const left  = Math.round(visibleLeft * ppb);
                      const width = Math.max((visibleRight - visibleLeft) * ppb - 1, 2);
                      const x0 = left + so * width;
                      const x1 = left + width;
                      const tp = tensionHandlePoint({ x0, y0, x1, y1, tension: tn });
                      if (!ghost && connectedResolved) {
                        claws.push({ n, x1, y1, left, width, y0, clawSelected });
                      }
                      out.push(
                        <g
                          key={`gl-${n.id}-${j}`}
                          data-glide-note-id={n.id}
                          data-note-iter={j}
                          data-left={left}
                          data-width={width}
                          data-note-y={y0}
                          className={ghost ? styles.glideGhost : undefined}
                        >
                          <path
                            data-glide-path
                            className={styles.glidePath}
                            d={svgPathFor({ xFlat: left, x0, y0, x1, y1, tension: tn })}
                          />
                          {!ghost && (
                            <>
                              {/* Visible handles stay small; each gets an
                                  invisible r=8 hit twin painted after it (the
                                  glideClawHit pattern) so grabs don't demand
                                  ±4px precision — misses used to land on the
                                  grid and trigger the empty-click deselect.
                                  Twins share the data attribute so
                                  redrawGlideNote moves both. */}
                              <circle
                                data-glide-left
                                cx={x0} cy={y0} r={3.5}
                                className={`${styles.glideAnchor} ${styles.glideAnchorLeft}`}
                                onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-left')}
                              />
                              <circle
                                data-glide-left
                                cx={x0} cy={y0} r={8}
                                className={`${styles.glideHandleHit} ${styles.glideAnchorLeft}`}
                                onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-left')}
                              />
                              <circle
                                data-glide-right
                                cx={x1} cy={y1} r={3.5}
                                className={`${styles.glideAnchor} ${styles.glideAnchorRight}`}
                                onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-right')}
                              />
                              <circle
                                data-glide-right
                                cx={x1} cy={y1} r={8}
                                className={`${styles.glideHandleHit} ${styles.glideAnchorRight}`}
                                onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-right')}
                              />
                              {y1 !== y0 && (
                                <>
                                  <circle
                                    data-glide-tension
                                    cx={tp.x} cy={tp.y} r={3}
                                    className={styles.glideTension}
                                    onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-tension')}
                                  />
                                  <circle
                                    data-glide-tension
                                    cx={tp.x} cy={tp.y} r={8}
                                    className={`${styles.glideHandleHit} ${styles.glideHandleHitMove}`}
                                    onMouseDown={(e) => handleGlideHandleDown(e, n, 'glide-tension')}
                                  />
                                </>
                              )}
                            </>
                          )}
                        </g>
                      );
                    }
                    return out;
                  });
                  const clawEls = claws.map(c => (
                    <g
                      key={`claw-${c.n.id}`}
                      data-glide-note-id={c.n.id}
                      data-note-iter="claw"
                      data-left={c.left}
                      data-width={c.width}
                      data-note-y={c.y0}
                    >
                      <circle
                        data-glide-claw
                        cx={c.x1} cy={c.y1} r={7}
                        className={`${styles.glideClaw}${c.clawSelected ? ` ${styles.clawSelected}` : ''}`}
                      />
                      <circle
                        data-glide-claw
                        cx={c.x1} cy={c.y1} r={7}
                        className={styles.glideClawHit}
                        onMouseDown={(e) => handleGlideHandleDown(e, c.n, 'glide-right')}
                        onContextMenu={(e) => {
                          e.preventDefault(); e.stopPropagation();
                          if (!selectedNoteIdsRef.current.has(c.n.id)) setSelectedNoteIds(new Set([c.n.id]));
                          onNoteContextMenu?.(e.clientX, e.clientY, c.n.id, 'glide');
                        }}
                      />
                    </g>
                  ));
                  return [...groups, ...clawEls];
                })()}
              </svg>
            )}

            <div ref={noteMarqueeElRef} className={styles.noteMarquee} />
            <div ref={velReadoutElRef} className={styles.velReadout} />
            <div ref={pianoRollPlayheadRef} className={styles.playhead} />
          </div>
        )}
      </div>

      {/* Effects rack — full modular grid for the effects tab. Overlays the grid
          (outside the scroll container so it never affects scrollWidth, bug 12). */}
      {activeTab === 'effects' && (
        <EffectsRack
          effects={track?.effects ?? []}
          trackId={track?.id}
          onAdd={onEffectAdd}
          onRemove={onEffectRemove}
          onToggleBypass={onEffectToggleBypass}
          onUpdate={onEffectUpdate}
          performanceQuality={performanceQuality}
          automatedKeys={automatedFxKeys}
        />
      )}

      {/* Performance UI overlay — outside the scroll container so it never affects scrollWidth (bug 12).
          Uses the LOCAL instrument state so the panel flips drum/melodic in the same commit as the dropdown. */}
      {activeTab === 'instrument' && (
        <InstrumentPanel
          trackId={track?.id}
          instrument={instrument}
          volume={track?.volume ?? 75}
          envelope={track?.envelope}
          isLoading={!!(track?.id && loadingTrackIds?.has(track.id))}
          onVolumeChange={onVolumeChange}
          onEnvelopeChange={onEnvelopeChange}
          auditionAttack={auditionAttack}
          auditionRelease={auditionRelease}
          auditionReleaseAll={auditionReleaseAll}
          auditionPrime={auditionPrime}
        />
      )}

      </div>
    </div>
  );
}
