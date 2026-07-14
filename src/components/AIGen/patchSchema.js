// AI Instrument Generator — pure data layer (no Tone, no React).
//
// A "patch" is the unit of exchange with the model: a JSON description of a
// playable instrument. As of the multi-timbral update a patch is a STACK of
// 1–3 "layers", each a full voice engine + envelope + filter + insert-FX chain
// plus a per-layer level and pitch offset:
//
//   patch  = { name, volume (master out), layers: [layer, …] }
//   layer  = { voice, envelope, filter, effects, volume, transpose, detune }
//
// `layers` is an ADDITIVE, backward-compatible field: a legacy flat patch (no
// `layers` key — voice/envelope/filter/effects/volume at the top level) is
// normalized to a single layer, so old .voxdaw files and library instruments
// load and sound identical, and SCHEMA_VERSION is intentionally NOT bumped.
//
// The model returns the patch as prompted JSON (see claudeService.js —
// structured outputs can't be used: the 16-effect union's compiled grammar is
// too large), so sanitizePatch() is the sole validator: every patch — model-
// generated or loaded from a .voxdaw — passes through it before any value
// reaches a Tone param. It guarantees *shape and range* from arbitrary input.

import { EFFECT_DEFS, defaultParamsFor } from '../Workstation/effectDefs';

// ── Models ────────────────────────────────────────────────────────────────
// Exact API model IDs — do not edit without checking the current catalog.
export const AI_MODELS = [
  { id: 'claude-opus-4-8',   label: 'Opus 4.8',   cost: '~2–3¢ / patch' },
  { id: 'claude-fable-5',    label: 'Fable 5',    cost: '~4–6¢ / patch' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', cost: '~1.5¢ / patch' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  cost: '~0.5¢ / patch' },
];
export const DEFAULT_MODEL = AI_MODELS[0].id;

// Token tiers — max_tokens is a CEILING, not a target (you're billed on tokens
// actually generated), so 'high' costs nothing extra on simple patches; it only
// lets larger multi-layer JSON through without tripping the max_tokens guard.
export const TOKEN_TIERS = {
  medium: 2048,
  high:   8192,
  xhigh:  16384, // 2× high — headroom for up to MAX_LAYERS layers
};
export const DEFAULT_TOKEN_TIER = 'medium';

// The extra-high tier unlocks the full 5-layer stack; other tiers cap at 3 (a
// 5-layer JSON needs xhigh's budget to avoid truncation). Enforced softly in the
// prompt (per-request user line) + the UI "+ layer" cap; sanitizePatch's hard
// cap is always MAX_LAYERS.
export function maxLayersForTier(tier) {
  return tier === 'xhigh' ? 5 : 3;
}

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
export const MAX_LAYERS = 5;

// Chassis knob metadata — same {min,max,scale} meta shape as EFFECT_DEFS
// params, consumed through automationMath's toKnob/fromKnob.
export const VOL_META = { min: -30, max: 6, step: 0.5, label: 'vol', unit: 'db' }; // master out
export const LAYER_VOL_META = { min: -30, max: 6, step: 0.5, label: 'level', unit: 'db' }; // per-layer mix
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
// Fat-oscillator unison controls (only meaningful for fat* oscillator types).
export const SPREAD_META = { min: 0, max: 100, step: 1, label: 'spread' };
export const COUNT_META  = { min: 1, max: 8,  step: 1, label: 'voices' };
// Per-voice glide (portamento) between successive notes on a mono voice.
export const PORTAMENTO_META = { min: 0, max: 0.5, step: 0.005, label: 'glide', unit: 's' };
// Per-layer pitch offset: whole octaves (−1 = sub, +1/+2 = shimmer) + fine
// semitones. Effective detune sent to the synth = octave*1200 + semitone*100 cents.
export const OCTAVE_META   = { min: -4, max: 4,   step: 1, label: 'octave' };
export const SEMITONE_META = { min: -12, max: 12, step: 1, label: 'semi' };
export const FILTER_META = {
  frequency: { min: 40, max: 18000, step: 1, scale: 'log', label: 'cutoff', unit: 'hz' },
  q:         { min: 0.1, max: 12, step: 0.1, label: 'res' },
};

// One playable layer before the first generation.
export const DEFAULT_LAYER = {
  voice: { engine: 'simple', oscillator: 'triangle' },
  envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 },
  filter: { type: 'lowpass', frequency: 12000, q: 0.7 },
  effects: [],
  volume: 0,
  octave: 0,
  semitone: 0,
};

