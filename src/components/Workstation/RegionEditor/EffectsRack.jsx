import React from 'react';
import styles from './EffectsRack.module.css';
import { EFFECT_TYPES, effectLabel } from '../effectDefs';

/**
 * Full per-track effects rack for the main editor "effects" tab — the modular grid
 * view. Renders the same `track.effects` data as the inspector EffectsList, as a
 * horizontal signal-chain of module panels (array order = signal order).
 *
 * Skeleton only: each module is a header (bypass / title / delete) + a placeholder
 * body. No DSP yet.
 *
 * @param {Array}  effects   the track's effects array
 * @param {string} trackId
 * @param {(trackId:string, fxType:string) => void} onAdd
 * @param {(trackId:string, fxId:string)   => void} onRemove
 * @param {(trackId:string, fxId:string)   => void} onToggleBypass
 */
export default function EffectsRack({ effects = [], trackId, onAdd, onRemove, onToggleBypass }) {
  const handleAdd = (e) => {
    const type = e.target.value;
    if (!type) return;
    onAdd?.(trackId, type);
    e.target.value = '';
  };

  const AddMenu = ({ label }) => (
    <select className={styles.addSelect} value="" onChange={handleAdd} aria-label="Add effect">
      <option value="" disabled>{label}</option>
      {EFFECT_TYPES.map(t => <option key={t} value={t}>{effectLabel(t)}</option>)}
    </select>
  );

  if (effects.length === 0) {
    return (
      <div className={styles.rack}>
        <div className={styles.empty}>
          <p className={styles.emptyText}>no effects on this track</p>
          <AddMenu label="+ add effect" />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.rack}>
      <div className={styles.chain}>
        {effects.map(fx => (
          <div key={fx.id} className={`${styles.module}${fx.bypass ? ` ${styles.moduleBypassed}` : ''}`}>
            <div className={styles.moduleHead}>
              <button
                type="button"
                className={`${styles.bypass}${fx.bypass ? '' : ` ${styles.bypassOn}`}`}
                title={fx.bypass ? 'Bypassed — click to enable' : 'Active — click to bypass'}
                onClick={() => onToggleBypass?.(trackId, fx.id)}
              >{fx.bypass ? 'off' : 'on'}</button>
              <span className={styles.title}>{effectLabel(fx.type)}</span>
              <button
                type="button"
                className={styles.close}
                title="Remove effect"
                onClick={() => onRemove?.(trackId, fx.id)}
              >×</button>
            </div>
            <div className={styles.moduleBody}>
              {effectLabel(fx.type)} parameters live here
            </div>
          </div>
        ))}

        <div className={styles.addModule}>
          <AddMenu label="+ add" />
        </div>
      </div>
    </div>
  );
}
