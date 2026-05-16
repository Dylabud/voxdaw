import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './WorkstationShell.module.css';
import RegionEditor from './RegionEditor/RegionEditor';

const PIXELS_PER_BEAT    = 25;
const PIXELS_PER_MEASURE = PIXELS_PER_BEAT * 4;  // 100px at zoom 1
const BPM                = 120;
const MEASURES           = 24;
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
  const ppb = ppm / 4;
  const pp8 = ppm / 8;
  const layers = [
    `repeating-linear-gradient(to right, var(--border-mid) 0, var(--border-mid) 1px, transparent 1px, transparent ${ppm}px)`,
    ...(zoomLevel >= 1.5 ? [`repeating-linear-gradient(to right, var(--border-faint) 0, var(--border-faint) 1px, transparent 1px, transparent ${ppb}px)`] : []),
    ...(zoomLevel >= 3.0 ? [`repeating-linear-gradient(to right, var(--border-subtle) 0, var(--border-subtle) 1px, transparent 1px, transparent ${pp8}px)`] : []),
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

  // Derived zoom values
  const pixelsPerMeasure = PIXELS_PER_MEASURE * zoomLevel;
  const pxPerSec         = PIXELS_PER_BEAT * (BPM / 60) * zoomLevel;

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

  // ── Derived editor state ───────────────────────────────────
  const editingTrack      = editingTrackId ? tracks.find(t => t.id === editingTrackId) : null;
  const editingTrackNotes = notes.filter(n => n.trackId === editingTrackId);

  const handleAddTrack = useCallback(() => {
    const n = nextIdRef.current++;
    setTracks(prev => [...prev, {
      id: `t${n}`,
      name: `track ${n}`,
      instrument: 'fm pluck',
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
    setNotes(prev => [...prev, { id: `note_${nextNoteIdRef.current++}`, ...noteData }]);
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
    if (isDraggingRef.current) return;
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
    if (hoverRef.current.trackId !== trackId) return;
    if (regions.some(r => r.trackId === trackId)) return;
    const measure = hoverRef.current.measure;
    if (isPositionOccupied(trackId, measure)) return;
    const n = nextRegionIdRef.current++;
    setRegions(prev => [...prev, { id: `r${n}`, trackId, startMeasure: measure, durationMeasures: 1 }]);
  };

  const stopMouseDown = (e) => e.stopPropagation();

  // ── Region drag ──────────────────────────────────────────────
  const startRegionDrag = (e, region, mode) => {
    e.stopPropagation();
    e.preventDefault();
    const regionEl       = e.currentTarget.closest(`.${styles.region}`);
    const origTrackIndex = tracksRef.current.findIndex(t => t.id === region.trackId);
    dragRef.current = {
      regionId:          region.id,
      trackId:           region.trackId,
      origTrackIndex,
      pendingTrackId:    region.trackId,
      pendingTrackIndex: origTrackIndex,
      mode,
      startX: e.clientX,
      initStart: region.startMeasure,
      initDuration: region.durationMeasures,
      el: regionEl,
      pendingStart: region.startMeasure,
      pendingDuration: region.durationMeasures,
    };
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  };

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round((e.clientX - d.startX) / pixelsPerMeasure);
      let newStart    = d.pendingStart;
      let newDuration = d.pendingDuration;

      const noOverlap = (candTrackId, candStart, candDur) =>
        !regionsRef.current.some(r =>
          r.id !== d.regionId &&
          r.trackId === candTrackId &&
          candStart < r.startMeasure + r.durationMeasures &&
          candStart + candDur > r.startMeasure
        );

      if (d.mode === 'move') {
        const candStart = Math.max(0, d.initStart + delta);
        const rect       = timelineRef.current.getBoundingClientRect();
        const relContent = e.clientY - rect.top + timelineRef.current.scrollTop - RULER_HEIGHT;
        const candIdx    = Math.max(0, Math.min(tracksRef.current.length - 1, Math.floor(relContent / TRACK_H)));
        const candTrackId = tracksRef.current[candIdx]?.id ?? d.pendingTrackId;
        if (noOverlap(candTrackId, candStart, d.initDuration)) {
          newStart              = candStart;
          d.pendingTrackId      = candTrackId;
          d.pendingTrackIndex   = candIdx;
        }
      } else if (d.mode === 'resize-right') {
        const candidate = Math.max(1, d.initDuration + delta);
        if (noOverlap(d.trackId, d.initStart, candidate)) newDuration = candidate;
      } else if (d.mode === 'resize-left') {
        const wanted    = d.initStart + delta;
        const candStart = Math.max(0, Math.min(wanted, d.initStart + d.initDuration - 1));
        const candDur   = d.initDuration + (d.initStart - candStart);
        if (noOverlap(d.trackId, candStart, candDur)) { newStart = candStart; newDuration = candDur; }
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
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      if (d.el) { d.el.style.transform = ''; d.el.style.zIndex = ''; }
      const { regionId, pendingStart, pendingDuration, pendingTrackId } = d;
      setRegions(prev => prev.map(r =>
        r.id === regionId
          ? { ...r, startMeasure: pendingStart, durationMeasures: pendingDuration, trackId: pendingTrackId }
          : r));
      dragRef.current = null;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pixelsPerMeasure]);

  // Keep refs in sync so drag closures always read current values without stale closures
  leftColWidthRef.current = leftColWidth;
  regionsRef.current      = regions;
  tracksRef.current       = tracks;

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
    Tone.Transport.bpm.value = BPM;
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
    if (rulerRef.current?.contains(e.target)) isDraggingRef.current = true;
  };

  useEffect(() => {
    const onMove = (e) => { if (!isDraggingRef.current) return; seekToClientX(e.clientX); };
    const onUp   = ()  => { isDraggingRef.current = false; };
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
        const next = Math.max(0.25, Math.min(8, prev * factor));
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
        const next = Math.max(0.25, Math.min(8, prev * factor));
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
        <div className={styles.transportCenter}>
          <button
            className={isPlaying ? styles.transportBtnActive : styles.transportBtn}
            onClick={handlePlayPause} title="Play / Pause (Space)">▶</button>
          <button className={styles.transportBtn} onClick={handleStop} title="Stop">■</button>
          <button className={styles.transportBtn} title="Record">●</button>
        </div>
        <div className={styles.transportRight}>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>BPM</span>
            <span className={styles.metaValue}>120</span>
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
                <div key={t.id} className={`${styles.trackRow}${editingTrackId === t.id ? ` ${styles.trackRowActive}` : ''}`}
                  onDoubleClick={() => setEditingTrackId(prev => prev === t.id ? null : t.id)}>
                  <div className={styles.trackTopRow}>
                    <div className={styles.trackNameBlock}>
                      <span className={styles.trackName}>{t.name}</span>
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
              minWidth: `${MEASURES * pixelsPerMeasure}px`,
              backgroundImage: computeGridBg(pixelsPerMeasure, zoomLevel),
            }}
          >
            {/* Ruler */}
            <div ref={rulerRef} className={styles.ruler}>
              {Array.from({ length: MEASURES }, (_, i) => (
                <span key={i} className={styles.rulerLabel}
                  style={{ left: `${i * pixelsPerMeasure}px` }}>
                  {i + 1}
                </span>
              ))}
            </div>

            {/* Track lanes */}
            {tracks.map((t) => {
              return (
                <div key={t.id} className={styles.trackLane}
                  onMouseMove={(e) => handleLaneMouseMove(e, t.id)}
                  onMouseLeave={() => handleLaneMouseLeave(t.id)}
                  onMouseDown={stopMouseDown}
                  onClick={(e) => handleLaneClick(e, t.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const { trackId: hTrackId, measure } = hoverRef.current;
                    if (hTrackId === t.id && regions.some(r => r.trackId === t.id) && !isPositionOccupied(t.id, measure)) {
                      const n = nextRegionIdRef.current++;
                      setRegions(prev => [...prev, { id: `r${n}`, trackId: t.id, startMeasure: measure, durationMeasures: 1 }]);
                    }
                    setEditingTrackId(t.id);
                  }}>
                  <div ref={(el) => { ghostRefs.current[t.id] = el; }} className={styles.ghost} />
                  {regions.filter(r => r.trackId === t.id).map(r => (
                    <div key={r.id} className={styles.region}
                      style={{
                        left:  `${r.startMeasure    * pixelsPerMeasure}px`,
                        width: `${r.durationMeasures * pixelsPerMeasure}px`,
                      }}
                      onMouseMove={(e) => e.stopPropagation()}
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
          </div>
        </div>
      </div>

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
              pianoRollPlayheadRef={pianoRollPlayheadRef}
              pianoScrollRef={pianoScrollRef}
              onGridScroll={handlePianoRollScroll}
              onLeftColResize={startLeftColDrag}
              onClose={() => setEditingTrackId(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}
