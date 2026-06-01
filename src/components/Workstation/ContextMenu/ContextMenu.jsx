import React, { useEffect, useRef, useState } from 'react';
import styles from './ContextMenu.module.css';

// Approximate dimensions used to clamp the menu inside the viewport before the
// real element is measured. The post-mount effect refines with actual size.
const MENU_W = 168;
const MENU_H = 240;
const SUBMENU_W = 96;

// Semitone options for the Pitch submenu: +12 … −12 excluding 0 (descending).
const PITCH_STEPS = Array.from({ length: 25 }, (_, i) => 12 - i).filter(n => n !== 0);

// Command sets per target type. Item kinds:
//   { action, label }        — plain command
//   'divider'                — separator
//   { submenu: 'pitch', … }  — Pitch ▸ row with a nested semitone submenu
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
};

/**
 * Custom right-click context menu for Workstation regions and notes.
 * Fixed-position floating panel positioned at the click coordinates.
 *
 * @param {{x:number,y:number,targetType:'region'|'note',targetId:string}|null} menu
 * @param {() => void} onClose
 * @param {(action:string, targetType:string, targetId:string, payload?:number) => void} onCommand
 */
export default function ContextMenu({ menu, onClose, onCommand }) {
  const menuRef = useRef(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const closeTimerRef = useRef(null);

  // Open/close lifecycle: any interaction outside a menu item dismisses it.
  useEffect(() => {
    if (!menu) return;
    setSubmenuOpen(false);
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

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  if (!menu) return null;

  const left = Math.min(menu.x, window.innerWidth  - MENU_W - 4);
  const top  = Math.min(menu.y, window.innerHeight - MENU_H - 4);
  const items = ITEMS[menu.targetType] ?? [];
  // Flip the submenu to the left when there isn't room on the right.
  const flipLeft = menu.x + MENU_W + SUBMENU_W > window.innerWidth;

  const openSub  = () => { clearTimeout(closeTimerRef.current); setSubmenuOpen(true); };
  const closeSub = () => { closeTimerRef.current = setTimeout(() => setSubmenuOpen(false), 180); };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it === 'divider') return <div key={`d${i}`} className={styles.divider} />;

        if (it.submenu === 'pitch') {
          return (
            <div
              key="pitch"
              className={styles.subWrap}
              onMouseEnter={openSub}
              onMouseLeave={closeSub}
            >
              <button
                type="button"
                className={`${styles.item} ${styles.subItem}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={openSub}
              >
                <span>{it.label}</span>
                <span className={styles.chevron}>▸</span>
              </button>
              {submenuOpen && (
                <div className={`${styles.submenu} ${flipLeft ? styles.submenuLeft : ''}`}>
                  {PITCH_STEPS.map(n => (
                    <button
                      key={n}
                      type="button"
                      className={styles.item}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { onCommand('pitch', menu.targetType, menu.targetId, n); onClose(); }}
                    >
                      {n > 0 ? `+${n}` : n}
                    </button>
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
