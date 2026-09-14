// Offline note renderer for the "sampled (CPU friendly)" custom-instrument
// mode: renders every chromatic note of a patch through the SAME graph the
// live engine builds (makeCustomInstrumentNode — layers, filters, FX, levels
// all baked in) so the resulting Tone.Sampler is sonically identical to the
// live composite, minus per-note release-tail nuance (the standard sampled-
// instrument compromise; playback fades with the patch's own max release).
//
// The Tone.Offline callback MUST stay fully synchronous: Offline swaps the
// GLOBAL Tone context for the callback's duration, and a synchronous callback
// closes the window in which unrelated async Tone work (live Part callbacks,
// glide-pool allocation) could build nodes into the wrong context — the same
// exposure class audioBounce.bounceProject already accepts.

import * as Tone from 'tone';
import { makeCustomInstrumentNode } from './customInstrumentSynth';
import { layersOf } from '../AIGen/patchSchema';
import { fxTailSec } from '../../hooks/useWorkstationAudio';
import { trimExportBuffer } from '../../utils/audioExport';

// C1..C7 chromatic — 73 notes. Outside the range Tone.Sampler repitches from
// the nearest (edge) sample automatically.
export const SAMPLE_MIN_MIDI = 24;
export const SAMPLE_MAX_MIDI = 96;
export const SAMPLE_NOTE_COUNT = SAMPLE_MAX_MIDI - SAMPLE_MIN_MIDI + 1;

// ≈ 8 bars at 120 BPM — the held-note ceiling of a sampled instrument. A
// sustain-0 (fading) patch goes silent long before this and the trailing-
// silence trim keeps its samples short; only true sustainers pay full length.
export const SAMPLE_SUSTAIN_SEC = 16;
const RELEASE_PAD_SEC = 0.3;
const RENDER_CAP_SEC = 45; // defensive cap on pathological delay/reverb tails

// Pure duration math (unit-tested): sustain + longest layer release + FX
// ring-out. fxTailSec is the hook's channel tail estimator — patch effects
// ({type, params}, no bypass/automation) satisfy its shape.
export function renderDurationSec(patch) {
  const layers = layersOf(patch);
  const maxRelease = layers.reduce((m, l) => Math.max(m, l.envelope?.release ?? 0), 0);
  const tail = fxTailSec({ effects: layers.flatMap((l) => l.effects ?? []) });
  return Math.min(RENDER_CAP_SEC, SAMPLE_SUSTAIN_SEC + maxRelease + tail + RELEASE_PAD_SEC);
}

const silentBuffer = (sampleRate) =>
  new AudioBuffer({ numberOfChannels: 2, length: Math.round(0.05 * sampleRate), sampleRate });

/**
 * Sequentially render all 73 chromatic notes of a patch.
 * Returns [{ midi, buffer: AudioBuffer }]; throws DOMException 'AbortError'
 * when the signal fires (granularity = one note; Tone.Offline has no
 * mid-render cancel). The inter-note await yields the main thread each note.
 */
export async function renderInstrumentSamples(patch, { onProgress, signal } = {}) {
  const durationSec = renderDurationSec(patch);
  const out = [];
  let done = 0;
  for (let midi = SAMPLE_MIN_MIDI; midi <= SAMPLE_MAX_MIDI; midi++) {
    if (signal?.aborted) throw new DOMException('sample render cancelled', 'AbortError');
    const note = Tone.Frequency(midi, 'midi').toNote();
    const rendered = await Tone.Offline(() => {
      // Same offline-build pattern as audioBounce (proven for this node kind).
      // No disposal needed — the whole offline context is discarded.
      const node = makeCustomInstrumentNode(patch);
      node.connect(Tone.getDestination());
      node.triggerAttack(note, 0, 1); // velocity 1: playback velocity scales gain
      node.triggerRelease(note, SAMPLE_SUSTAIN_SEC);
    }, durationSec);
    const raw = rendered.get();
    // Trailing-only trim (−80 dBFS backward scan + 0.25 s pad). A fully silent
    // note (extreme patch) becomes a tiny silent buffer so the Sampler map
    // stays chromatic-complete.
    const buffer = trimExportBuffer(raw, { startSec: 0 }) ?? silentBuffer(raw.sampleRate);
    out.push({ midi, buffer });
    onProgress?.(++done, SAMPLE_NOTE_COUNT);
  }
  return out;
}
