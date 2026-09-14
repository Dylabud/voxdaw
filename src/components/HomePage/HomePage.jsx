import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './HomePage.module.css';
import ProjectCard from './ProjectCard';
import { listProjects, getProject, saveProject, deleteProject, renameProject, listPreviewMetas, getPreviewWav, copyPreview } from '../../utils/projectStore';
import { deserializeProject, downloadJSON, readJSONFile, hashProjectData } from '../Workstation/projectIO';
import { THEME_ORDER, THEME_GLYPHS, THEME_LABELS, nextTheme } from '../../utils/theme';

export default function HomePage({ onNavigate, onOpenProject, theme, onThemeToggle, onThemeSelect, active }) {
  const [projects,     setProjects]     = useState([]);
  const [previewMetas, setPreviewMetas] = useState(new Map()); // projectId → preview meta record
  const [playingId,    setPlayingId]    = useState(null);      // project whose preview is playing
  const [storageError, setStorageError] = useState(false);
  const [toast,        setToast]        = useState(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const importInputRef = useRef(null);
  const toastTimerRef  = useRef(null);
  const themeMenuRef   = useRef(null);

  // Close the theme gear menu on any outside mousedown (the kebab pattern).
  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDown = (e) => {
      if (!themeMenuRef.current?.contains(e.target)) setThemeMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [themeMenuOpen]);
  const audioRef       = useRef(null);  // lazy shared HTMLAudioElement — one preview at a time
  const urlRef         = useRef(null);  // current Blob URL, revoked on stop/switch

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
    // Preview metas are cosmetic — a preview-store failure must not kill the list.
    try {
      const metas = await listPreviewMetas();
      setPreviewMetas(new Map(metas.map(m => [m.projectId, m])));
    } catch (e) {
      console.error('preview store unavailable', e);
    }
  }, []);

  // HomePage stays mounted (display:none) across navigation — `active` from
  // Root is the "user came back home" signal, so the grid re-lists on return.
  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setPlayingId(null);
  }, []);

  const handlePreviewToggle = useCallback(async (id) => {
    if (playingId === id) { stopPreview(); return; }
    stopPreview(); // starting one preview stops any other
    try {
      const wav = await getPreviewWav(id);
      if (!wav) { showToast('preview unavailable'); return; }
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      urlRef.current = url;
      if (!audioRef.current) audioRef.current = new Audio();
      const a = audioRef.current;
      a.src = url;
      a.onended = stopPreview;
      await a.play();
      setPlayingId(id);
    } catch (e) {
      console.error('preview playback failed', e);
      stopPreview();
      showToast('preview playback failed');
    }
  }, [playingId, stopPreview, showToast]);

  // Stop playback when navigating away (page stays mounted) and on unmount.
  useEffect(() => { if (!active) stopPreview(); }, [active, stopPreview]);
  useEffect(() => () => stopPreview(), [stopPreview]);

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
      const newId = crypto.randomUUID();
      await saveProject({
        id: newId,
        name,
        bpm: record.bpm,
        trackCount: record.trackCount,
        // The copy's data differs only by name, which the hash excludes — so
        // the source hash still matches and the copied preview is fresh.
        dataHash: record.dataHash,
        data: { ...record.data, name },
      });
      await copyPreview(id, newId).catch(e => console.error('preview copy failed', e));
      await refresh();
    } catch (e) {
      console.error('duplicate failed', e);
      showToast(`duplicate failed: ${e.message}`);
    }
  }, [refresh, showToast]);

  const handleDelete = useCallback(async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      if (playingId === id) stopPreview(); // its IDB rows die inside deleteProject
      await deleteProject(id);
      await refresh();
    } catch (e) {
      console.error('delete failed', e);
      showToast(`delete failed: ${e.message}`);
    }
  }, [refresh, showToast, playingId, stopPreview]);

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
        // Stamped so an export after this save reads fresh. A legacy file the
        // load path repairs may re-serialize differently → stale until the
        // first in-app save; self-healing, accepted.
        dataHash: hashProjectData({ ...raw, name }),
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
          <button className={styles.aiBtn}      onClick={() => onNavigate('aigen')}>[ Instrument Generator ]</button>
          <button
            className={styles.themeBtn}
            onClick={onThemeToggle}
            title={`Switch to ${THEME_LABELS[nextTheme(theme)]} mode`}
          >
            {THEME_GLYPHS[theme]}
          </button>
          <div className={styles.gearWrap} ref={themeMenuRef}>
            <button
              className={styles.themeBtn}
              title="Theme settings"
              onClick={() => setThemeMenuOpen(o => !o)}
            >
              ⚙
            </button>
            {themeMenuOpen && (
              <div className={styles.kebabMenu}>
                {THEME_ORDER.map((t) => (
                  <button
                    key={t}
                    className={`${styles.kebabItem} ${t === theme ? styles.menuItemActive : ''}`}
                    onClick={() => { onThemeSelect(t); setThemeMenuOpen(false); }}
                  >
                    {THEME_GLYPHS[t]} {THEME_LABELS[t]}{t === theme ? ' ·' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
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

        <div className={styles.list}>
          <button
            className={styles.newRow}
            onClick={() => onOpenProject?.({ projectId: null, data: null })}
          >
            <span className={styles.newPlus}>+</span>
            <span className={styles.newLabel}>New Project</span>
          </button>

          {projects.map(p => {
            const meta = previewMetas.get(p.id);
            return (
              <ProjectCard
                key={p.id}
                project={p}
                previewMeta={meta}
                fresh={!!meta && !!p.dataHash && meta.dataHash === p.dataHash}
                playing={playingId === p.id}
                onPreviewToggle={handlePreviewToggle}
                onOpen={handleOpen}
                onRename={handleRename}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onDownload={handleDownload}
              />
            );
          })}
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
