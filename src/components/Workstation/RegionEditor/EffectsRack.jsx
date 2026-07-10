import React from 'react';
import styles from './EffectsRack.module.css';
import { EFFECT_DEFS, EFFECT_TYPES, HEAVY_EFFECT_TYPES, effectLabel } from '../effectDefs';
import { toKnob, fromKnob } from '../automationMath';
import RotaryKnob from './RotaryKnob';
import FxVisualizer from './FxVisualizer';

/**
 * Full per-track effects rack for the main editor "effects" tab — the modular grid
 * view. Renders the same `track.effects` data as the inspector EffectsList, as a
 * horizontal signal-chain of module panels (array order = signal order). Modules
 * share one fixed height (uniform hardware-rack look) and vary in width with
 * their knob count; the chain centers vertically in the rack.
 *
 * Each module = header (bypass / title / ×), SVG visualizer (FxVisualizer, a pure
 * function of the params), and a knob row. Param rows are registry-driven from
 * EFFECT_DEFS metadata: kind 'toggle' → pill, kind 'select' → dropdown, default →
 * RotaryKnob. Knobs write through onUpdate → WorkstationShell.updateEffectSettings
 * (which MERGES params, so each control sends only its own key). Continuous
 * onChange during a knob drag is fine: the history recorder's burst coalescing
 * folds a drag into one undo entry, and the audio hook's param sync ramps each
 * committed value (0.02s).
 *
 * @param {Array}  effects   the track's effects array
 * @param {string} trackId
 * @param {(trackId:string, fxType:string) => void} onAdd
 * @param {(trackId:string, fxId:string)   => void} onRemove
 * @param {(trackId:string, fxId:string)   => void} onToggleBypass
 * @param {(trackId:string, fxId:string, params:Object) => void} onUpdate
 */

function formatValue(value, meta) {
  if (meta.unit === 'hz') {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    if (value < 10) return `${value.toFixed(value < 1 ? 2 : 1)}hz`; // LFO rates
    return `${Math.round(value)}hz`;
  }
  if (meta.unit === 's') {
    return value < 0.1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`;
  }
  if (meta.unit === 'db') {
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}db`;
  }
  return value.toFixed(2);
}

// `automatedKeys`: Set of "fxId:param" currently owned by an automation lane —
// those controls dim read-only ("automation takes over", single-writer rule).
export default function EffectsRack({ effects = [], trackId, onAdd, onRemove, onToggleBypass, onUpdate, performanceQuality = 'high', automatedKeys }) {
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
          // Resolved values (state ?? metadata default) — shared by the
          // visualizer and every control, so legacy saves missing new keys
          // render the same defaults the DSP builders fall back to.
          const vals = Object.fromEntries(
            paramDefs.map(([k, m]) => [k, fx.params?.[k] ?? m.default]),
          );
          // Low quality force-bypasses heavy FX in the audio hook; mirror it
          // here: body grayed + inert (header stays live so × still works).
          const qualityBlocked = performanceQuality === 'low' && HEAVY_EFFECT_TYPES.has(fx.type);
          return (
            <div key={fx.id} className={`${styles.module}${fx.bypass || qualityBlocked ? ` ${styles.moduleBypassed}` : ''}`}>
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
              <div className={`${styles.moduleBody}${qualityBlocked ? ` ${styles.bodyBlocked}` : ''}`}>
                {qualityBlocked && (
                  <div className={styles.qualityNotice}>
                    <span className={styles.qualityNoticeIcon} aria-hidden="true">◇</span>
                    increase sound quality to enable {effectLabel(fx.type)}
                  </div>
                )}
                <div className={styles.vizBox}>
                  <FxVisualizer type={fx.type} params={vals} />
                </div>
                <div className={styles.knobRow}>
                  {paramDefs.length === 0 && (
                    <span className={styles.noParams}>no parameters</span>
                  )}
                  {paramDefs.map(([key, meta]) => {
                    const value = vals[key];
                    const isAutomated = automatedKeys?.has(`${fx.id}:${key}`) ?? false;
                    // delay's dryThru is coupled to wet inside the composite —
                    // it locks whenever wet is automated.
                    const isLocked = isAutomated
                      || (key === 'dryThru' && (automatedKeys?.has(`${fx.id}:wet`) ?? false));
                    if (meta.kind === 'toggle') {
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`${styles.paramToggle}${value ? ` ${styles.paramToggleOn}` : ''}`}
                          style={isLocked ? { opacity: 0.35, pointerEvents: 'none' } : undefined}
                          title={isLocked ? 'controlled by automation' : `${meta.label} ${value ? 'on' : 'off'}`}
                          onClick={() => { if (!isLocked) onUpdate?.(trackId, fx.id, { [key]: !value }); }}
                          aria-pressed={!!value}
                          aria-disabled={isLocked}
                        >{meta.label}</button>
                      );
                    }
                    if (meta.kind === 'select') {
                      return (
                        <div key={key} className={styles.selectCol}>
                          <select
                            className={styles.paramSelect}
                            value={value}
                            onChange={ev => onUpdate?.(trackId, fx.id, { [key]: ev.target.value })}
                            aria-label={`${effectLabel(fx.type)} ${meta.label}`}
                          >
                            {meta.options.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                          <span className={styles.selectLabel}>{meta.label}</span>
                        </div>
                      );
                    }
                    return (
                      <RotaryKnob
                        key={key}
                        value01={toKnob(value, meta)}
                        defaultValue01={toKnob(meta.default, meta)}
                        onChange={v01 => onUpdate?.(trackId, fx.id, { [key]: fromKnob(v01, meta) })}
                        label={meta.label}
                        display={formatValue(value, meta)}
                        disabled={isLocked}
                        disabledHint="controlled by automation — delete the lane to regain manual control"
                      />
                    );
                  })}
                </div>
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
