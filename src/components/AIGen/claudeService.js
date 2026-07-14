// AI Instrument Generator — network layer. The only file that talks to the
// Anthropic API; nothing here touches Tone or React.
//
// Raw fetch, not @anthropic-ai/sdk: the SDK's credential chain dynamically
// imports `node:fs`/`node:path` (on-disk auth profiles), which stock CRA's
// webpack 5 cannot bundle (UnhandledSchemeError) without ejecting or adding a
// config-override layer. One endpoint is all we need, so a small wrapper wins.
// The `anthropic-dangerous-direct-browser-access` header is Anthropic's
// explicit CORS opt-in for browser-side calls — fine here because the key is
// the user's own, entered in-app (localStorage), never in the repo or bundle.
//
// The model returns the patch as prompted JSON (the SYSTEM_PROMPT asks for a
// bare JSON object), NOT via output_config structured outputs: PATCH's effects
// field is a discriminated union over all 16 effect types, and its compiled
// strict grammar exceeds Anthropic's grammar-size limit ("compiled grammar is
// too large"). sanitizePatch is the trust boundary regardless — it coerces any
// parsed object into a complete, range-clamped, playable patch.

import { EFFECT_DEFS, EFFECT_TYPES } from '../Workstation/effectDefs';
import { sanitizePatch, MAX_EFFECTS, MAX_LAYERS } from './patchSchema';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// One-line sonic character per effect — the model picks by sound, not by name.
const FX_CHARACTER = {
  filter:     'static tone shaping — darken (lowpass), thin out (highpass), or hollow (bandpass)',
  delay:      'rhythmic echoes; feedback = repeat count, lo/hi cut darken successive repeats',
  reverb:     'space and depth, from small room to huge wash',
  doubler:    'thickening chorus-style detune, subtle to lush',
  autofilter: 'LFO-driven rhythmic filter sweep (wobble / movement)',
  autowah:    'envelope wah that opens with note attacks (funky / vocal)',
  eq:         'broad 3-band tone tilt in dB',
  distortion: 'grit and saturation, from warm edge to fuzz',
  compressor: 'evens dynamics, adds punch and sustain',
  phaser:     'swirling notch sweep, slow and dreamy or fast and watery',
  bitcrusher: 'lo-fi digital crunch (fewer bits = harsher)',
  tremolo:    'amplitude pulse; spread widens it across the stereo field',
  vibrato:    'pitch wobble, subtle drift to seasick',
  widener:    'stereo width, mono (0) to extra wide (1)',
  pitchshift: 'parallel pitch layer in semitones (octaves, fifths, shimmer)',
  autopanner: 'automatic left↔right movement',
};

const fxSection = () => EFFECT_TYPES.map((t) => {
  const def = EFFECT_DEFS[t];
  const params = Object.entries(def.params).map(([k, m]) => {
    if (m.kind === 'toggle') return `${k} (on/off)`;
    if (m.kind === 'select') return `${k} (${m.options.join('|')})`;
    return `${k} ${m.min}–${m.max}${m.unit ? ` ${m.unit}` : ''} (default ${m.default})`;
  }).join(', ');
  return `- "${t}" (${def.label}): ${FX_CHARACTER[t]}. Params: ${params}`;
}).join('\n');

