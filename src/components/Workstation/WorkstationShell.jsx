import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './WorkstationShell.module.css';
import RegionEditor from './RegionEditor/RegionEditor';

const PIXELS_PER_BEAT    = 25;
const PIXELS_PER_MEASURE = PIXELS_PER_BEAT * 4;  // 100px at zoom 1
// BPM and totalMeasures are state inside the component
const TRACK_COLORS = [
  '#5DCAA5', // teal (brand accent)
  '#5A9FD4', // blue
  '#D4845A', // coral
  '#A57BD4', // purple
  '#D4C45A', // amber
  '#D45A7B', // rose
  '#7BD45A', // lime
];
const TRACK_H            = 72;  // matches .trackLane height in CSS
const RULER_HEIGHT       = 24;  // matches .ruler height in CSS
const MIN_REGION         = 0.0625; // minimum region width in measures (one 16th note)

const formatTime = (t) => {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  const cs   = Math.floor((t % 1) * 100);
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};

// Returns IDs of regions whose bounding box intersects the marquee rectangle (in timeline-scroll-relative px).
function getIntersectingRegionIds(minX, maxX, minY, maxY, regions, tracks, ppm) {
  return regions
    .filter(r => {
      const tIdx   = tracks.findIndex(t => t.id === r.trackId);
      const rLeft  = r.startMeasure * ppm;
      const rRight = (r.startMeasure + r.durationMeasures) * ppm;
      const rTop   = tIdx * TRACK_H;
      const rBot   = (tIdx + 1) * TRACK_H;
      return rLeft < maxX && rRight > minX && rTop < maxY && rBot > minY;
    })
    .map(r => r.id);
}

// Returns the smallest power-of-2 measure interval that keeps labels at least 80px apart.
function getMeasureInterval(ppm) {
  return Math.pow(2, Math.max(0, Math.ceil(Math.log2(80 / ppm))));
}

// Returns the snap increment (in measures) matching the smallest visible grid line at this zoom.
// Thresholds mirror computeGridBg exactly: beat lines appear at zoomLevel>=1.5 (ppm>=150),
// sub-beat lines at zoomLevel>=3.0 (ppm>=300). 16th-note lines are never drawn.
function getSnapIncrement(ppm) {
  if (ppm >= 300) return 0.125; // 8th notes
  if (ppm >= 150) return 0.25;  // quarter notes
  return 1;                      // full measures
}

// Used for both arrangement and piano roll grids — returns inline backgroundImage string.
export function computeGridBg(ppm, zoomLevel) {
  const labelStep    = getMeasureInterval(ppm);
  const effectivePpm = ppm * labelStep;
  const ppb = effectivePpm / 4;
  const pp8 = effectivePpm / 8;
  const layers = [
    `repeating-linear-gradient(to right, var(--border-mid) 0, var(--border-mid) 1px, transparent 1px, transparent ${effectivePpm}px)`,
    ...(labelStep === 1 && zoomLevel >= 1.5 ? [`repeating-linear-gradient(to right, var(--border-faint) 0, var(--border-faint) 1px, transparent 1px, transparent ${ppb}px)`] : []),
    ...(labelStep === 1 && zoomLevel >= 3.0 ? [`repeating-linear-gradient(to right, var(--border-subtle) 0, var(--border-subtle) 1px, transparent 1px, transparent ${pp8}px)`] : []),
  ];
  return layers.join(', ');
}

