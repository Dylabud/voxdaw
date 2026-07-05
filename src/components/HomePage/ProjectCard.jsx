import { useState, useEffect, useRef } from 'react';
import styles from './HomePage.module.css';

// Short human date for the card meta line: time for today, date otherwise.
function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export default function ProjectCard({ project, onOpen, onRename, onDuplicate, onDelete, onDownload }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [tempName, setTempName] = useState(project.name);
  const menuRef = useRef(null);

  // Close the kebab menu on any outside mousedown.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [menuOpen]);

  const commitRename = () => {
    setRenaming(false);
    const next = tempName.trim();
    if (next && next !== project.name) onRename(project.id, next);
    else setTempName(project.name);
  };

  return (
    <div
      className={styles.card}
      onClick={() => { if (!renaming && !menuOpen) onOpen(project.id); }}
    >
      <div className={styles.cardTop}>
        {renaming ? (
          <input
            autoFocus
            className={styles.cardNameInput}
            value={tempName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setTempName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setTempName(project.name); setRenaming(false); }
            }}
          />
        ) : (
          <span className={styles.cardName} title={project.name}>{project.name}</span>
        )}

        <div className={styles.kebabWrap} ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button
            className={styles.kebabBtn}
            title="Project actions"
            onClick={() => setMenuOpen(v => !v)}
          >
            ⋮
          </button>
          {menuOpen && (
            <div className={styles.kebabMenu}>
              <button className={styles.kebabItem} onClick={() => { setMenuOpen(false); setTempName(project.name); setRenaming(true); }}>rename</button>
              <button className={styles.kebabItem} onClick={() => { setMenuOpen(false); onDuplicate(project.id); }}>duplicate</button>
              <button className={styles.kebabItem} onClick={() => { setMenuOpen(false); onDownload(project.id); }}>download</button>
              <button className={`${styles.kebabItem} ${styles.kebabDanger}`} onClick={() => { setMenuOpen(false); onDelete(project.id, project.name); }}>delete</button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.cardMeta}>
        <span>{project.trackCount ?? 0} track{(project.trackCount ?? 0) !== 1 ? 's' : ''} · {project.bpm ?? 120} bpm</span>
        <span className={styles.cardWhen}>{formatWhen(project.updatedAt)}</span>
      </div>
    </div>
  );
}
