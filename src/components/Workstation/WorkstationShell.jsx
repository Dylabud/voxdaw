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

const formatTime = (t) => {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  const cs   = Math.floor((t % 1) * 100);
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};

// Used for both arrangement and piano roll grids — returns inline backgroundImage string.
export function computeGridBg(ppm, zoomLevel) {
  const labelStep    = Math.max(1, Math.ceil(50 / ppm));
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
  const syncingScrollRef     = useRef(false);  // anti-loop guard (horizontal)
  const syncingVerticalRef   = useRef(false);  // anti-loop guard (vertical)
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

  // ── Derived editor state ───────────────────────────────────
  const editingTrack      = editingTrackId ? tracks.find(t => t.id === editingTrackId) : null;
  const editingTrackNotes = notes.filter(n => n.trackId === editingTrackId);

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
      setNotes(prev => [...prev, {
        id: `note_${nextNoteIdRef.current++}`, ...noteData, regionId: existingRegion.id,
      }]);
    } else {
      const newRegionId = `region_${nextRegionIdRef.current++}`;
      setRegions(prev => [...prev, {
        id: newRegionId, trackId, startMeasure: measure, durationMeasures: 1,
      }]);
      setNotes(prev => [...prev, {
        id: `note_${nextNoteIdRef.current++}`, ...noteData, regionId: newRegionId,
      }]);
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
    if (isDraggingRef.current || dragRef.current) return;
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
    setRegions(prev => [...prev, { id: `r${n}`, trackId, startMeasure: measure, durationMeasures: 1 }]);
    if (measure + 1 > totalMeasures - 16) setTotalMeasures(prev => prev + 64);
  };

  const stopMouseDown = (e) => e.stopPropagation();

  // ── Destructive edit — trim/split overlapping regions on the same track ──
  const applyDestructiveEdit = useCallback((regions, notes, incoming) => {
    const newStart  = incoming.startMeasure;
    const newEnd    = newStart + incoming.durationMeasures;
    const newBStart = newStart * 4;
    const newBEnd   = newEnd   * 4;

    const nextRegions = [];
    let   nextNotes   = notes;

    for (const r of regions) {
      if (r.id === incoming.id || r.trackId !== incoming.trackId) { nextRegions.push(r); continue; }
      const oldStart = r.startMeasure;
      const oldEnd   = oldStart + r.durationMeasures;
      if (oldEnd <= newStart || oldStart >= newEnd) { nextRegions.push(r); continue; }

      // Case A: total eclipse — incoming fully covers old region
      if (newStart <= oldStart && newEnd >= oldEnd) {
        nextNotes = nextNotes.filter(n => n.regionId !== r.id);
        continue;
      }
      // Case B: right trim — incoming overlaps only the right portion of old
      if (newStart > oldStart && newEnd >= oldEnd) {
        nextRegions.push({ ...r, durationMeasures: newStart - oldStart });
        nextNotes = nextNotes.filter(n => n.regionId !== r.id || n.startBeat < newBStart);
        continue;
      }
      // Case C: left trim — incoming overlaps only the left portion of old
      if (newStart <= oldStart && newEnd < oldEnd) {
        nextRegions.push({ ...r, startMeasure: newEnd, durationMeasures: oldEnd - newEnd });
        nextNotes = nextNotes.filter(n => n.regionId !== r.id || n.startBeat >= newBEnd);
        continue;
      }
      // Case D: middle split — incoming is fully inside old region
      const rightId = `r${nextRegionIdRef.current++}`;
      nextRegions.push(
        { ...r, durationMeasures: newStart - oldStart },
        { ...r, id: rightId, startMeasure: newEnd, durationMeasures: oldEnd - newEnd },
      );
      nextNotes = nextNotes
        .filter(n => n.regionId !== r.id || n.startBeat < newBStart || n.startBeat >= newBEnd)
        .map(n => n.regionId === r.id && n.startBeat >= newBEnd ? { ...n, regionId: rightId } : n);
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
            return [{
              regionId: cId, trackId: r.trackId, origTrackIndex: tIdx,
              pendingTrackId: r.trackId, pendingTrackIndex: tIdx,
              initStart: r.startMeasure, initDuration: r.durationMeasures,
              pendingStart: r.startMeasure, pendingDuration: r.durationMeasures,
              el,
            }];
          })
      : [];

    const regionEl = e.currentTarget.closest('[data-region-id]');
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
      el: regionEl,
      pendingStart: region.startMeasure,
      pendingDuration: region.durationMeasures,
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
      const delta = Math.round((e.clientX - d.startX) / pixelsPerMeasure);
      let newStart    = d.pendingStart;
      let newDuration = d.pendingDuration;

      if (d.mode === 'move') {
        const allMembers        = [d, ...d.companions];
        const minInitStart      = Math.min(...allMembers.map(m => m.initStart));
        const minOrigTrackIndex = Math.min(...allMembers.map(m => m.origTrackIndex));
        const maxOrigTrackIndex = Math.max(...allMembers.map(m => m.origTrackIndex));
        const clampedDelta      = Math.max(-minInitStart, delta);

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
        newDuration = Math.max(1, d.initDuration + delta);
        for (const c of d.companions) {
          c.pendingDuration = Math.max(1, c.initDuration + delta);
          if (c.el) { c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`; c.el.style.zIndex = '10'; }
        }
      } else if (d.mode === 'resize-left') {
        const wanted    = d.initStart + delta;
        const candStart = Math.max(0, Math.min(wanted, d.initStart + d.initDuration - 1));
        newStart    = candStart;
        newDuration = d.initDuration + (d.initStart - candStart);
        for (const c of d.companions) {
          const cWanted   = c.initStart + delta;
          const cStart    = Math.max(0, Math.min(cWanted, c.initStart + c.initDuration - 1));
          c.pendingStart    = cStart;
          c.pendingDuration = c.initDuration + (c.initStart - cStart);
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

          const { regionId, pendingStart, pendingDuration, pendingTrackId, initStart } = d;
          const clusterIds = new Set([regionId, ...d.companions.map(c => c.regionId)]);

          const movedRegion = {
            ...regionsRef.current.find(r => r.id === regionId),
            startMeasure: pendingStart, durationMeasures: pendingDuration, trackId: pendingTrackId,
          };
          const cluster = [
            movedRegion,
            ...d.companions.map(c => ({
              ...regionsRef.current.find(r => r.id === c.regionId),
              startMeasure: c.pendingStart, durationMeasures: c.pendingDuration, trackId: c.pendingTrackId,
            })),
          ];

          // Sort: leftmost-on-track first so the rightmost (anchor) is processed last and wins
          cluster.sort((a, b) => {
            const ai = tracksRef.current.findIndex(t => t.id === a.trackId);
            const bi = tracksRef.current.findIndex(t => t.id === b.trackId);
            return ai !== bi ? ai - bi : a.startMeasure - b.startMeasure;
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
            cleanNotes = cleanNotes.map(n => {
              if (n.regionId === regionId) {
                return { ...n, startBeat: n.startBeat + (pendingStart - initStart) * 4, trackId: pendingTrackId };
              }
              const comp = d.companions.find(c => c.regionId === n.regionId);
              if (comp) {
                return { ...n, startBeat: n.startBeat + (comp.pendingStart - comp.initStart) * 4, trackId: comp.pendingTrackId };
              }
              return n;
            });
          }

          setRegions([...cleanRegions, ...resolvedCluster]);
          setNotes(cleanNotes);

          const rightEdge = Math.max(...resolvedCluster.map(r => r.startMeasure + r.durationMeasures));
          if (rightEdge > totalMeasuresRef.current - 16) setTotalMeasures(prev => Math.max(prev + 64, rightEdge + 16));
          document.body.classList.remove('is-dragging');
          document.body.style.cursor = '';
          lastDragEndTimeRef.current = Date.now();
        }
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
  }, [pixelsPerMeasure]);

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
      d.active   = true;
      d.currentX = currentX;
      d.currentY = currentY;
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
    };

    const onUp = () => {
      const d = marqueeDragRef.current;
      if (!d) return;
      if (d.active) {
        const minX = Math.min(d.startX, d.currentX ?? d.startX);
        const maxX = Math.max(d.startX, d.currentX ?? d.startX);
        const minY = Math.min(d.startY, d.currentY ?? d.startY);
        const maxY = Math.max(d.startY, d.currentY ?? d.startY);
        const ppm  = pixelsPerMeasure;
        const hit  = regionsRef.current.filter(r => {
          const tIdx   = tracksRef.current.findIndex(t => t.id === r.trackId);
          const rLeft  = r.startMeasure * ppm;
          const rRight = (r.startMeasure + r.durationMeasures) * ppm;
          const rTop   = tIdx * TRACK_H;
          const rBot   = (tIdx + 1) * TRACK_H;
          return rLeft < maxX && rRight > minX && rTop < maxY && rBot > minY;
        });
        setSelectedRegionIds(new Set(hit.map(r => r.id)));
        if (hit.length > 0) {
          pasteAnchorTrackIndexRef.current = Math.min(
            ...hit.map(r => tracksRef.current.findIndex(t => t.id === r.trackId))
          );
        }
        lastDragEndTimeRef.current = Date.now();
      }
      const el = marqueeElRef.current;
      if (el) { el.style.width = '0'; el.style.height = '0'; el.style.opacity = '0'; }
      marqueeDragRef.current = null;
    };

    window.addEventListener('mousemove', onMove, true);  // capture: fires before region stopPropagation
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pixelsPerMeasure]);

  // Keep refs in sync so drag closures always read current values without stale closures
  leftColWidthRef.current       = leftColWidth;
  regionsRef.current            = regions;
  tracksRef.current             = tracks;
  notesRef.current              = notes;
  totalMeasuresRef.current      = totalMeasures;
  selectedRegionIdsRef.current  = selectedRegionIds;

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
    const rect    = scroller.getBoundingClientRect();
    const x       = clientX - rect.left + scroller.scrollLeft;
    const seconds = Math.max(0, x / pxPerSec);
    Tone.Transport.seconds = seconds;
    updatePlayhead();
  }, [pxPerSec, updatePlayhead]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    seekToClientX(e.clientX);
    const scroller = timelineRef.current;
    if (rulerRef.current?.contains(e.target)) {
      isDraggingRef.current = true;
      document.body.classList.add('is-dragging');
    } else if (scroller) {
      const rect     = scroller.getBoundingClientRect();
      const contentX = e.clientX - rect.left + scroller.scrollLeft;
      const contentY = e.clientY - rect.top  + scroller.scrollTop - RULER_HEIGHT;
      marqueeDragRef.current = { startX: contentX, startY: contentY, active: false };
    }
  };

  useEffect(() => {
    const onMove = (e) => { if (!isDraggingRef.current) return; seekToClientX(e.clientX); };
    const onUp   = ()  => { isDraggingRef.current = false; document.body.classList.remove('is-dragging'); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [seekToClientX]);

  // ── Ctrl+Scroll zoom-to-cursor ────────────────────────────────
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const mouseX    = e.clientX - el.getBoundingClientRect().left;
      const absoluteX = mouseX + el.scrollLeft;
      const factor    = e.deltaY > 0 ? 0.9 : 1.1;
      setZoomLevel(prev => {
        const minZoom = timelineRef.current
          ? timelineRef.current.clientWidth / (PIXELS_PER_MEASURE * totalMeasuresRef.current)
          : 0.05;
        const next = Math.max(minZoom, Math.min(8, prev * factor));
        if (next === prev) return prev;
        pendingScrollRef.current = absoluteX * (next / prev) - mouseX;
        // proportional correction for piano roll (keeps same measure at left edge)
        const pianoEl = pianoScrollRef.current;
        if (pianoEl) pendingPianoScrollRef.current = pianoEl.scrollLeft * (next / prev);
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
      const factor     = e.deltaY > 0 ? 0.9 : 1.1;
      setZoomLevel(prev => {
        const minZoom = timelineRef.current
          ? timelineRef.current.clientWidth / (PIXELS_PER_MEASURE * totalMeasuresRef.current)
          : 0.05;
        const next = Math.max(minZoom, Math.min(8, prev * factor));
        if (next === prev) return prev;
        // zoom-to-cursor for piano roll
        pendingPianoScrollRef.current = absoluteX * (next / prev) - Math.max(0, gridMouseX);
        // proportional correction for arrangement (keeps same measure at left edge)
        const arrEl = timelineRef.current;
        if (arrEl) pendingScrollRef.current = arrEl.scrollLeft * (next / prev);
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
  const handleTimelineScroll = useCallback((e) => {
    if (!syncingScrollRef.current) {
      syncingScrollRef.current = true;
      if (pianoScrollRef.current) pianoScrollRef.current.scrollLeft = e.target.scrollLeft;
      syncingScrollRef.current = false;
    }
    if (!syncingVerticalRef.current) {
      syncingVerticalRef.current = true;
      if (trackHeadersRef.current) trackHeadersRef.current.scrollTop = e.target.scrollTop;
      syncingVerticalRef.current = false;
    }
  }, []);

  const handlePianoRollScroll = useCallback((e) => {
    if (syncingScrollRef.current) return;
    syncingScrollRef.current = true;
    if (timelineRef.current) timelineRef.current.scrollLeft = e.target.scrollLeft;
    syncingScrollRef.current = false;
    lastPianoScrollTopRef.current = e.target.scrollTop;
  }, []);

  const handleTrackHeadersScroll = useCallback((e) => {
    if (syncingVerticalRef.current) return;
    syncingVerticalRef.current = true;
    if (timelineRef.current) timelineRef.current.scrollTop = e.target.scrollTop;
    syncingVerticalRef.current = false;
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
        const newNotes = srcNotes.map(n => ({
          ...n,
          id: `note_${nextNoteIdRef.current++}`,
          regionId: idMap[n.regionId],
          startBeat: n.startBeat + (targetMeasure - leftmostMeasure) * 4,
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
                const labelStep = Math.max(1, Math.ceil(50 / pixelsPerMeasure));
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
                      setRegions(prev => [...prev, { id: `r${n}`, trackId: t.id, startMeasure: measure, durationMeasures: 1 }]);
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
