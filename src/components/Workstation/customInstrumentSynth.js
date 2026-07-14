// Composite "custom instrument" node — a full AI-generator patch baked into a
// single self-contained instrument the workstation can treat like any poly
// synth. A patch is a STACK of 1–3 layers (patchSchema); each layer gets its
// own subgraph, all summed into the master output:
//
//   layerₙ:  makePatchSynth(layer) → Tone.Filter → [makeFxGraph…] → layerVol ─┐
//   …                                                                          ├→ Volume(out)
//   layer₀:  makePatchSynth(layer) → Tone.Filter → [makeFxGraph…] → layerVol ─┘
//
// Each layer's synth carries its own transpose/detune offset (makePatchSynth),
// so one played note produces the stacked octaves/overtones. The whole patch
// character (voices + envelopes + filters + insert-FX + per-layer level +
// master level) is encapsulated here, BEFORE the track's own volume/pan/insert-
// FX chain.
//
// The object is NOT a Tone.PolySynth, but it quacks like one everywhere the
// engine looks: triggerAttack/Release/AttackRelease/releaseAll/set fan out to
// every layer synth, `.connect/.disconnect` delegate to the output Volume, and
// `activeVoices` sums across layers so synthIsRinging (duck-types on
// `typeof s.activeVoices === 'number'`) and applyEnvelope (duck-types on
// `synth.set`) both work with no engine changes. `toSeconds` delegates too —
// Tone.Part callbacks call it on the scheduled instrument, and a plain class
// (unlike a real Tone node) doesn't inherit it.
//
// Glide is supported: makeMonoGlideVoice builds a MONO stack of this graph
// (bare voices + per-layer filter/FX), exposing ONE `detune`/`volume` the glide
// scheduler writes — a shared detune Signal fanned into each layer voice (whose
// own detune holds its static offset) and one master gain. So a multi-layer
// custom-instrument glide keeps every layer's tone AND its octave offset.

import * as Tone from 'tone';
import { makePatchSynth, patchVoiceSpec } from '../AIGen/patchSynth';
import { layersOf, layerDetuneCents } from '../AIGen/patchSchema';
import { makeFxGraph } from './fxChain';

// Transparent filter when a layer's filter is null (matches useAIInstrument).
const FILTER_NEUTRAL = { type: 'lowpass', frequency: 18000, q: 0.7071 };

// Build one layer's static output chain (filter → FX → per-layer volume) and
// connect a source node into it. Returns the disposables + the layer's tail
// (`vol`). Shared with useAIInstrument so the generator page and the baked
// workstation instrument build byte-identical per-layer graphs.
export function buildLayerChain(layer, source) {
  const f = layer.filter ?? FILTER_NEUTRAL;
  const filter = new Tone.Filter({ type: f.type, frequency: f.frequency, Q: f.q });
  const fx = (layer.effects ?? []).map((e) => makeFxGraph(e.type, e.params));
  const vol = new Tone.Volume(layer.volume ?? 0);

  source.connect(filter);
  let node = filter;
  for (const g of fx) { node.connect(g.in); node = g.out; }
  node.connect(vol);
  return { filter, fx, vol };
}

class CustomInstrumentNode {
  constructor(patch) {
    this._out = new Tone.Volume(patch.volume ?? -6);
    this._layers = layersOf(patch).map((layer) => {
      const synth = makePatchSynth(layer);
      const { filter, fx, vol } = buildLayerChain(layer, synth);
      vol.connect(this._out);
      return { synth, filter, fx, vol };
    });
    // Pool steal / hardCutSynth read envelope.release — delegate `get` to the
    // longest-release layer so a still-ringing layer isn't undercounted.
    this._lead = this._layers.reduce((a, b) =>
      (b.synth.get().envelope?.release ?? 0) > (a.synth.get().envelope?.release ?? 0) ? b : a
    , this._layers[0]).synth;
    this.disposed = false;
  }

  // ── routing → output Volume ──────────────────────────────────────────────
  connect(dest, ...rest)   { this._out.connect(dest, ...rest); return this; }
  disconnect(...args)      { this._out.disconnect(...args);    return this; }
  toDestination()          { this._out.toDestination();        return this; }

  // ── voice control → every layer's PolySynth ──────────────────────────────
  triggerAttack(...a)        { for (const l of this._layers) l.synth.triggerAttack(...a);        return this; }
  triggerRelease(...a)       { for (const l of this._layers) l.synth.triggerRelease(...a);       return this; }
  triggerAttackRelease(...a) { for (const l of this._layers) l.synth.triggerAttackRelease(...a); return this; }
  releaseAll(...a)           { for (const l of this._layers) l.synth.releaseAll(...a);           return this; }
  set(opts)                  { for (const l of this._layers) l.synth.set(opts);                  return this; }
  get(...a)                  { return this._lead.get(...a); }        // hardCutSynth reads envelope.release

