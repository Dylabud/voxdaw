import { useState, useRef, useCallback } from 'react';
import HomePage from './components/HomePage/HomePage';
import App from './App';
import Workstation from './components/Workstation/Workstation';
import MoogModular from './components/MoogModular/MoogShell';

export default function Root() {
  const [page,       setPage]       = useState('home');
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Pages mount on first visit and stay alive for audio continuity.
  // Inactive pages are hidden via display:none so their audio engines keep running.
  const [visited, setVisited] = useState(() => new Set(['home']));

  // The Moog registers a bus-node getter here; the Workstation reads from it.
  const moogBusGetterRef = useRef(null);

  const navigate = useCallback((nextPage) => {
    setPage(nextPage);
    setVisited(prev => {
      if (prev.has(nextPage)) return prev;
      const next = new Set(prev);
      next.add(nextPage);
      return next;
    });
  }, []);

  const onThemeToggle = useCallback(() => setIsDarkMode(v => !v), []);

  // Stable getter handed to Workstation — calls through to whatever the Moog registered.
  // useCallback with [] means this function reference never changes across Root renders.
  const getMoogBusNode = useCallback(() => moogBusGetterRef.current?.() ?? null, []);

  // Returns display:none style for any page that isn't active; undefined (no style) otherwise.
  const hide = (p) => page !== p ? { display: 'none' } : undefined;

  return (
    <div
      data-theme={isDarkMode ? undefined : 'light'}
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', position: 'relative' }}
    >
      {/* Home — always mounted, no audio engine, cheap to keep alive */}
      <div style={hide('home')}>
        <HomePage onNavigate={navigate} />
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
          <Workstation
            onNavigateHome={() => navigate('home')}
            isDarkMode={isDarkMode}
            onThemeToggle={onThemeToggle}
            getMoogBusNode={getMoogBusNode}
          />
        </div>
      )}

      {/* Moog Modular — mounted on first visit; registers its audio bus on mount */}
      {visited.has('moogmodular') && (
        <div style={hide('moogmodular')}>
          <MoogModular
            onNavigateHome={() => navigate('home')}
            onBusReady={(getter) => { moogBusGetterRef.current = getter; }}
          />
        </div>
      )}
    </div>
  );
}
