// Patch → Tone.PolySynth builder for the AI Instrument Generator.
//
// Deliberately a peer to synthFactory.js, not an extension of it: the factory
// is keyed by workstation instrument *names* and feeds voiceSpecFor/glide
// pools; an AI patch is free-form parameter data on a different axis. The
// option shapes below mirror voiceSpecFor exactly so the timbres stay within
// what Tone 15.1.22 verifiably accepts.
//
// Caller owns routing and disposal. Input must already be sanitized
// (patchSchema.sanitizePatch) — nothing here re-validates ranges.

import * as Tone from 'tone';

const MAX_POLYPHONY = 16; // one page, one instrument — no quality-tier plumbing

// Voice class + constructor options for a patch — the single source both the
// PolySynth (makePatchSynth) and the bare mono glide voice
// (customInstrumentSynth.makeMonoGlideVoice) build from, so a glide voice is
// timbre-identical to the polyphonic voices. Mirrors synthFactory.voiceSpecFor.
export function patchVoiceSpec(patch) {
  const { voice, envelope } = patch;
  switch (voice.engine) {
    case 'fm':
      return { Voice: Tone.FMSynth, options: {
        harmonicity: voice.harmonicity ?? 3,
        modulationIndex: voice.modulationIndex ?? 10,
        oscillator: { type: voice.oscillator },
        modulation: { type: voice.modulationOscillator ?? 'sine' },
        envelope,
      } };
    case 'am':
      return { Voice: Tone.AMSynth, options: {
        harmonicity: voice.harmonicity ?? 2,
        oscillator: { type: voice.oscillator },
        modulation: { type: voice.modulationOscillator ?? 'sine' },
        envelope,
      } };
    default:
      return { Voice: Tone.Synth, options: {
        oscillator: { type: voice.oscillator },
        envelope,
      } };
  }
}

export function makePatchSynth(patch) {
  const { Voice, options } = patchVoiceSpec(patch);
  const synth = new Tone.PolySynth(Voice, options);
  synth.maxPolyphony = MAX_POLYPHONY;
  return synth;
}
