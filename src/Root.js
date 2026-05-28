import { useState } from 'react';
import HomePage from './components/HomePage/HomePage';
import App from './App';
import Workstation from './components/Workstation/Workstation';
import MoogModular from './components/MoogModular/MoogShell';

export default function Root() {
  const [page, setPage] = useState('home');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const onThemeToggle = () => setIsDarkMode(v => !v);

  let pageEl;
  if (page === 'voxtool') {
    pageEl = <App onNavigateHome={() => setPage('home')} isDarkMode={isDarkMode} onThemeToggle={onThemeToggle} />;
  } else if (page === 'workstation') {
    pageEl = <Workstation onNavigateHome={() => setPage('home')} isDarkMode={isDarkMode} onThemeToggle={onThemeToggle} />;
  } else if (page === 'moogmodular') {
    pageEl = <MoogModular onNavigateHome={() => setPage('home')} />;
  } else {
    pageEl = <HomePage onNavigate={setPage} />;
  }

  return (
    <div data-theme={isDarkMode ? undefined : 'light'} style={{ width: '100vw', height: '100vh' }}>
      {pageEl}
    </div>
  );
}
