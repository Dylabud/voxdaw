// Per-track insert-effect registry — the single source of truth for the available
// effect types, their display labels, their parameter metadata (ranges + defaults
// for the param UI), and the default param values used by addEffect().
//
// Consumed by: WorkstationShell's addEffect() (via defaultParamsFor), the
// EffectsList / EffectsRack "Add Effect" dropdowns, the EffectsRack param
// sliders/toggles, and the audio engine's fxChain.js (which maps these keys
// onto Tone graphs: Filter / FeedbackDelay composite / Freeverb / Chorus /
// AutoFilter / AutoWah — see KEY_MAPS + per-type builders there).
//
// Param metadata: { default, min, max, step, label, unit?, scale?, kind? }.
// kind: 'toggle' renders a pill button instead of a slider (boolean param).
//
// Range notes (load-bearing, not taste):
//   - delay.time max 1.0  → matches FeedbackDelay maxDelay:1 (rampTo above throws)
//   - delay.feedback ≤ 0.9 → no runaway self-oscillation
//   - reverb.roomSize ≤ 0.95 → Freeverb comb-filter stability
//   - filter.frequency / autofilter.rate use log scaling in the UI

export const EFFECT_DEFS = {
  filter: {
    label: 'Filter',
    params: {
      frequency: { default: 5000, min: 40, max: 18000, step: 1, label: 'cutoff', unit: 'hz', scale: 'log' },
      q:         { default: 1, min: 0.1, max: 12, step: 0.1, label: 'res' },
    },
  },
  delay: {
    label: 'Delay',
    params: {
      time:     { default: 0.25, min: 0.02, max: 1.0, step: 0.01, label: 'time', unit: 's' },
      feedback: { default: 0.3, min: 0, max: 0.9, step: 0.01, label: 'fdbk' },
      wet:      { default: 0.3, min: 0, max: 1, step: 0.01, label: 'mix' },
      // Dry-thru: pins the dry signal at unity regardless of mix, so the
      // original attack always cuts through with echoes riding on top.
      dryThru:  { default: false, kind: 'toggle', label: 'dry thru' },
    },
  },
  reverb: {
    label: 'Reverb',
    params: {
      roomSize: { default: 0.7, min: 0, max: 0.95, step: 0.01, label: 'size' },
      wet:      { default: 0.3, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  doubler: {
    label: 'Doubler',
    params: {
      depth: { default: 0.7, min: 0, max: 1, step: 0.01, label: 'depth' },
      wet:   { default: 0.5, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  autofilter: {
    label: 'Auto Filter', // LFO-driven rhythmic filter sweep
    params: {
      rate:  { default: 2, min: 0.1, max: 8, step: 0.01, label: 'rate', unit: 'hz', scale: 'log' },
      depth: { default: 4, min: 1, max: 6, step: 0.1, label: 'depth' }, // octaves above 200 Hz
      wet:   { default: 0.5, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  autowah: {
    label: 'Auto Wah', // envelope-follower wah — opens with note attacks
    params: {
      depth: { default: 4, min: 1, max: 6, step: 0.1, label: 'depth' }, // octaves above 100 Hz
      q:     { default: 2, min: 0.5, max: 10, step: 0.1, label: 'res' },
      wet:   { default: 0.5, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
};

// Stable ordering for the Add-Effect dropdowns.
export const EFFECT_TYPES = Object.keys(EFFECT_DEFS);

// Display label for an effect type, with a safe fallback for unknown/legacy types.
export function effectLabel(type) {
  return EFFECT_DEFS[type]?.label ?? String(type ?? 'FX');
}

// Plain { key: defaultValue } params object for a new effect instance.
export function defaultParamsFor(type) {
  return Object.fromEntries(
    Object.entries(EFFECT_DEFS[type]?.params ?? {}).map(([k, m]) => [k, m.default]),
  );
}
