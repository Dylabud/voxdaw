import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './ContextMenu.module.css';
import { TRACK_COLORS } from '../trackColors';

// Approximate dimensions used to clamp the menu inside the viewport before the
// real element is measured. The post-mount effect refines with actual size.
const MENU_W = 168;
const MENU_H = 300;
const SUBMENU_W = 96;

// Semitone options for the Pitch submenu: curated musical intervals, descending
// (octave, P5, P4, M3, m3, M2, m2 up and down). Drops tritone/6ths/7ths to keep
// the menu short.
const PITCH_STEPS = [12, 7, 5, 4, 3, 2, 1, -1, -2, -3, -4, -5, -7, -12];

// Command sets per target type. Item kinds:
//   { action, label }         — plain command
//   'divider'                 — separator
//   { submenu: <kind>, … }    — row with a nested submenu:
//     'pitch'     → semitone list         → onCommand('pitch', …, semis)
//     'color'     → TRACK_COLORS swatches → onCommand('color', …, hex)
//     'pasteFx'   → other-track list      → onCommand('pasteEffects', …, targetTrackId)
//     'exportFmt' → WAV / MP3             → onCommand('export', …, 'wav'|'mp3')
const ITEMS = {
  region: [
    { action: 'copy',  label: 'Copy' },
    { action: 'paste', label: 'Paste' },
    { action: 'split', label: 'Split Region' },
    { action: 'mute',  label: 'Mute Region' },
    'divider',
    { submenu: 'pitch', label: 'Pitch' },
    'divider',
    { action: 'delete', label: 'Delete' },
  ],
  note: [
    { action: 'copy',  label: 'Copy' },
    { action: 'paste', label: 'Paste' },
    'divider',
    { submenu: 'pitch', label: 'Pitch' },
    'divider',
    { action: 'delete', label: 'Delete' },
  ],
  track: [
    { action: 'rename', label: 'Rename' },
    { submenu: 'color', label: 'Color' },
    { submenu: 'pitch', label: 'Pitch Shift' },
    'divider',
    { action: 'duplicate', label: 'Duplicate Track' },
    { submenu: 'pasteFx', label: 'Paste Effects To' },
    { submenu: 'exportFmt', label: 'Export' },
    'divider',
    { action: 'delete', label: 'Delete Track' },
  ],
};

/**
 * Custom right-click context menu for Workstation regions, notes and tracks.
 * Fixed-position floating panel positioned at the click coordinates.
 *
 * @param {{x:number,y:number,targetType:'region'|'note'|'track',targetId:string}|null} menu
 * @param {() => void} onClose
 * @param {(action:string, targetType:string, targetId:string, payload?:number|string) => void} onCommand
 * @param {Array<{id:string,name:string,color:string}>} [tracks] — for the track menu's Paste-Effects-To submenu
 */
