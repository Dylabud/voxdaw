import { useState, useRef, useEffect, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './WorkstationShell.module.css';
import RegionEditor from './RegionEditor/RegionEditor';

const PIXELS_PER_BEAT = 25; // 100px per bar in 4/4 — matches CSS bar-line gradient
const BPM = 120;
const MEASURES = 24;        // ruler labels 1..24
const PX_PER_SEC = PIXELS_PER_BEAT * (BPM / 60);

const formatTime = (t) => {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  const cs   = Math.floor((t % 1) * 100);
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};

export default function WorkstationShell({ onNavigateHome, isDarkMode, onThemeToggle }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [tracks, setTracks]               = useState([]);
  const [regions, setRegions]             = useState([]);
  const [editingRegion, setEditingRegion] = useState(null);
  const [editorHeight, setEditorHeight]   = useState(320);
  const editorWrapRef = useRef(null);
  const nextIdRef       = useRef(1);
  const nextRegionIdRef = useRef(1);
  const ghostRefs       = useRef({});                                // trackId → ghost DOM element
  const hoverRef        = useRef({ trackId: null, measure: 0 });
  const dragRef         = useRef(null);                              // active region drag state
  const playheadRef    = useRef(null);
  const timeRef        = useRef(null);
  const timelineRef    = useRef(null);   // scroll container, for scrollLeft + bounding rect
  const rulerRef       = useRef(null);   // drag is initiated only when mousedown lands here
  const rafRef         = useRef(null);
  const isDraggingRef  = useRef(false);

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

  // ── Ghost region (hover preview) — ref-based, zero React re-renders ──
  // Ghost only shows on empty lanes; once a lane has any region, no ghost.
  const laneIsEmpty = (trackId) => !regions.some(r => r.trackId === trackId);

  const handleLaneMouseMove = (e, trackId) => {
    if (isDraggingRef.current) return;
    if (!laneIsEmpty(trackId)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const measure = Math.max(0, Math.floor(x / 100));
    hoverRef.current = { trackId, measure };
    const ghost = ghostRefs.current[trackId];
    if (ghost) {
      ghost.style.transform = `translateX(${measure * 100}px)`;
      ghost.style.opacity = '0.45';
    }
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
    if (!laneIsEmpty(trackId)) return;
    if (hoverRef.current.trackId !== trackId) return;
    const measure = hoverRef.current.measure;
    const n = nextRegionIdRef.current++;
    setRegions(prev => [...prev, {
      id: `r${n}`,
      trackId,
      startMeasure: measure,
      durationMeasures: 1,
    }]);
  };

  // Stop the lane's mousedown from bubbling to the timeline seek handler
  const stopMouseDown = (e) => e.stopPropagation();

  // ── Region drag (move + resize) — ref-based, commit on mouseup ───────
  const startRegionDrag = (e, region, mode) => {
    e.stopPropagation();
    e.preventDefault();
    const regionEl = e.currentTarget.closest(`.${styles.region}`);
    dragRef.current = {
      regionId: region.id,
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
      const delta = Math.round((e.clientX - d.startX) / 100);
      let newStart = d.initStart;
      let newDuration = d.initDuration;

      if (d.mode === 'move') {
        newStart = Math.max(0, d.initStart + delta);
      } else if (d.mode === 'resize-right') {
        newDuration = Math.max(1, d.initDuration + delta);
      } else if (d.mode === 'resize-left') {
        const wanted = d.initStart + delta;
        newStart = Math.max(0, Math.min(wanted, d.initStart + d.initDuration - 1));
        newDuration = d.initDuration + (d.initStart - newStart);
      }

      if (d.el) {
        d.el.style.left  = `${newStart * 100}px`;
        d.el.style.width = `${newDuration * 100}px`;
      }
      d.pendingStart = newStart;
      d.pendingDuration = newDuration;
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      const { regionId, pendingStart, pendingDuration } = d;
      setRegions(prev => prev.map(r =>
        r.id === regionId
          ? { ...r, startMeasure: pendingStart, durationMeasures: pendingDuration }
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
  }, []);

  // ── Region editing ───────────────────────────────────────────────────
  const handleEditRegion = (e, region) => {
    e.stopPropagation();
    setEditingRegion(region);
  };

  // ── Editor panel divider drag (resize panel height) ──────────────────
  const startDividerDrag = (e) => {
    e.preventDefault();
    let pending = editorHeight;
    const onMove = (ev) => {
      const wanted = window.innerHeight - ev.clientY;
      pending = Math.max(150, Math.min(wanted, window.innerHeight - 200));
      if (editorWrapRef.current) {
        editorWrapRef.current.style.height = `${pending}px`;
      }
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

  // Look up the track for the currently editing region (avoid stale data after delete)
  const editingTrack = editingRegion
    ? tracks.find(t => t.id === editingRegion.trackId)
    : null;

  // Shared visual update — called by rAF, seek, drag, pause.
  const updatePlayhead = useCallback(() => {
    const t = Tone.Transport.seconds;
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${t * PX_PER_SEC}px)`;
    }
    if (timeRef.current) {
      timeRef.current.textContent = formatTime(t);
    }
  }, []);

  // rAF loop runs only while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      updatePlayhead();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, updatePlayhead]);

  const handlePlayPause = useCallback(async () => {
    await Tone.start();
    Tone.Transport.bpm.value = BPM;
    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      setIsPlaying(false);
      updatePlayhead(); // freeze visual at the paused position
    } else {
      Tone.Transport.start();
      setIsPlaying(true);
    }
  }, [updatePlayhead]);

  const handleStop = useCallback(() => {
    Tone.Transport.stop();
    setIsPlaying(false);
    if (playheadRef.current) playheadRef.current.style.transform = 'translateX(0px)';
    if (timeRef.current)     timeRef.current.textContent = '00:00:00';
  }, []);

  // ── Click / drag seek ─────────────────────────────────────
  const seekToClientX = useCallback((clientX) => {
    const scroller = timelineRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const x = clientX - rect.left + scroller.scrollLeft;
    const seconds = Math.max(0, x / PX_PER_SEC);
    Tone.Transport.seconds = seconds;
    updatePlayhead();
  }, [updatePlayhead]);

  // Single mousedown handler: any mousedown seeks; only ruler mousedowns also begin a drag.
  const handleMouseDown = (e) => {
    e.preventDefault();
    seekToClientX(e.clientX);
    if (rulerRef.current?.contains(e.target)) {
      isDraggingRef.current = true;
    }
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingRef.current) return;
      seekToClientX(e.clientX);
    };
    const onUp = () => { isDraggingRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [seekToClientX]);

  // ── Spacebar hotkey ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      handlePlayPause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePlayPause]);

  return (
    <div className={styles.shell}>

      {/* ── Transport bar ───────────────────────────────────── */}
      <div className={styles.transport}>
        <div className={styles.transportLeft}>
          <button
            className={styles.themeBtn}
            onClick={onThemeToggle}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? '◑' : '○'}
          </button>
          <button className={styles.homeBtn} onClick={onNavigateHome}>
            [ ⌂ home ]
          </button>
        </div>

        <div className={styles.transportCenter}>
          <button
            className={isPlaying ? styles.transportBtnActive : styles.transportBtn}
            onClick={handlePlayPause}
            title="Play / Pause (Space)"
          >▶</button>
          <button
            className={styles.transportBtn}
            onClick={handleStop}
            title="Stop"
          >■</button>
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

      {/* ── Arrangement view ────────────────────────────────── */}
      <div className={`${styles.arrangement}${editingRegion ? ` ${styles.arrangementShrunk}` : ''}`}>

        {/* Track header column */}
        <div className={styles.trackHeaders}>
          <div className={styles.tracksHeader}>tracks</div>
          {tracks.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>no tracks</p>
              <p className={styles.emptyHint}>add a track to begin</p>
              <button className={styles.addTrackPrimary} onClick={handleAddTrack}>
                [ + add track ]
              </button>
            </div>
          ) : (
            <>
              {tracks.map((t) => (
                <div key={t.id} className={styles.trackRow}>
                  <div className={styles.trackTopRow}>
                    <div className={styles.trackNameBlock}>
                      <span className={styles.trackName}>{t.name}</span>
                      <button className={styles.trackInstrument} title="Change instrument (coming soon)">
                        {t.instrument}
                      </button>
                    </div>
                    <div className={styles.trackToggles}>
                      <button
                        className={t.isMuted ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleMute(t.id)}
                        title="Mute"
                      >M</button>
                      <button
                        className={t.isSolo ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleSolo(t.id)}
                        title="Solo"
                      >S</button>
                    </div>
                  </div>
                  <div className={styles.fakeSlider}>
                    <div className={styles.fakeSliderThumb} />
                  </div>
                </div>
              ))}
              <button className={styles.addTrackGhost} onClick={handleAddTrack}>
                [ + add track ]
              </button>
            </>
          )}
        </div>

        {/* Timeline grid */}
        <div ref={timelineRef} className={styles.timeline} onMouseDown={handleMouseDown}>
          <div className={styles.timelineInner}>
            <div ref={rulerRef} className={styles.ruler}>
              {Array.from({ length: MEASURES }, (_, i) => (
                <span
                  key={i}
                  className={styles.rulerLabel}
                  style={{ left: `${i * 100}px` }}
                >
                  {i + 1}
                </span>
              ))}
            </div>
            {tracks.map((t) => {
              const isEmpty = laneIsEmpty(t.id);
              return (
                <div
                  key={t.id}
                  className={styles.trackLane}
                  onMouseMove={(e) => handleLaneMouseMove(e, t.id)}
                  onMouseLeave={() => handleLaneMouseLeave(t.id)}
                  onMouseDown={stopMouseDown}
                  onClick={(e) => handleLaneClick(e, t.id)}
                >
                  {isEmpty && (
                    <div
                      ref={(el) => { ghostRefs.current[t.id] = el; }}
                      className={styles.ghost}
                    />
                  )}
                  {regions.filter(r => r.trackId === t.id).map(r => (
                    <div
                      key={r.id}
                      className={styles.region}
                      style={{
                        left:  `${r.startMeasure * 100}px`,
                        width: `${r.durationMeasures * 100}px`,
                      }}
                      onMouseDown={(e) => startRegionDrag(e, r, 'move')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        className={styles.resizeLeft}
                        onMouseDown={(e) => startRegionDrag(e, r, 'resize-left')}
                      />
                      <div
                        className={styles.resizeRight}
                        onMouseDown={(e) => startRegionDrag(e, r, 'resize-right')}
                      />
                      <button
                        className={styles.editBtn}
                        onMouseDown={stopMouseDown}
                        onClick={(e) => handleEditRegion(e, r)}
                      >
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

      {editingRegion && (
        <>
          <div
            className={styles.divider}
            onMouseDown={startDividerDrag}
            title="Drag to resize"
          />
          <div
            ref={editorWrapRef}
            className={styles.editorWrap}
            style={{ height: editorHeight }}
          >
            <RegionEditor
              region={editingRegion}
              track={editingTrack}
              onClose={() => setEditingRegion(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}
