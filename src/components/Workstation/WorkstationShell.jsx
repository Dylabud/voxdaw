import { useState, useRef, useEffect, useLayoutEffect, useCallback, Fragment } from 'react';
import * as Tone from 'tone';
import styles from './WorkstationShell.module.css';
import RegionEditor from './RegionEditor/RegionEditor';
import ContextMenu from './ContextMenu/ContextMenu';
import { KEYS } from './pitchKeys';
import { firstLoopOffsetMeasures, loopBoundaries } from './loopMath';
import useWorkstationAudio from '../../hooks/useWorkstationAudio';
import PanKnob from './PanKnob';
import { serializeProject, deserializeProject, downloadJSON, readJSONFile } from './projectIO';
import { saveProject as storeSaveProject } from '../../utils/projectStore';
import { EFFECT_DEFS, defaultParamsFor, automationTargetsFor, labelForTarget, metaForTarget } from './effectDefs';
import {
  TRACK_H, AUTO_LANE_H, GLOBAL_STRIP_H, computeLaneTops, yToTrackIndex, targetKey, toKnob, denorm,
  isVolumeAutomated, isPanAutomated, automatedFxKeys,
} from './automationMath';
import { TEMPO_META, tempoPointsOf, buildTempoMap } from './tempoMath';
import AutomationLane from './AutomationLane';
import GroupModal from './GroupModal';
import GroupFxPanel from './GroupFxPanel';
import { bounceProject } from './audioBounce';
import { exportWAV, exportMP3, trimExportBuffer } from '../../utils/audioExport';
import { transcribeAudio } from './transcribeAudio';
import { TRACK_COLORS } from './trackColors';
import { defaultEnvelopeFor } from './synthFactory';

const PIXELS_PER_BEAT    = 25;
const PIXELS_PER_MEASURE = PIXELS_PER_BEAT * 4;  // 100px at zoom 1
const MAX_HISTORY        = 100;                  // undo/redo stack cap
// BPM and totalMeasures are state inside the component
// TRACK_H (72, matches .trackLane height in CSS) now lives in automationMath.js
// alongside the automation sub-lane heights — one source for all Y-geometry.
const RULER_HEIGHT       = 24;  // matches .ruler height in CSS
const MIN_REGION         = 0.0625; // minimum region width in measures (one 16th note)
const LOOP_EPS           = 1e-6;
const normalizeLoopInterval = (durationMeasures, loopInterval) =>
  (loopInterval == null || durationMeasures <= loopInterval + LOOP_EPS) ? null : loopInterval;

const formatTime = (t) => {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  const cs   = Math.floor((t % 1) * 100);
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};

// Returns IDs of regions whose bounding box intersects the marquee rectangle (in timeline-scroll-relative px).
// `tops` = computeLaneTops output — open automation sub-lanes shift rows below them,
// so row Y comes from the cumulative table, not trackIndex * TRACK_H.
function getIntersectingRegionIds(minX, maxX, minY, maxY, regions, tracks, ppm, tops) {
  return regions
    .filter(r => {
      const tIdx   = tracks.findIndex(t => t.id === r.trackId);
      const rLeft  = r.startMeasure * ppm;
      const rRight = (r.startMeasure + r.durationMeasures) * ppm;
      const rTop   = tops[tIdx];
      // Row height from the cumulative table: a collapsed group member is a
      // zero-height band (tops[i+1] === tops[i]) — invisible, not selectable.
      const rBot   = Math.min(rTop + TRACK_H, tops[tIdx + 1] ?? (rTop + TRACK_H));
      if (rBot <= rTop) return false;
      return rLeft < maxX && rRight > minX && rTop < maxY && rBot > minY;
    })
    .map(r => r.id);
}

// Returns the smallest power-of-2 measure interval that keeps labels at least 80px apart.
function getMeasureInterval(ppm) {
  return Math.pow(2, Math.max(0, Math.ceil(Math.log2(80 / ppm))));
}

// Hide the per-region [edit] badge below this rendered width — below ~60px the badge crowds
// the resize handles and overflows the region content area.
const EDIT_BTN_MIN_PX = 60;

// Hide fade overlays + handles below this rendered region width — they're unusable below ~30px.
const FADE_UI_MIN_PX = 30;

// Blank session in deserializeProject's output shape — applied by the
// pending-project effect for "New Project". MUST mirror the useState/useRef
// initializers below exactly, or "New Project" would differ from a fresh mount.
const BLANK_PROJECT_DATA = {
  name: 'untitled', bpm: 120, totalMeasures: 200,
  tracks: [], regions: [], notes: [], globalAutomations: [], groups: [],
  nextId: 1, nextRegionId: 1, nextEffectId: 1, nextNoteId: 0, nextAutomationId: 1,
  nextGroupId: 1,
  repairedCount: 0,
};

