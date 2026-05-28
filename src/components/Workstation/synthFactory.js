import * as Tone from 'tone';
import { SAMPLED_INSTRUMENTS, SAMPLED_INSTRUMENT_NAMES } from './sampleInstruments';

// sampleInstruments added Phase 131 — re-exported for RegionEditor / audioBounce consumers
export const SYNTH_INSTRUMENTS = [
  'fm pluck', 'analog', 'strings', 'am', 'pluck',
  'sine', 'square', 'sawtooth', 'triangle',
];

export { SAMPLED_INSTRUMENT_NAMES };

export const INSTRUMENTS = [...SYNTH_INSTRUMENTS, ...SAMPLED_INSTRUMENT_NAMES];

export function isSampledInstrument(name) {
  return Object.prototype.hasOwnProperty.call(SAMPLED_INSTRUMENTS, name);
}

// Builds a fresh PolySynth or Tone.Sampler for the given instrument name.
// Caller owns disposal and routing. For sampled instruments, pass { onLoad }
// to be notified when buffers are decoded; Tone.Sampler silently ignores
// triggers before load completes.
export function makeSynth(instrument, opts = {}) {
  if (isSampledInstrument(instrument)) {
    const cfg = SAMPLED_INSTRUMENTS[instrument];
    return new Tone.Sampler({
      urls: cfg.urls,
      baseUrl: cfg.baseUrl,
      release: cfg.release,
      onload: opts.onLoad,
    });
  }
  switch (instrument) {
    case 'fm pluck':
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3, modulationIndex: 10,
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
      });
    case 'strings':
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3.5, modulationIndex: 10,
        oscillator: { type: 'sawtooth' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.3, decay: 0.2, sustain: 0.8, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 0.1, sustain: 0.8, release: 0.6 },
      });
    case 'am':
      return new Tone.PolySynth(Tone.AMSynth, {
        harmonicity: 2,
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.3 },
      });
    case 'pluck':
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
      });
    case 'sine':
    case 'square':
    case 'sawtooth':
    case 'triangle':
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: instrument },
        envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 },
      });
    case 'analog':
    default:
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.005, decay: 0.12, sustain: 0.3, release: 0.25 },
      });
  }
}
