// AI Instrument Generator — pure data layer (no Tone, no React).
//
// A "patch" is the unit of exchange with the model: a JSON description of a
// playable instrument (voice engine + envelope + filter + insert-FX chain).
// The model returns it as prompted JSON (see claudeService.js — structured
// outputs can't be used: the 16-effect union's compiled grammar is too large),
// so sanitizePatch() is the sole validator: every patch — model-generated or
// loaded from a .voxdaw — passes through it before any value reaches a Tone
// param. It guarantees *shape and range* from arbitrary input.

import { EFFECT_DEFS, defaultParamsFor } from '../Workstation/effectDefs';

// ── Models ────────────────────────────────────────────────────────────────
// Exact API model IDs — do not edit without checking the current catalog.
export const AI_MODELS = [
  { id: 'claude-opus-4-8',   label: 'Opus 4.8',   cost: '~2–3¢ / patch' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', cost: '~1.5¢ / patch' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  cost: '~0.5¢ / patch' },
];
export const DEFAULT_MODEL = AI_MODELS[0].id;

// ── Value domains ─────────────────────────────────────────────────────────
export const VOICE_ENGINES = ['simple', 'fm', 'am'];
// OmniOscillator types all three voice classes accept.
export const OSC_TYPES = [
  'sine', 'square', 'sawtooth', 'triangle',
  'fatsine', 'fatsquare', 'fatsawtooth', 'fattriangle', 'pulse',
];
export const MOD_OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle'];
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'];
export const MAX_EFFECTS = 4;

// Chassis knob metadata — same {min,max,scale} meta shape as EFFECT_DEFS
// params, consumed through automationMath's toKnob/fromKnob.
export const VOL_META = { min: -30, max: 6, step: 0.5, label: 'vol', unit: 'db' };
export const ENV_META = {
  attack:  { min: 0.001, max: 2, scale: 'log', label: 'atk' },
  decay:   { min: 0.001, max: 2, scale: 'log', label: 'dcy' },
  sustain: { min: 0,     max: 1,               label: 'sus' },
  release: { min: 0.001, max: 3, scale: 'log', label: 'rel' },
};
export const VOICE_META = {
  harmonicity:     { min: 0.25, max: 8, scale: 'log', label: 'harm' },
  modulationIndex: { min: 0,    max: 40,              label: 'mod idx' },
};
export const FILTER_META = {
  frequency: { min: 40, max: 18000, step: 1, scale: 'log', label: 'cutoff', unit: 'hz' },
  q:         { min: 0.1, max: 12, step: 0.1, label: 'res' },
};

// The keyboard is playable before the first generation.
export const DEFAULT_PATCH = {
  name: 'INIT',
  voice: { engine: 'simple', oscillator: 'triangle' },
  envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 },
  filter: { type: 'lowpass', frequency: 12000, q: 0.7 },
  effects: [],
  volume: -6,
};

// ── Sanitizer — the trust boundary ────────────────────────────────────────
const num = (v, min, max, dflt) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
};
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

// Per-effect: start from the registry defaults, overlay only known params,
// clamping numerics to the registry min/max — which IS the load-bearing set
// (delay.time ≤ 1.0, feedback ≤ 0.9, roomSize ≤ 0.95, compressor.threshold
// ≤ −0.1). Unknown keys are dropped.
const sanitizeEffect = (raw) => {
  const type = raw?.type;
  const defs = EFFECT_DEFS[type]?.params;
  if (!defs) return null;
  const params = defaultParamsFor(type);
  const src = raw.params ?? {};
  for (const [key, m] of Object.entries(defs)) {
    if (!(key in src)) continue;
    const v = src[key];
    if (m.kind === 'toggle') params[key] = Boolean(v);
    else if (m.kind === 'select') params[key] = oneOf(v, m.options, m.default);
    else params[key] = num(v, m.min, m.max, m.default);
  }
  return { type, params };
};

// Always returns a complete, playable patch — garbage in, INIT-ish out.
export function sanitizePatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = r.voice && typeof r.voice === 'object' ? r.voice : {};
  const e = r.envelope && typeof r.envelope === 'object' ? r.envelope : {};
  const d = DEFAULT_PATCH;

  const engine = oneOf(v.engine, VOICE_ENGINES, 'simple');
  const voice = {
    engine,
    oscillator: oneOf(v.oscillator, OSC_TYPES, 'triangle'),
  };
  if (engine !== 'simple') {
    voice.harmonicity = num(v.harmonicity, VOICE_META.harmonicity.min, VOICE_META.harmonicity.max, engine === 'fm' ? 3 : 2);
    voice.modulationOscillator = oneOf(v.modulationOscillator, MOD_OSC_TYPES, 'sine');
  }
  if (engine === 'fm') {
    voice.modulationIndex = num(v.modulationIndex, VOICE_META.modulationIndex.min, VOICE_META.modulationIndex.max, 10);
  }

  let filter = null;
  if (r.filter && typeof r.filter === 'object') {
    filter = {
      type: oneOf(r.filter.type, FILTER_TYPES, 'lowpass'),
      frequency: num(r.filter.frequency, FILTER_META.frequency.min, FILTER_META.frequency.max, 12000),
      q: num(r.filter.q, FILTER_META.q.min, FILTER_META.q.max, 0.7),
    };
  }

  const effects = (Array.isArray(r.effects) ? r.effects : [])
    .map(sanitizeEffect)
    .filter(Boolean)
    .slice(0, MAX_EFFECTS);

  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 48) : d.name,
    voice,
    envelope: {
      attack:  num(e.attack,  ENV_META.attack.min,  ENV_META.attack.max,  d.envelope.attack),
      decay:   num(e.decay,   ENV_META.decay.min,   ENV_META.decay.max,   d.envelope.decay),
      sustain: num(e.sustain, ENV_META.sustain.min, ENV_META.sustain.max, d.envelope.sustain),
      release: num(e.release, ENV_META.release.min, ENV_META.release.max, d.envelope.release),
    },
    filter,
    effects,
    volume: num(r.volume, VOL_META.min, VOL_META.max, d.volume),
  };
}