export default function WorkstationShell({ onNavigateHome, isDarkMode, onThemeToggle }) {
  const [isPlaying,      setIsPlaying]      = useState(false);
  const [tracks,         setTracks]         = useState([]);
  const [regions,        setRegions]        = useState([]);
  const [notes,          setNotes]          = useState([]);
  const [zoomLevel,      setZoomLevel]      = useState(1);
  const [editingTrackId, setEditingTrackId] = useState(null);
  const [editorHeight,   setEditorHeight]   = useState(320);
  const [leftColWidth,   setLeftColWidth]   = useState(316);
  const [bpm,            setBpm]            = useState(120);
  const [editingBpm,     setEditingBpm]     = useState(false);
  const [tempBpm,        setTempBpm]        = useState('120');
  const [selectedRegionIds, setSelectedRegionIds] = useState(new Set());
  const [totalMeasures,    setTotalMeasures]    = useState(200);
  const [toastMessage,     setToastMessage]     = useState(null);
  const [activeTrackId,    setActiveTrackId]    = useState(null);
  const [snapEnabled,      setSnapEnabled]      = useState(true);

  // Derived zoom values
  const pixelsPerMeasure = PIXELS_PER_MEASURE * zoomLevel;
  const pxPerSec         = PIXELS_PER_BEAT * (bpm / 60) * zoomLevel;

  const editorWrapRef        = useRef(null);
  const nextIdRef            = useRef(1);
  const nextRegionIdRef      = useRef(1);
  const nextNoteIdRef        = useRef(0);
  const ghostRefs            = useRef({});
  const hoverRef             = useRef({ trackId: null, measure: 0 });
  const dragRef              = useRef(null);
  const playheadRef          = useRef(null);
  const pianoRollPlayheadRef = useRef(null);
  const timeRef              = useRef(null);
  const timelineRef          = useRef(null);
  const rulerRef             = useRef(null);
  const rafRef               = useRef(null);
  const isDraggingRef        = useRef(false);
  const pianoScrollRef       = useRef(null);   // RegionEditor scroll container
  const trackHeadersRef      = useRef(null);
  const pendingScrollRef      = useRef(null);  // arrangement zoom-to-cursor pending scrollLeft
  const pendingPianoScrollRef = useRef(null);  // piano roll pending scrollLeft
  const shellRef              = useRef(null);
  const leftColWidthRef       = useRef(316);
  const regionsRef            = useRef([]);
  const tracksRef             = useRef([]);
  const selectedRegionIdsRef     = useRef(new Set());
  const lastPianoScrollTopRef    = useRef(null); // null = no user scroll yet → default to C4
  const lastDragEndTimeRef       = useRef(0);
  const capturedRegionStartRef   = useRef(null);
  const totalMeasuresRef         = useRef(200);
  const clipboardRef             = useRef(null);
  const notesRef                 = useRef([]);
  const marqueeDragRef           = useRef(null);
  const marqueeElRef             = useRef(null);
  const pasteAnchorTrackIndexRef = useRef(null);
  const autoScrollFrameRef       = useRef(null);
  const currentMousePosRef       = useRef({ x: 0, y: 0 });
  const marqueeHoverIdsRef       = useRef(new Set());
  const snapEnabledRef           = useRef(true);

  // ── Derived editor state ───────────────────────────────────
  const editingTrack      = editingTrackId ? tracks.find(t => t.id === editingTrackId) : null;
  const editingTrackNotes = notes.filter(n => n.trackId === editingTrackId);

  // ── Auto-scroll engine ────────────────────────────────────
  const stopAutoScroll = useCallback(() => {
    cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current) return;
    const THRESHOLD = 80;
    const MAX_SPEED = 15;
    const tick = () => {
      const el = timelineRef.current;
      if (!el) return;
      const b  = el.getBoundingClientRect();
      const { x: mx, y: my } = currentMousePosRef.current;
      let dx = 0, dy = 0;
      const dRight = b.right  - mx;  const dLeft = mx - b.left;
      const dBot   = b.bottom - my;  const dTop  = my - (b.top + RULER_HEIGHT);
      if (dRight < THRESHOLD) dx =  MAX_SPEED * Math.min(1, 1 - dRight / THRESHOLD);
      if (dLeft  < THRESHOLD) dx = -MAX_SPEED * Math.min(1, 1 - dLeft  / THRESHOLD);
      if (dBot   < THRESHOLD) dy =  MAX_SPEED * Math.min(1, 1 - dBot   / THRESHOLD);
      if (dTop   < THRESHOLD) dy = -MAX_SPEED * Math.min(1, 1 - dTop   / THRESHOLD);
      if (dx !== 0) el.scrollLeft = Math.max(0, el.scrollLeft + dx);
      if (dy !== 0) el.scrollTop  = Math.max(0, el.scrollTop  + dy);
      if (dx !== 0 || dy !== 0) {
        const { x, y } = currentMousePosRef.current;
        window.dispatchEvent(new MouseEvent('mousemove', {
          clientX: x, clientY: y, bubbles: true, buttons: 1, cancelable: true,
        }));
      }
      autoScrollFrameRef.current = requestAnimationFrame(tick);
    };
    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const handleAddTrack = useCallback(() => {
    const n = nextIdRef.current++;
    setTracks(prev => [...prev, {
      id: `t${n}`,
      name: `track ${n}`,
      instrument: 'fm pluck',
      color: TRACK_COLORS[(n - 1) % TRACK_COLORS.length],
      isMuted: false,
      isSolo: false,
    }]);
  }, []);

  const toggleMute = (id) => setTracks(prev =>
    prev.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t));
  const toggleSolo = (id) => setTracks(prev =>
    prev.map(t => t.id === id ? { ...t, isSolo: !t.isSolo } : t));

  // ── Note CRUD ───────────────────────────────────────────────
  const handleNoteAdd = useCallback((noteData) => {
    const { trackId, startBeat } = noteData;
    const measure = Math.floor(startBeat / 4);

    const existingRegion = regionsRef.current.find(r =>
      r.trackId === trackId &&
      startBeat >= r.startMeasure * 4 &&
      startBeat < (r.startMeasure + r.durationMeasures) * 4
    );

    if (existingRegion) {
      const bottleOriginBeat = (existingRegion.startMeasure - (existingRegion.clipOffset ?? 0)) * 4;
      setNotes(prev => [...prev, {
        id: `note_${nextNoteIdRef.current++}`, ...noteData,
        startBeat: startBeat - bottleOriginBeat,
        regionId: existingRegion.id,
      }]);
    } else {
      const newRegionId = `region_${nextRegionIdRef.current++}`;
      const newRegion = { id: newRegionId, trackId, startMeasure: measure, durationMeasures: 1, clipOffset: 0 };
      const result = applyDestructiveEdit(regionsRef.current, notesRef.current, newRegion);
      const merged = [...result.regions, newRegion].filter(r => r.durationMeasures > 0);
      const surviving = new Set(merged.map(r => r.id));
      const newNote = {
        id: `note_${nextNoteIdRef.current++}`, ...noteData,
        startBeat: startBeat - measure * 4,
        regionId: newRegionId,
      };
      setRegions(merged);
      setNotes([...result.notes.filter(n => surviving.has(n.regionId)), newNote]);
    }
  }, []);
  const handleNoteRemove = useCallback((noteId) => {
    setNotes(prev => prev.filter(n => n.id !== noteId));
  }, []);

  // ── Ghost region ─────────────────────────────────────────────
  // Returns true if `measure` falls inside any existing region on this track.
  const isPositionOccupied = (trackId, measure) =>
    regions.some(r =>
      r.trackId === trackId &&
      measure >= r.startMeasure &&
      measure < r.startMeasure + r.durationMeasures
    );

  const handleLaneMouseMove = (e, trackId) => {
    if (isDraggingRef.current || dragRef.current || marqueeDragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const measure = Math.max(0, Math.floor(x / pixelsPerMeasure));
    hoverRef.current = { trackId, measure };
    const ghost = ghostRefs.current[trackId];
    if (!ghost) return;
    if (regions.some(r => r.trackId === trackId) || isPositionOccupied(trackId, measure)) {
      ghost.style.opacity = '0';
      return;
    }
    ghost.style.transform = `translateX(${measure * pixelsPerMeasure}px)`;
    ghost.style.width     = `${pixelsPerMeasure}px`;
    ghost.style.opacity   = '0.45';
  };

  const handleLaneMouseLeave = (trackId) => {
    const ghost = ghostRefs.current[trackId];
    if (ghost) ghost.style.opacity = '0';
    if (hoverRef.current.trackId === trackId) {
      hoverRef.current = { trackId: null, measure: 0 };
    }
  };

  const handleLaneClick = (e, trackId) => {
    e.stopPropagation();
    if (isDraggingRef.current) return;
    if (Date.now() - lastDragEndTimeRef.current < 300) return;
    setSelectedRegionIds(new Set());
    setActiveTrackId(trackId);
    const rect    = e.currentTarget.getBoundingClientRect();
    const measure = Math.max(0, Math.floor((e.clientX - rect.left) / pixelsPerMeasure));
    if (regions.some(r => r.trackId === trackId)) {
      seekToClientX(e.clientX);
      pasteAnchorTrackIndexRef.current = tracksRef.current.findIndex(t => t.id === trackId);
      return;
    }
    if (isPositionOccupied(trackId, measure)) return;
    const n = nextRegionIdRef.current++;
    pasteAnchorTrackIndexRef.current = tracksRef.current.findIndex(t => t.id === trackId);
    setRegions(prev => [...prev, { id: `r${n}`, trackId, startMeasure: measure, durationMeasures: 1, clipOffset: 0 }]);
    if (measure + 1 > totalMeasures - 16) setTotalMeasures(prev => prev + 64);
  };

  const stopMouseDown = (e) => e.stopPropagation();

  // ── Destructive edit — trim/split overlapping regions on the same track ──
  // Bottle/Window model: the region is a viewport over a hidden container of notes.
  // Resizing only changes the visible window via startMeasure/durationMeasures/clipOffset.
  // Notes are stored bottle-local and are never deleted by trim/split, only by total eclipse
  // (Case A — the region itself is destroyed).
  const applyDestructiveEdit = useCallback((regions, notes, incoming) => {
    const newStart  = incoming.startMeasure;
    const newEnd    = newStart + incoming.durationMeasures;

    const nextRegions = [];
    let   nextNotes   = notes;

    for (const r of regions) {
      if (r.id === incoming.id || r.trackId !== incoming.trackId) { nextRegions.push(r); continue; }
      const oldStart  = r.startMeasure;
      const oldEnd    = oldStart + r.durationMeasures;
      const oldOffset = r.clipOffset ?? 0;
      if (oldEnd <= newStart || oldStart >= newEnd) { nextRegions.push(r); continue; }

      // Case A: total eclipse — incoming fully covers old region (region + bottle destroyed)
      if (newStart <= oldStart && newEnd >= oldEnd) {
        nextNotes = nextNotes.filter(n => n.regionId !== r.id);
        continue;
      }
      // Case B: right trim — bottle preserved, only window shrinks from the right
      if (newStart > oldStart && newEnd >= oldEnd) {
        nextRegions.push({ ...r, durationMeasures: newStart - oldStart });
        continue;
      }
      // Case C: left trim — bottle preserved; window starts later & advances clipOffset
      if (newStart <= oldStart && newEnd < oldEnd) {
        const shift = newEnd - oldStart;
        nextRegions.push({
          ...r,
          startMeasure: newEnd,
          durationMeasures: oldEnd - newEnd,
          clipOffset: oldOffset + shift,
        });
        continue;
      }
      // Case D: middle split — both halves get an independent copy of the full bottle
      const rightId = `r${nextRegionIdRef.current++}`;
      const rightShift = newEnd - oldStart;
      nextRegions.push(
        { ...r, durationMeasures: newStart - oldStart },
        {
          ...r,
          id: rightId,
          startMeasure: newEnd,
          durationMeasures: oldEnd - newEnd,
          clipOffset: oldOffset + rightShift,
        },
      );
      // Deep-clone every note belonging to r → new note IDs linked to rightId.
      const clones = [];
      for (const n of nextNotes) {
        if (n.regionId === r.id) {
          clones.push({ ...n, id: `note_${nextNoteIdRef.current++}`, regionId: rightId });
        }
      }
      if (clones.length) nextNotes = [...nextNotes, ...clones];
    }

    return { regions: nextRegions, notes: nextNotes };
  }, []);

  // ── Region drag ──────────────────────────────────────────────
  const startRegionDrag = (e, region, mode) => {
    e.stopPropagation();
    e.preventDefault();
    const origTrackIndex = tracksRef.current.findIndex(t => t.id === region.trackId);
    const isMultiDrag = selectedRegionIdsRef.current.has(region.id) && selectedRegionIdsRef.current.size > 1;

    if (!isMultiDrag) {
      setSelectedRegionIds(new Set([region.id]));
      pasteAnchorTrackIndexRef.current = origTrackIndex;
    }

    const companions = isMultiDrag
      ? [...selectedRegionIdsRef.current]
          .filter(id => id !== region.id)
          .flatMap(cId => {
            const r = regionsRef.current.find(x => x.id === cId);
            if (!r) return [];
            const tIdx = tracksRef.current.findIndex(t => t.id === r.trackId);
            const el   = timelineRef.current?.querySelector(`[data-region-id="${cId}"]`) ?? null;
            const co   = r.clipOffset ?? 0;
            return [{
              regionId: cId, trackId: r.trackId, origTrackIndex: tIdx,
              pendingTrackId: r.trackId, pendingTrackIndex: tIdx,
              initStart: r.startMeasure, initDuration: r.durationMeasures, initClipOffset: co,
              pendingStart: r.startMeasure, pendingDuration: r.durationMeasures, pendingClipOffset: co,
              el,
            }];
          })
      : [];

    const regionEl = e.currentTarget.closest('[data-region-id]');
    const co = region.clipOffset ?? 0;
    dragRef.current = {
      regionId:          region.id,
      trackId:           region.trackId,
      origTrackIndex,
      pendingTrackId:    region.trackId,
      pendingTrackIndex: origTrackIndex,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      initStart: region.startMeasure,
      initDuration: region.durationMeasures,
      initClipOffset: co,
      el: regionEl,
      pendingStart: region.startMeasure,
      pendingDuration: region.durationMeasures,
      pendingClipOffset: co,
      startScrollLeft: timelineRef.current?.scrollLeft ?? 0,
      dragStarted: false,
      companions,
    };
  };

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.dragStarted) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.dragStarted = true;
        document.body.classList.add('is-dragging');
        document.body.style.cursor = d.mode === 'move' ? 'grabbing' : 'ew-resize';
        if (d.el) d.el.style.filter = 'brightness(0.6)';
        for (const c of d.companions) { if (c.el) c.el.style.filter = 'brightness(0.6)'; }
      }
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      const snapInc = getSnapIncrement(pixelsPerMeasure);
      const scrollAdjust = (timelineRef.current?.scrollLeft ?? 0) - d.startScrollLeft;
      const rawDelta = (e.clientX - d.startX + scrollAdjust) / pixelsPerMeasure;
      let newStart    = d.pendingStart;
      let newDuration = d.pendingDuration;

      if (d.mode === 'move') {
        const allMembers        = [d, ...d.companions];
        const minInitStart      = Math.min(...allMembers.map(m => m.initStart));
        const minOrigTrackIndex = Math.min(...allMembers.map(m => m.origTrackIndex));
        const maxOrigTrackIndex = Math.max(...allMembers.map(m => m.origTrackIndex));
        const rawNewStart  = d.initStart + rawDelta;
        const actualDelta  = snapEnabledRef.current
          ? Math.round(rawNewStart / snapInc) * snapInc - d.initStart
          : rawDelta;
        const clampedDelta = Math.max(-minInitStart, actualDelta);

        const rect       = timelineRef.current.getBoundingClientRect();
        const relContent = e.clientY - rect.top + timelineRef.current.scrollTop - RULER_HEIGHT;
        const rawTrackDelta     = Math.floor(relContent / TRACK_H) - d.origTrackIndex;
        const clampedTrackDelta = Math.max(
          -minOrigTrackIndex,
          Math.min(tracksRef.current.length - 1 - maxOrigTrackIndex, rawTrackDelta)
        );
        const anchorNewIdx  = d.origTrackIndex + clampedTrackDelta;
        const candTrackId   = tracksRef.current[anchorNewIdx]?.id ?? d.pendingTrackId;
        newStart = d.initStart + clampedDelta;
        const prevTrackId   = d.pendingTrackId;
        d.pendingTrackId    = candTrackId;
        d.pendingTrackIndex = anchorNewIdx;
        if (d.el && candTrackId !== prevTrackId) {
          const color = tracksRef.current.find(t => t.id === candTrackId)?.color;
          if (color) d.el.style.setProperty('--track-color', color);
        }
        for (const c of d.companions) {
          const cStart       = c.initStart + clampedDelta;
          const cIdx         = c.origTrackIndex + clampedTrackDelta;
          const cTrackId     = tracksRef.current[cIdx]?.id ?? c.pendingTrackId;
          const prevCTrackId = c.pendingTrackId;
          c.pendingStart      = cStart;
          c.pendingTrackId    = cTrackId;
          c.pendingTrackIndex = cIdx;
          if (c.el) {
            c.el.style.left      = `${cStart * pixelsPerMeasure}px`;
            c.el.style.transform = `translateY(${(cIdx - c.origTrackIndex) * TRACK_H}px)`;
            c.el.style.zIndex    = '10';
            if (cTrackId !== prevCTrackId) {
              const color = tracksRef.current.find(t => t.id === cTrackId)?.color;
              if (color) c.el.style.setProperty('--track-color', color);
            }
          }
        }
      } else if (d.mode === 'resize-right') {
        const rawEnd     = d.initStart + d.initDuration + rawDelta;
        const snappedEnd = snapEnabledRef.current
          ? Math.round(rawEnd / snapInc) * snapInc
          : rawEnd;
        newDuration = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, snappedEnd - d.initStart);
        const rightActualDelta = newDuration - d.initDuration;
        for (const c of d.companions) {
          c.pendingDuration = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, c.initDuration + rightActualDelta);
          if (c.el) { c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`; c.el.style.zIndex = '10'; }
        }
      } else if (d.mode === 'resize-left') {
        // Bottle/Window: keep bottle origin (initStart - initClipOffset) fixed.
        // clipOffset = initClipOffset + (newStart - initStart) and is allowed to go negative —
        // the window extends past the bottle origin into empty padding (notes stay locked).
        // Constraints: newStart >= 0 (timeline bound), newStart <= initStart + initDuration - snapInc (duration >= snapInc).
        const rawLeft     = d.initStart + rawDelta;
        const snappedLeft = snapEnabledRef.current
          ? Math.round(rawLeft / snapInc) * snapInc
          : rawLeft;
        const preDelta    = snappedLeft - d.initStart;
        const minDur      = snapEnabledRef.current ? snapInc : MIN_REGION;
        const candStart   = Math.max(0, Math.min(d.initStart + preDelta, d.initStart + d.initDuration - minDur));
        newStart            = candStart;
        newDuration         = d.initDuration + (d.initStart - candStart);
        d.pendingClipOffset = d.initClipOffset + (candStart - d.initStart);
        for (const c of d.companions) {
          const cStart    = Math.max(0, Math.min(c.initStart + preDelta, c.initStart + c.initDuration - minDur));
          c.pendingStart       = cStart;
          c.pendingDuration    = c.initDuration + (c.initStart - cStart);
          c.pendingClipOffset  = c.initClipOffset + (cStart - c.initStart);
          if (c.el) {
            c.el.style.left  = `${c.pendingStart    * pixelsPerMeasure}px`;
            c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`;
            c.el.style.zIndex = '10';
          }
        }
      }

      if (d.el) {
        const yOffset = (d.pendingTrackIndex - d.origTrackIndex) * TRACK_H;
        d.el.style.left      = `${newStart    * pixelsPerMeasure}px`;
        d.el.style.width     = `${newDuration * pixelsPerMeasure}px`;
        d.el.style.transform = `translateY(${yOffset}px)`;
        d.el.style.zIndex    = '10';
      }
      d.pendingStart    = newStart;
      d.pendingDuration = newDuration;
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (d) {
        if (d.dragStarted) {
          const resetEl = (el) => {
            if (!el) return;
            el.style.transform = ''; el.style.zIndex = ''; el.style.filter = '';
            el.style.removeProperty('--track-color');
          };
          resetEl(d.el);
          for (const c of d.companions) resetEl(c.el);

          const { regionId, pendingStart, pendingDuration, pendingTrackId, pendingClipOffset } = d;
          const clusterIds = new Set([regionId, ...d.companions.map(c => c.regionId)]);

          const movedRegion = {
            ...regionsRef.current.find(r => r.id === regionId),
            startMeasure: pendingStart, durationMeasures: pendingDuration, trackId: pendingTrackId,
            clipOffset: pendingClipOffset,
          };
          const cluster = [
            movedRegion,
            ...d.companions.map(c => ({
              ...regionsRef.current.find(r => r.id === c.regionId),
              startMeasure: c.pendingStart, durationMeasures: c.pendingDuration, trackId: c.pendingTrackId,
              clipOffset: c.pendingClipOffset,
            })),
          ];

          // Pre-drag startMeasure sidecar — keeps the intrusion-direction signal alive
          // through wall-clamping (when multiple cluster members get pinned to pendingStart=0,
          // the post-clamp startMeasure can't disambiguate who was originally to the right).
          const initStartById = new Map();
          initStartById.set(regionId, d.initStart);
          for (const c of d.companions) initStartById.set(c.regionId, c.initStart);

          // Directional sort: the region whose moving edge intrudes into a neighbor must be
          // processed LAST so it wins. For resize-right that's the leftmost (its right edge
          // pushes right) → descending. For resize-left it's the rightmost (its left edge
          // pushes left) → ascending. move doesn't conflict internally; keep ascending.
          const secondaryAsc = d.mode === 'resize-right' ? -1 : 1;
          cluster.sort((a, b) => {
            const ai = tracksRef.current.findIndex(t => t.id === a.trackId);
            const bi = tracksRef.current.findIndex(t => t.id === b.trackId);
            if (ai !== bi) return ai - bi;
            return (initStartById.get(a.id) - initStartById.get(b.id)) * secondaryAsc;
          });

          // Step 1: Internal cluster resolution — cluster members on the same track trim each other
          let resolvedCluster = [];
          let cleanNotes = notesRef.current;
          for (const cr of cluster) {
            const result = applyDestructiveEdit(resolvedCluster, cleanNotes, cr);
            resolvedCluster = [...result.regions, cr];
            cleanNotes = result.notes;
          }

          // Step 2: External resolution — resolvedCluster vs background
          let cleanRegions = regionsRef.current.filter(r => !clusterIds.has(r.id));
          for (const cr of resolvedCluster) {
            const result = applyDestructiveEdit(cleanRegions, cleanNotes, cr);
            cleanRegions = result.regions;
            cleanNotes   = result.notes;
          }

          if (d.mode === 'move') {
            // Bottle-local notes don't shift when the window slides — only trackId may change.
            cleanNotes = cleanNotes.map(n => {
              if (n.regionId === regionId) {
                return { ...n, trackId: pendingTrackId };
              }
              const comp = d.companions.find(c => c.regionId === n.regionId);
              if (comp) {
                return { ...n, trackId: comp.pendingTrackId };
              }
              return n;
            });
          }

          // Defensive cull: drop any region with non-positive duration and orphaned notes.
          // No current path produces this, but cheap insurance against future regressions.
          const mergedRegions = [...cleanRegions, ...resolvedCluster].filter(r => r.durationMeasures > 0);
          const survivingRegionIds = new Set(mergedRegions.map(r => r.id));
          const finalNotes = cleanNotes.filter(n => survivingRegionIds.has(n.regionId));

          setRegions(mergedRegions);
          setNotes(finalNotes);

          // Dev-only invariant check: log any same-track region overlap after commit,
          // plus DOM<->state sync check that repairs any reconciler-missed inline styles.
          const dragMode = d.mode;
          queueMicrotask(() => {
            // 1. State overlap check.
            const byTrack = new Map();
            for (const r of regionsRef.current) {
              const arr = byTrack.get(r.trackId);
              if (arr) arr.push(r); else byTrack.set(r.trackId, [r]);
            }
            for (const [, list] of byTrack) {
              list.sort((a, b) => a.startMeasure - b.startMeasure);
              for (let i = 1; i < list.length; i++) {
                const prev = list[i - 1];
                const cur  = list[i];
                if (prev.startMeasure + prev.durationMeasures > cur.startMeasure) {
                  // eslint-disable-next-line no-console
                  console.warn('[region-overlap]', { prev, cur, mode: dragMode });
                }
              }
            }
            // 2. DOM<->state sync — intentional React reconciler bailout workaround.
            // When a region's commit-time value equals its pre-drag value (e.g. a companion
            // trimmed back to its original 1-measure width by cluster resolution), React's
            // reconciler diffs its own memo (old value) against the new JSX (same value),
            // sees no change, and skips emitting a DOM write — but the DOM was mutated to a
            // different value during drag. We resync explicitly. Silent on purpose.
            for (const r of regionsRef.current) {
              const el = timelineRef.current?.querySelector(`[data-region-id="${r.id}"]`);
              if (!el) continue;
              const expectedLeft  = `${r.startMeasure    * pixelsPerMeasure}px`;
              const expectedWidth = `${r.durationMeasures * pixelsPerMeasure}px`;
              if (el.style.left  !== expectedLeft)  el.style.left  = expectedLeft;
              if (el.style.width !== expectedWidth) el.style.width = expectedWidth;
            }
          });

          const rightEdge = Math.max(...resolvedCluster.map(r => r.startMeasure + r.durationMeasures));
          if (rightEdge > totalMeasuresRef.current - 16) setTotalMeasures(prev => Math.max(prev + 64, rightEdge + 16));
          document.body.classList.remove('is-dragging');
          document.body.style.cursor = '';
          lastDragEndTimeRef.current = Date.now();
        }
        stopAutoScroll();
        dragRef.current = null;
      } else if (capturedRegionStartRef.current) {
        const { x, y } = capturedRegionStartRef.current;
        if (Math.hypot(e.clientX - x, e.clientY - y) >= 4) {
          lastDragEndTimeRef.current = Date.now();
        }
      }
      capturedRegionStartRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pixelsPerMeasure, startAutoScroll, stopAutoScroll]);

  // ── Marquee selection drag ────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => {
      const d = marqueeDragRef.current;
      if (!d || e.buttons !== 1) return;
      const scroller = timelineRef.current;
      if (!scroller) return;
      const rect     = scroller.getBoundingClientRect();
      const currentX = e.clientX - rect.left + scroller.scrollLeft;
      const currentY = Math.max(0, e.clientY - rect.top + scroller.scrollTop - RULER_HEIGHT);
      if (!d.active && Math.hypot(currentX - d.startX, currentY - d.startY) < 4) return;
      if (!d.active) {
        Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
      }
      d.active   = true;
      d.currentX = currentX;
      d.currentY = currentY;
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      const left   = Math.min(d.startX, currentX);
      const top    = Math.min(d.startY, currentY);
      const width  = Math.abs(currentX - d.startX);
      const height = Math.abs(currentY - d.startY);
      const el = marqueeElRef.current;
      if (!el) return;
      el.style.left    = `${left}px`;
      el.style.top     = `${top + RULER_HEIGHT}px`;
      el.style.width   = `${width}px`;
      el.style.height  = `${height}px`;
      el.style.opacity = '1';
      // live region highlight — clear previous, apply new
      marqueeHoverIdsRef.current.forEach(id => {
        document.querySelector(`[data-region-id="${id}"]`)?.style.removeProperty('filter');
      });
      const hitIds = getIntersectingRegionIds(
        Math.min(d.startX, currentX), Math.max(d.startX, currentX),
        Math.min(d.startY, currentY), Math.max(d.startY, currentY),
        regionsRef.current, tracksRef.current, pixelsPerMeasure
      );
      marqueeHoverIdsRef.current = new Set(hitIds);
      hitIds.forEach(id => {
        document.querySelector(`[data-region-id="${id}"]`)?.style.setProperty('filter', 'brightness(0.6)');
      });
    };

    const onUp = () => {
      const d = marqueeDragRef.current;
      if (!d) return;
      // clear live hover highlights (selected regions re-render via setSelectedRegionIds below)
      marqueeHoverIdsRef.current.forEach(id => {
        document.querySelector(`[data-region-id="${id}"]`)?.style.removeProperty('filter');
      });
      marqueeHoverIdsRef.current = new Set();
      stopAutoScroll();
      if (d.active) {
        const minX = Math.min(d.startX, d.currentX ?? d.startX);
        const maxX = Math.max(d.startX, d.currentX ?? d.startX);
        const minY = Math.min(d.startY, d.currentY ?? d.startY);
        const maxY = Math.max(d.startY, d.currentY ?? d.startY);
        const hitIds = getIntersectingRegionIds(minX, maxX, minY, maxY,
          regionsRef.current, tracksRef.current, pixelsPerMeasure);
        const hit = regionsRef.current.filter(r => hitIds.includes(r.id));
        setSelectedRegionIds(new Set(hitIds));
        if (hit.length > 0) {
          pasteAnchorTrackIndexRef.current = Math.min(
            ...hit.map(r => tracksRef.current.findIndex(t => t.id === r.trackId))
          );
        }
        lastDragEndTimeRef.current = Date.now();
      } else {
        // Pure click in the void below all tracks — clear selection.
        // Lane clicks bypass this path via stopPropagation; ruler clicks route through
        // isDraggingRef and never set marqueeDragRef.
        setSelectedRegionIds(new Set());
      }
      const el = marqueeElRef.current;
      if (el) {
        // Clear left/top too — stale large `left` on an absolutely-positioned child
        // extends the parent's scrollable area, letting the user scroll past totalMeasures.
        el.style.left = ''; el.style.top = '';
        el.style.width = '0'; el.style.height = '0'; el.style.opacity = '0';
      }
      marqueeDragRef.current = null;
    };

    window.addEventListener('mousemove', onMove, true);  // capture: fires before region stopPropagation
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pixelsPerMeasure, startAutoScroll, stopAutoScroll]);

  // Keep refs in sync so drag closures always read current values without stale closures
  leftColWidthRef.current       = leftColWidth;
  regionsRef.current            = regions;
  tracksRef.current             = tracks;
  notesRef.current              = notes;
  totalMeasuresRef.current      = totalMeasures;
  selectedRegionIdsRef.current  = selectedRegionIds;
  snapEnabledRef.current        = snapEnabled;

  // ── Left-column resizer drag ───────────────────────────────
  const startLeftColDrag = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftColWidthRef.current;
    let pending = startW;
    const onMove = (ev) => {
      const newW = Math.max(200, Math.min(600, startW + (ev.clientX - startX)));
      pending = newW;
      shellRef.current?.style.setProperty('--left-col-width', `${newW}px`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setLeftColWidth(pending);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ── Editor panel divider drag ──────────────────────────────
  const startDividerDrag = (e) => {
    e.preventDefault();
    let pending = editorHeight;
    const onMove = (ev) => {
      const wanted = window.innerHeight - ev.clientY;
      pending = Math.max(150, Math.min(wanted, window.innerHeight - 200));
      if (editorWrapRef.current) editorWrapRef.current.style.height = `${pending}px`;
    };
    const onUp = () => {
      setEditorHeight(pending);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Playhead ─────────────────────────────────────────────────
  const updatePlayhead = useCallback(() => {
    const t = Tone.Transport.seconds;
    const x = t * pxPerSec;
    if (playheadRef.current)          playheadRef.current.style.transform          = `translateX(${x}px)`;
    if (pianoRollPlayheadRef.current) pianoRollPlayheadRef.current.style.transform = `translateX(${x}px)`;
    if (timeRef.current)              timeRef.current.textContent                  = formatTime(t);
  }, [pxPerSec]);

  // Reposition playhead when zoom changes (even while paused)
  useEffect(() => { updatePlayhead(); }, [pxPerSec, updatePlayhead]);

  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => { updatePlayhead(); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, updatePlayhead]);

  const handlePlayPause = useCallback(async () => {
    await Tone.start();
    Tone.Transport.bpm.value = bpm;
    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      setIsPlaying(false);
      updatePlayhead();
    } else {
      Tone.Transport.start();
      setIsPlaying(true);
    }
  }, [updatePlayhead]);

  const handleStop = useCallback(() => {
    Tone.Transport.stop();
    setIsPlaying(false);
    if (playheadRef.current)          playheadRef.current.style.transform          = 'translateX(0px)';
    if (pianoRollPlayheadRef.current) pianoRollPlayheadRef.current.style.transform = 'translateX(0px)';
    if (timeRef.current)              timeRef.current.textContent                  = '00:00:00';
  }, []);

  // ── BPM editing ──────────────────────────────────────────
  function handleBpmCommit() {
    let n = parseInt(tempBpm, 10);
    if (isNaN(n)) n = bpm;
    n = Math.max(20, Math.min(300, n));

    if (n !== bpm) {
      // Preserve musical position: scale Transport.seconds by BPM ratio before
      // changing tempo, so the playhead stays anchored at the same bar:beat.
      Tone.Transport.seconds = Tone.Transport.seconds * (bpm / n);
      Tone.Transport.bpm.value = n;
    }

    setBpm(n);
    setTempBpm(String(n));
    setEditingBpm(false);
  }

  // ── Seek ─────────────────────────────────────────────────────
  const seekToClientX = useCallback((clientX) => {
    const scroller = timelineRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const x    = clientX - rect.left + scroller.scrollLeft;
    if (snapEnabled) {
      const snapInc      = getSnapIncrement(pixelsPerMeasure);
      const rawMeasures  = x / pixelsPerMeasure;
      const snapMeasures = Math.max(0, Math.round(rawMeasures / snapInc) * snapInc);
      Tone.Transport.seconds = snapMeasures * 4 * (60 / bpm);
    } else {
      Tone.Transport.seconds = Math.max(0, x / pxPerSec);
    }
    updatePlayhead();
  }, [pxPerSec, updatePlayhead, snapEnabled, pixelsPerMeasure, bpm]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    seekToClientX(e.clientX);
    const scroller = timelineRef.current;
    if (rulerRef.current?.contains(e.target)) {
      isDraggingRef.current = true;
      document.body.classList.add('is-dragging');
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
    } else if (scroller) {
      const rect     = scroller.getBoundingClientRect();
      const contentX = e.clientX - rect.left + scroller.scrollLeft;
      const contentY = e.clientY - rect.top  + scroller.scrollTop - RULER_HEIGHT;
      marqueeDragRef.current = { startX: contentX, startY: contentY, active: false };
    }
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingRef.current) return;
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      seekToClientX(e.clientX);
    };
    const onUp   = ()  => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.classList.remove('is-dragging');
      stopAutoScroll();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [seekToClientX, stopAutoScroll]);

  // ── Ctrl+Scroll zoom-to-cursor ────────────────────────────────
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const mouseX    = e.clientX - el.getBoundingClientRect().left;
      const absoluteX = mouseX + el.scrollLeft;
      Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
      const factor    = e.deltaY > 0 ? 0.9 : 1.1;
      setZoomLevel(prev => {
        const minZoom = timelineRef.current
          ? timelineRef.current.clientWidth / (PIXELS_PER_MEASURE * totalMeasuresRef.current)
          : 0.05;
        const next = Math.max(minZoom, Math.min(8, prev * factor));
        if (next === prev) return prev;
        pendingScrollRef.current = absoluteX * (next / prev) - mouseX;
        // Bugs 3+5: piano roll must land at the SAME cursor-anchored target so the
        // scroll-sync handlers don't race and clobber one panel's anchor with the other's.
        if (pianoScrollRef.current) pendingPianoScrollRef.current = pendingScrollRef.current;
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Piano roll Ctrl+Scroll zoom — re-attaches when editor opens/closes
  useEffect(() => {
    const el = pianoScrollRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect       = el.getBoundingClientRect();
      const gridMouseX = e.clientX - rect.left - 56; // subtract sticky keys column
      const absoluteX  = Math.max(0, gridMouseX) + el.scrollLeft;
      Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
      const factor     = e.deltaY > 0 ? 0.9 : 1.1;
      setZoomLevel(prev => {
        const minZoom = timelineRef.current
          ? timelineRef.current.clientWidth / (PIXELS_PER_MEASURE * totalMeasuresRef.current)
          : 0.05;
        const next = Math.max(minZoom, Math.min(8, prev * factor));
        if (next === prev) return prev;
        // zoom-to-cursor for piano roll
        pendingPianoScrollRef.current = absoluteX * (next / prev) - Math.max(0, gridMouseX);
        // Bugs 3+5: arrangement must land at the SAME target so the sync handlers can't
        // race-overwrite the piano roll's cursor-anchored value with a divergent one.
        if (timelineRef.current) pendingScrollRef.current = pendingPianoScrollRef.current;
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [editingTrackId]); // re-attach when editor opens/closes

  // Clamp zoom up if viewport widens past the project boundary
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth <= 0) return;
      const minZoom = el.clientWidth / (PIXELS_PER_MEASURE * totalMeasuresRef.current);
      setZoomLevel(prev => Math.max(prev, minZoom));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bug 1: when the editor opens, the piano roll mounts at scrollLeft=0. RegionEditor's
  // mount useEffect then sets scrollTop, which fires a scroll event whose scrollLeft=0
  // → handlePianoRollScroll syncs that 0 back to the timeline, jumping us to the left.
  // Prime the piano roll's scrollLeft to match the timeline before that effect runs.
  // Parent useLayoutEffect fires after child useLayoutEffect but before any useEffect.
  useLayoutEffect(() => {
    if (editingTrackId && pianoScrollRef.current && timelineRef.current) {
      pianoScrollRef.current.scrollLeft = timelineRef.current.scrollLeft;
    }
  }, [editingTrackId]);

  // Apply zoom-to-cursor scroll corrections after React expands the DOM
  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && timelineRef.current) {
      timelineRef.current.scrollLeft = Math.max(0, pendingScrollRef.current);
      pendingScrollRef.current = null;
    }
    if (pendingPianoScrollRef.current !== null && pianoScrollRef.current) {
      pianoScrollRef.current.scrollLeft = Math.max(0, pendingPianoScrollRef.current);
      pendingPianoScrollRef.current = null;
    }
  }, [zoomLevel]);

  // ── Scroll sync ───────────────────────────────────────────────
  // Value-comparison guards: only write if the position actually differs so the
  // retaliatory scroll event on the counterpart never fires (same value → no scroll event).
  const handleTimelineScroll = useCallback((e) => {
    const sl = e.target.scrollLeft;
    const st = e.target.scrollTop;
    if (pianoScrollRef.current && pianoScrollRef.current.scrollLeft !== sl)
      pianoScrollRef.current.scrollLeft = sl;
    if (trackHeadersRef.current && trackHeadersRef.current.scrollTop !== st)
      trackHeadersRef.current.scrollTop = st;
  }, []);

  const handlePianoRollScroll = useCallback((e) => {
    const sl = e.target.scrollLeft;
    if (timelineRef.current && timelineRef.current.scrollLeft !== sl)
      timelineRef.current.scrollLeft = sl;
    lastPianoScrollTopRef.current = e.target.scrollTop;
  }, []);

  const handleTrackHeadersScroll = useCallback((e) => {
    const st = e.target.scrollTop;
    if (timelineRef.current && timelineRef.current.scrollTop !== st)
      timelineRef.current.scrollTop = st;
  }, []);

  // ── Spacebar ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      const el = document.activeElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      handlePlayPause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePlayPause]);

  // ── Delete / Backspace / Copy / Paste keyboard handlers ─────
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const inInput = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;

      // Delete / Backspace — remove all selected regions + their notes
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (inInput) return;
        const ids = selectedRegionIdsRef.current;
        if (!ids.size) return;
        e.preventDefault();
        setRegions(prev => prev.filter(r => !ids.has(r.id)));
        setNotes(prev => prev.filter(n => !ids.has(n.regionId)));
        setSelectedRegionIds(new Set());
        return;
      }

      // Copy — Cmd/Ctrl + C
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        if (inInput) return;
        const ids = [...selectedRegionIdsRef.current];
        if (!ids.length) return;
        const selectedRegions = regionsRef.current.filter(r => ids.includes(r.id));
        const selectedNotes   = notesRef.current.filter(n => ids.includes(n.regionId));
        const leftmostMeasure   = Math.min(...selectedRegions.map(r => r.startMeasure));
        const topmostTrackIndex = Math.min(...selectedRegions.map(r =>
          tracksRef.current.findIndex(t => t.id === r.trackId)
        ));
        clipboardRef.current = JSON.parse(JSON.stringify({
          regions: selectedRegions, notes: selectedNotes,
          leftmostMeasure, topmostTrackIndex,
        }));
        return;
      }

      // Paste — Cmd/Ctrl + V
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        if (inInput) return;
        if (!clipboardRef.current) return;
        e.preventDefault();
        const { regions: srcRegions, notes: srcNotes, leftmostMeasure, topmostTrackIndex } = clipboardRef.current;
        const targetMeasure    = parseInt(Tone.Transport.position.split(':')[0], 10);
        const anchorTrackIndex = pasteAnchorTrackIndexRef.current ?? topmostTrackIndex;
        const bottommostTrackIndex = Math.max(...srcRegions.map(r =>
          tracksRef.current.findIndex(t => t.id === r.trackId)
        ));
        const clusterHeight = bottommostTrackIndex - topmostTrackIndex;

        if (anchorTrackIndex + clusterHeight >= tracksRef.current.length) {
          setToastMessage('Overflow: not enough tracks below to paste cluster');
          setTimeout(() => setToastMessage(null), 3000);
          return;
        }

        const idMap = {};
        const newRegions = srcRegions.map(r => {
          const trackOffset = tracksRef.current.findIndex(t => t.id === r.trackId) - topmostTrackIndex;
          const newId = `r${nextRegionIdRef.current++}`;
          idMap[r.id] = newId;
          return {
            ...r,
            id: newId,
            startMeasure: targetMeasure + (r.startMeasure - leftmostMeasure),
            trackId: tracksRef.current[anchorTrackIndex + trackOffset]?.id ?? r.trackId,
          };
        });
        // Notes are bottle-local — startBeat unchanged on paste. Only IDs and trackId update.
        const newNotes = srcNotes.map(n => ({
          ...n,
          id: `note_${nextNoteIdRef.current++}`,
          regionId: idMap[n.regionId],
          trackId: newRegions.find(r => r.id === idMap[n.regionId])?.trackId ?? n.trackId,
        }));
        let cleanRegions = regionsRef.current;
        let cleanNotes   = notesRef.current;
        for (const r of newRegions) {
          const result = applyDestructiveEdit(cleanRegions, cleanNotes, r);
          cleanRegions = result.regions;
          cleanNotes   = result.notes;
        }
        setRegions([...cleanRegions, ...newRegions]);
        setNotes([...cleanNotes, ...newNotes]);
        setSelectedRegionIds(new Set(Object.values(idMap)));
        const rightEdge = Math.max(...newRegions.map(r => r.startMeasure + r.durationMeasures));
        if (rightEdge > totalMeasuresRef.current - 16) setTotalMeasures(prev => prev + 64);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={shellRef} className={styles.shell} style={{ '--left-col-width': `${leftColWidth}px` }}>

      {/* ── Transport bar ─────────────────────────────────── */}
      <div className={styles.transport}>
        <div className={styles.transportLeft}>
          <button className={styles.themeBtn} onClick={onThemeToggle}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
            {isDarkMode ? '◑' : '○'}
          </button>
          <button className={styles.homeBtn} onClick={onNavigateHome}>[ ⌂ home ]</button>
          <button
            className={snapEnabled ? styles.transportBtnActive : styles.transportBtn}
            onClick={() => setSnapEnabled(v => !v)}
            title="Snap to grid (magnet)">
            ⌘
          </button>
        </div>
        <div className={styles.transportRight}>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>BPM</span>
            {editingBpm ? (
              <input
                autoFocus
                type="number"
                className={styles.bpmInput}
                value={tempBpm}
                onChange={(e) => setTempBpm(e.target.value)}
                onBlur={handleBpmCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleBpmCommit();
                  if (e.key === 'Escape') { setTempBpm(String(bpm)); setEditingBpm(false); }
                }}
              />
            ) : (
              <span
                className={styles.metaValue}
                style={{ cursor: 'text' }}
                onClick={() => { setTempBpm(String(bpm)); setEditingBpm(true); }}
              >
                {bpm}
              </span>
            )}
          </div>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>TIME</span>
            <span ref={timeRef} className={styles.metaValue}>00:00:00</span>
          </div>
        </div>
      </div>

      {/* ── Arrangement view ─────────────────────────────── */}
      <div className={`${styles.arrangement}${editingTrackId ? ` ${styles.arrangementShrunk}` : ''}`}>

        {/* Track header column */}
        <div ref={trackHeadersRef} className={styles.trackHeaders} onScroll={handleTrackHeadersScroll}>
          <div className={styles.tracksHeader}>tracks</div>
          {tracks.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>no tracks</p>
              <p className={styles.emptyHint}>add a track to begin</p>
              <button className={styles.addTrackPrimary} onClick={handleAddTrack}>[ + add track ]</button>
            </div>
          ) : (
            <>
              {tracks.map((t) => (
                <div key={t.id} className={`${styles.trackRow}${editingTrackId === t.id ? ` ${styles.trackRowActive}` : activeTrackId === t.id ? ` ${styles.trackRowFocused}` : ''}`}
                  style={{ '--track-color': t.color }}
                  onClick={() => { setActiveTrackId(t.id); pasteAnchorTrackIndexRef.current = tracksRef.current.findIndex(x => x.id === t.id); }}
                  onDoubleClick={() => setEditingTrackId(prev => prev === t.id ? null : t.id)}>
                  <div className={styles.trackTopRow}>
                    <div className={styles.trackNameBlock}>
                      <div className={styles.trackNameRow}>
                        <span className={styles.trackColorDot} style={{ background: t.color }} />
                        <span className={styles.trackName}>{t.name}</span>
                      </div>
                      <button className={styles.trackInstrument} title="Change instrument">{t.instrument}</button>
                    </div>
                    <div className={styles.trackToggles}>
                      <button
                        className={t.isMuted ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleMute(t.id)} title="Mute">M</button>
                      <button
                        className={t.isSolo ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleSolo(t.id)} title="Solo">S</button>
                      <button
                        className={editingTrackId === t.id ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => setEditingTrackId(prev => prev === t.id ? null : t.id)}
                        title="Open piano roll">✎</button>
                    </div>
                  </div>
                  <div className={styles.fakeSlider}>
                    <div className={styles.fakeSliderThumb} />
                  </div>
                </div>
              ))}
              <button className={styles.addTrackGhost} onClick={handleAddTrack}>[ + add track ]</button>
            </>
          )}
        </div>

        {/* Left-column resizer handle */}
        <div className={styles.colResizer} onMouseDown={startLeftColDrag} />

        {/* Timeline grid */}
        <div
          ref={timelineRef}
          className={styles.timeline}
          onMouseDown={handleMouseDown}
          onScroll={handleTimelineScroll}
        >
          <div
            className={styles.timelineInner}
            style={{
              width: `${totalMeasures * pixelsPerMeasure}px`,
              backgroundImage: computeGridBg(pixelsPerMeasure, zoomLevel),
            }}
          >
            {/* Ruler */}
            <div ref={rulerRef} className={styles.ruler}>
              {(() => {
                const labelStep = getMeasureInterval(pixelsPerMeasure);
                return Array.from({ length: totalMeasures }, (_, i) => {
                  if (i % labelStep !== 0) return null;
                  return (
                    <span key={i} className={styles.rulerLabel}
                      style={{ left: `${i * pixelsPerMeasure}px` }}>
                      {i + 1}
                    </span>
                  );
                });
              })()}
            </div>

            {/* Track lanes */}
            {tracks.map((t) => {
              return (
                <div key={t.id} className={styles.trackLane}
                  style={{ '--track-color': t.color }}
                  onMouseMove={(e) => handleLaneMouseMove(e, t.id)}
                  onMouseLeave={() => handleLaneMouseLeave(t.id)}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (dragRef.current) return;
                    const scroller = timelineRef.current;
                    if (!scroller) return;
                    const rect     = scroller.getBoundingClientRect();
                    const contentX = e.clientX - rect.left + scroller.scrollLeft;
                    const contentY = e.clientY - rect.top  + scroller.scrollTop - RULER_HEIGHT;
                    marqueeDragRef.current = { startX: contentX, startY: contentY, active: false };
                  }}
                  onClick={(e) => handleLaneClick(e, t.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (Date.now() - lastDragEndTimeRef.current < 300) return;
                    if (e.target.closest(`.${styles.region}`)) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const measure = Math.max(0, Math.floor((e.clientX - rect.left) / pixelsPerMeasure));
                    if (regions.some(r => r.trackId === t.id) && !isPositionOccupied(t.id, measure)) {
                      const n = nextRegionIdRef.current++;
                      const newRegion = { id: `r${n}`, trackId: t.id, startMeasure: measure, durationMeasures: 1, clipOffset: 0 };
                      const result = applyDestructiveEdit(regionsRef.current, notesRef.current, newRegion);
                      const merged = [...result.regions, newRegion].filter(rg => rg.durationMeasures > 0);
                      const surviving = new Set(merged.map(rg => rg.id));
                      setRegions(merged);
                      setNotes(result.notes.filter(nt => surviving.has(nt.regionId)));
                      if (measure + 1 > totalMeasures - 16) setTotalMeasures(prev => prev + 64);
                    }
                    setEditingTrackId(t.id);
                  }}>
                  <div ref={(el) => { ghostRefs.current[t.id] = el; }} className={styles.ghost} />
                  {regions.filter(r => r.trackId === t.id).map(r => (
                    <div key={r.id} data-region-id={r.id} className={`${styles.region}${selectedRegionIds.has(r.id) ? ` ${styles.regionSelected}` : ''}`}
                      style={{
                        left:  `${r.startMeasure    * pixelsPerMeasure}px`,
                        width: `${r.durationMeasures * pixelsPerMeasure}px`,
                      }}
                      onMouseDownCapture={(e) => { capturedRegionStartRef.current = { x: e.clientX, y: e.clientY }; }}
                      onMouseDown={(e) => startRegionDrag(e, r, 'move')}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingTrackId(r.trackId); }}>
                      <div className={styles.resizeLeft}  onMouseDown={(e) => startRegionDrag(e, r, 'resize-left')} />
                      <div className={styles.resizeRight} onMouseDown={(e) => startRegionDrag(e, r, 'resize-right')} />
                      <button className={styles.editBtn} onMouseDown={stopMouseDown}
                        onClick={(e) => { e.stopPropagation(); setEditingTrackId(r.trackId); }}>
                        edit
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}

            <div ref={playheadRef} className={styles.playhead} />
            <div ref={marqueeElRef} className={styles.marquee} />
          </div>
        </div>
      </div>
      {toastMessage && <div className={styles.toast}>{toastMessage}</div>}

      {/* ── Piano roll editor ────────────────────────────── */}
      {editingTrackId && (
        <>
          <div className={styles.divider} onMouseDown={startDividerDrag} title="Drag to resize" />
          <div ref={editorWrapRef} className={styles.editorWrap} style={{ height: editorHeight }}>
            <RegionEditor
              track={editingTrack}
              notes={editingTrackNotes}
              regions={regions.filter(r => r.trackId === editingTrackId)}
              onNoteAdd={handleNoteAdd}
              onNoteRemove={handleNoteRemove}
              zoomLevel={zoomLevel}
              pixelsPerMeasure={pixelsPerMeasure}
              totalMeasures={totalMeasures}
              pianoRollPlayheadRef={pianoRollPlayheadRef}
              pianoScrollRef={pianoScrollRef}
              onGridScroll={handlePianoRollScroll}
              onLeftColResize={startLeftColDrag}
              onClose={() => setEditingTrackId(null)}
              scrollMemoryRef={lastPianoScrollTopRef}
            />
          </div>
        </>
      )}
      {/* ── Bottom transport bar ────────────────────────────── */}
      <div className={styles.bottomTransport}>
        <button
          className={isPlaying ? styles.transportBtnActive : styles.transportBtn}
          onClick={handlePlayPause} title="Play / Pause (Space)">▶</button>
        <button className={styles.transportBtn} onClick={handleStop} title="Stop">■</button>
        <button className={styles.transportBtn} title="Record">●</button>
      </div>
    </div>
  );
}
