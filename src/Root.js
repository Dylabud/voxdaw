import { useState, useRef, useCallback } from 'react';
import HomePage from './components/HomePage/HomePage';
import App from './App';
import WorkstationShell from './components/Workstation/WorkstationShell';
import MoogModular from './components/MoogModular/MoogShell';
import AIInstrumentGenerator from './components/AIGen/AIInstrumentGenerator';

export default function Root() {
  // A page may request to be re-landed after a full reload (the Moog's
  // reset/load-setup uses window.location.reload() to rebuild from its store —
  // this returns the user to the Moog instead of the default home page).
  const [page,       setPage]       = useState(() => {
    try {
      const ret = sessionStorage.getItem('voxdaw-return-page');
      if (ret) { sessionStorage.removeItem('voxdaw-return-page'); return ret; }
    } catch (_) {}
    return 'home';
  });
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Pages mount on first visit and stay alive for audio continuity.
  // Inactive pages are hidden via display:none so their audio engines keep running.
  const [visited, setVisited] = useState(() => new Set(['home', page]));
  const visitedRef = useRef(visited); visitedRef.current = visited;

  // The Moog registers a small control surface here ({ getBusNode,
  // resetSequencers, isPowered }); the Workstation reads from it. The
  // recording-active ref flows the other way — the Workstation flips it true
  // while recording so the Moog's KeyboardModule lets QWERTY through (Phase 66).
  const moogApiRef = useRef(null);
  const moogRecordingActiveRef = useRef(false);

  // Open-a-project request for the Workstation. The shell stays mounted across
  // navigations, so a mount-time prop can't deliver later opens — instead each
  // request carries a fresh monotonic requestId and the shell applies it in an
  // effect. data = deserializeProject output, or null for a blank New Project.
  const [pendingProject, setPendingProject] = useState(null);
  const projectRequestIdRef = useRef(0);

  const navigate = useCallback((nextPage) => {
    setPage(nextPage);
    setVisited(prev => {
      if (prev.has(nextPage)) return prev;
      const next = new Set(prev);
      next.add(nextPage);
      return next;
    });
  }, []);

  const openProject = useCallback(({ projectId, data }) => {
    // A live workstation session gets replaced — confirm before clobbering it.
    if (visitedRef.current.has('workstation') &&
        !window.confirm('Replace the current workstation session? Unsaved changes will be lost.')) {
      return;
    }
    projectRequestIdRef.current += 1;
    setPendingProject({ requestId: projectRequestIdRef.current, projectId: projectId ?? null, data: data ?? null });
    navigate('workstation');
  }, [navigate]);

  const onThemeToggle = useCallback(() => setIsDarkMode(v => !v), []);

  // Stable handlers handed to the Workstation — call through to whatever the Moog
  // registered. useCallback [] means their references never change across renders.
  const getMoogBusNode      = useCallback(() => moogApiRef.current?.getBusNode?.() ?? null, []);
  const resetMoogSequencers = useCallback(() => moogApiRef.current?.resetSequencers?.(), []);
  const isMoogPowered       = useCallback(() => moogApiRef.current?.isPowered?.() ?? false, []);
  const setMoogRecordingActive = useCallback((v) => { moogRecordingActiveRef.current = !!v; }, []);

  // Returns display:none style for any page that isn't active; undefined (no style) otherwise.
  const hide = (p) => page !== p ? { display: 'none' } : undefined;

  return (
    <div
      data-theme={isDarkMode ? undefined : 'light'}
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', position: 'relative' }}
    >
      {/* Home — always mounted, no audio engine, cheap to keep alive */}
      <div style={hide('home')}>
        <HomePage
          onNavigate={navigate}
          onOpenProject={openProject}
          isDarkMode={isDarkMode}
          onThemeToggle={onThemeToggle}
          active={page === 'home'}
        />
      </div>

      {/* VoxTool — mounted on first visit, kept alive so its audio engine persists */}
      {visited.has('voxtool') && (
        <div style={hide('voxtool')}>
          <App
            onNavigateHome={() => navigate('home')}
            isDarkMode={isDarkMode}
            onThemeToggle={onThemeToggle}
          />
        </div>
      )}

      {/* Workstation — mounted on first visit; receives Moog bus getter for recording */}
      {visited.has('workstation') && (
        <div style={hide('workstation')}>
          <WorkstationShell
            onNavigateHome={() => navigate('home')}
            isDarkMode={isDarkMode}
            onThemeToggle={onThemeToggle}
            getMoogBusNode={getMoogBusNode}
            resetMoogSequencers={resetMoogSequencers}
            isMoogPowered={isMoogPowered}
            setMoogRecordingActive={setMoogRecordingActive}
            pendingProject={pendingProject}
          />
        </div>
      )}

      {/* Moog Modular — mounted on first visit; registers its audio bus on mount */}
      {visited.has('moogmodular') && (
        <div style={hide('moogmodular')}>
          <MoogModular
            onNavigateHome={() => navigate('home')}
            onBusReady={(api) => { moogApiRef.current = api; }}
            recordingActiveRef={moogRecordingActiveRef}
          />
        </div>
      )}

      {/* AI Instrument Generator — mounted on first visit, kept alive like the rest */}
      {visited.has('aigen') && (
        <div style={hide('aigen')}>
          <AIInstrumentGenerator
            onNavigateHome={() => navigate('home')}
            isDarkMode={isDarkMode}
            onThemeToggle={onThemeToggle}
          />
        </div>
      )}
    </div>
  );
}