export default function ContextMenu({ menu, onClose, onCommand, tracks = [] }) {
  const menuRef = useRef(null);
  const submenuRef = useRef(null);
  // Which submenu row is open: null | 'pitch' | 'color' | 'pasteFx' |
  // 'exportFmt'. A single kind (not a boolean) because the track menu has
  // several submenu rows.
  const [submenuOpen, setSubmenuOpen] = useState(null);
  const closeTimerRef = useRef(null);       // submenu open/close delay
  const menuCloseTimerRef = useRef(null);   // whole-menu mouse-leave auto-close

  // Open/close lifecycle: any interaction outside a menu item dismisses it.
  useEffect(() => {
    if (!menu) return;
    setSubmenuOpen(null);
    const close = () => onClose();
    const onDocMouseDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };

    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('contextmenu', onDocMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('contextmenu', onDocMouseDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu, onClose]);

  // Refine clamping with the real measured size once mounted.
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth  - width  - 4);
    const top  = Math.min(menu.y, window.innerHeight - height - 4);
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top  = `${Math.max(4, top)}px`;
  }, [menu]);

  // Clamp the submenu into the viewport once it opens. Its resting position is
  // CSS top:50% + translateY(-50%) — centered on the PITCH row so the zero-line
  // separator sits across from the cursor. Centering means it can overflow the
  // top OR bottom edge near either end of the screen, and the inner
  // max-height/overflow scrollbar can't pull the container back into view. So
  // measure, compute a bidirectional shift, and re-apply it relative to the
  // centered position via calc(50% + …) — keeping the translateY(-50%) transform
  // intact (a raw px `top` would fight it). max-height:60vh guarantees it fits,
  // so at most one edge overflows.
  useLayoutEffect(() => {
    const el = submenuRef.current;
    if (!submenuOpen || !el) return;
    el.style.top = '';                 // back to CSS top:50% + translateY(-50%)
    const rect = el.getBoundingClientRect();
    const pad = 4;
    let shift = 0;
    if (rect.bottom > window.innerHeight - pad) shift = (window.innerHeight - pad) - rect.bottom;
    else if (rect.top < pad)                    shift = pad - rect.top;
    if (shift !== 0) el.style.top = `calc(50% + ${Math.round(shift)}px)`;
  }, [submenuOpen, menu]);

  useEffect(() => () => {
    clearTimeout(closeTimerRef.current);
    clearTimeout(menuCloseTimerRef.current);
  }, []);

  if (!menu) return null;

  const left = Math.min(menu.x, window.innerWidth  - MENU_W - 4);
  const top  = Math.min(menu.y, window.innerHeight - MENU_H - 4);
  const items = ITEMS[menu.targetType] ?? [];
  // Flip the submenu to the left when there isn't room on the right.
  const flipLeft = menu.x + MENU_W + SUBMENU_W > window.innerWidth;

  const openSub  = (kind) => { clearTimeout(closeTimerRef.current); setSubmenuOpen(kind); };
  const closeSub = () => { closeTimerRef.current = setTimeout(() => setSubmenuOpen(null), 360); };

  // Auto-close the whole menu shortly after the cursor leaves it. onMouseLeave is
  // subtree-aware, so moving into the (descendant) Pitch submenu doesn't fire it;
  // the 300ms debounce covers the 2px gap between the menu and the offset submenu.
  const onMenuEnter = () => clearTimeout(menuCloseTimerRef.current);
  const onMenuLeave = () => { menuCloseTimerRef.current = setTimeout(() => onClose(), 300); };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={onMenuEnter}
      onMouseLeave={onMenuLeave}
    >
      {items.map((it, i) => {
        if (it === 'divider') return <div key={`d${i}`} className={styles.divider} />;

        if (it.submenu) {
          const kind = it.submenu;
          const otherTracks = kind === 'pasteFx' ? tracks.filter(t => t.id !== menu.targetId) : null;
          return (
            <div
              key={kind}
              className={styles.subWrap}
              onMouseEnter={() => openSub(kind)}
              onMouseLeave={closeSub}
            >
              <button
                type="button"
                className={`${styles.item} ${styles.subItem}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => openSub(kind)}
              >
                <span>{it.label}</span>
                <span className={styles.chevron}>▸</span>
              </button>
              {submenuOpen === kind && (
                <div ref={submenuRef} className={`${styles.submenu} ${flipLeft ? styles.submenuLeft : ''}`}>
                  {kind === 'pitch' && PITCH_STEPS.map(n => (
                    <React.Fragment key={n}>
                      <button
                        type="button"
                        className={styles.item}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => { onCommand('pitch', menu.targetType, menu.targetId, n); onClose(); }}
                      >
                        {n > 0 ? `+${n}` : n}
                      </button>
                      {n === 1 && <div className={styles.divider} />}
                    </React.Fragment>
                  ))}
                  {kind === 'color' && (
                    <div className={styles.swatchGrid}>
                      {TRACK_COLORS.map(hex => (
                        <button
                          key={hex}
                          type="button"
                          className={styles.swatch}
                          style={{ background: hex }}
                          title={hex}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => { onCommand('color', menu.targetType, menu.targetId, hex); onClose(); }}
                        />
                      ))}
                    </div>
                  )}
                  {kind === 'exportFmt' && ['wav', 'mp3'].map(fmt => (
                    <button
                      key={fmt}
                      type="button"
                      className={styles.item}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { onCommand('export', menu.targetType, menu.targetId, fmt); onClose(); }}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                  {kind === 'pasteFx' && (otherTracks.length === 0 ? (
                    <div className={styles.submenuEmpty}>no other tracks</div>
                  ) : (
                    otherTracks.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        className={styles.item}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => { onCommand('pasteEffects', menu.targetType, menu.targetId, t.id); onClose(); }}
                      >
                        <span className={styles.trackSwatchDot} style={{ background: t.color }} />
                        {t.name}
                      </button>
                    ))
                  ))}
                </div>
              )}
            </div>
          );
        }

        return (
          <button
            key={it.action}
            type="button"
            className={styles.item}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { onCommand(it.action, menu.targetType, menu.targetId); onClose(); }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
