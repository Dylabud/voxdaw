import * as Tone from 'tone';
import { SAMPLED_INSTRUMENTS, SAMPLED_INSTRUMENT_NAMES, SAMPLED_MELODIC_NAMES } from './sampleInstruments';
import { DRUM_KIT_NAMES, isDrumKit, chokeTargetsFor } from './drumKits';
import { isCustomInstrument, getCustomInstrument } from './customInstruments';
import { makeCustomInstrumentNode, makeMonoGlideVoice } from './customInstrumentSynth';
import { getSampleSet } from './customSampleStore';
import { isVoxInstrument } from './voxInstruments';

// sampleInstruments added Phase 131 — re-exported for RegionEditor / audioBounce consumers
export const SYNTH_INSTRUMENTS = [
  'fm pluck', 'analog', 'strings', 'am', 'pluck',
  'sine', 'square', 'sawtooth', 'triangle',
];

export { SAMPLED_INSTRUMENT_NAMES, SAMPLED_MELODIC_NAMES, DRUM_KIT_NAMES, isDrumKit, chokeTargetsFor };
export { isCustomInstrument, isVoxInstrument };

export const INSTRUMENTS = [...SYNTH_INSTRUMENTS, ...SAMPLED_INSTRUMENT_NAMES];

export function isSampledInstrument(name) {
  return Object.prototype.hasOwnProperty.call(SAMPLED_INSTRUMENTS, name);
}