// Strip filesystem-hostile characters for the .voxdaw download filename.
const sanitizeFilename = (name) =>
  (String(name ?? '').replace(/[/\\:*?"<>|]/g, '').trim() || 'project');

// Returns the snap increment (in measures) matching the smallest visible grid line at this zoom.
// Fractional range (ppm>=150) mirrors drawGrid's beat/sub-beat thresholds (Phase 82).
// Macro range (ppm<80) reuses getMeasureInterval — single source of truth with the drawn grid.
export function getSnapIncrement(ppm) {
  if (ppm >= 300) return 0.125; // 8th notes
  if (ppm >= 150) return 0.25;  // quarter notes
  return getMeasureInterval(ppm); // 1, 2, 4, 8, 16… matches visible grid period
}

// Crisp grid renderer for both the arrangement and piano-roll grids. Draws onto a canvas
// pinned to the scroll viewport, virtualized to the visible measure range. pixelsPerMeasure
// stays float (smooth zoom, regions never jump) and each LINE is snapped to a whole pixel
// here at draw time (Math.round) so it can't smear — the only way to get smooth + crisp +
// aligned at once (a uniform CSS gradient can't snap lines individually). CSS vars are read
// at draw time so light/dark themes resolve automatically; fillRect of a 1px-wide rect at
// an integer X is crisp at any devicePixelRatio.
export function drawGrid(canvas, { scrollLeft, viewW, viewH, ppm, zoomLevel, leftInset = 0 }) {
  if (!canvas || viewW <= 0 || viewH <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(viewW * dpr);
  const bh = Math.round(viewH * dpr);
  if (canvas.width !== bw)  canvas.width  = bw;
  if (canvas.height !== bh) canvas.height = bh;
  canvas.style.width  = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);

  const cs     = getComputedStyle(canvas);
  const cMid   = cs.getPropertyValue('--border-mid').trim();
  const cFaint = cs.getPropertyValue('--border-faint').trim();
  const cSub   = cs.getPropertyValue('--border-subtle').trim();
  const labelStep = getMeasureInterval(ppm);
  const showBeats = labelStep === 1 && zoomLevel >= 1.5;
  const show8ths  = labelStep === 1 && zoomLevel >= 3.0;

  const line = (xContent, color) => {
    const x = Math.round(leftInset + xContent - scrollLeft); // per-line whole-pixel snap
    if (x < leftInset || x > viewW) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, 0, 1, viewH);
  };
  const firstM = Math.max(0, Math.floor((scrollLeft - leftInset) / ppm));
  const lastM  = Math.ceil((scrollLeft + (viewW - leftInset)) / ppm);
  for (let m = firstM; m <= lastM; m++) {
    if (m % labelStep === 0) line(m * ppm, cMid);                       // down-beat
    if (showBeats) for (let k = 1; k <= 3; k++) line(m * ppm + k * ppm / 4, cFaint); // quarters
    if (show8ths)  for (const k of [1, 3, 5, 7]) line(m * ppm + k * ppm / 8, cSub);  // eighths
  }
}

export default function WorkstationShell({ onNavigateHome, isDarkMode, onThemeToggle, getMoogBusNode, pendingProject }) {
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
  const [projectName,    setProjectName]    = useState('untitled');
  const [editingName,    setEditingName]    = useState(false);
  const [tempName,       setTempName]       = useState('untitled');
  const [currentProjectId, setCurrentProjectId] = useState(null); // browser-store id; null until first save
  const [selectedRegionIds, setSelectedRegionIds] = useState(new Set());
  const [totalMeasures,    setTotalMeasures]    = useState(200);
  const [toastMessage,     setToastMessage]     = useState(null);
  const [activeTrackId,    setActiveTrackId]    = useState(null);
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [advancedMode,     setAdvancedMode]     = useState(false);
  // Tracks with their automation area expanded (heartbeat toggle). UI-only:
  // never on track objects, never serialized, never in undo history.
  const [openAutomationTrackIds, setOpenAutomationTrackIds] = useState(() => new Set());
  // Last placed/moved/clicked automation anchor — Delete/Backspace target.
  // Index-based (points carry no ids); the central keydown handler re-resolves
  // validity through tracksRef before deleting, so stale selections are inert.
  const [selectedAnchor, setSelectedAnchor] = useState(null); // { trackId, automationId, pointIndex } | null
  // Global (project-wide) automation lanes — currently only { kind: 'tempo' }.
  // PROJECT DATA (unlike openAutomationTrackIds): serialized additively in
  // .voxdaw files and part of undo history. The audio hook is the single
  // writer of Transport.bpm (recomputeTempo); tempoMath.buildTempoMap is the
  // measures↔seconds source of truth everywhere.
  const [globalAutomations, setGlobalAutomations] = useState([]);
  // The tempo lane's visibility (chevron in the global strip) — UI-only.
  const [globalLaneOpen, setGlobalLaneOpen] = useState(false);
  // Track groups (flat, no nesting): [{ id: 'g<n>', name, color, isMuted,
  // isSolo, volume, pan, effects, automations }] + track.groupId membership.
  // Members are kept CONTIGUOUS in the tracks array (createGroup reorders,
  // deserialize normalizes) — the group header row renders before the first
  // member of each run. PROJECT DATA: undo history + additive .voxdaw field.
  const [groups, setGroups] = useState([]);
  // Collapsed groups (chevron) — UI-only, like openAutomationTrackIds.
  const [collapsedGroupIds, setCollapsedGroupIds] = useState(() => new Set());
  const [renamingGroupId, setRenamingGroupId] = useState(null);
  // { initiatorTrackId } | null — the create-group checkbox modal.
  const [groupModal, setGroupModal] = useState(null);
  // Group whose effects rack is docked at the bottom (mutually exclusive with
  // the track editor — opening one closes the other). UI-only.
  const [editingGroupId, setEditingGroupId] = useState(null);
  // Opening the track editor (double-click, ✎, …) evicts the group rack; the
  // group fx button does the reverse inline.
  useEffect(() => { if (editingTrackId != null) setEditingGroupId(null); }, [editingTrackId]);
  // Performance quality (high/medium/low) — machine capability, not project
  // data: persisted in localStorage, never enters .voxdaw files or undo history.
  const [performanceQuality, setPerformanceQuality] = useState(() => {
    try {
      const v = localStorage.getItem('voxdaw.performanceQuality');
      return v === 'low' || v === 'medium' || v === 'high' ? v : 'high';
    } catch { return 'high'; }
  });
  const handleQualityChange = useCallback((q) => {
    setPerformanceQuality(q);
    try { localStorage.setItem('voxdaw.performanceQuality', q); } catch {}
  }, []);

  // ── Moog recording ──────────────────────────────────────────────────────────
  const [moogRecording, setMoogRecording] = useState(false);
  const [moogRecordSec, setMoogRecordSec] = useState(0);
  const moogRecorderRef  = useRef(null);  // Tone.Recorder instance while recording
  const moogBusNodeRef   = useRef(null);  // connected bus node (for cleanup)
  const moogTimerRef     = useRef(null);  // setInterval id for elapsed-time display
  const moogRecordingRef = useRef(false); // ref mirror of moogRecording (avoids stale closures)

  // Audio region playback — keyed by regionId
  const audioBuffersByRegionId = useRef(new Map()); // regionId → native AudioBuffer
  const audioPlayersRef        = useRef(new Map()); // regionId → Tone.Player (synced to transport)

  // ── Undo/redo history (arrangement data only: tracks/regions/notes) ──────────
  const [past,   setPast]   = useState([]);   // [{tracks,regions,notes}, …] oldest→newest
  const [future, setFuture] = useState([]);
  const pastRef   = useRef(past);   pastRef.current   = past;   // read by the keydown handler
  const futureRef = useRef(future); futureRef.current = future;
  const latestRef        = useRef(null);   // most-recent committed snapshot (refs, immutable)
  const burstActiveRef   = useRef(false);  // leading-edge coalescing of a drag's many commits
  const burstTimerRef    = useRef(null);
  const timeTravelingRef = useRef(false);  // set while undo/redo/load applies state → don't record
  const undoRef          = useRef(null);
  const redoRef          = useRef(null);

  // Derived zoom values. pixelsPerMeasure stays float so zoom is smooth and regions
  // don't jump (a rounded unit shifts measure m by m·Δ px far down the timeline). Grid
  // lines are kept crisp instead by per-line whole-pixel snapping in drawGrid (canvas).
  const pixelsPerMeasure = PIXELS_PER_MEASURE * zoomLevel;
  // Global automation area height — rows above track 0 inside the same
  // scroller flow. laneTops mirror the DOM flow, so every geometry consumer
  // (marquee, region drag, ghost, auto-scroll) stays correct untouched.
  const globalAreaH = GLOBAL_STRIP_H + (globalLaneOpen ? AUTO_LANE_H : 0);
  const groupById = new Map(groups.map(g => [g.id, g]));
  // Cumulative row-top table — open automation sub-lanes (track AND group),
  // group header rows and collapsed groups all make row Y non-uniform.
  const laneTops = computeLaneTops(tracks, openAutomationTrackIds, globalAreaH,
    { collapsedIds: collapsedGroupIds, byId: groupById });
  // The (single) tempo automation, or an empty stand-in for the lane's dashed
  // baseline — the real object is created lazily by commitTempoPoints.
  const tempoAutomation = globalAutomations.find(a => a.target?.kind === 'tempo')
    ?? { id: '__tempo__', target: { kind: 'tempo' }, points: [] };
  const tempoAutomated = tempoAutomation.points.length > 0;

  const editorWrapRef        = useRef(null);
  const nextIdRef            = useRef(1);
  const nextRegionIdRef      = useRef(1);
  const nextNoteIdRef        = useRef(0);
  const nextEffectIdRef      = useRef(1);
  const nextAutomationIdRef  = useRef(1);
  const nextGroupIdRef       = useRef(1);
  const laneTopsRef          = useRef([0]);
  const ghostRefs            = useRef({});
  const hoverRef             = useRef({ trackId: null, measure: 0 });
  const dragRef              = useRef(null);
  const playheadRef          = useRef(null);
  const pianoRollPlayheadRef = useRef(null);
  const timeRef              = useRef(null);
  const bpmLiveRef           = useRef(null); // live tempo readout (rAF textContent — zero re-render)
  const timelineRef          = useRef(null);
  const timelineCanvasRef    = useRef(null);   // pinned grid-line canvas over the timeline viewport
  const rulerRef             = useRef(null);
  const rafRef               = useRef(null);
  const isDraggingRef        = useRef(false);
  const scrubClutchRef       = useRef(false); // ruler-scrub: transport was playing → silently pause; resume on mouseup
  const pianoScrollRef       = useRef(null);   // RegionEditor scroll container
  const trackHeadersRef      = useRef(null);
  const pendingScrollRef      = useRef(null);  // arrangement zoom-to-cursor pending scrollLeft
  const pendingPianoScrollRef = useRef(null);  // piano roll pending scrollLeft
  const liveZoomRef           = useRef(1);     // target zoom, ahead of committed `zoomLevel` during a gesture
  const shellRef              = useRef(null);
  const leftColWidthRef       = useRef(316);
  const regionsRef            = useRef([]);
  const tracksRef             = useRef([]);
  const selectedRegionIdsRef     = useRef(new Set());
  const selectedAnchorRef        = useRef(null);
  const globalAutomationsRef     = useRef([]);
  const groupsRef                = useRef([]);
  const collapsedGroupIdsRef     = useRef(new Set());
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
  // Phase 117 — one-shot suppression flags so a programmatic scroll write on a partner
  // doesn't trigger a stale mirror-back (timeline ↔ piano roll horizontal sync only;
  // vertical header sync was removed when headers moved inside the timeline scroller).
  const pianoScrollSuppressRef   = useRef(false);
  const timelineSuppressRef      = useRef(false);
  const noteSelectionRef         = useRef(new Set());
  const notesClipboardRef        = useRef(null);
  const clipboardKindRef         = useRef(null); // 'regions' | 'notes'
  const editingTrackIdRef        = useRef(null);
  const noteSelectionApiRef      = useRef(null); // { clear, setIds } from RegionEditor

  // ── Derived editor state ───────────────────────────────────
  const editingTrack      = editingTrackId ? tracks.find(t => t.id === editingTrackId) : null;
  const editingTrackNotes = notes.filter(n => n.trackId === editingTrackId);

  // Width of the sticky in-scroller track-header column. The column is
  // user-resizable (200-600px via --left-col-width), so every coordinate inset
  // reads this dynamically. offsetWidth is live even mid-resizer-drag (the drag
  // writes only the CSS var until mouseup).
  const headerColW = () => trackHeadersRef.current?.offsetWidth ?? leftColWidthRef.current;

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
      // Left hot-zone starts at the grid seam (right edge of the sticky header
      // column), not the pane edge — the header occupies the pane's left ~316px.
      const dRight = b.right  - mx;  const dLeft = mx - (b.left + headerColW());
      const dBot   = b.bottom - my;  const dTop  = my - (b.top + RULER_HEIGHT);
      if (dRight < THRESHOLD) dx =  MAX_SPEED * Math.min(1, 1 - dRight / THRESHOLD);
      if (dLeft  < THRESHOLD) dx = -MAX_SPEED * Math.min(1, 1 - dLeft  / THRESHOLD);
      if (dBot   < THRESHOLD) dy =  MAX_SPEED * Math.min(1, 1 - dBot   / THRESHOLD);
      if (dTop   < THRESHOLD) dy = -MAX_SPEED * Math.min(1, 1 - dTop   / THRESHOLD);
      if (dx !== 0) {
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (dx > 0 && el.scrollLeft >= maxScroll) dx = 0;
        else el.scrollLeft = Math.min(maxScroll, Math.max(0, el.scrollLeft + dx));
      }
      // Suppress vertical auto-scroll during a ruler scrub (isDraggingRef is true only
      // then) — the scrub cursor sits inside the ruler's top edge-zone, which would
      // otherwise scroll the grid up every frame. Region/marquee/note drags keep it.
      if (dy !== 0 && !isDraggingRef.current) el.scrollTop = Math.max(0, el.scrollTop + dy);
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
      volume: 75,
      pan: 0,
      effects: [],   // per-track insert-effect rack (see effectDefs.js); audio wiring deferred
    }]);
  }, []);

  const handleVolumeChange = useCallback((trackId, v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, volume: clamped } : t));
  }, []);

  const handlePanChange = useCallback((trackId, n) => {
    const clamped = Math.max(-1, Math.min(1, n));
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, pan: clamped } : t));
  }, []);

  // ── Project save / load / audio bounce ────────────────────────
  const loadInputRef = useRef(null);
  const [isBouncing, setIsBouncing] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const showToast = useCallback((msg, ms = 3000) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), ms);
  }, []);

  // Apply a deserialized project (deserializeProject output shape) to the
  // running session. Shared by the [ load ] file input and the pending-project
  // effect (open-from-homepage / New Project).
  const applyProjectData = useCallback((data) => {
    Tone.Transport.stop();
    setIsPlaying(false);
    setEditingTrackId(null);
    setSelectedRegionIds(new Set());
    setProjectName(data.name ?? 'untitled');
    setBpm(data.bpm);
    setTempBpm(String(data.bpm));
    // No direct Transport.bpm write — recomputeTempo (the signal's single
    // writer, via the hook's tempo-sync effect on the bpm/globalAutomations
    // change) re-anchors the curve after this commit.
    setTotalMeasures(Math.max(24, data.totalMeasures));
    // Reset undo/redo to the loaded project (the load itself isn't an undoable step).
    timeTravelingRef.current = true; // make the recorder treat this commit as non-recordable
    latestRef.current = {
      tracks: data.tracks, regions: data.regions, notes: data.notes,
      globalAutomations: data.globalAutomations ?? [],
      groups: data.groups ?? [],
    };
    burstActiveRef.current = false;
    if (burstTimerRef.current) { clearTimeout(burstTimerRef.current); burstTimerRef.current = null; }
    setPast([]);
    setFuture([]);
    setTracks(data.tracks);
    setRegions(data.regions);
    setNotes(data.notes);
    setGlobalAutomations(data.globalAutomations ?? []);
    setGroups(data.groups ?? []);
    setCollapsedGroupIds(new Set());
    setRenamingGroupId(null);
    nextIdRef.current       = data.nextId;
    nextRegionIdRef.current = data.nextRegionId;
    nextEffectIdRef.current = data.nextEffectId ?? 1;
    // Note-counter restore is load-bearing: without it, post-load mints
    // start at 0 and collide with loaded note ids (the ghost-note bug).
    nextNoteIdRef.current   = data.nextNoteId ?? 0;
    nextAutomationIdRef.current = data.nextAutomationId ?? 1;
    nextGroupIdRef.current  = data.nextGroupId ?? 1;
  }, []);

  // [ save ] writes to the browser project store (IndexedDB) — the homepage
  // Projects grid reads from it. Producing a .voxdaw file moved to the export menu.
  const handleSaveProject = useCallback(async () => {
    try {
      const payload = serializeProject({ bpm, totalMeasures, tracks, regions, notes, name: projectName, globalAutomations, groups });
      const id = currentProjectId ?? crypto.randomUUID();
      await storeSaveProject({
        id, name: projectName, bpm, trackCount: tracks.length, data: payload,
      });
      if (!currentProjectId) setCurrentProjectId(id);
      showToast(`saved "${projectName}"`);
    } catch (e) {
      console.error('save project failed', e);
      showToast(`save failed: ${e.message}`);
    }
  }, [bpm, totalMeasures, tracks, regions, notes, globalAutomations, groups, projectName, currentProjectId, showToast]);

  const handleExportProjectFile = useCallback(() => {
    setShowExportMenu(false);
    const payload = serializeProject({ bpm, totalMeasures, tracks, regions, notes, name: projectName, globalAutomations, groups });
    const filename = `${sanitizeFilename(projectName)}.voxdaw`;
    downloadJSON(payload, filename);
    showToast(`exported ${filename}`);
  }, [bpm, totalMeasures, tracks, regions, notes, globalAutomations, groups, projectName, showToast]);

  const handleLoadProject = useCallback(async (file) => {
    if (!file) return;
    try {
      const raw = await readJSONFile(file);
      const data = deserializeProject(raw);
      applyProjectData(data);
      // A raw file open isn't tied to a stored project yet — first save creates one.
      setCurrentProjectId(null);
      showToast(data.repairedCount > 0
        ? `loaded ${file.name} (repaired ${data.repairedCount} note${data.repairedCount !== 1 ? 's' : ''})`
        : `loaded ${file.name}`);
    } catch (e) {
      console.error('load project failed', e);
      showToast(`load failed: ${e.message}`);
    }
  }, [applyProjectData, showToast]);

  // Open-from-homepage / New Project. Root bumps requestId on every request, so
  // the same project can be re-opened (intentional reload) while StrictMode
  // double-invocations and unrelated re-renders are no-ops.
  const lastAppliedReqRef = useRef(0);
  useEffect(() => {
    if (!pendingProject || pendingProject.requestId === lastAppliedReqRef.current) return;
    lastAppliedReqRef.current = pendingProject.requestId;
    if (pendingProject.data) {
      applyProjectData(pendingProject.data);
      setCurrentProjectId(pendingProject.projectId ?? null);
    } else {
      applyProjectData(BLANK_PROJECT_DATA);
      setCurrentProjectId(null);
    }
  }, [pendingProject, applyProjectData]);

  const handleNameCommit = useCallback(() => {
    const next = tempName.trim() || 'untitled';
    setProjectName(next);
    setTempName(next);
    setEditingName(false);
  }, [tempName]);

  const handleExportAudio = useCallback(async (format) => {
    setShowExportMenu(false);
    if (isBouncing) return;
    setIsBouncing(true);
    showToast('bouncing audio…', 60000);
    try {
      // Hard right stop through the tempo map (constant-bpm math would mis-cap
      // a project whose tempo lane speeds up or slows down).
      const capSec = buildTempoMap(bpm, tempoPointsOf(globalAutomations)).secondsAtMeasure(totalMeasures);
      const { buffer, firstOnsetSec } = await bounceProject({ tracks, regions, notes, bpm, globalAutomations, groups, capSec });
      // Trim leading silence to the first note's onset and trailing silence
      // after the last audible sample; null = nothing audible to export.
      const trimmed = firstOnsetSec == null
        ? null
        : trimExportBuffer(buffer, { startSec: firstOnsetSec });
      if (!trimmed) { showToast('nothing to export'); return; }
      const blob = format === 'wav' ? exportWAV(trimmed) : exportMP3(trimmed);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`exported project.${format}`);
    } catch (e) {
      console.error('bounce failed', e);
      showToast(`bounce failed: ${e.message}`);
    } finally {
      setIsBouncing(false);
    }
  }, [tracks, regions, notes, bpm, globalAutomations, groups, totalMeasures, isBouncing, showToast]);

  // Mute and Solo are mutually exclusive per track: turning one ON clears the
  // other; turning one OFF changes nothing else.
  const toggleMute = (id) => setTracks(prev =>
    prev.map(t => t.id === id
      ? { ...t, isMuted: !t.isMuted, isSolo: !t.isMuted ? false : t.isSolo }
      : t));
  const toggleSolo = (id) => setTracks(prev =>
    prev.map(t => t.id === id
      ? { ...t, isSolo: !t.isSolo, isMuted: !t.isSolo ? false : t.isMuted }
      : t));

  // Instrument change clears any ADSR override so the knobs snap to the new
  // instrument's defaults (and a decay/sustain override never lands on a
  // Sampler after a melodic→drum switch).
  const handleInstrumentChange = useCallback((trackId, instrument) => setTracks(prev =>
    prev.map(t => t.id === trackId ? { ...t, instrument, envelope: undefined } : t)), []);

  // Merge a partial ADSR edit into the track's override, seeding from the
  // instrument default on first touch so the stored object is always complete.
  // Immutable map → inherits the history burst-coalescer (one undo per drag),
  // matching updateEffectSettings.
  const handleEnvelopeChange = useCallback((trackId, partial) => setTracks(prev =>
    prev.map(t => {
      if (t.id !== trackId) return t;
      const base = t.envelope ?? defaultEnvelopeFor(t.instrument) ?? {};
      return { ...t, envelope: { ...base, ...partial } };
    })), []);

  // ── Per-track effects rack CRUD ──────────────────────────────────────────────
  // Effects live on the track object (track.effects), so they ride existing prop
  // threading and the passive undo/redo recorder for free. Array order = signal
  // order. Audio is not wired yet — this is the state/UI skeleton.
  const addEffect = useCallback((trackId, fxType) => {
    const def = EFFECT_DEFS[fxType];
    if (!def) return;
    const fx = { id: `e${nextEffectIdRef.current++}`, type: fxType, bypass: false, params: defaultParamsFor(fxType) };
    setTracks(prev => prev.map(t =>
      t.id === trackId ? { ...t, effects: [...(t.effects ?? []), fx] } : t));
  }, []);
  // Removing an effect also GCs automations targeting it (an orphan lane would
  // silently do nothing and confuse — regionId-authoritative repair precedent).
  const removeEffect = useCallback((trackId, fxId) => setTracks(prev => prev.map(t =>
    t.id === trackId
      ? {
          ...t,
          effects: (t.effects ?? []).filter(e => e.id !== fxId),
          automations: (t.automations ?? []).filter(a => !(a.target?.kind === 'fx' && a.target.effectId === fxId)),
        }
      : t)), []);
  const toggleBypassEffect = useCallback((trackId, fxId) => setTracks(prev => prev.map(t =>
    t.id === trackId
      ? { ...t, effects: (t.effects ?? []).map(e => e.id === fxId ? { ...e, bypass: !e.bypass } : e) }
      : t)), []);
  const updateEffectSettings = useCallback((trackId, fxId, newParams) => setTracks(prev => prev.map(t =>
    t.id === trackId
      ? { ...t, effects: (t.effects ?? []).map(e => e.id === fxId ? { ...e, params: { ...e.params, ...newParams } } : e) }
      : t)), []);

  // ── Track automation CRUD ────────────────────────────────────────────────────
  // Automations live on the track object (track.automations) like effects, so
  // they ride prop threading + the passive undo recorder for free (point drags
  // coalesce into one entry via the burst coalescer). The expanded/collapsed
  // Set is UI-only state — see openAutomationTrackIds.
  const toggleAutomationArea = useCallback((trackId) => {
    setOpenAutomationTrackIds(prev => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);
  const addAutomation = useCallback((trackId, target) => {
    // Eager mint — never inside the updater (StrictMode double-invokes updaters).
    const id = `a${nextAutomationIdRef.current++}`;
    setTracks(prev => prev.map(t => {
      if (t.id !== trackId) return t;
      const existing = t.automations ?? [];
      if (existing.some(a => targetKey(a.target) === targetKey(target))) return t; // one lane per target
      return { ...t, automations: [...existing, { id, target, points: [] }] };
    }));
  }, []);
  const removeAutomation = useCallback((trackId, automationId) => setTracks(prev => prev.map(t =>
    t.id === trackId
      ? { ...t, automations: (t.automations ?? []).filter(a => a.id !== automationId) }
      : t)), []);
  // Single commit from a lane's mouseup (Zero-Re-render: the drag itself is DOM-only).
  const commitAutomationPoints = useCallback((trackId, automationId, points) => setTracks(prev => prev.map(t =>
    t.id === trackId
      ? { ...t, automations: (t.automations ?? []).map(a => a.id === automationId ? { ...a, points } : a) }
      : t)), []);

  // ── Group effects + automation CRUD — setGroups twins of the track versions.
  // Same eager id mints (e<n>/a<n> namespaces span tracks AND groups), same
  // orphan-GC on effect removal, same one-lane-per-target rule.
  const addGroupEffect = useCallback((groupId, fxType) => {
    const def = EFFECT_DEFS[fxType];
    if (!def) return;
    const fx = { id: `e${nextEffectIdRef.current++}`, type: fxType, bypass: false, params: defaultParamsFor(fxType) };
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, effects: [...(g.effects ?? []), fx] } : g));
  }, []);
  const removeGroupEffect = useCallback((groupId, fxId) => setGroups(prev => prev.map(g =>
    g.id === groupId
      ? {
          ...g,
          effects: (g.effects ?? []).filter(e => e.id !== fxId),
          automations: (g.automations ?? []).filter(a => !(a.target?.kind === 'fx' && a.target.effectId === fxId)),
        }
      : g)), []);
  const toggleBypassGroupEffect = useCallback((groupId, fxId) => setGroups(prev => prev.map(g =>
    g.id === groupId
      ? { ...g, effects: (g.effects ?? []).map(e => e.id === fxId ? { ...e, bypass: !e.bypass } : e) }
      : g)), []);
  const updateGroupEffectSettings = useCallback((groupId, fxId, newParams) => setGroups(prev => prev.map(g =>
    g.id === groupId
      ? { ...g, effects: (g.effects ?? []).map(e => e.id === fxId ? { ...e, params: { ...e.params, ...newParams } } : e) }
      : g)), []);
  const addGroupAutomation = useCallback((groupId, target) => {
    const id = `a${nextAutomationIdRef.current++}`; // eager mint (StrictMode)
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const existing = g.automations ?? [];
      if (existing.some(a => targetKey(a.target) === targetKey(target))) return g;
      return { ...g, automations: [...existing, { id, target, points: [] }] };
    }));
  }, []);
  const removeGroupAutomation = useCallback((groupId, automationId) => setGroups(prev => prev.map(g =>
    g.id === groupId
      ? { ...g, automations: (g.automations ?? []).filter(a => a.id !== automationId) }
      : g)), []);
  const commitGroupAutomationPoints = useCallback((groupId, automationId, points) => setGroups(prev => prev.map(g =>
    g.id === groupId
      ? { ...g, automations: (g.automations ?? []).map(a => a.id === automationId ? { ...a, points } : a) }
      : g)), []);

  // Tempo-lane commit. The tempo automation is created lazily on first commit;
  // its id is minted OUTSIDE the updater (StrictMode double-invokes updaters —
  // an inside mint would burn two ids).
  const commitTempoPoints = useCallback((points) => {
    const existing = globalAutomationsRef.current.find(a => a.target?.kind === 'tempo');
    const id = existing?.id ?? ('a' + nextAutomationIdRef.current++);
    setGlobalAutomations(prev => prev.some(a => a.id === id)
      ? prev.map(a => (a.id === id ? { ...a, points } : a))
      : [...prev, { id, target: { kind: 'tempo' }, points }]);
  }, []);

  // Tempo-lane drag preview (the applyAutomationValue pattern): a short ramp
  // on Transport.bpm during the drag; the commit's setGlobalAutomations fires
  // the hook's tempo-sync effect, whose recomputeTempo (the signal's single
  // steady-state writer) re-anchors the whole curve on mouseup.
  // cancelAndHoldAtTime (NOT cancelScheduledValues) is load-bearing: ticks are
  // the integral of this curve, and a plain cancel mid-ramp rewrites the
  // already-played shape → position jumps + TickParam corruption (see
  // recomputeTempo). The hold also pins the current value, so no setValueAtTime
  // is needed before the ramp. Gated to a non-running transport: while playing,
  // the preview would drag the LIVE tempo to the held point's value, stomping
  // the scheduled curve mid-song — the playing tempo only changes on mouseup.
  const previewTempo = useCallback((v01) => {
    if (Tone.Transport.state === 'started') return;
    const sig = Tone.Transport.bpm;
    const now = Tone.now();
    sig.cancelAndHoldAtTime(now);
    sig.linearRampToValueAtTime(denorm(v01, TEMPO_META), now + 0.02);
  }, []);

  // Workstation audio engine — reconciles synths/gains/parts against tracks/regions/notes.
  // Does NOT call Tone.start(); the user-gesture path (handlePlayPause, RegionEditor preview)
  // already handles that. Stops Transport + disposes nodes on unmount → clean handoff to VoxTool.
  const {
    silenceAll, recomputeFades, loadingTrackIds,
    auditionAttack, auditionRelease, auditionReleaseAll, auditionPrime,
    applyAutomationValue,
  } = useWorkstationAudio({ tracks, regions, notes, bpm, performanceQuality, globalAutomations, groups });

  // ── History recorder ────────────────────────────────────────
  // Passive: records AFTER React commits, so multi-setter actions (e.g. split =
  // setRegions + setNotes) coalesce into one entry via React 18 batching — no changes
  // to any of the ~46 mutation sites. Leading-edge burst coalescing folds a drag's many
  // mid-flight commits (and continuous volume/pan slider commits) into a single entry.
  // Snapshots store array refs (state is updated immutably, so they're effectively frozen).
  useEffect(() => {
    const cur = { tracks, regions, notes, globalAutomations, groups };
    if (timeTravelingRef.current) {            // change came from undo/redo/load → don't record
      timeTravelingRef.current = false;
      latestRef.current = cur;
      burstActiveRef.current = false;
      if (burstTimerRef.current) { clearTimeout(burstTimerRef.current); burstTimerRef.current = null; }
      return;
    }
    if (latestRef.current === null) { latestRef.current = cur; return; } // initial mount
    const baseline = latestRef.current;
    // No real change (e.g. StrictMode's mount double-invoke, or a re-render that didn't
    // touch these arrays) → don't record. State updates immutably, so a changed array is
    // always a new reference.
    if (baseline.tracks === cur.tracks && baseline.regions === cur.regions
        && baseline.notes === cur.notes && baseline.globalAutomations === cur.globalAutomations
        && baseline.groups === cur.groups) return;
    latestRef.current = cur;
    if (!burstActiveRef.current) {             // leading edge → push the pre-change snapshot
      burstActiveRef.current = true;
      setPast(p => { const n = [...p, baseline]; return n.length > MAX_HISTORY ? n.slice(n.length - MAX_HISTORY) : n; });
      setFuture([]);
    }
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => { burstActiveRef.current = false; burstTimerRef.current = null; }, 200);
  }, [tracks, regions, notes, globalAutomations, groups]);

  const applyHistory = useCallback((s) => {
    setTracks(s.tracks); setRegions(s.regions); setNotes(s.notes);
    setGlobalAutomations(s.globalAutomations ?? []);
    setGroups(s.groups ?? []);
  }, []);
  const endBurst = useCallback(() => {
    burstActiveRef.current = false;
    if (burstTimerRef.current) { clearTimeout(burstTimerRef.current); burstTimerRef.current = null; }
  }, []);

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (!p.length) return;
    endBurst();
    const prev = p[p.length - 1];
    const current = latestRef.current;   // capture present BEFORE reassigning latestRef below
    timeTravelingRef.current = true;
    setFuture(f => [current, ...f]);      // updater runs at render time — must use the captured value
    setPast(a => a.slice(0, -1));
    latestRef.current = prev;
    applyHistory(prev);
    silenceAll();        // kill any voice ringing from a region this undo just removed (no ghost notes)
    recomputeFades();    // re-anchor region fade gains to the restored region set
  }, [endBurst, applyHistory, silenceAll, recomputeFades]);

  const redo = useCallback(() => {
    const f = futureRef.current;
    if (!f.length) return;
    endBurst();
    const next = f[0];
    const current = latestRef.current;   // capture present BEFORE reassigning latestRef below
    timeTravelingRef.current = true;
    setPast(p => { const n = [...p, current]; return n.length > MAX_HISTORY ? n.slice(n.length - MAX_HISTORY) : n; });
    setFuture(a => a.slice(1));
    latestRef.current = next;
    applyHistory(next);
    silenceAll();
    recomputeFades();
  }, [endBurst, applyHistory, silenceAll, recomputeFades]);

  undoRef.current = undo;
  redoRef.current = redo;
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  // ── Note dedupe — same (regionId, note, startBeat, durationBeats) collapses to the
  //    most-recently-touched (or last-in-array) survivor. Wired into every commit path
  //    so a freshly placed/dropped note replaces a perfectly-overlapping older one.
  const dedupePerfectOverlaps = useCallback((notes, lastTouchedIds = []) => {
    const lastSet = new Set(lastTouchedIds);
    const survivors = new Map(); // key → note
    for (const n of notes) {
      // toFixed(4) collapses floating-point drift from snap fractions (e.g. 1/3 = 0.333…)
      // so two notes that are musically identical also key identically (Phase 116 bug 5).
      const key = `${n.regionId}|${n.note}|${n.startBeat.toFixed(4)}|${n.durationBeats.toFixed(4)}`;
      const prev = survivors.get(key);
      if (!prev) { survivors.set(key, n); continue; }
      // Prefer last-touched; otherwise prefer the later array position (current `n`).
      if (lastSet.has(prev.id) && !lastSet.has(n.id)) continue;
      survivors.set(key, n);
    }
    // Preserve original order
    const surviveIds = new Set([...survivors.values()].map(n => n.id));
    return notes.filter(n => surviveIds.has(n.id));
  }, []);

  // ── Note CRUD ───────────────────────────────────────────────
  const handleNoteAdd = useCallback((noteData) => {
    const { trackId, startBeat } = noteData;
    const measure = Math.floor(startBeat / 4);
    const newNoteId = `note_${nextNoteIdRef.current++}`;

    const existingRegion = regionsRef.current.find(r =>
      r.trackId === trackId &&
      startBeat >= r.startMeasure * 4 &&
      startBeat < (r.startMeasure + r.durationMeasures) * 4
    );

    if (existingRegion) {
      // Phase 110: block placements inside the ghost (looped) area.
      if (existingRegion.loopInterval != null) {
        const baseEndBeat = (existingRegion.startMeasure + existingRegion.loopInterval) * 4;
        if (startBeat >= baseEndBeat) return null;
      }
      const bottleOriginBeat = (existingRegion.startMeasure - (existingRegion.clipOffset ?? 0)) * 4;
      const newNote = {
        id: newNoteId, ...noteData,
        startBeat: startBeat - bottleOriginBeat,
        regionId: existingRegion.id,
      };
      setNotes(prev => dedupePerfectOverlaps([...prev, newNote], [newNoteId]));
    } else {
      const newRegionId = `region_${nextRegionIdRef.current++}`;
      const newRegion = { id: newRegionId, trackId, startMeasure: measure, durationMeasures: 1, clipOffset: 0, fadeIn: 0, fadeOut: 0, fadeInFloor: 0, fadeOutFloor: 0, loopInterval: null };
      const result = applyDestructiveEdit(regionsRef.current, notesRef.current, newRegion);
      const merged = [...result.regions, newRegion].filter(r => r.durationMeasures > 0);
      const surviving = new Set(merged.map(r => r.id));
      const newNote = {
        id: newNoteId, ...noteData,
        startBeat: startBeat - measure * 4,
        regionId: newRegionId,
      };
      setRegions(merged);
      setNotes(dedupePerfectOverlaps(
        [...result.notes.filter(n => surviving.has(n.regionId)), newNote],
        [newNoteId],
      ));
    }
    return newNoteId;
  }, [dedupePerfectOverlaps]);
  const handleNoteRemove = useCallback((noteId) => {
    setNotes(prev => prev.filter(n => n.id !== noteId));
  }, []);
  const handleCommitNoteEdits = useCallback((updates) => {
    if (!updates || !updates.length) return;
    const map = new Map(updates.map(u => [u.id, u]));
    const touchedIds = updates.map(u => u.id);
    setNotes(prev => dedupePerfectOverlaps(
      prev.map(n => {
        const u = map.get(n.id);
        return u ? { ...n, ...u } : n;
      }),
      touchedIds,
    ));
  }, [dedupePerfectOverlaps]);
  const handleNotesDelete = useCallback((ids) => {
    const set = ids instanceof Set ? ids : new Set(ids);
    if (set.size === 0) return;
    setNotes(prev => prev.filter(n => !set.has(n.id)));
  }, []);

  // ── Right-click context menu (regions + notes) ─────────────────
  // menu = null | { x, y, targetType: 'region'|'note', targetId }
  const [contextMenu, setContextMenu] = useState(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Transpose by `semis` semitones (musical: + is up). KEYS is ordered high→low
  // (buildKeys runs hiOct→loOct), so a higher pitch is a *lower* index → ki − semis.
  const shiftNoteName = (name, semis) => {
    const ki = KEYS.findIndex(k => k.name === name);
    if (ki < 0) return name;
    return KEYS[Math.max(0, Math.min(KEYS.length - 1, ki - semis))].name;
  };
  const transposeRegions = useCallback((regionIds, semis) => {
    const set = regionIds instanceof Set ? regionIds : new Set(regionIds);
    setNotes(prev => prev.map(n =>
      set.has(n.regionId) ? { ...n, note: shiftNoteName(n.note, semis) } : n));
  }, []);
  const transposeNotes = useCallback((noteIds, semis) => {
    const set = noteIds instanceof Set ? noteIds : new Set(noteIds);
    setNotes(prev => prev.map(n =>
      set.has(n.id) ? { ...n, note: shiftNoteName(n.note, semis) } : n));
  }, []);

  // ── Track context-menu operations ──────────────────────────────
  // All plain setTracks/setRegions/setNotes mutations → auto-undoable via the
  // passive history recorder (one batched commit = one undo entry). Ids minted
  // eagerly OUTSIDE state updaters so StrictMode double-invokes can't
  // double-increment (same rule as splitRegionAtMeasure).
  const [renamingTrackId, setRenamingTrackId] = useState(null);

  const duplicateTrack = useCallback((trackId) => {
    const src = tracksRef.current.find(t => t.id === trackId);
    if (!src) return;
    const newTrackId  = `t${nextIdRef.current++}`;
    const regionIdMap = new Map(); // old regionId → cloned regionId
    const newRegions = regionsRef.current.filter(r => r.trackId === trackId).map(r => {
      const id = `r${nextRegionIdRef.current++}`;
      regionIdMap.set(r.id, id);
      return { ...r, id, trackId: newTrackId };
    });
    // Select by region ownership (regionId is authoritative), not trackId:
    // the old trackId filter + `?? n.regionId` fallback let a desynced note
    // clone itself pointing at the SOURCE track's region (ghost note there,
    // and killed by that region's deletion).
    const newNotes = notesRef.current.filter(n => regionIdMap.has(n.regionId)).map(n => ({
      ...n,
      id: `note_${nextNoteIdRef.current++}`,
      trackId: newTrackId,
      regionId: regionIdMap.get(n.regionId),
    }));
    // Fresh effect ids are load-bearing: the audio hook's bypass delta-check
    // (appliedFxBypassByIdRef) is keyed by effect id — copied ids would alias
    // bypass state across the two tracks. The old→new map lets automations
    // follow their effect into the clone.
    const effectIdMap = new Map();
    const clonedEffects = (src.effects ?? []).map(fx => {
      const nid = `e${nextEffectIdRef.current++}`;
      effectIdMap.set(fx.id, nid);
      return { ...fx, id: nid, params: { ...fx.params } };
    });
    const clone = {
      ...src,
      id: newTrackId,
      name: `${src.name} copy`,
      effects: clonedEffects,
      // Automations clone with fresh a<n> ids; fx targets are remapped through
      // effectIdMap (an unmatched target would be an orphan — drop it).
      automations: (src.automations ?? [])
        .filter(a => a.target?.kind !== 'fx' || effectIdMap.has(a.target.effectId))
        .map(a => ({
          id: `a${nextAutomationIdRef.current++}`,
          target: a.target.kind === 'fx'
            ? { ...a.target, effectId: effectIdMap.get(a.target.effectId) }
            : { ...a.target },
          points: (a.points ?? []).map(p => ({ ...p })),
        })),
    };
    setTracks(prev => {
      const i = prev.findIndex(t => t.id === trackId);
      const next = [...prev];
      next.splice(i < 0 ? next.length : i + 1, 0, clone);
      return next;
    });
    if (newRegions.length) setRegions(prev => [...prev, ...newRegions]);
    if (newNotes.length)   setNotes(prev => [...prev, ...newNotes]);
  }, []);

  const deleteTrack = useCallback((trackId) => {
    const idx = tracksRef.current.findIndex(t => t.id === trackId);
    const dead = tracksRef.current[idx];
    const deadRegionIds = new Set(
      regionsRef.current.filter(r => r.trackId === trackId).map(r => r.id));
    setTracks(prev => prev.filter(t => t.id !== trackId));
    // Group GC: a group whose last member dies is dropped.
    if (dead?.groupId
        && !tracksRef.current.some(t => t.id !== trackId && t.groupId === dead.groupId)) {
      setGroups(prev => prev.filter(g => g.id !== dead.groupId));
    }
    setRegions(prev => prev.filter(r => r.trackId !== trackId));
    setNotes(prev => prev.filter(n => n.trackId !== trackId));
    setSelectedRegionIds(prev => {
      if (![...prev].some(id => deadRegionIds.has(id))) return prev;
      return new Set([...prev].filter(id => !deadRegionIds.has(id)));
    });
    setEditingTrackId(prev => (prev === trackId ? null : prev));
    setRenamingTrackId(prev => (prev === trackId ? null : prev));
    setActiveTrackId(prev => {
      if (prev !== trackId) return prev;
      const rest = tracksRef.current.filter(t => t.id !== trackId);
      return rest.length ? rest[Math.min(Math.max(idx, 0), rest.length - 1)].id : null;
    });
    pasteAnchorTrackIndexRef.current = null; // index-based anchor may now be stale
    // Audio nodes self-dispose via the useWorkstationAudio reconcilers (effects
    // #1/#1b/#4) — NO manual dispose here (it would double-dispose). Just cut
    // any voice still ringing from the removed regions (undo's precedent).
    silenceAll();
  }, [silenceAll]);

  // ── Track groups ─────────────────────────────────────────────
  // Creation: id minted eagerly (never inside an updater — StrictMode), the
  // members are spliced CONTIGUOUS at the first member's position (an
  // ungrouped track can't sit inside another group's run, so the splice never
  // fragments one), and membership is track.groupId.
  const createGroup = useCallback((memberIds) => {
    const ids = new Set(memberIds);
    if (ids.size < 2) return;
    const n = nextGroupIdRef.current++;
    const first = tracksRef.current.find(t => ids.has(t.id));
    const group = {
      id: `g${n}`, name: `group ${n}`,
      color: first?.color ?? TRACK_COLORS[(n - 1) % TRACK_COLORS.length],
      isMuted: false, isSolo: false, volume: 75, pan: 0, effects: [], automations: [],
    };
    setGroups(prev => [...prev, group]);
    setTracks(prev => {
      const firstIdx = prev.findIndex(t => ids.has(t.id));
      const members  = prev.filter(t => ids.has(t.id)).map(t => ({ ...t, groupId: group.id }));
      const rest     = prev.filter(t => !ids.has(t.id));
      const next     = [...rest];
      next.splice(Math.min(firstIdx, rest.length), 0, ...members);
      return next;
    });
    pasteAnchorTrackIndexRef.current = null; // index-based anchor is stale after reorder
    setGroupModal(null);
  }, []);

  const toggleGroupCollapsed = useCallback((groupId) => {
    setCollapsedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }, []);

  // Group mute/solo mirror the track pattern: mutually exclusive per group.
  const toggleGroupMute = (id) => setGroups(prev =>
    prev.map(g => g.id === id
      ? { ...g, isMuted: !g.isMuted, isSolo: !g.isMuted ? false : g.isSolo }
      : g));
  const toggleGroupSolo = (id) => setGroups(prev =>
    prev.map(g => g.id === id
      ? { ...g, isSolo: !g.isSolo, isMuted: !g.isSolo ? false : g.isMuted }
      : g));

  const handleGroupVolumeChange = useCallback((groupId, v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, volume: clamped } : g));
  }, []);

  const handleGroupPanChange = useCallback((groupId, n) => {
    const clamped = Math.max(-1, Math.min(1, n));
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, pan: clamped } : g));
  }, []);

  // Ungroup: dissolve the group, keep the tracks (Dylan's spec).
  const ungroup = useCallback((groupId) => {
    setTracks(prev => prev.map(t => t.groupId === groupId ? { ...t, groupId: undefined } : t));
    setGroups(prev => prev.filter(g => g.id !== groupId));
    setCollapsedGroupIds(prev => { const next = new Set(prev); next.delete(groupId); return next; });
  }, []);

  // Remove ONE track from its group; a group left with <2 members dissolves
  // (groups are only ever formed with ≥2).
  const removeTrackFromGroup = useCallback((trackId) => {
    const gid = tracksRef.current.find(t => t.id === trackId)?.groupId;
    if (!gid) return;
    const remaining = tracksRef.current.filter(t => t.groupId === gid && t.id !== trackId);
    if (remaining.length < 2) { ungroup(gid); return; }
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, groupId: undefined } : t));
  }, [ungroup]);

  // Delete Group + Tracks: destructive (confirm() at the dispatch site);
  // undoable because groups+tracks+regions+notes are all in history snapshots.
  const deleteGroup = useCallback((groupId) => {
    const memberIds = new Set(tracksRef.current.filter(t => t.groupId === groupId).map(t => t.id));
    const deadRegionIds = new Set(regionsRef.current.filter(r => memberIds.has(r.trackId)).map(r => r.id));
    setTracks(prev => prev.filter(t => !memberIds.has(t.id)));
    setRegions(prev => prev.filter(r => !memberIds.has(r.trackId)));
    setNotes(prev => prev.filter(n => !memberIds.has(n.trackId)));
    setGroups(prev => prev.filter(g => g.id !== groupId));
    setCollapsedGroupIds(prev => { const next = new Set(prev); next.delete(groupId); return next; });
    setSelectedRegionIds(prev => new Set([...prev].filter(id => !deadRegionIds.has(id))));
    setEditingTrackId(prev => (memberIds.has(prev) ? null : prev));
    setRenamingTrackId(prev => (memberIds.has(prev) ? null : prev));
    setActiveTrackId(prev => (memberIds.has(prev) ? null : prev));
    pasteAnchorTrackIndexRef.current = null;
    // Audio nodes self-dispose via the useWorkstationAudio reconcilers — just
    // cut any voice still ringing from the removed regions (deleteTrack's precedent).
    silenceAll();
  }, [silenceAll]);

  const pasteEffectsTo = useCallback((sourceTrackId, targetTrackId) => {
    const src = tracksRef.current.find(t => t.id === sourceTrackId);
    if (!src || sourceTrackId === targetTrackId) return;
    // Fresh ids + deep-copied params per effect (same aliasing rule as duplicate).
    const cloned = (src.effects ?? []).map(fx =>
      ({ ...fx, id: `e${nextEffectIdRef.current++}`, params: { ...fx.params } }));
    // The target's whole rack is replaced, so its fx-targeting automations
    // become orphans — GC them (volume/pan lanes survive).
    setTracks(prev => prev.map(t => t.id === targetTrackId
      ? { ...t, effects: cloned, automations: (t.automations ?? []).filter(a => a.target?.kind !== 'fx') }
      : t));
  }, []);

  const exportTrack = useCallback(async (trackId, format = 'wav') => {
    if (isBouncing) return;
    const track = tracksRef.current.find(t => t.id === trackId);
    if (!track) return;
    setIsBouncing(true);
    showToast(`bouncing ${track.name}…`, 60000);
    try {
      // Force-solo the target: bounceProject's audibility rule
      // (!isMuted && (!anySoloed || isSolo)) then renders only this track.
      const soloed = tracksRef.current.map(t => ({ ...t, isSolo: t.id === trackId, isMuted: false }));
      // Neutralize group mute/solo too — a muted parent group would silence
      // the stem; the soloed track still prints THROUGH its group's FX chain
      // (the desired bus sound).
      const neutralGroups = groupsRef.current.map(g => ({ ...g, isMuted: false, isSolo: false }));
      const globalAutos = globalAutomationsRef.current;
      const capSec = buildTempoMap(bpm, tempoPointsOf(globalAutos)).secondsAtMeasure(totalMeasuresRef.current);
      const { buffer, firstOnsetSec } = await bounceProject({
        tracks: soloed, regions: regionsRef.current, notes: notesRef.current, bpm,
        globalAutomations: globalAutos, groups: neutralGroups, capSec,
      });
      const trimmed = firstOnsetSec == null
        ? null
        : trimExportBuffer(buffer, { startSec: firstOnsetSec });
      if (!trimmed) { showToast('nothing to export'); return; }
      const blob = format === 'wav' ? exportWAV(trimmed) : exportMP3(trimmed);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${track.name}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`exported ${track.name}.${format}`);
    } catch (e) {
      console.error('track bounce failed', e);
      showToast(`bounce failed: ${e.message}`);
    } finally {
      setIsBouncing(false);
    }
  }, [bpm, isBouncing, showToast]);

  // Split a region at global measure P into Left (keeps id + notes) and Right
  // (new id + cloned notes). Bottle-preserving; phase-aware for looped regions
  // (R resumes the loop mid-cycle so the grid timing is unchanged). Returns
  // { left, right, clones } or null if P is not strictly inside the region.
  // Mints region/note ids eagerly (called once per region, never inside a state
  // updater) so React StrictMode double-invokes can't double-increment.
  const splitRegionAtMeasure = useCallback((r, P) => {
    const S = r.startMeasure;
    const D = r.durationMeasures;
    const EPS = 1e-6;
    if (P <= S + EPS || P >= S + D - EPS) return null;
    const rel = P - S;
    const co  = r.clipOffset ?? 0;
    const li  = r.loopInterval ?? null;
    const origPhase = li != null ? (r.loopPhase ?? 0) : 0;

    // Aggregate of every produced region + every cloned note. regions[0] is the
    // Left piece (reuses r.id, keeps the originals); each new piece gets fresh
    // ids minted eagerly here (never inside a state updater) so StrictMode
    // double-invokes can't double-increment. `clones` deep-copies the full
    // bottle for each right-side piece (out-of-window notes stay hidden, not
    // destroyed — the Bottle/Window model).
    const regions = [];
    const clones  = [];
    const newRegion = (fields) => {
      const id = `r${nextRegionIdRef.current++}`;
      for (const n of notesRef.current) {
        if (n.regionId === r.id) clones.push({ ...n, id: `note_${nextNoteIdRef.current++}`, regionId: id });
      }
      return { ...r, id, ...fields };
    };

    // ── Left: original truncated at the playhead (keeps looping with a partial
    // tail). Identical to the prior behavior; preserves a pre-existing phase for
    // back-compat with already-phased regions loaded from old projects.
    let leftLI, leftPhase;
    if (li == null)            { leftLI = null; leftPhase = 0; }
    else if (origPhase === 0)  { leftLI = normalizeLoopInterval(rel, li); leftPhase = 0; }
    else                       { leftLI = li;  leftPhase = origPhase; } // keep phased loop intact
    regions.push({
      ...r,
      durationMeasures: rel,
      fadeIn:  Math.min(r.fadeIn ?? 0, rel),
      fadeOut: 0,
      fadeInFloor:  r.fadeInFloor ?? 0,
      fadeOutFloor: 0,
      loopInterval: leftLI,
      loopPhase: leftPhase,
    });

    // ── Non-looped region: existing 2-piece Case-D split (slide the bottle
    // window forward by the cut). No remainder/clean-loop concept applies.
    if (li == null) {
      regions.push(newRegion({
        startMeasure: P,
        durationMeasures: D - rel,
        fadeIn: 0,
        fadeOut: Math.min(r.fadeOut ?? 0, D - rel),
        fadeInFloor: 0,
        fadeOutFloor: r.fadeOutFloor ?? 0,
        clipOffset: co + rel,
        loopInterval: null,
        loopPhase: 0,
      }));
      return { regions, clones };
    }

    // ── Looped region: boundary-aware three-piece split.
    //   homeLocalRel = which home-cycle position the playhead sits on.
    //   nextBoundaryRel = next cycle boundary (home-local wraps to 0) right of P.
    const homeLocalRel    = (((rel + origPhase) % li) + li) % li;
    const distToNext      = homeLocalRel <= EPS ? 0 : li - homeLocalRel;
    const nextBoundaryRel = rel + distToNext;
    const onBoundary      = distToNext <= EPS;
    const hasR            = !onBoundary && nextBoundaryRel < D - EPS;

    if (!onBoundary) {
      // ── M: the severed remainder of the in-progress cycle, from the playhead
      // to the next boundary (or the region end when no full cycle follows).
      // Non-looping; clipOffset windows the bottle onto home-local [homeLocalRel, li).
      const mDur = hasR ? (nextBoundaryRel - rel) : (D - rel);
      regions.push(newRegion({
        startMeasure: P,
        durationMeasures: mDur,
        fadeIn: 0,
        fadeInFloor: 0,
        fadeOut: hasR ? 0 : Math.min(r.fadeOut ?? 0, mDur),
        fadeOutFloor: hasR ? 0 : (r.fadeOutFloor ?? 0),
        clipOffset: co + homeLocalRel,
        loopInterval: null,
        loopPhase: 0,
      }));
    }

    if (onBoundary || hasR) {
      // ── R: a fresh, clean phase-0 loop starting at the next boundary, with the
      // full home block and a working loop-resize handle. On an on-boundary split
      // R starts at the playhead itself (no remainder produced).
      const rStartRel = onBoundary ? rel : nextBoundaryRel;
      const rDur      = D - rStartRel;
      regions.push(newRegion({
        startMeasure: S + rStartRel,
        durationMeasures: rDur,
        fadeIn: 0,
        fadeInFloor: 0,
        fadeOut: Math.min(r.fadeOut ?? 0, rDur),
        fadeOutFloor: r.fadeOutFloor ?? 0,
        clipOffset: co,
        loopInterval: normalizeLoopInterval(rDur, li),
        loopPhase: 0,
      }));
    }

    return { regions, clones };
  }, []);

  // Context-menu commands operate on the whole active selection when the clicked
  // item is part of it; otherwise just the clicked item. `payload` carries the
  // semitone count for the pitch submenu.
  const handleContextCommand = useCallback((action, type, id, payload) => {
    if (type === 'track') {
      if (action === 'pitch') {
        // Destructive track transpose — rewrites note names like the region
        // pitch submenu (one source of truth; undoable via the recorder).
        setNotes(prev => prev.map(n =>
          n.trackId === id ? { ...n, note: shiftNoteName(n.note, payload) } : n));
      }
      else if (action === 'rename')       setRenamingTrackId(id);
      else if (action === 'color')        setTracks(prev => prev.map(t => t.id === id ? { ...t, color: payload } : t));
      else if (action === 'duplicate')    duplicateTrack(id);
      else if (action === 'createGroup')  setGroupModal({ initiatorTrackId: id });
      else if (action === 'ungroupTrack') removeTrackFromGroup(id);
      else if (action === 'pasteEffects') pasteEffectsTo(id, payload);
      else if (action === 'export')       exportTrack(id, payload ?? 'wav');
      else if (action === 'delete')       deleteTrack(id);
      return;
    }
    if (type === 'group') {
      if (action === 'rename')       setRenamingGroupId(id);
      else if (action === 'color')   setGroups(prev => prev.map(g => g.id === id ? { ...g, color: payload } : g));
      else if (action === 'ungroup') ungroup(id);
      else if (action === 'delete') {
        const g = groupsRef.current.find(x => x.id === id);
        const count = tracksRef.current.filter(t => t.groupId === id).length;
        if (window.confirm(`Delete group "${g?.name ?? id}" AND its ${count} track${count === 1 ? '' : 's'}? (undoable)`)) {
          deleteGroup(id);
        }
      }
      return;
    }
    if (type === 'region') {
      const ids = selectedRegionIdsRef.current.has(id)
        ? [...selectedRegionIdsRef.current] : [id];
      const set = new Set(ids);
      if (action === 'delete') {
        setRegions(prev => prev.filter(r => !set.has(r.id)));
        setNotes(prev => prev.filter(n => !set.has(n.regionId)));
        setSelectedRegionIds(new Set());
      } else if (action === 'mute') {
        const anchor = regionsRef.current.find(r => r.id === id);
        const next = !(anchor?.isMuted);
        setRegions(prev => prev.map(r => set.has(r.id) ? { ...r, isMuted: next } : r));
      } else if (action === 'pitch') {
        transposeRegions(set, payload);
      } else if (action === 'split') {
        const P = Tone.Transport.ticks / (Tone.Transport.PPQ * 4); // playhead in measures
        const splits = [];
        for (const rid of ids) {
          const r = regionsRef.current.find(x => x.id === rid);
          if (!r) continue;
          const res = splitRegionAtMeasure(r, P);
          if (res) splits.push({ leftId: rid, ...res }); // leftId === res.regions[0].id
        }
        if (!splits.length) return;
        const splitById = new Map(splits.map(s => [s.leftId, s]));
        setRegions(prev => prev.flatMap(rg => {
          const s = splitById.get(rg.id);
          return s ? s.regions : [rg];
        }));
        const allClones = splits.flatMap(s => s.clones);
        if (allClones.length) setNotes(prev => [...prev, ...allClones]);
        const nextSel = new Set();
        for (const s of splits) for (const pr of s.regions) nextSel.add(pr.id);
        setSelectedRegionIds(nextSel);
      } else console.log('[context-menu] region', action, ids); // copy / paste (stubs)
    } else {
      const sel = noteSelectionRef.current;
      const ids = sel?.has(id) ? [...sel] : [id];
      const set = new Set(ids);
      if (action === 'delete') handleNotesDelete(set);
      else if (action === 'pitch') transposeNotes(set, payload);
      else console.log('[context-menu] note', action, ids); // copy / paste (stubs)
    }
  }, [transposeRegions, transposeNotes, handleNotesDelete, splitRegionAtMeasure,
      duplicateTrack, deleteTrack, pasteEffectsTo, exportTrack,
      removeTrackFromGroup, ungroup, deleteGroup]);

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
    setRegions(prev => [...prev, { id: `r${n}`, trackId, startMeasure: measure, durationMeasures: 1, clipOffset: 0, fadeIn: 0, fadeOut: 0, fadeInFloor: 0, fadeOutFloor: 0, loopInterval: null }]);
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
        const newDur = newStart - oldStart;
        const fIn  = Math.min(r.fadeIn  ?? 0, newDur);
        const fOut = Math.min(r.fadeOut ?? 0, Math.max(0, newDur - fIn));
        const clampedLI = normalizeLoopInterval(newDur, r.loopInterval ?? null);
        nextRegions.push({ ...r, durationMeasures: newDur, fadeIn: fIn, fadeOut: fOut, fadeInFloor: r.fadeInFloor ?? 0, fadeOutFloor: r.fadeOutFloor ?? 0, loopInterval: clampedLI });
        continue;
      }
      // Case C: left trim — bottle preserved; window starts later & advances clipOffset
      if (newStart <= oldStart && newEnd < oldEnd) {
        const shift = newEnd - oldStart;
        const newDur = oldEnd - newEnd;
        // Left side was eaten — fadeIn no longer meaningful; preserve fadeOut clamped.
        const fOut = Math.min(r.fadeOut ?? 0, newDur);
        const clampedLI = normalizeLoopInterval(newDur, r.loopInterval ?? null);
        nextRegions.push({
          ...r,
          startMeasure: newEnd,
          durationMeasures: newDur,
          clipOffset: oldOffset + shift,
          fadeIn: 0,
          fadeOut: fOut,
          fadeInFloor: 0,
          fadeOutFloor: r.fadeOutFloor ?? 0,
          loopInterval: clampedLI,
        });
        continue;
      }
      // Case D: middle split — both halves get an independent copy of the full bottle
      const rightId = `r${nextRegionIdRef.current++}`;
      const rightShift = newEnd - oldStart;
      const leftDur  = newStart - oldStart;
      const rightDur = oldEnd - newEnd;
      const leftFIn  = Math.min(r.fadeIn ?? 0, leftDur);
      const leftLI  = normalizeLoopInterval(leftDur,  r.loopInterval ?? null);
      const rightLI = normalizeLoopInterval(rightDur, r.loopInterval ?? null);
      nextRegions.push(
        { ...r, durationMeasures: leftDur, fadeIn: leftFIn, fadeOut: 0, fadeInFloor: r.fadeInFloor ?? 0, fadeOutFloor: 0, loopInterval: leftLI },
        {
          ...r,
          id: rightId,
          startMeasure: newEnd,
          durationMeasures: rightDur,
          clipOffset: oldOffset + rightShift,
          fadeIn: 0,
          fadeOut: Math.min(r.fadeOut ?? 0, rightDur),
          fadeInFloor: 0,
          fadeOutFloor: r.fadeOutFloor ?? 0,
          loopInterval: rightLI,
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
    if (e.button !== 0) return; // ignore right/middle click — context menu handles those
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
            const fIn   = r.fadeIn        ?? 0;
            const fOut  = r.fadeOut       ?? 0;
            const fInF  = r.fadeInFloor   ?? 0;
            const fOutF = r.fadeOutFloor  ?? 0;
            const loopI = r.loopInterval  ?? null;
            return [{
              regionId: cId, trackId: r.trackId, origTrackIndex: tIdx,
              pendingTrackId: r.trackId, pendingTrackIndex: tIdx,
              initStart: r.startMeasure, initDuration: r.durationMeasures, initClipOffset: co,
              pendingStart: r.startMeasure, pendingDuration: r.durationMeasures, pendingClipOffset: co,
              initFadeIn: fIn, initFadeOut: fOut,
              initFadeInFloor: fInF, initFadeOutFloor: fOutF,
              pendingFadeIn: fIn, pendingFadeOut: fOut,
              pendingFadeInFloor: fInF, pendingFadeOutFloor: fOutF,
              initLoopInterval: loopI,
              pendingLoopInterval: loopI, // null stays null; loop modes set their fallback inline
              el,
            }];
          })
      : [];

    const regionEl = e.currentTarget.closest('[data-region-id]');
    const co = region.clipOffset ?? 0;
    const fIn = region.fadeIn ?? 0;
    const fOut = region.fadeOut ?? 0;
    // Merged-joint zone upgrade: when fades meet (fadeIn + fadeOut = duration), clicking
    // the central zone of either handle drags them together; edges still split.
    let effectiveMode = mode;
    if ((mode === 'fade-left' || mode === 'fade-right') &&
        fIn + fOut >= region.durationMeasures - 1e-6) {
      const r = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - r.left) / r.width;
      if (pct >= 0.3 && pct <= 0.7) effectiveMode = 'fade-both';
    }
    dragRef.current = {
      regionId:          region.id,
      trackId:           region.trackId,
      origTrackIndex,
      pendingTrackId:    region.trackId,
      pendingTrackIndex: origTrackIndex,
      mode: effectiveMode,
      startX: e.clientX,
      startY: e.clientY,
      initStart: region.startMeasure,
      initDuration: region.durationMeasures,
      initClipOffset: co,
      initFadeIn: fIn,
      initFadeOut: fOut,
      initFadeInFloor:  region.fadeInFloor  ?? 0,
      initFadeOutFloor: region.fadeOutFloor ?? 0,
      regionHeight: regionEl?.getBoundingClientRect().height ?? 64,
      el: regionEl,
      pendingStart: region.startMeasure,
      pendingDuration: region.durationMeasures,
      pendingClipOffset: co,
      pendingFadeIn: fIn,
      pendingFadeOut: fOut,
      pendingFadeInFloor:  region.fadeInFloor  ?? 0,
      pendingFadeOutFloor: region.fadeOutFloor ?? 0,
      initLoopInterval:    region.loopInterval ?? null,
      pendingLoopInterval: region.loopInterval ?? null,
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
        if (d.mode === 'fade-left' || d.mode === 'fade-right' || d.mode === 'fade-both'
            || d.mode === 'fade-left-floor' || d.mode === 'fade-right-floor') {
          document.body.classList.add('is-fade-dragging');
        }
        if (d.mode === 'loop-right' || d.mode === 'loop-resize-base') {
          document.body.classList.add('is-loop-dragging');
        }
        // Phase 108: per-region marker scopes handle visibility to dragged region(s) only.
        if (d.el) d.el.setAttribute('data-active-drag', 'true');
        for (const c of d.companions) { if (c.el) c.el.setAttribute('data-active-drag', 'true'); }
        const isFloor = d.mode === 'fade-left-floor' || d.mode === 'fade-right-floor';
        document.body.style.cursor = d.mode === 'move' ? 'grabbing' : (isFloor ? 'ns-resize' : 'ew-resize');
        if (d.el) d.el.style.filter = 'brightness(0.6)';
        for (const c of d.companions) { if (c.el) c.el.style.filter = 'brightness(0.6)'; }
      }
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      const snapInc = getSnapIncrement(pixelsPerMeasure);
      const tl = timelineRef.current;
      const rect = tl.getBoundingClientRect();
      const scrollAdjust = (tl?.scrollLeft ?? 0) - d.startScrollLeft;
      // Hard right-wall: clamp cursor to the rendered grid's right edge.
      // Region edges may overflow past the wall (anchor's grabOffset still applies); only the cursor is walled.
      // Grid content starts after the sticky header column, so the wall sits headerColW() further right.
      const maxCursorClientX = rect.left + headerColW() + (totalMeasuresRef.current * pixelsPerMeasure) - tl.scrollLeft;
      const clampedClientX = Math.min(e.clientX, maxCursorClientX);
      const rawDelta = (clampedClientX - d.startX + scrollAdjust) / pixelsPerMeasure;
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

        const relContent = e.clientY - rect.top + timelineRef.current.scrollTop - RULER_HEIGHT;
        // Cumulative lookup (not / TRACK_H): open automation sub-lanes belong to
        // their track, so a drop anywhere in a track's strip lands on that track.
        const rawTrackDelta     = yToTrackIndex(relContent, laneTopsRef.current) - d.origTrackIndex;
        let clampedTrackDelta = Math.max(
          -minOrigTrackIndex,
          Math.min(tracksRef.current.length - 1 - maxOrigTrackIndex, rawTrackDelta)
        );
        // Collapsed-group guard: yToTrackIndex can't RETURN a hidden track
        // (zero-height band), but the clamp arithmetic and companion offsets
        // can still land one on a collapsed member — keep the last valid
        // delta instead of dropping a region into an invisible lane.
        const isHiddenTrack = (idx) => {
          const gid = tracksRef.current[idx]?.groupId;
          return !!gid && collapsedGroupIdsRef.current.has(gid);
        };
        if (isHiddenTrack(d.origTrackIndex + clampedTrackDelta)
            || d.companions.some(c => isHiddenTrack(c.origTrackIndex + clampedTrackDelta))) {
          clampedTrackDelta = (d.pendingTrackIndex ?? d.origTrackIndex) - d.origTrackIndex;
        }
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
            const tops = laneTopsRef.current;
            c.el.style.left      = `${cStart * pixelsPerMeasure}px`;
            c.el.style.transform = `translateY(${tops[cIdx] - tops[c.origTrackIndex]}px)`;
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
      } else if (d.mode === 'loop-right') {
        // Same right-edge stretching math as resize-right; lock loopInterval to initDuration
        // if it was previously null (anchor and each companion locks its own base).
        const rawEnd     = d.initStart + d.initDuration + rawDelta;
        const snappedEnd = snapEnabledRef.current
          ? Math.round(rawEnd / snapInc) * snapInc
          : rawEnd;
        newDuration = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, snappedEnd - d.initStart);
        d.pendingLoopInterval = d.initLoopInterval ?? d.initDuration;
        const rightActualDelta = newDuration - d.initDuration;
        for (const c of d.companions) {
          c.pendingDuration = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, c.initDuration + rightActualDelta);
          c.pendingLoopInterval = c.initLoopInterval ?? c.initDuration;
          if (c.el) { c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`; c.el.style.zIndex = '10'; }
        }
        // Phase 110/111: mid-drag setRegions so new iterations/segments/dividers/ghost notes render live.
        // Scoped to loop-right only (other modes preserve the direct-DOM Phase 95 pattern).
        // Phase 111: normalize so collapsing the loop back to base clears loopInterval live (not just on drop).
        const anchorDur = newDuration;
        const anchorLI  = normalizeLoopInterval(newDuration, d.pendingLoopInterval);
        const companionsSnapshot = d.companions.map(c => ({
          regionId: c.regionId,
          durationMeasures: c.pendingDuration,
          loopInterval: normalizeLoopInterval(c.pendingDuration, c.pendingLoopInterval),
        }));
        setRegions(prev => prev.map(r => {
          if (r.id === d.regionId) return { ...r, durationMeasures: anchorDur, loopInterval: anchorLI };
          const comp = companionsSnapshot.find(c => c.regionId === r.id);
          if (comp) return { ...r, durationMeasures: comp.durationMeasures, loopInterval: comp.loopInterval };
          return r;
        }));
      } else if (d.mode === 'loop-resize-base') {
        // Drag the first dashed divider — resizes loopInterval; durationMeasures pushes
        // out only if the new base would exceed it. Anchor + cluster companions.
        const initLoop = d.initLoopInterval ?? d.initDuration;
        const rawLoop  = initLoop + rawDelta;
        const snapped  = snapEnabledRef.current ? Math.round(rawLoop / snapInc) * snapInc : rawLoop;
        const newLoop  = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, snapped);
        d.pendingLoopInterval = newLoop;
        newDuration = Math.max(d.initDuration, newLoop);
        const loopDelta = newLoop - initLoop;
        for (const c of d.companions) {
          const cInit   = c.initLoopInterval ?? c.initDuration;
          const cNewLoop = Math.max(snapEnabledRef.current ? snapInc : MIN_REGION, cInit + loopDelta);
          c.pendingLoopInterval = cNewLoop;
          c.pendingDuration     = Math.max(c.initDuration, cNewLoop);
          if (c.el) { c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`; c.el.style.zIndex = '10'; }
        }
      } else if (d.mode === 'fade-left') {
        // Continuous (not snap-quantized) per user choice. Push opposing fade if collision.
        // Cluster: apply same rawDelta to each companion, clamped per-region.
        const applyFadeLeft = (initIn, initOut, dur) => {
          const fIn = Math.max(0, Math.min(dur, initIn + rawDelta));
          let fOut = initOut;
          if (fIn + fOut > dur) fOut = Math.max(0, dur - fIn);
          return [fIn, fOut];
        };
        [d.pendingFadeIn, d.pendingFadeOut] = applyFadeLeft(d.initFadeIn, d.initFadeOut, d.initDuration);
        for (const c of d.companions) {
          [c.pendingFadeIn, c.pendingFadeOut] = applyFadeLeft(c.initFadeIn, c.initFadeOut, c.initDuration);
        }
      } else if (d.mode === 'fade-right') {
        const applyFadeRight = (initIn, initOut, dur) => {
          const fOut = Math.max(0, Math.min(dur, initOut - rawDelta));
          let fIn = initIn;
          if (fIn + fOut > dur) fIn = Math.max(0, dur - fOut);
          return [fIn, fOut];
        };
        [d.pendingFadeIn, d.pendingFadeOut] = applyFadeRight(d.initFadeIn, d.initFadeOut, d.initDuration);
        for (const c of d.companions) {
          [c.pendingFadeIn, c.pendingFadeOut] = applyFadeRight(c.initFadeIn, c.initFadeOut, c.initDuration);
        }
      } else if (d.mode === 'fade-both') {
        // Joint slides by rawDelta; clamp per-region against own initDuration.
        const applyFadeBoth = (initIn, dur) => {
          const joint = Math.max(0, Math.min(dur, initIn + rawDelta));
          return [joint, dur - joint];
        };
        [d.pendingFadeIn, d.pendingFadeOut] = applyFadeBoth(d.initFadeIn, d.initDuration);
        for (const c of d.companions) {
          [c.pendingFadeIn, c.pendingFadeOut] = applyFadeBoth(c.initFadeIn, c.initDuration);
        }
      } else if (d.mode === 'fade-left-floor' || d.mode === 'fade-right-floor') {
        // Vertical drag: up (negative dy) raises the floor; capped at 80%.
        const dy = e.clientY - d.startY;
        const floorDelta = dy / d.regionHeight;
        const isLeft = d.mode === 'fade-left-floor';
        const anchorInit = isLeft ? d.initFadeInFloor : d.initFadeOutFloor;
        const next = Math.max(0, Math.min(0.8, anchorInit - floorDelta));
        if (isLeft) d.pendingFadeInFloor  = next;
        else        d.pendingFadeOutFloor = next;
        for (const c of d.companions) {
          const cInit = isLeft ? c.initFadeInFloor : c.initFadeOutFloor;
          const cNext = Math.max(0, Math.min(0.8, cInit - floorDelta));
          if (isLeft) c.pendingFadeInFloor  = cNext;
          else        c.pendingFadeOutFloor = cNext;
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
        // Phase 106: if region had a base loop, the visible loop length tracks the moving edge.
        const anchorMovedBy = candStart - d.initStart; // positive when shrinking from left
        if (d.initLoopInterval !== null) {
          d.pendingLoopInterval = Math.max(MIN_REGION, Math.min(newDuration, d.initLoopInterval - anchorMovedBy));
        } else {
          d.pendingLoopInterval = null;
        }
        for (const c of d.companions) {
          const cStart    = Math.max(0, Math.min(c.initStart + preDelta, c.initStart + c.initDuration - minDur));
          c.pendingStart       = cStart;
          c.pendingDuration    = c.initDuration + (c.initStart - cStart);
          c.pendingClipOffset  = c.initClipOffset + (cStart - c.initStart);
          if (c.initLoopInterval !== null) {
            const cMovedBy = cStart - c.initStart;
            c.pendingLoopInterval = Math.max(MIN_REGION, Math.min(c.pendingDuration, c.initLoopInterval - cMovedBy));
          } else {
            c.pendingLoopInterval = null;
          }
          if (c.el) {
            c.el.style.left  = `${c.pendingStart    * pixelsPerMeasure}px`;
            c.el.style.width = `${c.pendingDuration * pixelsPerMeasure}px`;
            c.el.style.zIndex = '10';
          }
        }
      }

      // Clamp fades to fit the new duration on resize (live so the overlay tracks).
      if (d.mode === 'resize-right' || d.mode === 'resize-left') {
        const fIn  = Math.min(d.initFadeIn, newDuration);
        const fOut = Math.min(d.initFadeOut, Math.max(0, newDuration - fIn));
        d.pendingFadeIn  = fIn;
        d.pendingFadeOut = fOut;
      }

      // Live fade overlay + handle DOM updates (Zero-Re-render Rule).
      const writeFadeDom = (el, pFadeIn, pFadeOut, pFloorIn, pFloorOut) => {
        if (!el) return;
        const fInPx  = pFadeIn  * pixelsPerMeasure;
        const fOutPx = pFadeOut * pixelsPerMeasure;
        const floorInPct  = (pFloorIn  ?? 0) * 100;
        const floorOutPct = (pFloorOut ?? 0) * 100;
        const inEl  = el.querySelector('[data-fade-in]');
        const outEl = el.querySelector('[data-fade-out]');
        const hLEl  = el.querySelector('[data-fade-handle-left]');
        const hREl  = el.querySelector('[data-fade-handle-right]');
        if (inEl)  {
          inEl.style.display  = fInPx  > 0 ? '' : 'none';
          inEl.style.width    = `${fInPx}px`;
          inEl.style.clipPath = `polygon(0 0, 100% 0, 0 ${100 - floorInPct}%)`;
        }
        if (outEl) {
          outEl.style.display = fOutPx > 0 ? '' : 'none';
          outEl.style.width   = `${fOutPx}px`;
          outEl.style.clipPath = `polygon(0 0, 100% 0, 100% ${100 - floorOutPct}%)`;
        }
        if (hLEl)  hLEl.style.left  = `${fInPx}px`;
        if (hREl)  hREl.style.right = `${fOutPx}px`;
        const fLEl = el.querySelector('[data-fade-floor-left]');
        const fREl = el.querySelector('[data-fade-floor-right]');
        if (fLEl) fLEl.style.bottom = `${floorInPct}%`;
        if (fREl) fREl.style.bottom = `${floorOutPct}%`;
      };

      if (d.el) {
        const tops = laneTopsRef.current;
        const yOffset = tops[d.pendingTrackIndex] - tops[d.origTrackIndex];
        d.el.style.left      = `${newStart    * pixelsPerMeasure}px`;
        d.el.style.width     = `${newDuration * pixelsPerMeasure}px`;
        d.el.style.transform = `translateY(${yOffset}px)`;
        d.el.style.zIndex    = '10';
        writeFadeDom(d.el, d.pendingFadeIn, d.pendingFadeOut, d.pendingFadeInFloor, d.pendingFadeOutFloor);
      }
      // Companion fade DOM writes (cluster bulk fade — Phase 103).
      const isFadeMode = d.mode === 'fade-left' || d.mode === 'fade-right' || d.mode === 'fade-both'
                       || d.mode === 'fade-left-floor' || d.mode === 'fade-right-floor';
      if (isFadeMode) {
        for (const c of d.companions) {
          writeFadeDom(c.el, c.pendingFadeIn, c.pendingFadeOut, c.pendingFadeInFloor, c.pendingFadeOutFloor);
        }
      }
      // Phase 107: live preview for loop-resize-base + resize-left (loop tint, first divider, mini-notes).
      const writeLoopDom = (el, loopInterval, clipOffset) => {
        if (!el) return;
        const baseLoop = loopInterval ?? null;
        if (baseLoop !== null) {
          const xPx = baseLoop * pixelsPerMeasure;
          const tintEl = el.querySelector('[data-loop-tint]');
          if (tintEl) tintEl.style.left = `${xPx}px`;
          const firstDiv = el.querySelector('[data-loop-divider-first]');
          if (firstDiv) firstDiv.style.left = `${xPx}px`;
          // Phase 113: sync segment left/width so iteration boundaries paint in the same
          // frame as the divider/tint. Last segment is anchored via right:0 (Phase 112).
          const segEls = el.querySelectorAll('[data-loop-segment]');
          let maxI = -1;
          segEls.forEach(s => { const i = parseInt(s.dataset.loopSegmentI, 10); if (i > maxI) maxI = i; });
          segEls.forEach(s => {
            const i = parseInt(s.dataset.loopSegmentI, 10);
            s.style.left = `${i * baseLoop * pixelsPerMeasure}px`;
            if (i < maxI) s.style.width = `${baseLoop * pixelsPerMeasure}px`;
          });
        }
        const wsb = (clipOffset ?? 0) * 4;
        const ppb = pixelsPerMeasure / 4;
        el.querySelectorAll('[data-mini-note]').forEach((mn) => {
          const iter = parseInt(mn.dataset.miniNoteIter, 10) || 0;
          const sb   = parseFloat(mn.dataset.miniNoteStartbeat);
          const local = sb - wsb;
          mn.style.left = `${iter * (baseLoop ?? 0) * pixelsPerMeasure + local * ppb}px`;
        });
      };
      if (d.mode === 'loop-resize-base') {
        writeLoopDom(d.el, d.pendingLoopInterval, d.initClipOffset);
        for (const c of d.companions) writeLoopDom(c.el, c.pendingLoopInterval, c.initClipOffset);
        // Phase 111: mid-drag setRegions so segments/dividers/ghost notes reflow when duration extends past initDuration.
        const anchorDur = newDuration;
        const anchorLI  = d.pendingLoopInterval;
        const snap = d.companions.map(c => ({
          regionId: c.regionId, durationMeasures: c.pendingDuration, loopInterval: c.pendingLoopInterval,
        }));
        setRegions(prev => prev.map(r => {
          if (r.id === d.regionId) return { ...r, durationMeasures: anchorDur, loopInterval: anchorLI };
          const comp = snap.find(c => c.regionId === r.id);
          if (comp) return { ...r, durationMeasures: comp.durationMeasures, loopInterval: comp.loopInterval };
          return r;
        }));
      } else if (d.mode === 'resize-left') {
        writeLoopDom(d.el, d.pendingLoopInterval, d.pendingClipOffset);
        for (const c of d.companions) writeLoopDom(c.el, c.pendingLoopInterval, c.pendingClipOffset);
        // Phase 111: mid-drag setRegions so segments/dividers/ghost notes reflow with the moving left edge.
        const anchorStart = newStart;
        const anchorDur   = newDuration;
        const anchorCO    = d.pendingClipOffset;
        const anchorLI    = d.pendingLoopInterval;
        const snap = d.companions.map(c => ({
          regionId: c.regionId,
          startMeasure: c.pendingStart,
          durationMeasures: c.pendingDuration,
          clipOffset: c.pendingClipOffset,
          loopInterval: c.pendingLoopInterval,
        }));
        setRegions(prev => prev.map(r => {
          if (r.id === d.regionId) {
            return { ...r, startMeasure: anchorStart, durationMeasures: anchorDur, clipOffset: anchorCO, loopInterval: anchorLI };
          }
          const comp = snap.find(c => c.regionId === r.id);
          if (comp) return { ...r, ...comp };
          return r;
        }));
      }
      d.pendingStart    = newStart;
      d.pendingDuration = newDuration;
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (d) {
        // Phase 106: click-without-drag on the loop handle appends one base-loop length
        // to the anchor and to each cluster companion (each uses its own base length).
        if (!d.dragStarted && d.mode === 'loop-right') {
          const baseLoop = d.initLoopInterval ?? d.initDuration;
          d.pendingDuration = d.initDuration + baseLoop;
          d.pendingLoopInterval = baseLoop;
          for (const c of d.companions) {
            const cBase = c.initLoopInterval ?? c.initDuration;
            c.pendingDuration = c.initDuration + cBase;
            c.pendingLoopInterval = cBase;
          }
          d.dragStarted = true; // fall through to existing commit path
        }
        if (d.dragStarted) {
          const resetEl = (el) => {
            if (!el) return;
            el.style.transform = ''; el.style.zIndex = ''; el.style.filter = '';
            el.style.removeProperty('--track-color');
          };
          resetEl(d.el);
          for (const c of d.companions) resetEl(c.el);

          const { regionId, pendingStart, pendingDuration, pendingTrackId, pendingClipOffset, pendingFadeIn, pendingFadeOut, pendingFadeInFloor, pendingFadeOutFloor, pendingLoopInterval } = d;
          const clusterIds = new Set([regionId, ...d.companions.map(c => c.regionId)]);

          // Phase 105/106/109: loopInterval commit policy by drag mode.
          //   - loop-right / loop-resize-base : commit pendingLoopInterval as-is (explicit loop edit).
          //   - resize-right                  : normalize current loopInterval against the new duration
          //                                     (auto-null if shrunk back to ≤ 1 iteration — Phase 109).
          //   - resize-left                   : normalize pendingLoopInterval (Phase 106 + Phase 109).
          //   - other modes                   : leave loopInterval untouched (preserved by ...r spread).
          const anchorOriginal = regionsRef.current.find(r => r.id === regionId);
          const anchorLoopOverride =
            d.mode === 'loop-right'
              ? { loopInterval: normalizeLoopInterval(pendingDuration, pendingLoopInterval) }
              : d.mode === 'loop-resize-base'
                ? { loopInterval: pendingLoopInterval } // explicit loop edit; preserve even when duration == loopInterval
                : d.mode === 'resize-right'
                  ? { loopInterval: normalizeLoopInterval(pendingDuration, anchorOriginal?.loopInterval ?? null) }
                  : d.mode === 'resize-left'
                    ? { loopInterval: normalizeLoopInterval(pendingDuration, pendingLoopInterval) }
                    : {};
          const movedRegion = {
            ...anchorOriginal,
            startMeasure: pendingStart, durationMeasures: pendingDuration, trackId: pendingTrackId,
            clipOffset: pendingClipOffset,
            fadeIn: pendingFadeIn, fadeOut: pendingFadeOut,
            fadeInFloor: pendingFadeInFloor, fadeOutFloor: pendingFadeOutFloor,
            ...anchorLoopOverride,
          };
          const cluster = [
            movedRegion,
            ...d.companions.map(c => {
              const cLoopOverride =
                d.mode === 'loop-right'
                  ? { loopInterval: normalizeLoopInterval(c.pendingDuration, c.pendingLoopInterval) }
                  : d.mode === 'loop-resize-base'
                    ? { loopInterval: c.pendingLoopInterval }
                    : d.mode === 'resize-right'
                      ? { loopInterval: normalizeLoopInterval(c.pendingDuration, c.initLoopInterval) }
                      : d.mode === 'resize-left'
                        ? { loopInterval: normalizeLoopInterval(c.pendingDuration, c.pendingLoopInterval) }
                        : {};
              return {
                ...regionsRef.current.find(r => r.id === c.regionId),
                startMeasure: c.pendingStart, durationMeasures: c.pendingDuration, trackId: c.pendingTrackId,
                clipOffset: c.pendingClipOffset,
                fadeIn: c.pendingFadeIn, fadeOut: c.pendingFadeOut,
                fadeInFloor: c.pendingFadeInFloor, fadeOutFloor: c.pendingFadeOutFloor,
                ...cLoopOverride,
              };
            }),
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
          document.body.classList.remove('is-fade-dragging');
          document.body.classList.remove('is-loop-dragging');
          if (d.el) d.el.removeAttribute('data-active-drag');
          for (const c of d.companions) { if (c.el) c.el.removeAttribute('data-active-drag'); }
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
      const currentX = e.clientX - (rect.left + headerColW()) + scroller.scrollLeft;
      const currentY = Math.max(0, e.clientY - rect.top + scroller.scrollTop - RULER_HEIGHT);
      if (!d.active && Math.hypot(currentX - d.startX, currentY - d.startY) < 4) return;
      if (!d.active) {
        Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
        document.body.classList.add('is-dragging');
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
        regionsRef.current, tracksRef.current, pixelsPerMeasure, laneTopsRef.current
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
      document.body.classList.remove('is-dragging');
      if (d.active) {
        const minX = Math.min(d.startX, d.currentX ?? d.startX);
        const maxX = Math.max(d.startX, d.currentX ?? d.startX);
        const minY = Math.min(d.startY, d.currentY ?? d.startY);
        const maxY = Math.max(d.startY, d.currentY ?? d.startY);
        const hitIds = getIntersectingRegionIds(minX, maxX, minY, maxY,
          regionsRef.current, tracksRef.current, pixelsPerMeasure, laneTopsRef.current);
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
  selectedAnchorRef.current     = selectedAnchor;
  globalAutomationsRef.current  = globalAutomations;
  groupsRef.current             = groups;
  collapsedGroupIdsRef.current  = collapsedGroupIds;
  snapEnabledRef.current        = snapEnabled;
  editingTrackIdRef.current     = editingTrackId;
  laneTopsRef.current           = laneTops;

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
    // Phase 112: delta-from-mousedown math so the click point's offset within the
    // divider handle is preserved (no first-mousemove jump).
    const startY = e.clientY;
    const startH = editorHeight;
    let pending  = startH;
    const onMove = (ev) => {
      const wanted = startH - (ev.clientY - startY);
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
    // Tick-driven so bpm changes can't desync the visual from the audio.
    // Tone.Transport.ticks is canonical musical time; it never jumps when bpm
    // changes. Seconds is kept only for the wall-clock readout. Uses the same float
    // measure unit (pixelsPerMeasure/4 = px per beat) as the grid/regions so it stays
    // locked to them at any zoom.
    const beats = Tone.Transport.ticks / Tone.Transport.PPQ;
    const x     = beats * (pixelsPerMeasure / 4);
    if (playheadRef.current)          playheadRef.current.style.transform          = `translateX(${x}px)`;
    if (pianoRollPlayheadRef.current) pianoRollPlayheadRef.current.style.transform = `translateX(${x}px)`;
    if (timeRef.current)              timeRef.current.textContent                  = formatTime(Tone.Transport.seconds);
    // Live automated tempo (span only rendered while the tempo lane has points).
    if (bpmLiveRef.current)           bpmLiveRef.current.textContent               = `∿${Math.round(Tone.Transport.bpm.value)}`;
  }, [pixelsPerMeasure]);

  // Reposition playhead when zoom changes (even while paused) — layout phase so the
  // playhead transform commits in the SAME pre-paint pass as the grid rescale and the
  // zoom-to-cursor scrollLeft correction (a plain useEffect runs post-paint, painting
  // one stale-transform frame against the new grid scale → the "jump then snap" jitter,
  // worst far down the timeline where the per-zoom delta is largest).
  useLayoutEffect(() => { updatePlayhead(); }, [updatePlayhead]);

  // ── Timeline grid canvas ─────────────────────────────────────
  // Redraws the pinned grid-line canvas for the current viewport + scroll + zoom.
  const drawTimelineGrid = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    drawGrid(timelineCanvasRef.current, {
      scrollLeft: el.scrollLeft,
      viewW: el.clientWidth,
      viewH: el.clientHeight,
      ppm: pixelsPerMeasure,
      zoomLevel,
      leftInset: headerColW(), // grid content starts after the sticky header column
    });
  }, [pixelsPerMeasure, zoomLevel]);

  // Redraw on zoom/unit change + theme toggle (layout phase, in lockstep with the grid
  // rescale + playhead so they move together). Scroll redraws are wired in
  // handleTimelineScroll; resize redraws ride the existing ResizeObserver below.
  useLayoutEffect(() => { drawTimelineGrid(); }, [drawTimelineGrid, isDarkMode, totalMeasures]);

  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      // Auto-pause when transport reaches the rendered right edge — compare
      // ticks-to-ticks so a mid-playback bpm change doesn't trip the ceiling.
      const maxTicks = totalMeasuresRef.current * 4 * Tone.Transport.PPQ;
      if (Tone.Transport.ticks >= maxTicks) {
        Tone.Transport.ticks = maxTicks;
        Tone.Transport.pause();
        silenceAll();
        setIsPlaying(false);
        updatePlayhead();
        return;
      }
      updatePlayhead();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, updatePlayhead, silenceAll]);

  const handlePlayPause = useCallback(async () => {
    await Tone.start();
    // No direct Transport.bpm write — recomputeFades → recomputeTempo (the
    // signal's single writer) re-anchors the bpm curve on the resume branch.
    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      silenceAll();
      setIsPlaying(false);
      updatePlayhead();
    } else {
      silenceAll(); // kill any stale voice ringing from a prior position before resuming
      recomputeFades();
      Tone.Transport.start();
      setIsPlaying(true);
    }
  }, [updatePlayhead, silenceAll, recomputeFades]);

  const handleStop = useCallback(() => {
    Tone.Transport.stop();
    silenceAll();
    recomputeFades();
    setIsPlaying(false);
    if (playheadRef.current)          playheadRef.current.style.transform          = 'translateX(0px)';
    if (pianoRollPlayheadRef.current) pianoRollPlayheadRef.current.style.transform = 'translateX(0px)';
    if (timeRef.current)              timeRef.current.textContent                  = '00:00:00';
  }, [silenceAll, recomputeFades]);

  // ── Moog recording ────────────────────────────────────────
  // Connects a Tone.Recorder to the Moog's moogBus tap node and captures audio.
  // Toggle: first click = start recording, second click = stop + download .webm.
  const handleMoogRecord = useCallback(async () => {
    if (moogRecordingRef.current) {
      // ── Stop ──
      clearInterval(moogTimerRef.current);
      moogTimerRef.current = null;
      const blob = await moogRecorderRef.current?.stop();
      try { moogBusNodeRef.current?.disconnect(moogRecorderRef.current); } catch (_) {}
      moogRecorderRef.current = null;
      moogBusNodeRef.current  = null;
      moogRecordingRef.current = false;
      setMoogRecording(false);
      setMoogRecordSec(0);
      if (blob) {
        // Require exactly one selected region to attach the recording to.
        const selIds = selectedRegionIdsRef.current;
        if (selIds.size !== 1) {
          setToastMessage('Select exactly one region before recording to place the audio in it.');
          return;
        }
        const regionId = [...selIds][0];
        const region   = regionsRef.current.find(r => r.id === regionId);
        if (!region) { setToastMessage('Selected region not found.'); return; }

        try {
          // Decode WebM blob → native AudioBuffer via the live AudioContext.
          const arrayBuffer = await blob.arrayBuffer();
          const nativeBuf   = await Tone.context.rawContext.decodeAudioData(arrayBuffer);

          // Dispose any existing player for this region (re-recording support).
          const existing = audioPlayersRef.current.get(regionId);
          if (existing) { try { existing.stop(); existing.dispose(); } catch (_) {} }

          // Create a Tone.Player synced to the transport, starting at the region's measure.
          // player.sync().start(offset) means: every time Transport plays, the audio starts
          // at this transport position — the same semantics as Tone.Part.start().
          const player = new Tone.Player(new Tone.ToneAudioBuffer(nativeBuf)).toDestination();
          player.sync().start(`${region.startMeasure}m`);

          audioBuffersByRegionId.current.set(regionId, nativeBuf);
          audioPlayersRef.current.set(regionId, player);

          // Mark region so the timeline shows the audio badge.
          setRegions(prev => prev.map(r => r.id === regionId ? { ...r, hasAudio: true } : r));

          // ── Transcription ──────────────────────────────────────────────────
          // Run YIN pitch detection on the decoded buffer, extract note events,
          // and replace any existing notes for this region with the transcription.
          // The existing piano roll (RegionEditor) and MIDI playback (useWorkstationAudio)
          // handle display and playback without any additional code.
          const transcribed = transcribeAudio(nativeBuf, Tone.Transport.bpm.value);
          // Mint ids eagerly, OUTSIDE the updater — StrictMode double-invokes
          // updaters, which double-mints (the eager-mint rule from splitRegion).
          const newNotes = transcribed.map(n => ({
            id:            `note_${nextNoteIdRef.current++}`,
            regionId,
            trackId:       region.trackId,
            note:          n.note,
            startBeat:     n.startBeat,
            durationBeats: n.durationBeats,
            velocity:      n.velocity,
          }));
          setNotes(prev => [...prev.filter(n => n.regionId !== regionId), ...newNotes]);

          const count = transcribed.length;
          setToastMessage(
            count > 0
              ? `Moog recording placed — ${count} note${count !== 1 ? 's' : ''} transcribed. Click [ edit ] to view in piano roll.`
              : 'Moog recording placed. No pitched notes detected — check signal level or try drier settings.'
          );
        } catch (err) {
          setToastMessage(`Could not decode Moog recording: ${err.message}`);
        }
      }
      return;
    }

    // ── Start ──
    const busNode = getMoogBusNode?.();
    if (!busNode) {
      setToastMessage('Open the Moog Modular page first to initialise the audio connection.');
      return;
    }
    try {
      await Tone.start();
      const recorder = new Tone.Recorder();
      busNode.connect(recorder);
      recorder.start();
      moogRecorderRef.current  = recorder;
      moogBusNodeRef.current   = busNode;
      moogRecordingRef.current = true;
      setMoogRecording(true);
      setMoogRecordSec(0);
      moogTimerRef.current = setInterval(() => setMoogRecordSec(s => s + 1), 1000);
    } catch (err) {
      setToastMessage(`Moog recording error: ${err.message}`);
    }
  }, [getMoogBusNode]);

  // Clean up recorder and audio players on unmount.
  useEffect(() => {
    return () => {
      clearInterval(moogTimerRef.current);
      if (moogRecorderRef.current) {
        moogRecorderRef.current.stop().catch(() => {});
        try { moogBusNodeRef.current?.disconnect(moogRecorderRef.current); } catch (_) {}
      }
      for (const [, player] of audioPlayersRef.current) {
        try { player.stop(); player.dispose(); } catch (_) {}
      }
      audioPlayersRef.current.clear();
    };
  }, []);

  // Dispose audio players whenever their region is deleted from the arrangement.
  useEffect(() => {
    for (const [regionId, player] of audioPlayersRef.current) {
      if (!regions.find(r => r.id === regionId)) {
        try { player.stop(); player.dispose(); } catch (_) {}
        audioPlayersRef.current.delete(regionId);
        audioBuffersByRegionId.current.delete(regionId);
      }
    }
  }, [regions]);

  // ── BPM editing ──────────────────────────────────────────
  function handleBpmCommit() {
    let n = parseInt(tempBpm, 10);
    if (isNaN(n)) n = bpm;
    n = Math.max(20, Math.min(300, n));

    // No direct Transport.bpm write: the hook's tempo-sync effect fires on the
    // setBpm commit and recomputeTempo (the signal's single writer) re-anchors
    // the whole curve. Tone's source of truth is ticks, so the bpm change
    // preserves musical position automatically — no playhead jump.
    setBpm(n);
    setTempBpm(String(n));
    setEditingBpm(false);
  }

  // ── Seek ─────────────────────────────────────────────────────
  const seekToClientX = useCallback((clientX) => {
    const scroller = timelineRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const x    = clientX - (rect.left + headerColW()) + scroller.scrollLeft;
    // Tick-domain seek: pixels are measure-based, so x → measures → ticks is
    // exact at ANY tempo (a seconds conversion would be wrong under the tempo
    // lane and needlessly bpm-coupled without it).
    if (snapEnabled) {
      const snapInc      = getSnapIncrement(pixelsPerMeasure);
      const rawMeasures  = x / pixelsPerMeasure;
      const snapMeasures = Math.max(0, Math.round(rawMeasures / snapInc) * snapInc);
      Tone.Transport.ticks = Math.round(snapMeasures * 4 * Tone.Transport.PPQ);
    } else {
      Tone.Transport.ticks = Math.round(Math.max(0, x / pixelsPerMeasure) * 4 * Tone.Transport.PPQ);
    }
    silenceAll(); // cut any voice still ringing from the pre-seek position (ghost note)
    recomputeFades();
    updatePlayhead();
  }, [updatePlayhead, snapEnabled, pixelsPerMeasure, recomputeFades, silenceAll]);

  const handleMouseDown = (e) => {
    // The sticky header column lives inside this scroller now — its controls
    // (rows, M/S, add-track, …) must not seek the playhead or arm a marquee.
    // Return before preventDefault so buttons keep native focus/dblclick.
    if (trackHeadersRef.current?.contains(e.target)) return;
    e.preventDefault();
    seekToClientX(e.clientX);
    const scroller = timelineRef.current;
    if (rulerRef.current?.contains(e.target)) {
      isDraggingRef.current = true;
      document.body.classList.add('is-dragging');
      currentMousePosRef.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
      // Clutch: silently pause the transport while scrubbing so the audio
      // engine isn't fighting the seek writes. UI Play button stays lit.
      if (Tone.Transport.state === 'started') {
        scrubClutchRef.current = true;
        Tone.Transport.pause();
        silenceAll();
      }
    } else if (scroller) {
      const rect     = scroller.getBoundingClientRect();
      const contentX = e.clientX - (rect.left + headerColW()) + scroller.scrollLeft;
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
      if (scrubClutchRef.current) {
        scrubClutchRef.current = false;
        recomputeFades();
        Tone.Transport.start();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [seekToClientX, stopAutoScroll]);

  // ── Ctrl+Scroll zoom-to-cursor ────────────────────────────────
  // Phase 120: listener is ALWAYS attached. Phase 118's conditional attach (only while
  //   a real Ctrl/Meta keydown was held) broke macOS trackpad pinch-zoom — the OS
  //   synthesizes a wheel event with ctrlKey:true but fires no keydown, so attach()
  //   never ran. Phase 119 disproved the diagonal-scroll motivation for the conditional
  //   attach, so reverting costs nothing and restores pinch-zoom on both surfaces.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Grid-relative cursor X: subtract the sticky header column (clamped to the
      // seam when the cursor is over the header — mirrors the piano roll's - 56).
      // clientWidth includes the header, so min-zoom/max-scroll correct for it too.
      const mouseX   = Math.max(0, e.clientX - el.getBoundingClientRect().left - headerColW());
      const prevZoom = liveZoomRef.current;
      const minZoom  = (el.clientWidth - headerColW()) / (PIXELS_PER_MEASURE * totalMeasuresRef.current);
      const nextZoom = Math.max(minZoom, Math.min(8, prevZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      if (nextZoom === prevZoom) return;
      Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
      // Anchor against the scroll target that WILL be applied (pendingScrollRef) while a
      // correction is in flight — NOT el.scrollLeft, which is stale whenever React hasn't
      // committed a prior zoom step yet (i.e. exactly when there's a lot to render). When
      // idle, pendingScrollRef is null and we use the real DOM scroll (captures manual
      // scrolls + edge clamping). This chains the anchor across batched wheel events with
      // no scroll-event reconciliation, so no feedback loop.
      const ratio      = nextZoom / prevZoom;
      const baseScroll = pendingScrollRef.current != null ? pendingScrollRef.current : el.scrollLeft;
      const absoluteX  = mouseX + baseScroll;
      const maxScroll  = Math.max(0, headerColW() + totalMeasuresRef.current * PIXELS_PER_MEASURE * nextZoom - el.clientWidth);
      const nextScroll = Math.min(maxScroll, Math.max(0, absoluteX * ratio - mouseX));
      liveZoomRef.current = nextZoom;
      pendingScrollRef.current = nextScroll;
      if (pianoScrollRef.current) pendingPianoScrollRef.current = nextScroll;
      setZoomLevel(nextZoom);
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
      const gridMouseX = Math.max(0, e.clientX - rect.left - 56); // subtract sticky keys column
      const prevZoom   = liveZoomRef.current;
      const minZoom    = timelineRef.current
        ? (timelineRef.current.clientWidth - headerColW()) / (PIXELS_PER_MEASURE * totalMeasuresRef.current)
        : 0.05;
      const nextZoom = Math.max(minZoom, Math.min(8, prevZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      if (nextZoom === prevZoom) return;
      Object.values(ghostRefs.current).forEach(g => { if (g) g.style.opacity = '0'; });
      // Same batching-independent anchor as the arrangement handler (scroll is mirrored, so
      // clamp to the timeline's max). Base = the in-flight piano scroll target, else the
      // real DOM scroll. Keeps the grid point under the cursor fixed.
      const ratio      = nextZoom / prevZoom;
      const baseScroll = pendingPianoScrollRef.current != null ? pendingPianoScrollRef.current : el.scrollLeft;
      const absoluteX  = gridMouseX + baseScroll;
      const tl         = timelineRef.current;
      const maxScroll  = tl ? Math.max(0, headerColW() + totalMeasuresRef.current * PIXELS_PER_MEASURE * nextZoom - tl.clientWidth) : Infinity;
      const nextScroll = Math.min(maxScroll, Math.max(0, absoluteX * ratio - gridMouseX));
      liveZoomRef.current = nextZoom;
      pendingPianoScrollRef.current = nextScroll;
      if (timelineRef.current) pendingScrollRef.current = nextScroll;
      setZoomLevel(nextZoom);
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
      drawTimelineGrid(); // viewport size changed → repaint grid lines
      const minZoom = Math.max(0, el.clientWidth - headerColW()) / (PIXELS_PER_MEASURE * totalMeasuresRef.current);
      liveZoomRef.current = Math.max(liveZoomRef.current, minZoom); // keep the zoom anchor ref in sync
      setZoomLevel(prev => Math.max(prev, minZoom));
    });
    observer.observe(el);
    // The header column is a sticky flex item inside `el`, so resizing it no
    // longer changes el.clientWidth — observe it directly so the left-column
    // resizer live-repaints the grid inset and re-clamps min-zoom.
    if (trackHeadersRef.current) observer.observe(trackHeadersRef.current);
    return () => observer.disconnect();
  }, [drawTimelineGrid]);

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

  // ── Scroll sync (horizontal only: timeline ↔ piano roll) ──────────────
  // Vertical sync is gone: the track-header column is a sticky flex item INSIDE
  // the timeline scroller (the piano roll's .keys pattern), so headers and lanes
  // share one native scroll surface — no mirroring, no ≤1-frame partner lag.
  // Phase 117 one-shot suppress flags remain for the surviving horizontal pair:
  //   a programmatic scroll on a partner sets the partner's flag; the partner's
  //   handler consumes the flag and returns (prevents the mirror-back race). The
  //   Phase 82 value-comparison guard stays as a secondary defense for no-op writes.
  const handleTimelineScroll = useCallback((e) => {
    drawTimelineGrid(); // repaint pinned grid lines for the new scrollLeft (before any suppress return)
    if (timelineSuppressRef.current) { timelineSuppressRef.current = false; return; }
    const sl = e.target.scrollLeft;
    if (pianoScrollRef.current && pianoScrollRef.current.scrollLeft !== sl) {
      pianoScrollSuppressRef.current = true;
      pianoScrollRef.current.scrollLeft = sl;
    }
  }, [drawTimelineGrid]);

  const handlePianoRollScroll = useCallback((e) => {
    lastPianoScrollTopRef.current = e.target.scrollTop;
    if (pianoScrollSuppressRef.current) { pianoScrollSuppressRef.current = false; return; }
    const sl = e.target.scrollLeft;
    if (timelineRef.current && timelineRef.current.scrollLeft !== sl) {
      timelineSuppressRef.current = true;
      timelineRef.current.scrollLeft = sl;
    }
  }, []);

  // ── Spacebar (strict hijack) ─────────────────────────────────
  // Capture-phase + blur-active-element so a previously-focused Mute/Solo/✎
  // button doesn't also fire its default activate-on-keyup. preventDefault
  // also blocks page scroll. Bypass for text inputs.
  //
  // Cross-page guard: Root.js keeps every visited page mounted under
  // display:none, so these window listeners stay attached while the user is
  // on the VoxTool/Moog pages — without the guard, Space there silently
  // toggles the hidden Workstation transport. offsetParent is null under a
  // display:none ancestor (shell is never position:fixed, so this is exact).
  useEffect(() => {
    const isTextField = (el) =>
      !el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      if (!shellRef.current || shellRef.current.offsetParent === null) return; // page hidden
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      const ae = document.activeElement;
      if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
      if (e.repeat) return;
      handlePlayPause();
    };
    const onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      if (!shellRef.current || shellRef.current.offsetParent === null) return; // page hidden
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey,   true);
    window.addEventListener('keyup',   onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey,   true);
      window.removeEventListener('keyup',   onKeyUp, true);
    };
  }, [handlePlayPause]);

  // ── Anchor-selection clear on any mousedown ─────────────────
  // Capture phase fires before every lane handler, so a click on a point
  // clears here first and the lane's own mouseup re-selects it — clicking
  // anywhere else simply leaves the selection cleared. Guarded so the setState
  // only fires while something is actually selected.
  useEffect(() => {
    const onDown = () => {
      if (selectedAnchorRef.current) setSelectedAnchor(null);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, []);

  // ── Delete / Backspace / Copy / Paste keyboard handlers ─────
  useEffect(() => {
    const onKey = (e) => {
      // Same cross-page guard as the spacebar hijack — a Cmd+Z / Delete on the
      // VoxTool/Moog pages must not silently mutate the hidden arrangement.
      if (!shellRef.current || shellRef.current.offsetParent === null) return;
      const el = document.activeElement;
      const inInput = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;

      const hasNoteSel = !!editingTrackIdRef.current && noteSelectionRef.current.size > 0;

      // Undo / Redo — Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y (redo).
      // Called via refs so this handler's effect deps don't need to track undo/redo.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        if (inInput) return;
        e.preventDefault();
        (e.shiftKey ? redoRef : undoRef).current?.();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        if (inInput) return;
        e.preventDefault();
        redoRef.current?.();
        return;
      }

      // Escape — clear automation-anchor selection (no other Escape behavior
      // lives at shell level; RegionEditor/ContextMenu own theirs locally).
      if (e.key === 'Escape') {
        if (selectedAnchorRef.current) setSelectedAnchor(null);
        return;
      }

      // Delete / Backspace — priority: notes > automation anchor > regions
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (inInput) return;
        if (hasNoteSel) {
          e.preventDefault();
          const ids = new Set(noteSelectionRef.current);
          setNotes(prev => prev.filter(n => !ids.has(n.id)));
          noteSelectionApiRef.current?.clear();
          return;
        }
        if (selectedAnchorRef.current) {
          const { trackId, automationId, pointIndex } = selectedAnchorRef.current;
          if (trackId === '__global__') {
            // Global (tempo) lane — keyed by kind, not id (see the lane's
            // onSelectPoint).
            const a = globalAutomationsRef.current.find(x => x.target?.kind === 'tempo');
            if (a && pointIndex < (a.points?.length ?? 0)) {
              e.preventDefault();
              commitTempoPoints(a.points.filter((_, k) => k !== pointIndex));
            }
            setSelectedAnchor(null);
            return;
          }
          // Channel = track or group (disjoint id namespaces; the commit
          // setter differs by which list resolves the id).
          const t = tracksRef.current.find(x => x.id === trackId);
          const grp = t ? null : groupsRef.current.find(x => x.id === trackId);
          const a = (t ?? grp)?.automations?.find(x => x.id === automationId);
          if (a && pointIndex < (a.points?.length ?? 0)) {
            e.preventDefault();
            const pts = a.points.filter((_, k) => k !== pointIndex);
            if (t) commitAutomationPoints(trackId, automationId, pts);
            else   commitGroupAutomationPoints(trackId, automationId, pts);
          }
          setSelectedAnchor(null);
          return;
        }
        const ids = selectedRegionIdsRef.current;
        if (!ids.size) return;
        e.preventDefault();
        setRegions(prev => prev.filter(r => !ids.has(r.id)));
        setNotes(prev => prev.filter(n => !ids.has(n.regionId)));
        setSelectedRegionIds(new Set());
        return;
      }

      // Cmd+A select-all is handled inside RegionEditor (when editor focused). Let it pass through.

      // Copy — Cmd/Ctrl + C
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        if (inInput) return;
        if (hasNoteSel) {
          const ids = new Set(noteSelectionRef.current);
          const selNotes = notesRef.current.filter(n => ids.has(n.id));
          if (!selNotes.length) return;
          const regionsMap = new Map(regionsRef.current.map(r => [r.id, r]));
          const globals = selNotes.map(n => {
            const r = regionsMap.get(n.regionId);
            const bottleOrigin = ((r?.startMeasure ?? 0) - (r?.clipOffset ?? 0)) * 4;
            return {
              note: n.note,
              durationBeats: n.durationBeats,
              globalBeat: bottleOrigin + n.startBeat,
            };
          });
          const anchor = Math.min(...globals.map(g => g.globalBeat));
          notesClipboardRef.current = globals.map(g => ({
            note: g.note,
            durationBeats: g.durationBeats,
            relBeat: g.globalBeat - anchor,
          }));
          clipboardKindRef.current = 'notes';
          return;
        }
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
        clipboardKindRef.current = 'regions';
        return;
      }

      // Cut — Cmd/Ctrl + X (copy + delete)
      if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
        if (inInput) return;
        if (hasNoteSel) {
          e.preventDefault();
          const ids = new Set(noteSelectionRef.current);
          const selNotes = notesRef.current.filter(n => ids.has(n.id));
          if (!selNotes.length) return;
          const regionsMap = new Map(regionsRef.current.map(r => [r.id, r]));
          const globals = selNotes.map(n => {
            const r = regionsMap.get(n.regionId);
            const bottleOrigin = ((r?.startMeasure ?? 0) - (r?.clipOffset ?? 0)) * 4;
            return {
              note: n.note,
              durationBeats: n.durationBeats,
              globalBeat: bottleOrigin + n.startBeat,
            };
          });
          const anchor = Math.min(...globals.map(g => g.globalBeat));
          notesClipboardRef.current = globals.map(g => ({
            note: g.note,
            durationBeats: g.durationBeats,
            relBeat: g.globalBeat - anchor,
          }));
          clipboardKindRef.current = 'notes';
          setNotes(prev => prev.filter(n => !ids.has(n.id)));
          noteSelectionApiRef.current?.clear();
          return;
        }
        const ids = [...selectedRegionIdsRef.current];
        if (!ids.length) return;
        e.preventDefault();
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
        clipboardKindRef.current = 'regions';
        const idSet = new Set(ids);
        setRegions(prev => prev.filter(r => !idSet.has(r.id)));
        setNotes(prev => prev.filter(n => !idSet.has(n.regionId)));
        setSelectedRegionIds(new Set());
        return;
      }

      // Paste — Cmd/Ctrl + V
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        if (inInput) return;

        // Notes paste path
        if (clipboardKindRef.current === 'notes' && notesClipboardRef.current?.length) {
          if (!editingTrackIdRef.current) return;
          e.preventDefault();
          const tid = editingTrackIdRef.current;
          // Ticks → beats: exact at any tempo (seconds/constant-bpm is not).
          const anchorBeat = Tone.Transport.ticks / Tone.Transport.PPQ;

          let nextRegions = regionsRef.current;
          let nextNotes   = notesRef.current;
          const newIds = [];
          const pasteEnds = [];

          for (const cn of notesClipboardRef.current) {
            const globalBeat = anchorBeat + cn.relBeat;
            if (globalBeat < 0) continue;
            const measure = Math.floor(globalBeat / 4);
            const existing = nextRegions.find(r =>
              r.trackId === tid &&
              globalBeat >= r.startMeasure * 4 &&
              globalBeat < (r.startMeasure + r.durationMeasures) * 4
            );
            if (existing) {
              if (existing.loopInterval != null) {
                const baseEndBeat = (existing.startMeasure + existing.loopInterval) * 4;
                if (globalBeat >= baseEndBeat) continue;
              }
              const bottleOriginBeat = (existing.startMeasure - (existing.clipOffset ?? 0)) * 4;
              const newId = `note_${nextNoteIdRef.current++}`;
              nextNotes = [...nextNotes, {
                id: newId, trackId: tid, note: cn.note,
                durationBeats: cn.durationBeats,
                startBeat: globalBeat - bottleOriginBeat,
                regionId: existing.id,
              }];
              newIds.push(newId);
              pasteEnds.push(globalBeat + cn.durationBeats);
            } else {
              const newRegionId = `region_${nextRegionIdRef.current++}`;
              const newRegion = { id: newRegionId, trackId: tid, startMeasure: measure, durationMeasures: 1, clipOffset: 0, fadeIn: 0, fadeOut: 0, fadeInFloor: 0, fadeOutFloor: 0, loopInterval: null };
              const result = applyDestructiveEdit(nextRegions, nextNotes, newRegion);
              const merged = [...result.regions, newRegion].filter(r => r.durationMeasures > 0);
              const surviving = new Set(merged.map(r => r.id));
              nextRegions = merged;
              nextNotes = result.notes.filter(n => surviving.has(n.regionId));
              const newId = `note_${nextNoteIdRef.current++}`;
              nextNotes = [...nextNotes, {
                id: newId, trackId: tid, note: cn.note,
                durationBeats: cn.durationBeats,
                startBeat: globalBeat - measure * 4,
                regionId: newRegionId,
              }];
              newIds.push(newId);
              pasteEnds.push(globalBeat + cn.durationBeats);
            }
          }

          if (newIds.length === 0) return;
          setRegions(nextRegions);
          setNotes(dedupePerfectOverlaps(nextNotes, newIds));
          noteSelectionApiRef.current?.setIds(newIds);
          if (Tone.Transport.state !== 'started') {
            const maxEnd = Math.max(...pasteEnds); // beats
            Tone.Transport.ticks = Math.round(maxEnd * Tone.Transport.PPQ);
            updatePlayhead();
          }
          return;
        }

        // Regions paste path
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
        if (rightEdge > totalMeasuresRef.current - 16) {
          setTotalMeasures(prev => Math.max(prev + 64, rightEdge + 16));
        }
        // Phase 104/105: advance global playhead to the right edge of the pasted payload —
        // but only when transport is not playing, so the live sweep isn't interrupted (Phase 105 guard).
        if (Tone.Transport.state !== 'started') {
          Tone.Transport.ticks = Math.round(rightEdge * 4 * Tone.Transport.PPQ);
          updatePlayhead();
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bpm, updatePlayhead, commitAutomationPoints, commitGroupAutomationPoints, commitTempoPoints]);

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
          <button className={styles.transportBtn} onClick={() => undoRef.current?.()} disabled={!canUndo} title="Undo (⌘Z)">↶</button>
          <button className={styles.transportBtn} onClick={() => redoRef.current?.()} disabled={!canRedo} title="Redo (⌘⇧Z)">↷</button>
          <button className={`${styles.transportBtn} ${styles.transportTextBtn}`} onClick={handleSaveProject} title="Save project to this browser (appears on the homepage)">[ save ]</button>
          <button className={`${styles.transportBtn} ${styles.transportTextBtn}`} onClick={() => loadInputRef.current?.click()} title="Load project from .voxdaw">[ load ]</button>
          <div className={styles.exportWrap}>
            <button
              className={`${isBouncing ? styles.transportBtnActive : styles.transportBtn} ${styles.transportTextBtn}`}
              onClick={() => setShowExportMenu(v => !v)}
              disabled={isBouncing}
              title="Export audio bounce">
              {isBouncing ? '[ bouncing… ]' : '[ export ]'}
            </button>
            {showExportMenu && !isBouncing && (
              <div className={styles.exportMenu}>
                <button className={styles.exportMenuItem} onClick={() => handleExportAudio('mp3')}>mp3</button>
                <button className={styles.exportMenuItem} onClick={() => handleExportAudio('wav')}>wav</button>
                <button className={styles.exportMenuItem} onClick={handleExportProjectFile}>.voxdaw</button>
              </div>
            )}
          </div>
          <input
            ref={loadInputRef}
            type="file"
            accept=".voxdaw,.json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleLoadProject(f); }}
          />
          <button
            className={snapEnabled ? styles.transportBtnActive : styles.transportBtn}
            onClick={() => setSnapEnabled(v => !v)}
            title="Snap to grid (magnet)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 style={{ display: 'block' }} aria-hidden="true">
              <path d="M4 4 v7 a8 8 0 0 0 16 0 V4" />
              <path d="M9 4 v7 a3 3 0 0 0 6 0 V4" />
              <line x1="4" y1="4" x2="9" y2="4" />
              <line x1="15" y1="4" x2="20" y2="4" />
            </svg>
          </button>
          <button
            className={advancedMode ? styles.transportBtnActive : styles.transportBtn}
            onClick={() => setAdvancedMode(v => !v)}
            title="Advanced mode (fade floor handles)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 style={{ display: 'block' }} aria-hidden="true">
              <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z" />
            </svg>
          </button>
        </div>
        <div className={styles.transportRight}>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>QUALITY</span>
            <select
              className={styles.qualitySelect}
              value={performanceQuality}
              onChange={(e) => handleQualityChange(e.target.value)}
              title="Sound quality — low disables processing-heavy effects to reduce CPU load"
            >
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </div>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>NAME</span>
            {editingName ? (
              <input
                autoFocus
                type="text"
                className={styles.nameInput}
                value={tempName}
                onChange={(e) => setTempName(e.target.value)}
                onBlur={handleNameCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNameCommit();
                  if (e.key === 'Escape') { setTempName(projectName); setEditingName(false); }
                }}
              />
            ) : (
              <span
                className={styles.metaValue}
                style={{ cursor: 'text' }}
                title="Rename project"
                onClick={() => { setTempName(projectName); setEditingName(true); }}
              >
                {projectName}
              </span>
            )}
          </div>
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
            {tempoAutomated && (
              <span ref={bpmLiveRef} className={styles.bpmLive} title="live tempo (automated)">∿{bpm}</span>
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

        {/* Left-column resizer handle */}
        <div data-no-note-deselect className={styles.colResizer} onMouseDown={startLeftColDrag} />

        {/* Single scroll surface: sticky-left track headers + grid share one scroller
            (the piano roll's .keys pattern) — headers and lanes can never desync. */}
        <div
          ref={timelineRef}
          className={styles.timeline}
          onMouseDown={handleMouseDown}
          onScroll={handleTimelineScroll}
        >
          {/* Grid lines: canvas pinned to the scroll viewport (zero-size sticky holder),
              redrawn per-line-snapped on scroll/zoom/resize/theme. Behind the lanes. */}
          <div className={styles.gridCanvasHolder}><canvas ref={timelineCanvasRef} /></div>

          {/* Track header column — sticky-left inside the scroller */}
          <div ref={trackHeadersRef} className={styles.trackHeaders}>
          <div className={styles.tracksHeader}>tracks</div>
          {/* Global automation strip + tempo lane header — heights MUST mirror
              the timeline side's rows (laneTops' topOffset assumes it). */}
          <div className={styles.globalStripRow}>
            <button
              className={styles.globalChevron}
              onClick={() => setGlobalLaneOpen(v => !v)}
              title={globalLaneOpen ? 'collapse global automation' : 'expand global automation'}
            >
              {globalLaneOpen ? '▾' : '▸'}
            </button>
            <span className={styles.globalStripLabel}>global</span>
            {tempoAutomated && !globalLaneOpen && <span className={styles.globalStripHint}>∿ tempo</span>}
          </div>
          {globalLaneOpen && (
            <div className={styles.autoHeaderRow} style={{ '--track-color': 'var(--accent-color)' }}>
              <select className={styles.globalTargetSelect} value="tempo" onChange={() => {}}>
                <option value="tempo">tempo</option>
              </select>
              <span className={styles.globalStripHint}>{TEMPO_META.min}–{TEMPO_META.max} bpm</span>
            </div>
          )}
          {tracks.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>no tracks</p>
              <p className={styles.emptyHint}>add a track to begin</p>
              <button className={styles.addTrackPrimary} onClick={handleAddTrack}>[ + add track ]</button>
            </div>
          ) : (
            <>
              {tracks.map((t, ti) => {
                const group = t.groupId ? groupById.get(t.groupId) : null;
                const isFirstMember = !!group && (ti === 0 || tracks[ti - 1].groupId !== t.groupId);
                const isCollapsed = !!group && collapsedGroupIds.has(group.id);
                return (
                <Fragment key={t.id}>
                {/* Group header row — rendered before the run's first member;
                    height (GROUP_H) MUST mirror the timeline's .groupLane. */}
                {isFirstMember && (
                  <div className={styles.groupRow}
                    style={{ '--group-color': group.color }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, targetType: 'group', targetId: group.id });
                    }}>
                    <button
                      className={styles.groupChevron}
                      onClick={() => toggleGroupCollapsed(group.id)}
                      title={isCollapsed ? 'Expand group' : 'Collapse group'}>
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <span className={styles.trackColorDot} style={{ background: group.color }} />
                    {renamingGroupId === group.id ? (
                      <input
                        className={styles.trackNameInput}
                        defaultValue={group.name}
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.target.blur();
                          else if (e.key === 'Escape') { e.target.value = group.name; e.target.blur(); }
                        }}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (name && name !== group.name) {
                            setGroups(prev => prev.map(g => g.id === group.id ? { ...g, name } : g));
                          }
                          setRenamingGroupId(null);
                        }}
                      />
                    ) : (
                      <span className={styles.groupName} onDoubleClick={() => setRenamingGroupId(group.id)}>
                        {group.name}
                      </span>
                    )}
                    <div className={styles.groupControls}>
                      <button
                        className={openAutomationTrackIds.has(group.id) ? styles.trackBtnActive : styles.trackBtn}
                        onClick={(e) => { e.stopPropagation(); toggleAutomationArea(group.id); }}
                        title={openAutomationTrackIds.has(group.id) ? 'Hide group automation' : 'Show group automation'}>
                        <svg viewBox="0 0 16 12" width="14" height="10" fill="none"
                             stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                             strokeLinejoin="round" style={{ display: 'block', margin: '0 auto' }}
                             aria-hidden="true">
                          <path d="M1 6 h3.2 l1.8-4.2 l4 8.4 l1.8-4.2 h3.2" />
                        </svg>
                      </button>
                      <button
                        className={editingGroupId === group.id ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => { setEditingGroupId(prev => prev === group.id ? null : group.id); setEditingTrackId(null); }}
                        title="Group effects rack">fx</button>
                      <PanKnob
                        value={group.pan ?? 0}
                        onChange={(v) => handleGroupPanChange(group.id, v)}
                        size={18}
                        disabled={isPanAutomated(group)}
                      />
                      <input
                        type="range"
                        min={0} max={100} step={1}
                        value={group.volume ?? 75}
                        onChange={(e) => handleGroupVolumeChange(group.id, parseInt(e.target.value, 10))}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        className={`${styles.volumeSlider} ${styles.groupVolumeSlider}`}
                        disabled={isVolumeAutomated(group)}
                        title={`group volume ${group.volume ?? 75}`}
                      />
                      <button
                        className={group.isMuted ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleGroupMute(group.id)} title="Mute group">M</button>
                      <button
                        className={group.isSolo ? styles.trackBtnActive : styles.trackBtn}
                        onClick={() => toggleGroupSolo(group.id)} title="Solo group">S</button>
                    </div>
                  </div>
                )}
                {/* Group automation header sub-rows — heights MUST mirror the
                    timeline's group .autoLane / .autoAddStrip (laneTops assumes it). */}
                {isFirstMember && openAutomationTrackIds.has(group.id) && (
                  <>
                    {(group.automations ?? []).map(a => (
                      <div key={a.id} className={styles.autoHeaderRow} style={{ '--track-color': group.color }}>
                        <span className={styles.autoHeaderLabel}>{labelForTarget(group, a.target)}</span>
                        <button
                          className={styles.autoHeaderDelete}
                          title="Delete automation"
                          onClick={() => removeGroupAutomation(group.id, a.id)}>×</button>
                      </div>
                    ))}
                    <div className={styles.autoAddRow} style={{ '--track-color': group.color }}>
                      <select
                        className={styles.autoAddSelect}
                        value=""
                        aria-label="Add group automation"
                        onChange={(e) => {
                          const opt = automationTargetsFor(group).find(x => x.key === e.target.value);
                          if (opt) addGroupAutomation(group.id, opt.target);
                          e.target.value = '';
                        }}>
                        <option value="" disabled>+ automation</option>
                        {(() => {
                          const existing = new Set((group.automations ?? []).map(a => targetKey(a.target)));
                          return automationTargetsFor(group)
                            .filter(o => !existing.has(o.key))
                            .map(o => <option key={o.key} value={o.key}>{o.label}</option>);
                        })()}
                      </select>
                    </div>
                  </>
                )}
                {!isCollapsed && (<>
                <div className={`${styles.trackRow}${group ? ` ${styles.trackRowGrouped}` : ''}${editingTrackId === t.id ? ` ${styles.trackRowActive}` : activeTrackId === t.id ? ` ${styles.trackRowFocused}` : ''}`}
                  style={{ '--track-color': t.color, ...(group ? { '--group-color': group.color } : {}) }}
                  onClick={() => { setActiveTrackId(t.id); pasteAnchorTrackIndexRef.current = tracksRef.current.findIndex(x => x.id === t.id); }}
                  onDoubleClick={() => setEditingTrackId(prev => prev === t.id ? null : t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveTrackId(t.id);
                    setContextMenu({ x: e.clientX, y: e.clientY, targetType: 'track', targetId: t.id });
                  }}>
                  <div className={styles.trackTopRow}>
                    <div className={styles.trackNameBlock}>
                      <div className={styles.trackNameRow}>
                        <span className={styles.trackColorDot} style={{ background: t.color }} />
                        {renamingTrackId === t.id ? (
                          <input
                            className={styles.trackNameInput}
                            defaultValue={t.name}
                            autoFocus
                            onFocus={(e) => e.target.select()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.target.blur();
                              else if (e.key === 'Escape') { e.target.value = t.name; e.target.blur(); }
                            }}
                            onBlur={(e) => {
                              const name = e.target.value.trim();
                              if (name && name !== t.name) {
                                setTracks(prev => prev.map(x => x.id === t.id ? { ...x, name } : x));
                              }
                              setRenamingTrackId(null);
                            }}
                          />
                        ) : (
                          <span className={styles.trackName}>{t.name}</span>
                        )}
                      </div>
                      <button className={styles.trackInstrument} title={loadingTrackIds.has(t.id) ? 'Loading samples…' : 'Change instrument'}>{t.instrument}{loadingTrackIds.has(t.id) ? ' …' : ''}</button>
                    </div>
                    <div className={styles.trackToggles}>
                      <button
                        className={openAutomationTrackIds.has(t.id) ? styles.trackBtnActive : styles.trackBtn}
                        onClick={(e) => { e.stopPropagation(); toggleAutomationArea(t.id); }}
                        title={openAutomationTrackIds.has(t.id) ? 'Hide automation' : 'Show automation'}>
                        {/* heartbeat pulse — inline SVG (no icon-library deps) */}
                        <svg viewBox="0 0 16 12" width="14" height="10" fill="none"
                             stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                             strokeLinejoin="round" style={{ display: 'block', margin: '0 auto' }}
                             aria-hidden="true">
                          <path d="M1 6 h3.2 l1.8-4.2 l4 8.4 l1.8-4.2 h3.2" />
                        </svg>
                      </button>
                      <PanKnob
                        value={t.pan ?? 0}
                        onChange={(v) => handlePanChange(t.id, v)}
                        size={20}
                        disabled={isPanAutomated(t)}
                      />
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
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={t.volume ?? 75}
                    onChange={(e) => handleVolumeChange(t.id, parseInt(e.target.value, 10))}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className={styles.volumeSlider}
                    disabled={isVolumeAutomated(t)}
                    style={isVolumeAutomated(t) ? { opacity: 0.35 } : undefined}
                    title={isVolumeAutomated(t)
                      ? 'volume is automated — delete the automation lane to regain manual control'
                      : `volume ${t.volume ?? 75}`}
                  />
                </div>
                {/* Automation header sub-rows — heights MUST mirror the timeline's
                    .autoLane / .autoAddStrip exactly (laneTops assumes it). */}
                {openAutomationTrackIds.has(t.id) && (
                  <>
                    {(t.automations ?? []).map(a => (
                      <div key={a.id} className={styles.autoHeaderRow} style={{ '--track-color': t.color }}>
                        <span className={styles.autoHeaderLabel}>{labelForTarget(t, a.target)}</span>
                        <button
                          className={styles.autoHeaderDelete}
                          title="Delete automation"
                          onClick={() => removeAutomation(t.id, a.id)}>×</button>
                      </div>
                    ))}
                    <div className={styles.autoAddRow} style={{ '--track-color': t.color }}>
                      <select
                        className={styles.autoAddSelect}
                        value=""
                        aria-label="Add automation"
                        onChange={(e) => {
                          const opt = automationTargetsFor(t).find(x => x.key === e.target.value);
                          if (opt) addAutomation(t.id, opt.target);
                          e.target.value = '';
                        }}>
                        <option value="" disabled>+ automation</option>
                        {(() => {
                          const existing = new Set((t.automations ?? []).map(a => targetKey(a.target)));
                          return automationTargetsFor(t)
                            .filter(o => !existing.has(o.key))
                            .map(o => <option key={o.key} value={o.key}>{o.label}</option>);
                        })()}
                      </select>
                    </div>
                  </>
                )}
                </>)}
                </Fragment>
                );
              })}
              <button className={styles.addTrackGhost} onClick={handleAddTrack}>[ + add track ]</button>
            </>
          )}
          </div>

          <div
            className={styles.timelineInner}
            style={{
              width: `${totalMeasures * pixelsPerMeasure}px`,
            }}
          >
            {/* Ruler */}
            <div ref={rulerRef} data-no-note-deselect className={styles.ruler}>
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

            {/* Global automation strip + tempo lane — heights mirror the header
                column's globalStripRow/autoHeaderRow (laneTops assumes it).
                The strip is inert: no seek/marquee from inside it. */}
            <div className={styles.globalStrip} onMouseDown={(e) => e.stopPropagation()} />
            {globalLaneOpen && (
              <div className={styles.autoLane} style={{ '--track-color': 'var(--accent-color)' }}>
                <AutomationLane
                  automation={tempoAutomation}
                  meta={TEMPO_META}
                  baselineValue01={toKnob(Math.max(TEMPO_META.min, Math.min(TEMPO_META.max, bpm)), TEMPO_META)}
                  pixelsPerMeasure={pixelsPerMeasure}
                  totalMeasures={totalMeasures}
                  snapIncrement={getSnapIncrement(pixelsPerMeasure)}
                  snapEnabledRef={snapEnabledRef}
                  onCommitPoints={commitTempoPoints}
                  onLivePreview={previewTempo}
                  selectedPointIndex={
                    // Keyed by the constant 'tempo' (not the automation id —
                    // the id is minted on first commit AFTER selection fires).
                    selectedAnchor?.trackId === '__global__' && selectedAnchor?.automationId === 'tempo'
                      ? selectedAnchor.pointIndex : null
                  }
                  onSelectPoint={(i) => setSelectedAnchor(
                    i == null ? null : { trackId: '__global__', automationId: 'tempo', pointIndex: i }
                  )}
                />
              </div>
            )}

            {/* Track lanes */}
            {tracks.map((t, ti) => {
              const autoOpen = openAutomationTrackIds.has(t.id);
              const group = t.groupId ? groupById.get(t.groupId) : null;
              const isFirstMember = !!group && (ti === 0 || tracks[ti - 1].groupId !== t.groupId);
              const isCollapsed = !!group && collapsedGroupIds.has(group.id);
              return (
                <Fragment key={t.id}>
                {/* Group lane row — inert strip (no seek/marquee), height GROUP_H
                    mirrors the header column's .groupRow. */}
                {isFirstMember && (
                  <div className={styles.groupLane}
                    style={{ '--group-color': group.color }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, targetType: 'group', targetId: group.id });
                    }}
                  />
                )}
                {/* Group automation sub-lanes — mirror the header column's rows. */}
                {isFirstMember && openAutomationTrackIds.has(group.id) && (
                  <>
                    {(group.automations ?? []).map(a => {
                      const meta = metaForTarget(group, a.target);
                      if (!meta) return null; // orphan guard (deserialize also drops these)
                      const baseline = a.target.kind === 'volume'
                        ? (group.volume ?? 75) / 100
                        : a.target.kind === 'pan'
                          ? ((group.pan ?? 0) + 1) / 2
                          : toKnob(
                              (group.effects ?? []).find(fx => fx.id === a.target.effectId)?.params?.[a.target.param] ?? meta.default,
                              meta);
                      return (
                        <div key={a.id} className={styles.autoLane} style={{ '--track-color': group.color }}>
                          <AutomationLane
                            automation={a}
                            meta={meta}
                            baselineValue01={baseline}
                            pixelsPerMeasure={pixelsPerMeasure}
                            totalMeasures={totalMeasures}
                            snapIncrement={getSnapIncrement(pixelsPerMeasure)}
                            snapEnabledRef={snapEnabledRef}
                            onCommitPoints={(pts) => commitGroupAutomationPoints(group.id, a.id, pts)}
                            onLivePreview={(v01) => applyAutomationValue?.(group.id, a.target, v01)}
                            selectedPointIndex={
                              selectedAnchor?.trackId === group.id && selectedAnchor?.automationId === a.id
                                ? selectedAnchor.pointIndex : null
                            }
                            onSelectPoint={(i) => setSelectedAnchor(
                              i == null ? null : { trackId: group.id, automationId: a.id, pointIndex: i }
                            )}
                          />
                        </div>
                      );
                    })}
                    <div className={styles.autoAddStrip} />
                  </>
                )}
                {!isCollapsed && (<>
                <div className={styles.trackLane}
                  style={{ '--track-color': t.color }}
                  onMouseMove={(e) => handleLaneMouseMove(e, t.id)}
                  onMouseLeave={() => handleLaneMouseLeave(t.id)}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (dragRef.current) return;
                    const scroller = timelineRef.current;
                    if (!scroller) return;
                    const rect     = scroller.getBoundingClientRect();
                    const contentX = e.clientX - (rect.left + headerColW()) + scroller.scrollLeft;
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
                      const newRegion = { id: `r${n}`, trackId: t.id, startMeasure: measure, durationMeasures: 1, clipOffset: 0, fadeIn: 0, fadeOut: 0, fadeInFloor: 0, fadeOutFloor: 0, loopInterval: null };
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
                    <div key={r.id} data-region-id={r.id}
                      {...((r.loopInterval ?? null) !== null ? { 'data-looped': true } : {})}
                      className={`${styles.region}${selectedRegionIds.has(r.id) ? ` ${styles.regionSelected}` : ''}${(r.isMuted || t.isMuted) ? ` ${styles.regionMuted}` : ''}`}
                      style={{
                        left:  `${r.startMeasure    * pixelsPerMeasure}px`,
                        width: `${r.durationMeasures * pixelsPerMeasure}px`,
                        ...(r.hasAudio ? { borderTop: '2px solid #5DCAA5' } : {}),
                      }}
                      onMouseDownCapture={(e) => { capturedRegionStartRef.current = { x: e.clientX, y: e.clientY }; }}
                      onMouseDown={(e) => startRegionDrag(e, r, 'move')}
                      onClick={(e) => e.stopPropagation()}
                      onContextMenu={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (!selectedRegionIds.has(r.id)) setSelectedRegionIds(new Set([r.id]));
                        setContextMenu({ x: e.clientX, y: e.clientY, targetType: 'region', targetId: r.id });
                      }}
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingTrackId(r.trackId); }}>
                      {r.hasAudio && (
                        <div style={{
                          position: 'absolute', top: 3, left: 6,
                          fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
                          color: '#5DCAA5',
                          textShadow: '0 0 6px rgba(93,202,165,0.55)',
                          pointerEvents: 'none', userSelect: 'none', zIndex: 2,
                        }}>
                          ♪ MOOG
                        </div>
                      )}
                      {(r.loopInterval ?? null) !== null && (() => {
                        const total = r.durationMeasures;
                        // Phase-aware cycle boundaries; edges[] = each segment's left edge.
                        const edges = [0, ...loopBoundaries(r.loopPhase ?? 0, r.loopInterval, total)];
                        const segs = [];
                        for (let i = 0; i < edges.length; i++) {
                          const segStart = edges[i];
                          // Phase 112: anchor the last segment to the region's right edge so any
                          // one-frame lag between region width and segment commit can't show through.
                          const isLast = i === edges.length - 1;
                          segs.push(
                            <div key={`seg-${i}`} data-loop-segment data-loop-segment-i={i}
                              className={styles.loopSegment}
                              style={isLast
                                ? { left: `${segStart * pixelsPerMeasure}px`, right: 0 }
                                : { left: `${segStart * pixelsPerMeasure}px`, width: `${Math.max(0, (edges[i + 1] - segStart) * pixelsPerMeasure)}px` }
                              } />
                          );
                        }
                        return segs;
                      })()}
                      {(r.loopInterval ?? null) !== null && (() => {
                        const bounds = loopBoundaries(r.loopPhase ?? 0, r.loopInterval, r.durationMeasures);
                        if (!bounds.length) return null; // no repeat yet → no tint
                        return <div data-loop-tint className={styles.loopTint}
                          style={{ left: `${bounds[0] * pixelsPerMeasure}px` }} />;
                      })()}
                      {(() => {
                        const regionNotes = notes.filter(n => n.regionId === r.id);
                        if (regionNotes.length === 0) return null;
                        const clipOffset = r.clipOffset ?? 0;
                        const baseLoop   = r.loopInterval ?? r.durationMeasures;
                        const windowStartBeat = clipOffset * 4;
                        const windowEndBeat   = (clipOffset + baseLoop) * 4;
                        const inWindow = regionNotes.filter(n =>
                          n.startBeat >= windowStartBeat && n.startBeat < windowEndBeat
                        );
                        if (inWindow.length === 0) return null;
                        const idxList = inWindow.map(n => KEYS.findIndex(k => k.name === n.note)).filter(i => i >= 0);
                        if (idxList.length === 0) return null;
                        const minIdx  = Math.min(...idxList);
                        const maxIdx  = Math.max(...idxList);
                        const idxSpan = Math.max(1, maxIdx - minIdx);
                        const phase      = r.loopInterval != null ? (r.loopPhase ?? 0) : 0;
                        const ppb        = pixelsPerMeasure / 4;
                        const regionWidthPx = r.durationMeasures * pixelsPerMeasure;
                        const out = [];
                        if (baseLoop > 0) {
                          for (const n of inWindow) {
                            const keyIndex = KEYS.findIndex(k => k.name === n.note);
                            if (keyIndex < 0) continue;
                            const yRel = (keyIndex - minIdx) / idxSpan;
                            // Phase-aware occurrences: firstOffset + j*baseLoop measures.
                            const homeLocalMeasures = n.startBeat / 4 - clipOffset;
                            const firstOff = firstLoopOffsetMeasures(homeLocalMeasures, phase, baseLoop);
                            for (let j = 0; ; j++) {
                              const xPx = (firstOff + j * baseLoop) * pixelsPerMeasure;
                              if (xPx >= regionWidthPx) break;
                              out.push(
                                <div key={`mn-${j}-${n.id}`}
                                  data-mini-note
                                  data-mini-note-iter={j}
                                  data-mini-note-startbeat={n.startBeat}
                                  className={`${styles.miniNote}${j > 0 ? ` ${styles.miniNoteGhost}` : ''}`}
                                  style={{
                                    left: `${Math.round(xPx)}px`,
                                    top:  `${4 + yRel * 70}%`,
                                    width: `${Math.max(n.durationBeats * ppb - 1, 2)}px`,
                                  }} />
                              );
                            }
                          }
                        }
                        return out;
                      })()}
                      {(r.loopInterval ?? null) !== null && r.loopInterval > 0 && (() => {
                        const phase  = r.loopPhase ?? 0;
                        const bounds = loopBoundaries(phase, r.loopInterval, r.durationMeasures);
                        return bounds.map((bx, idx) => {
                          // The draggable base-loop handle only makes sense on un-phased
                          // loops (phase 0). Phased split-halves omit it.
                          const isFirst = idx === 0 && phase === 0;
                          return (
                            <div key={`loop-${idx}`}
                              {...(isFirst ? { 'data-loop-divider-first': true } : {})}
                              className={`${styles.loopDivider}${isFirst ? ` ${styles.loopDividerBase}` : ''}`}
                              style={{ left: `${bx * pixelsPerMeasure}px` }}
                              onMouseDown={isFirst ? (e) => startRegionDrag(e, r, 'loop-resize-base') : undefined}
                            />
                          );
                        });
                      })()}
                      {r.durationMeasures * pixelsPerMeasure >= FADE_UI_MIN_PX && (
                        <>
                          <div data-fade-in
                            className={`${styles.fadeOverlay} ${styles.fadeInOverlay}`}
                            style={{
                              width: `${(r.fadeIn ?? 0) * pixelsPerMeasure}px`,
                              display: (r.fadeIn ?? 0) > 0 ? '' : 'none',
                              clipPath: `polygon(0 0, 100% 0, 0 ${100 - (r.fadeInFloor ?? 0) * 100}%)`,
                            }} />
                          <div data-fade-out
                            className={`${styles.fadeOverlay} ${styles.fadeOutOverlay}`}
                            style={{
                              width: `${(r.fadeOut ?? 0) * pixelsPerMeasure}px`,
                              display: (r.fadeOut ?? 0) > 0 ? '' : 'none',
                              clipPath: `polygon(0 0, 100% 0, 100% ${100 - (r.fadeOutFloor ?? 0) * 100}%)`,
                            }} />
                        </>
                      )}
                      <div className={styles.resizeLeft}  onMouseDown={(e) => startRegionDrag(e, r, 'resize-left')} />
                      <div className={styles.resizeRight} onMouseDown={(e) => startRegionDrag(e, r, 'resize-right')} />
                      {r.durationMeasures * pixelsPerMeasure >= FADE_UI_MIN_PX && (
                        <button data-loop-handle
                          className={`${styles.cornerBtn} ${styles.loopHandle}`}
                          onMouseDown={(e) => startRegionDrag(e, r, 'loop-right')}
                          onClick={(e) => e.stopPropagation()}
                          title="Loop region (click to add one, drag to extend)">
                          <svg viewBox="0 0 14 14" width="10" height="10" fill="none"
                               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                               style={{ display: 'block' }} aria-hidden="true">
                            <path d="M3 5 a4 4 0 0 1 8 0 v2" />
                            <path d="M11 9 a4 4 0 0 1 -8 0 v-2" />
                            <path d="M9 5 l2 0 l0 -2" />
                            <path d="M5 9 l-2 0 l0 2" />
                          </svg>
                        </button>
                      )}
                      {r.durationMeasures * pixelsPerMeasure >= FADE_UI_MIN_PX && (
                        <>
                          <div data-fade-handle-left
                            className={`${styles.fadeHandle} ${styles.fadeHandleLeft}`}
                            style={{ left: `${(r.fadeIn ?? 0) * pixelsPerMeasure}px` }}
                            onMouseDown={(e) => startRegionDrag(e, r, 'fade-left')} />
                          <div data-fade-handle-right
                            className={`${styles.fadeHandle} ${styles.fadeHandleRight}`}
                            style={{ right: `${(r.fadeOut ?? 0) * pixelsPerMeasure}px` }}
                            onMouseDown={(e) => startRegionDrag(e, r, 'fade-right')} />
                          {advancedMode && (
                            <>
                              <div data-fade-floor-left
                                className={`${styles.fadeFloorHandle} ${styles.fadeFloorHandleLeft}`}
                                style={{ bottom: `${(r.fadeInFloor ?? 0) * 100}%` }}
                                onMouseDown={(e) => startRegionDrag(e, r, 'fade-left-floor')} />
                              <div data-fade-floor-right
                                className={`${styles.fadeFloorHandle} ${styles.fadeFloorHandleRight}`}
                                style={{ bottom: `${(r.fadeOutFloor ?? 0) * 100}%` }}
                                onMouseDown={(e) => startRegionDrag(e, r, 'fade-right-floor')} />
                            </>
                          )}
                        </>
                      )}
                      {r.durationMeasures * pixelsPerMeasure >= EDIT_BTN_MIN_PX && (
                        <button
                          className={`${styles.cornerBtn} ${styles.editBtn}${advancedMode ? ` ${styles.editBtnShifted}` : ''}`}
                          onMouseDown={stopMouseDown}
                          onClick={(e) => { e.stopPropagation(); setEditingTrackId(r.trackId); }}>
                          edit
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {/* Automation sub-lanes — row heights mirror the header column's
                    .autoHeaderRow / .autoAddRow (laneTops assumes it). */}
                {autoOpen && (t.automations ?? []).map(a => {
                  const meta = metaForTarget(t, a.target);
                  if (!meta) return null; // orphan guard (deserialize also drops these)
                  const baseline = a.target.kind === 'volume'
                    ? (t.volume ?? 75) / 100
                    : a.target.kind === 'pan'
                      ? ((t.pan ?? 0) + 1) / 2
                      : toKnob(
                          (t.effects ?? []).find(fx => fx.id === a.target.effectId)?.params?.[a.target.param] ?? meta.default,
                          meta);
                  return (
                    <div key={a.id} className={styles.autoLane} style={{ '--track-color': t.color }}>
                      <AutomationLane
                        automation={a}
                        meta={meta}
                        baselineValue01={baseline}
                        pixelsPerMeasure={pixelsPerMeasure}
                        totalMeasures={totalMeasures}
                        snapIncrement={getSnapIncrement(pixelsPerMeasure)}
                        snapEnabledRef={snapEnabledRef}
                        onCommitPoints={(pts) => commitAutomationPoints(t.id, a.id, pts)}
                        onLivePreview={(v01) => applyAutomationValue?.(t.id, a.target, v01)}
                        selectedPointIndex={
                          selectedAnchor?.trackId === t.id && selectedAnchor?.automationId === a.id
                            ? selectedAnchor.pointIndex : null
                        }
                        onSelectPoint={(i) => setSelectedAnchor(
                          i == null ? null : { trackId: t.id, automationId: a.id, pointIndex: i }
                        )}
                      />
                    </div>
                  );
                })}
                {autoOpen && <div className={styles.autoAddStrip} />}
                </>)}
                </Fragment>
              );
            })}

            <div ref={playheadRef} className={styles.playhead} />
            <div ref={marqueeElRef} className={styles.marquee} />
          </div>
        </div>
      </div>
      {toastMessage && <div className={styles.toast}>{toastMessage}</div>}

      {/* ── Group effects rack (bottom dock, editor's slot) ── */}
      {editingGroupId && !editingTrackId && groupById.get(editingGroupId) && (
        <>
          <div data-no-note-deselect className={styles.divider} onMouseDown={startDividerDrag} title="Drag to resize" />
          <div ref={editorWrapRef} className={styles.editorWrap} style={{ height: editorHeight }}>
            <GroupFxPanel
              group={groupById.get(editingGroupId)}
              performanceQuality={performanceQuality}
              onClose={() => setEditingGroupId(null)}
              onAdd={addGroupEffect}
              onRemove={removeGroupEffect}
              onToggleBypass={toggleBypassGroupEffect}
              onUpdate={updateGroupEffectSettings}
            />
          </div>
        </>
      )}

      {/* ── Piano roll editor ────────────────────────────── */}
      {editingTrackId && (
        <>
          <div data-no-note-deselect className={styles.divider} onMouseDown={startDividerDrag} title="Drag to resize" />
          <div ref={editorWrapRef} className={styles.editorWrap} style={{ height: editorHeight }}>
            <RegionEditor
              track={editingTrack}
              notes={editingTrackNotes}
              regions={regions.filter(r => r.trackId === editingTrackId)}
              onNoteAdd={handleNoteAdd}
              onNoteRemove={handleNoteRemove}
              onCommitNoteEdits={handleCommitNoteEdits}
              onNotesDelete={handleNotesDelete}
              onNoteContextMenu={(x, y, id) => setContextMenu({ x, y, targetType: 'note', targetId: id })}
              onNoteSelectionChange={(ids) => { noteSelectionRef.current = ids; }}
              exposeSelectionSetter={(api) => { noteSelectionApiRef.current = api; }}
              magnetOn={snapEnabled}
              zoomLevel={zoomLevel}
              pixelsPerMeasure={pixelsPerMeasure}
              totalMeasures={totalMeasures}
              pianoRollPlayheadRef={pianoRollPlayheadRef}
              pianoScrollRef={pianoScrollRef}
              onGridScroll={handlePianoRollScroll}
              onLeftColResize={startLeftColDrag}
              onClose={() => setEditingTrackId(null)}
              scrollMemoryRef={lastPianoScrollTopRef}
              onInstrumentChange={handleInstrumentChange}
              onVolumeChange={handleVolumeChange}
              onEnvelopeChange={handleEnvelopeChange}
              onEffectAdd={addEffect}
              onEffectRemove={removeEffect}
              onEffectToggleBypass={toggleBypassEffect}
              onEffectUpdate={updateEffectSettings}
              automatedFxKeys={editingTrack ? automatedFxKeys(editingTrack) : undefined}
              isDarkMode={isDarkMode}
              performanceQuality={performanceQuality}
              loadingTrackIds={loadingTrackIds}
              auditionAttack={auditionAttack}
              auditionRelease={auditionRelease}
              auditionReleaseAll={auditionReleaseAll}
              auditionPrime={auditionPrime}
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
        <button
          className={moogRecording ? styles.transportBtnActive : styles.transportBtn}
          onClick={handleMoogRecord}
          title={moogRecording ? 'Stop Moog recording and download' : 'Record from Moog Modular'}
          style={moogRecording ? { color: '#e04848' } : undefined}
        >
          {moogRecording ? `■ ${moogRecordSec}s` : '● MOOG'}
        </button>
      </div>
      <ContextMenu menu={contextMenu} onClose={closeContextMenu} onCommand={handleContextCommand} tracks={tracks} />
      {groupModal && (
        <GroupModal
          tracks={tracks}
          groups={groups}
          initiatorTrackId={groupModal.initiatorTrackId}
          onCancel={() => setGroupModal(null)}
          onCreate={createGroup}
        />
      )}
    </div>
  );
}
