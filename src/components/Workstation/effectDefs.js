// Per-track insert-effect registry — the single source of truth for the available
// effect types, their display labels, their parameter metadata (ranges + defaults
// for the param UI), and the default param values used by addEffect().
//
// Consumed by: WorkstationShell's addEffect() (via defaultParamsFor), the
// EffectsList / EffectsRack "Add Effect" dropdowns, the EffectsRack param
// knobs/toggles/selects, and the audio engine's fxChain.js (which maps these
// keys onto Tone graphs: Filter / Delay composite / Reverb composite / Chorus /
// AutoFilter / AutoWah / EQ3 / Distortion / Compressor / Phaser / BitCrusher /
// Tremolo / Vibrato / StereoWidener / PitchShift / AutoPanner — see
// KEY_MAPS + per-type builders there).
//
// Param metadata: { default, min, max, step, label, unit?, scale?, kind?, options? }.
// kind: 'toggle' renders a pill button (boolean param).
// kind: 'select' renders a dropdown; `options` lists the string values.
//
// Range notes (load-bearing, not taste):
//   - delay.time max 1.0  → matches the composite's Tone.Delay maxDelay:1
//     (a rampTo above delayTime.maxValue throws)
//   - delay.feedback ≤ 0.9 → loop stays stable (in-loop cut filters have
//     passband gain ≤ 1, so they never push the loop gain over unity)
//   - delay.lowCut min 20 / highCut max 18000 → filter is transparent at rest
//   - reverb.roomSize ≤ 0.95 → Freeverb comb-filter stability
//   - reverb.preDelay max 0.25 → matches the composite's Tone.Delay maxDelay:0.25
//   - compressor.attack min 0.001 → DynamicsCompressorNode minimum
//   - hz-unit params + autofilter/phaser rate use log scaling in the UI

