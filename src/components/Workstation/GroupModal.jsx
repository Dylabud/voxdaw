import { useState } from 'react';
import styles from './GroupModal.module.css';

/**
 * Create-group modal (Phase: track grouping). Centered fixed overlay listing
 * every track with a checkbox: the right-clicked (initiator) track starts
 * checked but CAN be unchecked; tracks already in a group are grayed out with
 * their group's name (flat groups — no nesting; ungroup first to move one).
 * The action button reads "select more tracks" (disabled) until ≥2 tracks are
 * checked, then becomes "create group".
 */
export default function GroupModal({ tracks, groups, initiatorTrackId, onCancel, onCreate }) {
  const [checkedIds, setCheckedIds] = useState(() => new Set(
    tracks.some(t => t.id === initiatorTrackId && !t.groupId) ? [initiatorTrackId] : []
  ));
  const groupNameById = new Map(groups.map(g => [g.id, g.name]));

  const toggle = (id) => setCheckedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const canCreate = checkedIds.size >= 2;

  return (
    <div className={styles.overlay} onMouseDown={onCancel}>
      <div className={styles.box} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <button className={styles.closeBtn} onClick={onCancel} title="Cancel">✕</button>
          <span className={styles.title}>create group</span>
        </div>
        <div className={styles.list}>
          {tracks.map(t => {
            const grouped = !!t.groupId;
            return (
              <label
                key={t.id}
                className={`${styles.row}${grouped ? ` ${styles.rowDisabled}` : ''}`}
              >
                <span className={styles.dot} style={{ background: t.color }} />
                <span className={styles.name}>{t.name}</span>
                {grouped && (
                  <span className={styles.groupedNote}>
                    in {groupNameById.get(t.groupId) ?? 'a group'}
                  </span>
                )}
                <input
                  type="checkbox"
                  className={styles.check}
                  disabled={grouped}
                  checked={checkedIds.has(t.id)}
                  onChange={() => toggle(t.id)}
                />
              </label>
            );
          })}
        </div>
        <div className={styles.footer}>
          <button
            className={canCreate ? styles.createBtn : styles.createBtnDisabled}
            disabled={!canCreate}
            onClick={() => onCreate([...checkedIds])}
          >
            {canCreate ? '[ create group ]' : 'select more tracks'}
          </button>
        </div>
      </div>
    </div>
  );
}