// Static bytes — built once at module load, user text goes only in the user
// message (prompt-cache friendly).
const SYSTEM_PROMPT = `You are an expert synthesizer sound designer. You translate a plain-language description of an instrument into a patch for a Tone.js synthesis engine, returned as JSON matching the provided schema.

A patch is a STACK of 1–${MAX_LAYERS} "layers" that all sound together when a key is played. Each layer is a complete voice (engine + envelope + filter + insert-FX + level + pitch offset).

## Layering
- Use ONE layer for simple, clean, or focused sounds — a single bass, lead, or pluck. Most patches are one layer; do not add layers a description doesn't call for.
- Use 2–3 layers only for rich, immersive, or "big" sounds. Classic stacks: a sine/triangle SUB an octave down + a body layer at pitch + a bright SHIMMER an octave up. Give each layer a distinct role and balance them with per-layer "volume".
- Per-layer pitch offset: "octave" is a whole-octave shift (−4 to 4) — use −1 for a sub-octave, +1 or +2 for a shimmer, 0 to play at the note. "semitone" (−12 to 12) fine-tunes on top of the octave — use it for intervals (e.g. +7 for a fifth) or a couple of cents' worth of detune between layers.

## Voice engines (per layer)
- "simple": one oscillator through an amp envelope. Clean, direct — basses, leads, pads, organs. Use fat* oscillators for thickness (they add unison voices — set "count" 1–8 and "spread" 0–100 cents), "pulse" for hollow/reedy.
- "fm": frequency modulation. Bells, electric pianos, metallic plucks, clangorous or glassy tones. "harmonicity" is the carrier:modulator ratio (integers = harmonic/musical, non-integers = inharmonic/bell-like/metallic). "modulationIndex" is brightness/edge: 1–5 mellow, 5–15 bright, 15–40 harsh.
- "am": amplitude modulation. Organ-like, hollow, tremolo-textured tones. "harmonicity" shifts the modulator's tuning.
- "portamento" (0–0.5 s, any engine): glide time between successive notes — 0 for none, small values for a legato slide. Optional; omit for none.

## Envelope (seconds, per layer)
attack 0.001–2 (percussive <0.01, pads 0.3–2), decay 0.001–2, sustain 0–1 (plucks/keys near 0, sustained tones 0.5–1), release 0.001–3.

## Filter (per layer)
Optional static filter: type lowpass|highpass|bandpass, frequency 40–18000 Hz, q 0.1–12 (higher q = resonant peak). Use null for no filtering. Most layers benefit from a gentle lowpass to tame digital edge.

## Effects (per layer — insert chain, array order = signal order)
Use at most ${MAX_EFFECTS - 1} effects per layer; fewer is usually better. Put distortion/compression early, modulation mid, delay/reverb last.
${fxSection()}

## Output
- Each layer's "volume": that layer's level in the mix, dB (−30 to 6). Balance the stack — often a sub sits a little lower, a shimmer a little lower still.
- Top-level "volume": the master output level in dB (−30 to 6). Default to −6; go lower for dense/resonant patches.
- name: a short, evocative patch name (1–4 words).
- Keep every number inside its stated range. Make deliberate, musical choices that match the user's description rather than defaults.

## Response format
Respond with ONLY a single JSON object — no markdown code fences, no prose before or after. Use exactly this shape:

{
  "name": "string",
  "volume": -6,
  "layers": [
    {
      "voice": { "engine": "simple|fm|am", "oscillator": "<one oscillator type>", "harmonicity": 3, "modulationIndex": 10, "modulationOscillator": "sine", "count": 3, "spread": 20, "portamento": 0 },
      "envelope": { "attack": 0.01, "decay": 0.1, "sustain": 0.5, "release": 0.3 },
      "filter": { "type": "lowpass|highpass|bandpass", "frequency": 5000, "q": 1 },
      "effects": [ { "type": "<effect type>", "params": { } } ],
      "volume": 0,
      "octave": 0,
      "semitone": 0
    }
  ]
}

- 1 to ${MAX_LAYERS} layers — the user message states the maximum allowed for THIS request; never exceed it. Prefer 1 unless richness is called for.
- Include voice.harmonicity + modulationOscillator only for fm/am, and modulationIndex only for fm; omit them for simple. Include voice.count + voice.spread only for fat* oscillators. Include voice.portamento only when a glide is wanted.
- Each layer's filter may be null for no filtering.
- Use at most ${MAX_EFFECTS - 1} effects per layer; each effect's "params" object uses only that effect's parameter keys listed above.`;

export function getSystemPrompt() { return SYSTEM_PROMPT; }

/**
 * Generate a patch from a text description.
 * Returns { patch } on success, { refusal: true } if the model declined.
 * Throws on API/network errors — map with describeApiError.
 */
export async function generatePatch({ apiKey, model, description, mode = 'patch', maxTokens = 2048, maxLayers = 3 }) {
  if (mode === 'sample') {
    // STUB — future text-to-audio backend (e.g. Stable Audio): generate a
    // short single-note wav, return { mode: 'sample', sampleUrl, rootNote }
    // for useAIInstrument's Sampler path. Not implemented.
    throw new Error("sample mode isn't available yet");
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      // The per-request layer cap rides the (uncached) user turn so the system
      // prompt stays byte-identical and prompt-cache-friendly.
      messages: [{ role: 'user', content: `${description}\n\nUse at most ${maxLayers} layer${maxLayers === 1 ? '' : 's'} for this instrument.` }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* non-JSON body */ }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const response = await res.json();
  if (response.stop_reason === 'refusal') return { refusal: true };
  if (response.stop_reason === 'max_tokens') {
    throw new Error('response was cut short — switch tokens to “high”, or use fewer layers / a simpler description');
  }
  const text = (response.content ?? []).find((b) => b.type === 'text')?.text ?? '';
  return { patch: sanitizePatch(parsePatchJson(text)) };
}

// Isolate the JSON object from the model's text reply — tolerates stray prose or
// ```json fences by slicing between the first '{' and last '}'. sanitizePatch
// handles any structural imperfection past that; only a genuinely unparseable
// reply throws.
function parsePatchJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('the model did not return a patch — try again');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('the model returned malformed JSON — try again');
  }
}

// HTTP-status mapping — kind: 'auth' should open the key-settings UI.
export function describeApiError(err) {
  if (err?.status === 401) {
    return { kind: 'auth', msg: 'invalid API key — check your key in settings' };
  }
  if (err?.status === 429) {
    return { kind: 'rate', msg: 'rate limited — wait a moment and try again' };
  }
  if (typeof err?.status === 'number') {
    return { kind: 'api', msg: `API error ${err.status} — try again` };
  }
  return { kind: 'other', msg: err?.message || 'request failed — check your connection' };
}
