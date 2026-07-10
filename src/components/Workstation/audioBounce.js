import * as Tone from 'tone';
import { makeSynth, isDrumKit, chokeTargetsFor } from './synthFactory';
import { makeFxGraph } from './fxChain';
import { EFFECT_DEFS } from './effectDefs';
import { automationValueAt, denorm } from './automationMath';
import {
  buildRegionEvents,
  volForSliderValue,
  scheduleFadeEnvelope,
  estimateTrackTailSec,
} from '../../hooks/useWorkstationAudio';

// Upper bound on how long the audible tracks can ring past the last note,
// so the render window covers the full tail (trimExportBuffer then finds the
// real endpoint by scanning). Per-track math lives in estimateTrackTailSec
// (shared with the live engine's activity pruner): synth release, drum
// one-shots, non-bypassed delay/reverb decay to −60 dB, clamp [2, 30].
function estimateFxTailSec(tracks) {
  const anySoloed = tracks.some(t => t.isSolo);
  let tail = 0;
  for (const t of tracks) {
    if (t.isMuted || (anySoloed && !t.isSolo)) continue;
    tail = Math.max(tail, estimateTrackTailSec(t));
  }
  return Math.min(30, Math.max(2, tail));
}

// Schedule a track's automation envelopes in the OFFLINE context. The offline
// transport starts at 0, so transport time == context time and every point
// lands at plain `point.time * secPerMeasure` — mirrors the live scheduler in
// useWorkstationAudio (same exp/linear rule, same coupled-wet ctx). 'set'-kind
// (plain-setter) targets are pushed onto `stepped` for the shared ~30 Hz
// scheduleRepeat driver built after the track loop. Automations targeting a
// bypassed effect are skipped (offline never builds those graphs — matches
// the live engine, where a pruned bypass graph renders nothing).
function scheduleOfflineAutomation(t, { volume, pan, graphByFxId }, bpm, stepped) {
  const secPerMeasure = 4 * (60 / bpm);
  for (const a of t.automations ?? []) {
    const pts = a.points ?? [];
    if (pts.length === 0) continue;
    const tgt = a.target ?? {};
    let entries = null;
    let toParam = null;
    let exp = false;
    let setFn = null;
    let ctx;
    if (tgt.kind === 'volume') {
      entries = [{ param: volume.gain, map: (v) => v }];
      toParam = (v01) => volForSliderValue(v01 * 100);
      exp = true; // gain floor 0.063 > 0 — matches the slider's dB curve
    } else if (tgt.kind === 'pan') {
      entries = [{ param: pan.pan, map: (v) => v }];
      toParam = (v01) => v01 * 2 - 1;
    } else if (tgt.kind === 'fx') {
      const e = (t.effects ?? []).find(x => x.id === tgt.effectId);
      const g = graphByFxId.get(tgt.effectId);
      const meta = e ? EFFECT_DEFS[e.type]?.params?.[tgt.param] : null;
      const ap = g?.autoParams?.[tgt.param];
      if (!e || !g || !meta || !ap) continue;
      toParam = (v01) => denorm(v01, meta);
      ctx = { dryThru: !!e.params?.dryThru };
      if (ap.kind === 'set') setFn = ap.set;
      else { entries = ap.params; exp = meta.scale === 'log'; }
    } else {
      continue;
    }

    if (setFn) {
      setFn(toParam(automationValueAt(pts, 0)));
      stepped.push({ set: setFn, toParam, points: pts });
      continue;
    }
    for (const { param, map } of entries) {
      let prev = map(toParam(automationValueAt(pts, 0)), ctx);
      param.setValueAtTime(prev, 0);
      for (const p of pts) {
        const at = p.time * secPerMeasure;
        if (at <= 0) continue;
        const val = map(toParam(p.value), ctx);
        if (exp && val > 0 && prev > 0) param.exponentialRampToValueAtTime(val, at);
        else                            param.linearRampToValueAtTime(val, at);
        prev = val;
      }
    }
  }
}

/**
 * Offline render of the current project to an AudioBuffer.
 *
 * Mirrors the live signal graph from useWorkstationAudio:
 *   regionSynth → regionFadeGain → trackVolumeGain → trackPanner
 *     → [insert FX, track.effects order] → trackMuteGain → Destination
 *
 * Mute/solo, per-track volume, and effect params are snapshotted at call time
 * and baked in. Bypassed effects are simply not instantiated (no crossfade
 * machinery is needed offline). tailSec defaults to an FX-aware estimate
 * (estimateFxTailSec) so delay/reverb tails aren't truncated; pass a number to
 * override. capSec bounds the total render (the project's hard right stop).
 *
 * Returns { buffer, firstOnsetSec }: firstOnsetSec is the earliest note onset
 * across audible tracks (for export start-trim), or null if nothing audible
 * is scheduled at all.
 */
