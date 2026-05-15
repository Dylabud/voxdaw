import { useState } from 'react';
import styles from './Workstation.module.css';
import WorkstationShell from './WorkstationShell';

export default function Workstation({ onNavigateHome, isDarkMode, onThemeToggle }) {
  const [view, setView] = useState('warning');

  if (view === 'shell') {
    return <WorkstationShell onNavigateHome={onNavigateHome} isDarkMode={isDarkMode} onThemeToggle={onThemeToggle} />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.center}>
        <p className={styles.label}>WORKSTATION</p>
        <p className={styles.sub}>under construction</p>
        <div className={styles.btnRow}>
          <button className={styles.backBtn} onClick={onNavigateHome}>
            [ ← back ]
          </button>
          <button className={styles.continueBtn} onClick={() => setView('shell')}>
            [ continue → ]
          </button>
        </div>
      </div>
    </div>
  );
}
