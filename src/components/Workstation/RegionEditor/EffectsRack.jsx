import React from 'react';
import styles from './EffectsRack.module.css';
import { EFFECT_DEFS, EFFECT_TYPES, effectLabel } from '../effectDefs';

/**
 * Full per-track effects rack for the main editor "effects" tab — the modular grid
 * view. Renders the same `track.effects` data as the inspector EffectsList, as a
 * horizontal signal-chain of module panels (array order = signal order).
 *
 * Param rows are registry-driven from EFFECT_DEFS metadata. Sliders write through
 * onUpdate → WorkstationShell.updateEffectSettings (which MERGES params, so each
 * row sends only its own key). Continuous onChange is fine: the history recorder's
 * burst coalescing folds a drag into one undo entry, and the audio hook's param
 * sync ramps each committed value (0.02s).
 *
 * @param {Array}  effects   the track's effects array
 * @param {string} trackId
 * @param {(trackId:string, fxType:string) => void} onAdd
 * @param {(trackId:string, fxId:string)   => void} onRemove
 * @param {(trackId:string, fxId:string)   => void} onToggleBypass
 * @param {(trackId:string, fxId:string, params:Object) => void} onUpdate
 */

// Log-scale mapping for perceptual params (filter cutoff): slider runs 0..1,
// value = min * (max/min)^v. Linear params pass through untouched.
function toSlider(value, meta) {
  if (meta.scale !== 'log') return value;
  return Math.log(value / meta.min) / Math.log(meta.max / meta.min);
}
function fromSlider(v, meta) {
  if (meta.scale !== 'log') return v;
  return meta.min * Math.pow(meta.max / meta.min, v);
}
function formatValue(value, meta) {
  if (meta.unit === 'hz') {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}hz`;
  }
  if (meta.unit === 's') return `${value.toFixed(2)}s`;
  return value.toFixed(2);
}

export default function EffectsRack({ effects = [], trackId, onAdd, onRemove, onToggleBypass, onUpdate }) {
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
        {effects.map(fx => {
          const paramDefs = Object.entries(EFFECT_DEFS[fx.type]?.params ?? {});
          return (
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
                {paramDefs.length === 0 && (
                  <span className={styles.noParams}>no parameters</span>
                )}
                {paramDefs.map(([key, meta]) => {
                  const value = fx.params?.[key] ?? meta.default;
                  if (meta.kind === 'toggle') {
                    return (
                      <div key={key} className={styles.paramRow}>
                        <button
                          type="button"
                          className={`${styles.paramToggle}${value ? ` ${styles.paramToggleOn}` : ''}`}
                          title={`${meta.label} ${value ? 'on' : 'off'}`}
                          onClick={() => onUpdate?.(trackId, fx.id, { [key]: !value })}
                          aria-pressed={!!value}
                        >{meta.label}</button>
                      </div>
                    );
                  }
                  return (
                    <div key={key} className={styles.paramRow}>
                      <span className={styles.paramLabel}>{meta.label}</span>
                      <input
                        type="range"
                        className={styles.paramSlider}
                        min={meta.scale === 'log' ? 0 : meta.min}
                        max={meta.scale === 'log' ? 1 : meta.max}
                        step={meta.scale === 'log' ? 0.001 : meta.step}
                        value={toSlider(value, meta)}
                        onChange={ev => onUpdate?.(trackId, fx.id, { [key]: fromSlider(+ev.target.value, meta) })}
                        aria-label={`${effectLabel(fx.type)} ${meta.label}`}
                      />
                      <span className={styles.paramValue}>{formatValue(value, meta)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className={styles.addModule}>
          <AddMenu label="+ add" />
        </div>
      </div>
    </div>
  );
}
