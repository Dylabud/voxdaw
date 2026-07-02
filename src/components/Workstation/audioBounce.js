import * as Tone from 'tone';
import { makeSynth } from './synthFactory';
import { makeFxGraph } from './fxChain';
import {
  buildRegionEvents,
  volForSliderValue,
  scheduleFadeEnvelope,
} from '../../hooks/useWorkstationAudio';

/**
 * Offline render of the current project to an AudioBuffer.
 *
 * Mirrors the live signal graph from useWorkstationAudio:
 *   regionSynth → regionFadeGain → trackVolumeGain → trackPanner
 *     → [insert FX, track.effects order] → trackMuteGain → Destination
 *
 * Mute/solo, per-track volume, and effect params are snapshotted at call time
 * and baked in. Bypassed effects are simply not instantiated (no crossfade
 * machinery is needed offline). Note: the default tailSec may truncate a long
 * delay-feedback/reverb tail ringing past the last region — raise tailSec if
 * that matters for a given export.
 */
export async function bounceProject({ tracks, regions, notes, bpm, tailSec = 2 }) {
  const rightMeasure = regions.reduce(
    (m, r) => Math.max(m, r.startMeasure + r.durationMeasures), 0,
  );
  const durationSec = Math.max(0.1, rightMeasure * 4 * (60 / bpm) + tailSec);

  const buffer = await Tone.Offline(async ({ transport }) => {
    transport.bpm.value = bpm;
    const anySoloed = tracks.some(t => t.isSolo);

    // Per-track volume → pan → [FX] → mute → destination
    const trackVolumeByTrackId = new Map();
    for (const t of tracks) {
      const audible = !t.isMuted && (!anySoloed || t.isSolo);
      const mute    = new Tone.Gain(audible ? 1 : 0).toDestination();
      // Insert effects built back-to-front so `head` always points at the
      // next node downstream; bypassed/unknown effects are skipped entirely.
      // Params (incl. delay dryThru) are baked at construction; Chorus/
      // AutoFilter .start() runs inside the builder — valid in this offline
      // context because the graph is constructed within the Offline callback.
      let head = mute;
      for (const e of [...(t.effects ?? [])].reverse()) {
        if (e.bypass) continue;
        const g = makeFxGraph(e.type, e.params);
        if (!g) continue;
        g.out.connect(head);
        head = g.in;
      }
      const pan     = new Tone.Panner(Math.max(-1, Math.min(1, t.pan ?? 0))).connect(head);
      const volume  = new Tone.Gain(volForSliderValue(t.volume ?? 75)).connect(pan);
      trackVolumeByTrackId.set(t.id, volume);
    }

    // Per-region synth + fade gain
    for (const r of regions) {
      const trackVolume = trackVolumeByTrackId.get(r.trackId);
      if (!trackVolume) continue;
      const track = tracks.find(t => t.id === r.trackId);
      if (!track) continue;

      const fadeGain = new Tone.Gain(1).connect(trackVolume);
      const synth    = makeSynth(track.instrument).connect(fadeGain);

      scheduleFadeEnvelope(fadeGain, r, bpm);

      const events = buildRegionEvents(r, notes);
      if (events.length > 0) {
        new Tone.Part(
          (time, ev) => synth.triggerAttackRelease(ev.note, ev.duration, time, 0.8),
          events,
        ).start(0);
      }
    }

    // Defensive: ensure any Tone.Sampler buffers used by sampled instruments
    // finish decoding in this offline context before rendering begins.
    await Tone.loaded();

    transport.start();
  }, durationSec);

  return buffer.get();
}
