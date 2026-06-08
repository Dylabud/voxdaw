import React, { useState } from 'react';
import styles from './EffectsList.module.css';
import { EFFECT_TYPES, effectLabel } from '../effectDefs';

/**
 * Compact per-track effects list for the left inspector — the "simplified chain"
 * view. Mirrors the same `track.effects` data as the full EffectsRack tab.
 *
 * Skeleton only: rows show a bypass dot, the effect name, and an expand caret that
 * reveals a placeholder for future micro-controls. No DSP yet.
 *
 * @param {Array}  effects   the track's effects array (order = signal order)
 * @param {string} trackId
 * @param {(trackId:string, fxType:string) => void} onAdd
 * @param {(trackId:string, fxId:string)   => void} onRemove
 * @param {(trackId:string, fxId:string)   => void} onToggleBypass
 */
export default function EffectsList({ effects = [], trackId, onAdd, onRemove, onToggleBypass }) {
  const [expanded, setExpanded] = useState(() => new Set());

  const toggleExpand = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleAdd = (e) => {
    const type = e.target.value;
    if (!type) return;
    onAdd?.(trackId, type);
    e.target.value = '';   // reset so the same type can be picked again
  };

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>effects</label>

      {effects.length === 0 ? (
        <p className={styles.empty}>No Effects</p>
      ) : (
        <ul className={styles.list}>
          {effects.map(fx => {
            const isOpen = expanded.has(fx.id);
            return (
              <li key={fx.id} className={styles.item}>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={`${styles.bypassDot}${fx.bypass ? '' : ` ${styles.bypassOn}`}`}
                    title={fx.bypass ? 'Bypassed — click to enable' : 'Active — click to bypass'}
                    onClick={() => onToggleBypass?.(trackId, fx.id)}
                  />
                  <button
                    type="button"
                    className={`${styles.name}${fx.bypass ? ` ${styles.nameBypassed}` : ''}`}
                    onClick={() => toggleExpand(fx.id)}
                  >
                    <span>{effectLabel(fx.type)}</span>
                    <span className={`${styles.caret}${isOpen ? ` ${styles.caretOpen}` : ''}`} />
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    title="Remove effect"
                    onClick={() => onRemove?.(trackId, fx.id)}
                  >×</button>
                </div>
                {isOpen && (
                  <div className={styles.params}>params coming soon</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <select className={styles.add} value="" onChange={handleAdd}>
        <option value="" disabled>+ add effect</option>
        {EFFECT_TYPES.map(t => (
          <option key={t} value={t}>{effectLabel(t)}</option>
        ))}
      </select>
    </div>
  );
}
