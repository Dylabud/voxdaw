// Patch layer → Tone.PolySynth builder for the AI Instrument Generator.
//
// Deliberately a peer to synthFactory.js, not an extension of it: the factory
// is keyed by workstation instrument *names* and feeds voiceSpecFor/glide
// pools; an AI patch is free-form parameter data on a different axis. The
// option shapes below mirror voiceSpecFor exactly so the timbres stay within
// what Tone 15.1.22 verifiably accepts.
//
// A patch is a stack of layers (patchSchema); these builders operate on ONE
// layer (voice + envelope + fat-osc unison + portamento). The per-layer pitch
// offset (transpose + detune) is applied to the built synth's `detune` param —
// see layerDetuneCents. Caller owns routing and disposal. Input must already be
// sanitized (patchSchema.sanitizeLayer) — nothing here re-validates ranges.

import * as Tone from 'tone';
import { layerDetuneCents } from './patchSchema';

// Workstation default (custom-instrument layers); the generator raises it (see
// useAIInstrument) so long-release stacked chords don't drop notes.
const DEFAULT_MAX_POLYPHONY = 16;

// Oscillator options for a layer — folds in fat-osc unison (count/spread) when
// the oscillator is a fat* type; those keys are Tone-ignored on non-fat types
// but sanitizeLayer only ever emits them for fat oscillators.
function oscOptions(voice) {
  const osc = { type: voice.oscillator };
  if (voice.count != null)  osc.count  = voice.count;
  if (voice.spread != null) osc.spread = voice.spread;
  return osc;
}

// Voice class + constructor options for a layer — the single source both the
// PolySynth (makePatchSynth) and the bare mono glide voice
// (customInstrumentSynth.makeMonoGlideVoice) build from, so a glide voice is
// timbre-identical to the polyphonic voices. Mirrors synthFactory.voiceSpecFor.
export function patchVoiceSpec(layer) {
  const { voice, envelope } = layer;
  const portamento = voice.portamento ?? 0;
  switch (voice.engine) {
    case 'fm':
      return { Voice: Tone.FMSynth, options: {
        harmonicity: voice.harmonicity ?? 3,
        modulationIndex: voice.modulationIndex ?? 10,
        oscillator: oscOptions(voice),
        modulation: { type: voice.modulationOscillator ?? 'sine' },
        envelope,
        portamento,
      } };
    case 'am':
      return { Voice: Tone.AMSynth, options: {
        harmonicity: voice.harmonicity ?? 2,
        oscillator: oscOptions(voice),
        modulation: { type: voice.modulationOscillator ?? 'sine' },
        envelope,
        portamento,
      } };
    default:
      return { Voice: Tone.Synth, options: {
        oscillator: oscOptions(voice),
        envelope,
        portamento,
      } };
  }
}

// One PolySynth for one layer, pitched by the layer's octave offset.
export function makePatchSynth(layer, { maxPolyphony = DEFAULT_MAX_POLYPHONY } = {}) {
  const { Voice, options } = patchVoiceSpec(layer);
  const synth = new Tone.PolySynth(Voice, options);
  synth.maxPolyphony = maxPolyphony;
  const cents = layerDetuneCents(layer);
  if (cents) synth.set({ detune: cents });
  return synth;
}