// Per-instrument amplitude ADSR — the single source of truth for both the
// synth build below and the instrument-tab ADSR knobs (defaultEnvelopeFor).
// 'analog' is the default; the plain oscillator voices share one envelope.
const DEFAULT_SYNTH_ENV = { attack: 0.005, decay: 0.12, sustain: 0.3, release: 0.25 };
const PLAIN_OSC_ENV     = { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 };
const SYNTH_ENVELOPES = {
  'fm pluck': { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
  'strings':  { attack: 0.3, decay: 0.2, sustain: 0.8, release: 0.8 },
  'am':       { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
  'pluck':    { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
  'sine':     PLAIN_OSC_ENV, 'square': PLAIN_OSC_ENV,
  'sawtooth': PLAIN_OSC_ENV, 'triangle': PLAIN_OSC_ENV,
  'analog':   DEFAULT_SYNTH_ENV,
};
// Release for a vox take whose sample set isn't decoded (yet, or on this machine).
const VOX_FALLBACK_RELEASE = 0.3;
// Shortest fade-in a vox take note ever gets (Phase 133). A rest-gated (droning) patch
// is photographed mid-waveform at full level from its first sample, so with attack 0
// every note started as a step from silence — a click on each note, loudest on
// back-to-back sequencer lines. 5 ms is below any audible softening of the attack.
const VOX_MIN_FADE_IN = 0.005;
const envFor = (instrument) => ({ ...(SYNTH_ENVELOPES[instrument] ?? DEFAULT_SYNTH_ENV) });

// The effective amplitude envelope a track starts from before any override.
// Melodic PolySynths → full ADSR; sampled melodic → attack/release only (the
// only fields Tone.Sampler exposes); drum kits → null (no ADSR surface).
export function defaultEnvelopeFor(instrument, { useSampled = false } = {}) {
  if (isDrumKit(instrument)) return null;
  // Vox take (Phase 130): a real Tone.Sampler over the photographed notes →
  // attack/release only, with the release measured at photograph time.
  if (isVoxInstrument(instrument)) {
    return { attack: 0, release: getSampleSet(instrument)?.release ?? VOX_FALLBACK_RELEASE };
  }
  // Custom instrument: a patch is a STACK of layers, each with its own envelope
  // baked in at build. A SINGLE layer → its own ADSR (applying it is a no-op).
  // MULTIPLE layers → null: there is no single default, and returning one would
  // make the envelope-sync (effect 3c) clobber every layer with it — the
  // multi-layer "silent/wrong layer" bug. Null makes applyEnvelope a no-op, so
  // each layer keeps the envelope makePatchSynth built it with.
  // In SAMPLED mode the instrument is a real Tone.Sampler → attack/release
  // only, with the release the render was fading with (customMaxRelease).
  if (isCustomInstrument(instrument)) {
    if (useSampled) return { attack: 0, release: customMaxRelease(instrument) ?? 1 };
    const layers = getCustomInstrument(instrument)?.patch?.layers;
    return layers && layers.length === 1 ? { ...layers[0].envelope } : null;
  }
  if (isSampledInstrument(instrument)) {
    const cfg = SAMPLED_INSTRUMENTS[instrument];
    return { attack: 0, release: cfg?.release ?? 1 };
  }
  return envFor(instrument);
}

// Longest release across a custom instrument's layers (for tail estimation —
// defaultEnvelopeFor returns null for multi-layer, so activity-pruning/bounce
// can't read a single release from it). null for non-custom / unknown ids.
export function customMaxRelease(instrument) {
  if (!isCustomInstrument(instrument)) return null;
  const layers = getCustomInstrument(instrument)?.patch?.layers;
  if (!layers?.length) return null;
  return layers.reduce((m, l) => Math.max(m, l.envelope?.release ?? 0), 0);
}

// Apply an ADSR override to a live synth — one path for both node kinds.
// PolySynth → set the full envelope (only the keys present); Tone.Sampler →
// its plain attack/release setters (no decay/sustain). No-op when env is
// nullish or the synth is gone. Called at build time and by the live sync
// effect when track.envelope changes.
export function applyEnvelope(synth, env) {
  if (!synth || synth.disposed || !env) return;
  if (synth instanceof Tone.Sampler) {
    if (env.attack  != null) synth.attack  = env.attack;
    if (env.release != null) synth.release = env.release;
    return;
  }
  if (typeof synth.set === 'function') {
    const e = {};
    for (const k of ['attack', 'decay', 'sustain', 'release']) if (env[k] != null) e[k] = env[k];
    if (Object.keys(e).length) synth.set({ envelope: e });
  }
}

// Voice class + constructor options for each synth-family instrument — the
// single source both makeSynth (PolySynth wrapper) and makeGlideVoice (bare
// mono voice for per-note glide scheduling) build from, so a glide voice is
// timbre-identical to the track's polyphonic voices.
function voiceSpecFor(instrument) {
  switch (instrument) {
    case 'fm pluck':
      return { Voice: Tone.FMSynth, options: {
        harmonicity: 3, modulationIndex: 10,
        envelope: envFor('fm pluck'),
      } };
    case 'strings':
      return { Voice: Tone.FMSynth, options: {
        harmonicity: 3.5, modulationIndex: 10,
        oscillator: { type: 'sawtooth' },
        modulation: { type: 'sine' },
        envelope: envFor('strings'),
        modulationEnvelope: { attack: 0.5, decay: 0.1, sustain: 0.8, release: 0.6 },
      } };
    case 'am':
      return { Voice: Tone.AMSynth, options: {
        harmonicity: 2,
        envelope: envFor('am'),
      } };
    case 'pluck':
      return { Voice: Tone.Synth, options: {
        oscillator: { type: 'sawtooth' },
        envelope: envFor('pluck'),
      } };
    case 'sine':
    case 'square':
    case 'sawtooth':
    case 'triangle':
      return { Voice: Tone.Synth, options: {
        oscillator: { type: instrument },
        envelope: envFor(instrument),
      } };
    case 'analog':
    default:
      return { Voice: Tone.Synth, options: {
        oscillator: { type: 'triangle' },
        envelope: envFor('analog'),
      } };
  }
}

// ── Vox take sampler with sustain loops (Vox Phase 131) ─────────────────────
// A photographed note is only 4 s long, so a held note used to stop dead at 4 s.
// voxFreeze now marks a seamless (pre-crossfaded) sustain loop inside each
// steady note; this Sampler plays those notes LOOPED so they hold for as long as
// the note does, then fade with the release on note-off. Decaying notes (plucks)
// carry no loop and play exactly as before.
//
// Still a real Tone.Sampler, so every _activeSources path (ghost-note fix,
// silenceAll, sampler glide, synthIsRinging) applies unchanged. Its own attack is
// a copy of Tone 15.1.22's Sampler.triggerAttack (PRIVATE _findClosest /
// _buffers / _activeSources) with one change: the loop is set BEFORE start().
// Setting `source.loop` after start runs cancelStop, which also cancels the
// fade-in ramp's target — any attack > 0 would leave the note silent at gain 0.
// Second change (Phase 133): a VOX_MIN_FADE_IN floor on every note's fade-in.
// Re-verify on a Tone bump, with the ghost-note fix; private fields missing →
// plain Sampler attack (no loop, the pre-131 behaviour).
class VoxLoopSampler extends Tone.Sampler {
  constructor(options) {
    super(options);
    this._voxLoops = options?.loops ?? {};
  }
  triggerAttack(notes, time, velocity = 1) {
    if (typeof this._findClosest !== 'function' || !this._buffers || !this._activeSources) {
      return super.triggerAttack(notes, time, velocity);
    }
    for (const note of Array.isArray(notes) ? notes : [notes]) {
      const midiFloat = 69 + 12 * Math.log2(this.toFrequency(note) / 440);
      const midi = Math.round(midiFloat);
      const difference = this._findClosest(midi);
      const closest = midi - difference;
      const buffer = this._buffers.get(closest);
      const playbackRate = Math.pow(2, (difference + (midiFloat - midi)) / 12);
      const lp = this._voxLoops[closest];
      const loop = Array.isArray(lp) && lp[1] > lp[0] && lp[1] <= buffer.duration;
      const source = new Tone.ToneBufferSource({
        url: buffer, context: this.context, curve: this.curve,
        fadeIn: Math.max(this.attack, VOX_MIN_FADE_IN), fadeOut: this.release, playbackRate,
        ...(loop ? { loop: true, loopStart: lp[0], loopEnd: lp[1] } : {}),
      }).connect(this.output);
      // Looped: no scheduled end — the note lasts until its release. Offset 0
      // explicitly (a looped start would otherwise default to loopStart).
      source.start(time, 0, loop ? undefined : buffer.duration / playbackRate, velocity);
      if (!Array.isArray(this._activeSources.get(midi))) this._activeSources.set(midi, []);
      this._activeSources.get(midi).push(source);
      source.onended = () => {
        const list = this._activeSources?.get(midi);
        const i = list ? list.indexOf(source) : -1;
        if (i !== -1) list.splice(i, 1);
      };
    }
    return this;
  }
}

// Builds a fresh PolySynth or Tone.Sampler for the given instrument name.
// Caller owns disposal and routing. For sampled instruments, pass { onLoad }
// to be notified when buffers are decoded; Tone.Sampler silently ignores
// triggers before load completes. Pass { envelope } to apply a per-track ADSR
// override on top of the instrument default.
export function makeSynth(instrument, opts = {}) {
  let synth;
  if (isVoxInstrument(instrument)) {
    // Vox take (Phase 130): the photographed notes, one every 3 semitones —
    // Tone.Sampler repitches the notes in between. Buffer urls → `loaded`
    // synchronously (the sampled-custom contract). No set decoded → default
    // synth; the prime completion bumps sampleSetsVersion and synthKeyFor
    // flips to 'S', so the reconciler hot-swaps the real sound in.
    const set = getSampleSet(instrument);
    if (set) {
      synth = new VoxLoopSampler({ urls: set.urls, release: set.release ?? VOX_FALLBACK_RELEASE, loops: set.loops });
    } else {
      const { Voice, options } = voiceSpecFor('analog');
      synth = new Tone.PolySynth(Voice, options);
    }
  } else if (isCustomInstrument(instrument)) {
    // Baked composite (voice + filter + FX + level). Missing def (imported id
    // this machine never registered) → graceful default synth, same spirit as
    // the deserialize instrument fallback.
    // SAMPLED mode (opts.useSampled + a rendered set in the cache) → a REAL
    // Tone.Sampler over the pre-rendered per-note buffers: one buffer source
    // per note instead of N layer synths + FX. Buffer urls make `loaded` true
    // synchronously, so none of the sampler loading bookkeeping applies. Being
    // a genuine Sampler also opts it into the engine's _activeSources paths
    // (ghost-note fix, silenceAll hard-cut, glide playbackRate chains). No set
    // in the cache yet → live composite fallback (the UI shows render/prime).
    const def = getCustomInstrument(instrument);
    const set = opts.useSampled ? getSampleSet(instrument) : null;
    if (set) {
      synth = new Tone.Sampler({
        urls: set.urls,
        release: set.release ?? customMaxRelease(instrument) ?? 0.1,
      });
    } else if (def) {
      synth = makeCustomInstrumentNode(def.patch);
    } else {
      const { Voice, options } = voiceSpecFor('analog');
      synth = new Tone.PolySynth(Voice, options);
    }
  } else if (isSampledInstrument(instrument)) {
    const cfg = SAMPLED_INSTRUMENTS[instrument];
    synth = new Tone.Sampler({
      urls: cfg.urls,
      baseUrl: cfg.baseUrl,
      release: cfg.release,
      onload: opts.onLoad,
    });
  } else {
    const { Voice, options } = voiceSpecFor(instrument);
    synth = new Tone.PolySynth(Voice, options);
  }
  if (opts.envelope) applyEnvelope(synth, opts.envelope);
  // Optional voice cap (performance quality tiers) — Samplers have no voice pool.
  if (opts.maxPolyphony != null && !(synth instanceof Tone.Sampler)) {
    synth.maxPolyphony = opts.maxPolyphony;
  }
  return synth;
}

// Bare mono voice for glide chains (synth-family instruments only). Exposes a
// schedulable `detune` Signal (cents) that PolySynth can't provide — the glide
// scheduler owns it exclusively (Single Writer). Caller owns routing/disposal.
export function makeGlideVoice(instrument, opts = {}) {
  // Custom instrument: a mono version of its baked composite (voice + filter +
  // FX) so glides keep the patch's tone. Missing def → bare-voice fallback.
  if (isCustomInstrument(instrument)) {
    const def = getCustomInstrument(instrument);
    if (def) return makeMonoGlideVoice(def.patch, opts);
  }
  const { Voice, options } = voiceSpecFor(instrument);
  const voice = new Voice(options);
  if (opts.envelope) applyEnvelope(voice, opts.envelope);
  return voice;
}
