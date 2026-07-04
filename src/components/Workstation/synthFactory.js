import * as Tone from 'tone';
import { SAMPLED_INSTRUMENTS, SAMPLED_INSTRUMENT_NAMES, SAMPLED_MELODIC_NAMES } from './sampleInstruments';
import { DRUM_KIT_NAMES, isDrumKit, chokeTargetsFor } from './drumKits';

// sampleInstruments added Phase 131 — re-exported for RegionEditor / audioBounce consumers
export const SYNTH_INSTRUMENTS = [
  'fm pluck', 'analog', 'strings', 'am', 'pluck',
  'sine', 'square', 'sawtooth', 'triangle',
];

export { SAMPLED_INSTRUMENT_NAMES, SAMPLED_MELODIC_NAMES, DRUM_KIT_NAMES, isDrumKit, chokeTargetsFor };

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
const envFor = (instrument) => ({ ...(SYNTH_ENVELOPES[instrument] ?? DEFAULT_SYNTH_ENV) });

// The effective amplitude envelope a track starts from before any override.
// Melodic PolySynths → full ADSR; sampled melodic → attack/release only (the
// only fields Tone.Sampler exposes); drum kits → null (no ADSR surface).
export function defaultEnvelopeFor(instrument) {
  if (isDrumKit(instrument)) return null;
  if (isSampledInstrument(instrument)) {
    const cfg = SAMPLED_INSTRUMENTS[instrument];
    return { attack: 0, release: cfg?.release ?? 1 };
  }
  return envFor(instrument);
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

// Builds a fresh PolySynth or Tone.Sampler for the given instrument name.
// Caller owns disposal and routing. For sampled instruments, pass { onLoad }
// to be notified when buffers are decoded; Tone.Sampler silently ignores
// triggers before load completes. Pass { envelope } to apply a per-track ADSR
// override on top of the instrument default.
export function makeSynth(instrument, opts = {}) {
  let synth;
  if (isSampledInstrument(instrument)) {
    const cfg = SAMPLED_INSTRUMENTS[instrument];
    synth = new Tone.Sampler({
      urls: cfg.urls,
      baseUrl: cfg.baseUrl,
      release: cfg.release,
      onload: opts.onLoad,
    });
  } else {
    switch (instrument) {
      case 'fm pluck':
        synth = new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 3, modulationIndex: 10,
          envelope: envFor('fm pluck'),
        });
        break;
      case 'strings':
        synth = new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 3.5, modulationIndex: 10,
          oscillator: { type: 'sawtooth' },
          modulation: { type: 'sine' },
          envelope: envFor('strings'),
          modulationEnvelope: { attack: 0.5, decay: 0.1, sustain: 0.8, release: 0.6 },
        });
        break;
      case 'am':
        synth = new Tone.PolySynth(Tone.AMSynth, {
          harmonicity: 2,
          envelope: envFor('am'),
        });
        break;
      case 'pluck':
        synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'sawtooth' },
          envelope: envFor('pluck'),
        });
        break;
      case 'sine':
      case 'square':
      case 'sawtooth':
      case 'triangle':
        synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: instrument },
          envelope: envFor(instrument),
        });
        break;
      case 'analog':
      default:
        synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: envFor('analog'),
        });
        break;
    }
  }
  if (opts.envelope) applyEnvelope(synth, opts.envelope);
  return synth;
}
