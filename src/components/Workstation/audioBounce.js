import * as Tone from 'tone';
import { makeSynth } from './synthFactory';
import {
  buildRegionEvents,
  volForSliderValue,
  scheduleFadeEnvelope,
} from '../../hooks/useWorkstationAudio';

/**
 * Offline render of the current project to an AudioBuffer.
 *
 * Mirrors the live signal graph from useWorkstationAudio:
 *   regionSynth → regionFadeGain → trackVolumeGain → trackMuteGain → Destination
 *
 * Mute/solo and per-track volume are snapshotted at call time and baked in.
 */
export async function bounceProject({ tracks, regions, notes, bpm, tailSec = 2 }) {
  const rightMeasure = regions.reduce(
    (m, r) => Math.max(m, r.startMeasure + r.durationMeasures), 0,
  );
  const durationSec = Math.max(0.1, rightMeasure * 4 * (60 / bpm) + tailSec);

  const buffer = await Tone.Offline(({ transport }) => {
    transport.bpm.value = bpm;
    const anySoloed = tracks.some(t => t.isSolo);

    // Per-track volume → pan → mute → destination
    const trackVolumeByTrackId = new Map();
    for (const t of tracks) {
      const audible = !t.isMuted && (!anySoloed || t.isSolo);
      const mute    = new Tone.Gain(audible ? 1 : 0).toDestination();
      const pan     = new Tone.Panner(Math.max(-1, Math.min(1, t.pan ?? 0))).connect(mute);
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

    transport.start();
  }, durationSec);

  return buffer.get();
}