  // Tone time/pitch parsers — Tone.Part callbacks call synth.toSeconds; a plain
  // class doesn't inherit them, which is the "toSeconds is not a function" crash.
  toSeconds(x)   { return this._lead.toSeconds(x); }
  toFrequency(x) { return this._lead.toFrequency(x); }

  get activeVoices()  { return this._layers.reduce((n, l) => n + (l.synth.activeVoices ?? 0), 0); }
  get maxPolyphony()  { return this._lead.maxPolyphony; }
  set maxPolyphony(v) { for (const l of this._layers) l.synth.maxPolyphony = v; }

  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    for (const l of this._layers) {
      try { l.synth.releaseAll(); } catch { /* context may be closed */ }
      l.synth.dispose();
      l.filter.dispose();
      l.fx.forEach((g) => g.dispose());
      l.vol.dispose();
    }
    this._out.dispose();
    return this;
  }
}

export function makeCustomInstrumentNode(patch) {
  return new CustomInstrumentNode(patch);
}

// ── Mono glide voice ────────────────────────────────────────────────────────
// A MONO stack of the composite for per-note portamento chains: one bare voice
// per layer (through that layer's filter + FX + level), summed into a master
// gain. The glide scheduler (scheduleGlideSynthVoice) is the SINGLE writer of
// `detune`/`volume`:
//   • `detune` is a shared Tone.Signal connected into every layer voice's own
//     `detune` — each voice's detune.value holds its static transpose/detune
//     offset, so the scheduler's portamento curve ADDS on top of each layer's
//     octave/interval.
//   • `volume` is a master Tone.Volume after the layer sum (per-layer static
//     level lives in each layer's own Volume).
class MonoGlideVoice {
  constructor(patch, opts = {}) {
    this._out      = new Tone.Volume(patch.volume ?? -6);
    this._glideVol = new Tone.Volume(0).connect(this._out); // scheduler writes .volume
    this._detune   = new Tone.Signal({ value: 0, units: 'cents' }); // scheduler writes this

    this._layers = layersOf(patch).map((layer) => {
      const { Voice, options } = patchVoiceSpec(layer);
      const voice = new Voice(options);
      // Track ADSR override (custom tracks can carry one) → this layer's voice.
      if (opts.envelope) {
        const e = {};
        for (const k of ['attack', 'decay', 'sustain', 'release']) if (opts.envelope[k] != null) e[k] = opts.envelope[k];
        if (Object.keys(e).length) voice.set({ envelope: e });
      }
      // Static layer offset lives on the voice's own detune; the shared signal
      // adds the portamento curve on top.
      voice.detune.value = layerDetuneCents(layer);
      this._detune.connect(voice.detune);

      const { filter, fx, vol } = buildLayerChain(layer, voice);
      vol.connect(this._glideVol);
      return { voice, filter, fx, vol };
    });
    this._lead = this._layers.reduce((a, b) =>
      (b.voice.get().envelope?.release ?? 0) > (a.voice.get().envelope?.release ?? 0) ? b : a
    , this._layers[0]).voice;
    this.disposed = false;
  }

  // Scheduler writes these two (Signal + Param) — one shared source each.
  get detune() { return this._detune; }
  get volume() { return this._glideVol.volume; }

  triggerAttack(...a)  { for (const l of this._layers) l.voice.triggerAttack(...a);  return this; }
  triggerRelease(...a) { for (const l of this._layers) l.voice.triggerRelease(...a); return this; }
  set(opts)            { for (const l of this._layers) l.voice.set(opts); return this; }  // silenceAll hard-cut + envelope sync
  get(...a)            { return this._lead.get(...a); }                                    // pool steal reads envelope.release
  connect(dest, ...r)  { this._out.connect(dest, ...r);   return this; }
  disconnect(...a)     { this._out.disconnect(...a);      return this; }

  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    for (const l of this._layers) {
      try { l.voice.triggerRelease(); } catch { /* context may be closed */ }
      l.voice.dispose();
      l.filter.dispose();
      l.fx.forEach((g) => g.dispose());
      l.vol.dispose();
    }
    this._detune.dispose();
    this._glideVol.dispose();
    this._out.dispose();
    return this;
  }
}

export function makeMonoGlideVoice(patch, opts = {}) {
  return new MonoGlideVoice(patch, opts);
}