export async function bounceProject({ tracks, regions, notes, bpm, tailSec = null, capSec = Infinity }) {
  const rightMeasure = regions.reduce(
    (m, r) => Math.max(m, r.startMeasure + r.durationMeasures), 0,
  );
  const tail = tailSec ?? estimateFxTailSec(tracks);
  const durationSec = Math.max(0.1, Math.min(rightMeasure * 4 * (60 / bpm) + tail, capSec));
  let minOnsetTicks = Infinity;

  const buffer = await Tone.Offline(async ({ transport }) => {
    transport.bpm.value = bpm;
    const anySoloed = tracks.some(t => t.isSolo);

    // Per-track volume → pan → [FX] → mute → destination
    const trackVolumeByTrackId = new Map();
    const audibleTrackIds = new Set();
    const steppedAutomation = []; // 'set'-kind targets for the shared driver below
    for (const t of tracks) {
      const audible = !t.isMuted && (!anySoloed || t.isSolo);
      if (audible) audibleTrackIds.add(t.id);
      const mute    = new Tone.Gain(audible ? 1 : 0).toDestination();
      // Insert effects built back-to-front so `head` always points at the
      // next node downstream; bypassed/unknown effects are skipped entirely.
      // Params (incl. delay dryThru) are baked at construction; Chorus/
      // AutoFilter .start() runs inside the builder — valid in this offline
      // context because the graph is constructed within the Offline callback.
      const graphByFxId = new Map(); // fxId → graph (automation target lookup)
      let head = mute;
      for (const e of [...(t.effects ?? [])].reverse()) {
        if (e.bypass) continue;
        const g = makeFxGraph(e.type, e.params);
        if (!g) continue;
        graphByFxId.set(e.id, g);
        g.out.connect(head);
        head = g.in;
      }
      const pan     = new Tone.Panner(Math.max(-1, Math.min(1, t.pan ?? 0))).connect(head);
      const volume  = new Tone.Gain(volForSliderValue(t.volume ?? 75)).connect(pan);
      trackVolumeByTrackId.set(t.id, volume);
      scheduleOfflineAutomation(t, { volume, pan, graphByFxId }, bpm, steppedAutomation);
    }
    if (steppedAutomation.length > 0) {
      transport.scheduleRepeat(() => {
        const tM = transport.seconds / (4 * (60 / bpm));
        for (const s of steppedAutomation) {
          const v01 = automationValueAt(s.points, tM);
          if (v01 != null) s.set(s.toParam(v01));
        }
      }, 1 / 30);
    }

    // Per-region synth + fade gain
    for (const r of regions) {
      const trackVolume = trackVolumeByTrackId.get(r.trackId);
      if (!trackVolume) continue;
      const track = tracks.find(t => t.id === r.trackId);
      if (!track) continue;

      const fadeGain = new Tone.Gain(1).connect(trackVolume);
      const synth    = makeSynth(track.instrument, { envelope: track.envelope }).connect(fadeGain);

      scheduleFadeEnvelope(fadeGain, r, bpm);

      const events = buildRegionEvents(r, notes);
      if (events.length > 0) {
        // Fold the earliest onset across audible tracks for the export
        // start-trim. Event times are "${ticks}i" strings and looped-region
        // events aren't sorted, so scan them all.
        if (audibleTrackIds.has(r.trackId)) {
          for (const ev of events) {
            minOnsetTicks = Math.min(minOnsetTicks, parseInt(ev.time, 10));
          }
        }
        // Drum kits mirror the live path: choke the hat group, then a bare
        // attack (one-shot — the source self-stops at buffer end, so drawn
        // note length never truncates a cymbal). Melodic path unchanged.
        const isDrum = isDrumKit(track.instrument);
        new Tone.Part(
          isDrum
            ? (time, ev) => {
                const t = synth.toSeconds(time);
                for (const tgt of chokeTargetsFor(ev.note)) synth.triggerRelease(tgt, t);
                synth.triggerAttack(ev.note, t, 0.8);
              }
            : (time, ev) => synth.triggerAttackRelease(ev.note, ev.duration, time, 0.8),
          events,
        ).start(0);
      }
    }

    // Defensive: ensure any Tone.Sampler buffers used by sampled instruments
    // finish decoding in this offline context before rendering begins.
    await Tone.loaded();

    transport.start();
  }, durationSec);

  const firstOnsetSec = minOnsetTicks === Infinity
    ? null
    : (minOnsetTicks / Tone.Transport.PPQ) * (60 / bpm);
  return { buffer: buffer.get(), firstOnsetSec };
}
