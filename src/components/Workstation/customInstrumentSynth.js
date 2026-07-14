// Composite "custom instrument" node — a full AI-generator patch baked into a
// single self-contained instrument the workstation can treat like any poly
// synth. Graph mirrors useAIInstrument exactly:
//
//   makePatchSynth(patch) → Tone.Filter → [makeFxGraph…] → Tone.Volume(out)
//
// The whole patch character (voice + envelope + filter + insert-FX + level) is
// encapsulated here, BEFORE the track's own volume/pan/insert-FX chain — so a
// track using a custom instrument sounds exactly like the generator while its
// own FX rack stays separate.
//
// The object is NOT a Tone.PolySynth, but it quacks like one everywhere the
// engine looks: triggerAttack/Release/AttackRelease/releaseAll/set/dispose
// delegate to the inner PolySynth, `.connect/.disconnect` delegate to the
// output Volume, and `activeVoices` is exposed so synthIsRinging (which
// duck-types on `typeof s.activeVoices === 'number'`) and applyEnvelope (which
// duck-types on `synth.set`) both work with no engine changes. `toSeconds`
// delegates too — Tone.Part callbacks call it on the scheduled instrument, and
// a plain class (unlike a real Tone node) doesn't inherit it.
//
// Glide is supported: makeMonoGlideVoice builds a MONO version of this graph
// (bare voice + filter + FX) exposing the `detune`/`volume` the glide scheduler
// writes — so custom-instrument glides keep the patch's filter/FX character.

import * as Tone from 'tone';
import { makePatchSynth, patchVoiceSpec } from '../AIGen/patchSynth';
import { makeFxGraph } from './fxChain';

// Transparent filter when patch.filter is null (matches useAIInstrument).
const FILTER_NEUTRAL = { type: 'lowpass', frequency: 18000, q: 0.7071 };

class CustomInstrumentNode {
  constructor(patch) {
    const f = patch.filter ?? FILTER_NEUTRAL;
    this._synth  = makePatchSynth(patch);
    this._filter = new Tone.Filter({ type: f.type, frequency: f.frequency, Q: f.q });
    this._fx     = (patch.effects ?? []).map((e) => makeFxGraph(e.type, e.params));
    this._out    = new Tone.Volume(patch.volume ?? -6);

    this._synth.connect(this._filter);
    let node = this._filter;
    for (const g of this._fx) { node.connect(g.in); node = g.out; }
    node.connect(this._out);

    this.disposed = false;
  }

  // ── routing → output Volume ──────────────────────────────────────────────
  connect(dest, ...rest)   { this._out.connect(dest, ...rest); return this; }
  disconnect(...args)      { this._out.disconnect(...args);    return this; }
  toDestination()          { this._out.toDestination();        return this; }

  // ── voice control → inner PolySynth ──────────────────────────────────────
  triggerAttack(...a)        { this._synth.triggerAttack(...a);        return this; }
  triggerRelease(...a)       { this._synth.triggerRelease(...a);       return this; }
  triggerAttackRelease(...a) { this._synth.triggerAttackRelease(...a); return this; }
  releaseAll(...a)           { this._synth.releaseAll(...a);           return this; }
  set(opts)                  { this._synth.set(opts);                  return this; }
  get(...a)                  { return this._synth.get(...a); }          // hardCutSynth reads envelope.release

  // Tone time/pitch parsers — Tone.Part callbacks call synth.toSeconds; a plain
  // class doesn't inherit them, which is the "toSeconds is not a function" crash.
  toSeconds(x)   { return this._synth.toSeconds(x); }
  toFrequency(x) { return this._synth.toFrequency(x); }

  get activeVoices()  { return this._synth.activeVoices; }
  get maxPolyphony()  { return this._synth.maxPolyphony; }
  set maxPolyphony(v) { this._synth.maxPolyphony = v; }

  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    try { this._synth.releaseAll(); } catch { /* context may be closed */ }
    this._synth.dispose();
    this._filter.dispose();
    this._fx.forEach((g) => g.dispose());
    this._out.dispose();
    return this;
  }
}

export function makeCustomInstrumentNode(patch) {
  return new CustomInstrumentNode(patch);
}

// ── Mono glide voice ────────────────────────────────────────────────────────
// A MONO version of the composite for per-note portamento chains: one bare
// voice (schedulable `detune`) through the patch's filter + FX, so a
// custom-instrument glide keeps the same tone as its sustained notes. The glide
// scheduler (scheduleGlideSynthVoice) is the SINGLE writer of `detune`/`volume`
// — both delegate to the inner voice's own Signal/Param.
class MonoGlideVoice {
  constructor(patch, opts = {}) {
    const f = patch.filter ?? FILTER_NEUTRAL;
    const { Voice, options } = patchVoiceSpec(patch);
    this._voice  = new Voice(options);
    this._filter = new Tone.Filter({ type: f.type, frequency: f.frequency, Q: f.q });
    this._fx     = (patch.effects ?? []).map((e) => makeFxGraph(e.type, e.params));
    this._out    = new Tone.Volume(patch.volume ?? -6);

    this._voice.connect(this._filter);
    let node = this._filter;
    for (const g of this._fx) { node.connect(g.in); node = g.out; }
    node.connect(this._out);

    // Track ADSR override (custom tracks can carry one) → inner voice.
    if (opts.envelope) {
      const e = {};
      for (const k of ['attack', 'decay', 'sustain', 'release']) if (opts.envelope[k] != null) e[k] = opts.envelope[k];
      if (Object.keys(e).length) this._voice.set({ envelope: e });
    }
    this.disposed = false;
  }

  // Scheduler writes these two (Signal + Param) — expose the inner voice's own.
  get detune() { return this._voice.detune; }
  get volume() { return this._voice.volume; }

  triggerAttack(...a)  { this._voice.triggerAttack(...a);  return this; }
  triggerRelease(...a) { this._voice.triggerRelease(...a); return this; }
  set(opts)            { this._voice.set(opts); return this; }  // silenceAll hard-cut + envelope sync
  get(...a)            { return this._voice.get(...a); }        // pool steal reads envelope.release
  connect(dest, ...r)  { this._out.connect(dest, ...r);   return this; }
  disconnect(...a)     { this._out.disconnect(...a);      return this; }

  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    try { this._voice.triggerRelease(); } catch { /* context may be closed */ }
    this._voice.dispose();
    this._filter.dispose();
    this._fx.forEach((g) => g.dispose());
    this._out.dispose();
    return this;
  }
}

export function makeMonoGlideVoice(patch, opts = {}) {
  return new MonoGlideVoice(patch, opts);
}