export const EFFECT_DEFS = {
  filter: {
    label: 'Filter',
    params: {
      type:      { default: 'lowpass', kind: 'select', options: ['lowpass', 'highpass', 'bandpass'], label: 'type' },
      frequency: { default: 5000, min: 40, max: 18000, step: 1, label: 'cutoff', unit: 'hz', scale: 'log' },
      q:         { default: 1, min: 0.1, max: 12, step: 0.1, label: 'res' },
    },
  },
  delay: {
    label: 'Delay',
    params: {
      time:     { default: 0.25, min: 0.02, max: 1.0, step: 0.01, label: 'time', unit: 's' },
      feedback: { default: 0.3, min: 0, max: 0.9, step: 0.01, label: 'fdbk' },
      // In-loop cut filters: each repeat passes through them again, so echoes
      // get progressively darker/thinner (standard DAW delay behavior).
      lowCut:   { default: 20, min: 20, max: 2000, step: 1, label: 'lo cut', unit: 'hz', scale: 'log' },
      highCut:  { default: 18000, min: 400, max: 18000, step: 1, label: 'hi cut', unit: 'hz', scale: 'log' },
      wet:      { default: 0.3, min: 0, max: 1, step: 0.01, label: 'mix' },
      // Dry-thru: pins the dry signal at unity regardless of mix, so the
      // original attack always cuts through with echoes riding on top.
      dryThru:  { default: false, kind: 'toggle', label: 'dry thru' },
    },
  },
  reverb: {
    label: 'Reverb',
    params: {
      roomSize:  { default: 0.7, min: 0, max: 0.95, step: 0.01, label: 'size' },
      preDelay:  { default: 0, min: 0, max: 0.25, step: 0.005, label: 'pre dly', unit: 's' },
      dampening: { default: 3000, min: 500, max: 15000, step: 1, label: 'damp', unit: 'hz', scale: 'log' },
      wet:       { default: 0.3, min: 0, max: 1, step: 0.01, label: 'mix' },
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
  eq: {
    label: 'EQ', // Tone.EQ3 — 3-band gain (no wet: bypass is the off-switch)
    params: {
      low:  { default: 0, min: -12, max: 12, step: 0.5, label: 'low', unit: 'db' },
      mid:  { default: 0, min: -12, max: 12, step: 0.5, label: 'mid', unit: 'db' },
      high: { default: 0, min: -12, max: 12, step: 0.5, label: 'high', unit: 'db' },
    },
  },
  distortion: {
    label: 'Distortion',
    params: {
      drive: { default: 0.4, min: 0, max: 1, step: 0.01, label: 'drive' },
      wet:   { default: 0.5, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  compressor: {
    label: 'Compressor', // no wet — inline dynamics, bypass is the off-switch
    params: {
      // max −0.1 (not 0) is load-bearing: Tone's Param.setRampPoint replaces an
      // exact current value of 0 with +1e-7 (exponential ramps can't touch 0),
      // then its own [-100, 0] range assert throws and crashes the React tree.
      threshold: { default: -24, min: -60, max: -0.1, step: 0.5, label: 'thresh', unit: 'db' },
      ratio:     { default: 4, min: 1, max: 20, step: 0.1, label: 'ratio' },
      attack:    { default: 0.01, min: 0.001, max: 0.5, step: 0.001, label: 'attack', unit: 's', scale: 'log' },
      release:   { default: 0.2, min: 0.01, max: 1, step: 0.005, label: 'release', unit: 's' },
    },
  },
  phaser: {
    label: 'Phaser',
    params: {
      rate:  { default: 0.5, min: 0.1, max: 8, step: 0.01, label: 'rate', unit: 'hz', scale: 'log' },
      depth: { default: 3, min: 1, max: 6, step: 0.1, label: 'depth' }, // octaves above 350 Hz
      wet:   { default: 0.5, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  bitcrusher: {
    label: 'Bitcrusher', // worklet-based bit-depth reduction
    params: {
      bits: { default: 4, min: 1, max: 8, step: 0.5, label: 'bits' },
      wet:  { default: 1, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  tremolo: {
    label: 'Tremolo', // stereo amplitude LFO
    params: {
      rate:   { default: 4, min: 0.1, max: 20, step: 0.01, label: 'rate', unit: 'hz', scale: 'log' },
      depth:  { default: 0.6, min: 0, max: 1, step: 0.01, label: 'depth' },
      spread: { default: 0, min: 0, max: 180, step: 1, label: 'spread' }, // L/R LFO phase offset (deg)
      wet:    { default: 1, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  vibrato: {
    label: 'Vibrato', // pitch LFO (delay-line modulation)
    params: {
      rate:  { default: 5, min: 0.1, max: 12, step: 0.01, label: 'rate', unit: 'hz', scale: 'log' },
      depth: { default: 0.1, min: 0, max: 1, step: 0.01, label: 'depth' },
      wet:   { default: 1, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  widener: {
    label: 'Stereo Widener', // mid/side width — 0.5 = unity; no wet, bypass is the off-switch
    params: {
      width: { default: 0.75, min: 0, max: 1, step: 0.01, label: 'width' },
    },
  },
  pitchshift: {
    label: 'Pitch Shift',
    params: {
      pitch:      { default: 0, min: -12, max: 12, step: 1, label: 'semi' },
      windowSize: { default: 0.1, min: 0.03, max: 0.1, step: 0.005, label: 'window', unit: 's' },
      wet:        { default: 1, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
  autopanner: {
    label: 'Auto-Pan', // LFO-driven stereo panning
    params: {
      rate:  { default: 1, min: 0.1, max: 10, step: 0.01, label: 'rate', unit: 'hz', scale: 'log' },
      depth: { default: 1, min: 0, max: 1, step: 0.01, label: 'depth' },
      wet:   { default: 1, min: 0, max: 1, step: 0.01, label: 'mix' },
    },
  },
};

// Stable ordering for the Add-Effect dropdowns.
export const EFFECT_TYPES = Object.keys(EFFECT_DEFS);

// Effects whose DSP runs continuously (LFOs, feedback comb banks, granular
// delay lines) even with silent input — LOW performance quality force-bypasses
// these. Cheap native-node effects (filter / eq / distortion / compressor /
// delay / bitcrusher / widener) always stay on.
export const HEAVY_EFFECT_TYPES = new Set([
  'reverb', 'pitchshift', 'doubler', 'autofilter', 'autowah',
  'phaser', 'tremolo', 'vibrato', 'autopanner',
]);

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
