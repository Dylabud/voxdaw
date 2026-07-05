import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './HomePage.module.css';
import ProjectCard from './ProjectCard';
import { listProjects, getProject, saveProject, deleteProject, renameProject } from '../../utils/projectStore';
import { deserializeProject, downloadJSON, readJSONFile } from '../Workstation/projectIO';

export default function HomePage({ onNavigate, onOpenProject, isDarkMode, onThemeToggle, active }) {
  const [projects,     setProjects]     = useState([]);
  const [storageError, setStorageError] = useState(false);
  const [toast,        setToast]        = useState(null);
  const importInputRef = useRef(null);
  const toastTimerRef  = useRef(null);

  const showToast = useCallback((msg, ms = 3000) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setStorageError(false);
    } catch (e) {
      console.error('project store unavailable', e);
      setStorageError(true);
    }
  }, []);

  // HomePage stays mounted (display:none) across navigation — `active` from
  // Root is the "user came back home" signal, so the grid re-lists on return.
  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  const handleOpen = useCallback(async (id) => {
    try {
      const record = await getProject(id);
      if (!record) throw new Error('project not found');
      const data = deserializeProject(record.data);
      onOpenProject?.({ projectId: id, data });
    } catch (e) {
      console.error('open project failed', e);
      showToast(`open failed: ${e.message}`);
    }
  }, [onOpenProject, showToast]);

  const handleRename = useCallback(async (id, name) => {
    try {
      await renameProject(id, name);
      await refresh();
    } catch (e) {
      console.error('rename failed', e);
      showToast(`rename failed: ${e.message}`);
    }
  }, [refresh, showToast]);

  const handleDuplicate = useCallback(async (id) => {
    try {
      const record = await getProject(id);
      if (!record) throw new Error('project not found');
      const name = `${record.name} copy`;
      await saveProject({
        id: crypto.randomUUID(),
        name,
        bpm: record.bpm,
        trackCount: record.trackCount,
        data: { ...record.data, name },
      });
      await refresh();
    } catch (e) {
      console.error('duplicate failed', e);
      showToast(`duplicate failed: ${e.message}`);
    }
  }, [refresh, showToast]);

  const handleDelete = useCallback(async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await deleteProject(id);
      await refresh();
    } catch (e) {
      console.error('delete failed', e);
      showToast(`delete failed: ${e.message}`);
    }
  }, [refresh, showToast]);

  const handleDownload = useCallback(async (id) => {
    try {
      const record = await getProject(id);
      if (!record) throw new Error('project not found');
      const filename = `${(record.name || 'project').replace(/[/\\:*?"<>|]/g, '').trim() || 'project'}.voxdaw`;
      downloadJSON(record.data, filename);
    } catch (e) {
      console.error('download failed', e);
      showToast(`download failed: ${e.message}`);
    }
  }, [showToast]);

  // Import validates first (deserializeProject throws on bad files), stores the
  // record so it appears on the grid, then opens it in the Workstation.
  const handleImport = useCallback(async (file) => {
    if (!file) return;
    try {
      const raw = await readJSONFile(file);
      const data = deserializeProject(raw);
      const fallbackName = file.name.replace(/\.(voxdaw|json)$/i, '') || 'untitled';
      const name = data.name !== 'untitled' ? data.name : fallbackName;
      const id = crypto.randomUUID();
      await saveProject({
        id, name,
        bpm: data.bpm,
        trackCount: data.tracks.length,
        data: { ...raw, name },
      });
      await refresh();
      onOpenProject?.({ projectId: id, data: { ...data, name } });
    } catch (e) {
      console.error('import failed', e);
      showToast(`import failed: ${e.message}`);
    }
  }, [refresh, onOpenProject, showToast]);

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.wordmark}>
            <span className={styles.dots}>··</span> VoxDAW
          </span>
          <span className={styles.tagline}>gestural synthesis studio</span>
        </div>
        <nav className={styles.headerNav}>
          <button className={styles.primaryBtn} onClick={() => onNavigate('voxtool')}>[ VoxTool ]</button>
          <button className={styles.ghostBtn}   onClick={() => onNavigate('workstation')}>[ Workstation ]</button>
          <button className={styles.moogBtn}    onClick={() => onNavigate('moogmodular')}>[ Moog Modular ]</button>
          <button
            className={styles.themeBtn}
            onClick={onThemeToggle}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? '◑' : '○'}
          </button>
        </nav>
      </header>

      {/* ── Projects ── */}
      <main className={styles.main}>
        <div className={styles.sectionRow}>
          <span className={styles.sectionLabel}>Projects</span>
          <button className={styles.importBtn} onClick={() => importInputRef.current?.click()}>
            [ import .voxdaw ]
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".voxdaw,.json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleImport(f); }}
          />
        </div>

        {storageError && (
          <p className={styles.storageNote}>
            browser storage unavailable — saved projects can't be listed here.
            you can still import a .voxdaw file to open it.
          </p>
        )}

        <div className={styles.grid}>
          <button
            className={styles.newCard}
            onClick={() => onOpenProject?.({ projectId: null, data: null })}
          >
            <span className={styles.newPlus}>+</span>
            <span className={styles.newLabel}>New Project</span>
          </button>

          {projects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={handleOpen}
              onRename={handleRename}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onDownload={handleDownload}
            />
          ))}
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className={styles.footer}>
        <span className={styles.footerLabel}>ALPHA BUILD</span>
        <span className={styles.footerBody}>
          all video processing happens locally on your machine — no video or personal data
          is ever recorded, saved, or sent to any server. projects are stored in this browser.
        </span>
      </footer>

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