// The keyboard is playable before the first generation.
export const DEFAULT_PATCH = {
  name: 'INIT',
  volume: -6,           // master output level
  layers: [DEFAULT_LAYER],
};

// Effective per-layer pitch offset in cents (single source — poly + glide paths).
export function layerDetuneCents(layer) {
  return (layer?.octave ?? 0) * 1200 + (layer?.semitone ?? 0) * 100;
}

// ── Sanitizer — the trust boundary ────────────────────────────────────────
const num = (v, min, max, dflt) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
};
const int = (v, min, max, dflt) => Math.round(num(v, min, max, dflt));
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

// One layer of a patch — the shape the old flat patch used, minus `name`, plus
// per-layer `volume`/`transpose`/`detune` and optional fat-osc + portamento
// voice params. Always returns a complete, playable layer.
export function sanitizeLayer(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = r.voice && typeof r.voice === 'object' ? r.voice : {};
  const e = r.envelope && typeof r.envelope === 'object' ? r.envelope : {};
  const d = DEFAULT_LAYER;

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
  // Fat-oscillator unison — only kept when the oscillator is a fat* type.
  if (voice.oscillator.startsWith('fat')) {
    if (v.count != null)  voice.count  = int(v.count,  COUNT_META.min,  COUNT_META.max,  3);
    if (v.spread != null) voice.spread = num(v.spread, SPREAD_META.min, SPREAD_META.max, 20);
  }
  if (v.portamento != null) voice.portamento = num(v.portamento, PORTAMENTO_META.min, PORTAMENTO_META.max, 0);

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
    voice,
    envelope: {
      attack:  num(e.attack,  ENV_META.attack.min,  ENV_META.attack.max,  d.envelope.attack),
      decay:   num(e.decay,   ENV_META.decay.min,   ENV_META.decay.max,   d.envelope.decay),
      sustain: num(e.sustain, ENV_META.sustain.min, ENV_META.sustain.max, d.envelope.sustain),
      release: num(e.release, ENV_META.release.min, ENV_META.release.max, d.envelope.release),
    },
    filter,
    effects,
    volume: num(r.volume, LAYER_VOL_META.min, LAYER_VOL_META.max, d.volume),
    octave: sanitizeOctave(r, d.octave),
    semitone: int(r.semitone, SEMITONE_META.min, SEMITONE_META.max, d.semitone),
  };
}

// Per-layer octave, migrating the pre-octave `transpose` (semitones) field on
// patches saved by the very first multi-layer build (round to nearest octave).
function sanitizeOctave(r, dflt) {
  if (r.octave != null)    return int(r.octave, OCTAVE_META.min, OCTAVE_META.max, dflt);
  if (r.transpose != null) return int(Math.round(r.transpose / 12), OCTAVE_META.min, OCTAVE_META.max, dflt);
  return dflt;
}

// Always returns a complete, playable multi-layer patch — garbage in, INIT-ish
// out. Accepts both the new `{ layers: [...] }` shape and a legacy flat patch
// (voice/envelope/filter/effects/volume at the top level) → single layer.
export function sanitizePatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_PATCH;

  let layers;
  if (Array.isArray(r.layers) && r.layers.length) {
    layers = r.layers.map(sanitizeLayer).slice(0, MAX_LAYERS);
  } else {
    // Legacy flat patch: its top-level `volume` was the OUTPUT level, so it
    // becomes the master (below) — the single layer sits at unity (0 dB), which
    // reproduces the old graph exactly. Strip `volume` before making the layer.
    const { volume: _flatVolume, ...flatRest } = r;
    layers = [sanitizeLayer(flatRest)];
  }

  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 48) : d.name,
    volume: num(r.volume, VOL_META.min, VOL_META.max, d.volume),
    layers,
  };
}

// Layer accessor tolerant of a stray flat patch (defensive — sanitizePatch
// always produces `layers`, but callers may hold an un-sanitized object).
export function layersOf(patch) {
  if (patch && Array.isArray(patch.layers) && patch.layers.length) return patch.layers;
  return patch ? [patch] : [];
}
