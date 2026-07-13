import * as Tone from 'tone';
import { makeSynth, makeGlideVoice, isDrumKit, chokeTargetsFor } from './synthFactory';
import { makeFxGraph } from './fxChain';
import { EFFECT_DEFS } from './effectDefs';
import { automationValueAt, denorm, isPanAutomated } from './automationMath';
import { buildTempoMap, tempoPointsOf, tempoScheduleOps } from './tempoMath';
import { planGlideSegments } from './glideMath';
import {
  buildRegionEvents,
  volForSliderValue,
  scheduleFadeEnvelope,
  estimateTrackTailSec,
  estimateGroupTailSec,
  clampPan,
  scheduleGlideSynthVoice,
  scheduleGlideSamplerChain,
} from '../../hooks/useWorkstationAudio';

// Group-aware audibility — the live engine's effect #2 rule: a solo anywhere
// (track or group) gates everything; a track is heard iff neither it nor its
// group is muted AND (nothing soloed OR it/its group is soloed).
function computeAudibility(tracks, groups) {
  const groupById = new Map(groups.map(g => [g.id, g]));
  const anySoloed = tracks.some(t => t.isSolo) || groups.some(g => g.isSolo);
  const trackAudible = (t) => {
    const grp = t.groupId ? groupById.get(t.groupId) : null;
    return !t.isMuted && !grp?.isMuted && (!anySoloed || t.isSolo || !!grp?.isSolo);
  };
  const groupAudible = (g) => {
    const memberSolo = tracks.some(t => t.groupId === g.id && t.isSolo);
    return !g.isMuted && (!anySoloed || g.isSolo || memberSolo);
  };
  return { groupById, trackAudible, groupAudible };
}

// Upper bound on how long the audible tracks can ring past the last note,
// so the render window covers the full tail (trimExportBuffer then finds the
// real endpoint by scanning). Per-track math lives in estimateTrackTailSec
// (shared with the live engine's activity pruner): synth release, drum
// one-shots, non-bypassed delay/reverb decay to −60 dB, clamp [2, 30].
// A grouped track's ring-out passes through the group bus's own FX — SERIAL
// chains ring sequentially, so the tails add before the final clamp.
function estimateFxTailSec(tracks, groups = []) {
  const { groupById, trackAudible } = computeAudibility(tracks, groups);
  let tail = 0;
  for (const t of tracks) {
    if (!trackAudible(t)) continue;
    const grp = t.groupId ? groupById.get(t.groupId) : null;
    tail = Math.max(tail, estimateTrackTailSec(t) + (grp ? estimateGroupTailSec(grp) : 0));
  }
  return Math.min(30, Math.max(2, tail));
}

// Schedule a track's automation envelopes in the OFFLINE context. The offline
// transport starts at 0, so transport time == context time and every point
// lands at the tempo map's secondsAtMeasure — mirrors the live scheduler in
// useWorkstationAudio (same exp/linear rule, same coupled-wet ctx). 'set'-kind
// (plain-setter) targets are pushed onto `stepped` for the shared ~30 Hz
// scheduleRepeat driver built after the track loop. Automations targeting a
// bypassed effect are skipped (offline never builds those graphs — matches
// the live engine, where a pruned bypass graph renders nothing).
// `panEntries` (optional) overrides the pan target's entries — used for group
// pan lanes, which are member OFFSETS ramped on the MEMBER panners (mirrors
// the live resolveAutomationTarget group branch); the group bus Panner is
// inert glue at 0.
function scheduleOfflineAutomation(t, { volume, pan, panEntries = null, graphByFxId }, tempoMap, stepped) {
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
      entries = panEntries ?? [{ param: pan.pan, map: (v) => v }];
      if (!entries.length) continue;
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
        const at = tempoMap.secondsAtMeasure(p.time);
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
export async function bounceProject({ tracks, regions, notes, bpm, globalAutomations = [], groups = [], audioBuffers = new Map(), tailSec = null, capSec = Infinity }) {
  // Recorded Moog audio lives in a regionId → native AudioBuffer map (session
  // only — not persisted). Look-up tolerates a Map or a plain object.
  const getBuf = (id) => (audioBuffers instanceof Map ? audioBuffers.get(id) : audioBuffers?.[id]) || null;
  const rightMeasure = regions.reduce(
    (m, r) => Math.max(m, r.startMeasure + r.durationMeasures), 0,
  );
  // Tempo map — identical math to the live engine's recomputeTempo, and the
  // offline transport starts at 0 so map seconds == context seconds exactly.
  const tempoMap = buildTempoMap(bpm, tempoPointsOf(globalAutomations));
  const tail = tailSec ?? estimateFxTailSec(tracks, groups);
  // Content end = the note-based right edge, extended by any recorded buffer that
  // rings past its region (the live Tone.Player plays the whole buffer from the
  // region start regardless of drawn length). Only audible tracks extend it.
  const { trackAudible: trackAudibleForDur } = computeAudibility(tracks, groups);
  let contentEndSec = tempoMap.secondsAtMeasure(rightMeasure);
  for (const r of regions) {
    if (!r.hasAudio) continue;
    const buf = getBuf(r.id);
    const track = tracks.find(t => t.id === r.trackId);
    if (!buf || !track || !trackAudibleForDur(track)) continue;
    contentEndSec = Math.max(contentEndSec, tempoMap.secondsAtMeasure(r.startMeasure) + buf.duration);
  }
  const durationSec = Math.max(0.1, Math.min(contentEndSec + tail, capSec));
  let minOnsetTicks = Infinity;

  const buffer = await Tone.Offline(async ({ transport }) => {
    // Schedule the same bpm curve the live transport plays (flat base bpm
    // when the tempo lane is empty). tempoScheduleOps mirrors recomputeTempo —
    // its strictly-increasing event times are load-bearing (stacked-point
    // steps must never share a ramp's end timestamp; see TEMPO_STEP_EPS).
    // .value covers [0, eps) until the leading re-anchor set lands.
    transport.bpm.value = tempoMap.bpmAtMeasure(0);
    for (const op of tempoScheduleOps(tempoMap, 0, 0)) {
      if (op.kind === 'set') transport.bpm.setValueAtTime(op.bpm, op.time);
      else transport.bpm.linearRampToValueAtTime(op.bpm, op.time);
    }
    const { trackAudible, groupAudible } = computeAudibility(tracks, groups);

    const trackVolumeByTrackId = new Map();
    const trackPannerByTrackId = new Map();
    const audibleTrackIds = new Set();
    const steppedAutomation = []; // 'set'-kind targets for the shared driver below

    // Group buses first (mirrors the live chain): memberMutes → groupIn →
    // groupVolume → groupPan(inert, 0) → [group FX] → groupMute → destination.
    // Group pan (knob AND lane) is a member OFFSET applied on the member
    // panners, so group automation scheduling is DEFERRED until after the
    // track loop below (member panners must exist for the pan entries).
    const groupInById = new Map();
    const pendingGroupAutomation = []; // [{ g, handles }]
    for (const g of groups) {
      const gMute = new Tone.Gain(groupAudible(g) ? 1 : 0).toDestination();
      const graphByFxId = new Map();
      let gHead = gMute;
      for (const e of [...(g.effects ?? [])].reverse()) {
        if (e.bypass) continue;
        const gr = makeFxGraph(e.type, e.params);
        if (!gr) continue;
        graphByFxId.set(e.id, gr);
        gr.out.connect(gHead);
        gHead = gr.in;
      }
      const gPan = new Tone.Panner(0).connect(gHead); // inert glue — see clampPan
      const gVol = new Tone.Gain(volForSliderValue(g.volume ?? 75)).connect(gPan);
      const gIn  = new Tone.Gain(1).connect(gVol);
      groupInById.set(g.id, gIn);
      pendingGroupAutomation.push({ g, handles: { volume: gVol, pan: gPan, graphByFxId } });
    }

    // Per-track volume → pan → [FX] → mute → (group bus | destination)
    for (const t of tracks) {
      const audible = trackAudible(t);
      if (audible) audibleTrackIds.add(t.id);
      const mute = new Tone.Gain(audible ? 1 : 0);
      const busIn = t.groupId ? groupInById.get(t.groupId) : null;
      if (busIn) mute.connect(busIn); else mute.toDestination();
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
      // Effective pan bakes the group offset (clampPan(t.pan + g.pan)); when
      // a group pan LANE exists, its scheduler below overwrites at t=0.
      const grp = t.groupId ? groups.find(g => g.id === t.groupId) : null;
      const pan     = new Tone.Panner(clampPan((t.pan ?? 0) + (grp?.pan ?? 0))).connect(head);
      const volume  = new Tone.Gain(volForSliderValue(t.volume ?? 75)).connect(pan);
      trackVolumeByTrackId.set(t.id, volume);
      trackPannerByTrackId.set(t.id, pan);
      scheduleOfflineAutomation(t, { volume, pan, graphByFxId }, tempoMap, steppedAutomation);
    }
    // Group automation — after the track loop so group PAN lanes can target
    // the member panners (member offset, own-lane members keep their own).
    for (const { g, handles } of pendingGroupAutomation) {
      const panEntries = [];
      for (const t of tracks) {
        if (t.groupId !== g.id || isPanAutomated(t)) continue;
        const mp = trackPannerByTrackId.get(t.id);
        if (!mp) continue;
        const base = t.pan ?? 0;
        panEntries.push({ param: mp.pan, map: (v) => clampPan(base + v) });
      }
      scheduleOfflineAutomation(g, { ...handles, panEntries }, tempoMap, steppedAutomation);
    }
    if (steppedAutomation.length > 0) {
      transport.scheduleRepeat(() => {
        // Ticks are canonical musical time — correct under the tempo curve.
        const tM = transport.ticks / (transport.PPQ * 4);
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

      // Recorded Moog audio region: render the captured buffer instead of the
      // transcription notes — raw to destination (matching the live Tone.Player),
      // gated on track audibility so mute/solo apply. A missing buffer falls
      // through to the note path (the transcription persists; the buffer does not).
      const recBuf = r.hasAudio ? getBuf(r.id) : null;
      if (recBuf) {
        if (audibleTrackIds.has(r.trackId)) {
          const startSec = tempoMap.secondsAtMeasure(r.startMeasure);
          new Tone.Player(recBuf).toDestination().start(startSec);
          minOnsetTicks = Math.min(minOnsetTicks, r.startMeasure * Tone.Transport.PPQ * 4);
        }
        continue; // no synth, no transcription notes — the buffer is the sound
      }

      const fadeGain = new Tone.Gain(1).connect(trackVolume);
      const synth    = makeSynth(track.instrument, { envelope: track.envelope }).connect(fadeGain);

      scheduleFadeEnvelope(fadeGain, r, { current: tempoMap });

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
        // Melodic durations resolve through the tempo map (a note held THROUGH
        // a tempo ramp releases at its true musical end) — mirrors the live
        // makePartCallback. Event time/duration are "<ticks>i" strings.
        const durSecOf = (ev) => {
          const q = Tone.Transport.PPQ * 4;
          const m0 = parseInt(ev.time, 10) / q;
          const m1 = m0 + parseInt(ev.duration, 10) / q;
          return tempoMap.secondsAtMeasure(m1) - tempoMap.secondsAtMeasure(m0);
        };
        // Per-note velocity mirrors the live makePartCallback: 1–120 int on
        // the event → Tone's 0–1 NormalRange.
        const velOf = (ev) => (ev.velocity ?? 100) / 120;
        // Glide chains mirror the live path via the SAME shared schedulers.
        // Synth family: pre-create the mono voices here (before transport
        // start), round-robin acquired in the callback. Sampler family:
        // scheduleGlideSamplerChain captures + curves the buffer source; the
        // throwaway Set stands in for liveSamplerSourcesRef (nothing to
        // silence offline). Glide-free regions build zero extra nodes and the
        // callbacks below are byte-identical to the pre-glide behavior.
        const glideCount = isDrum ? 0 : events.reduce((c, ev) => c + (ev.glide ? 1 : 0), 0);
        const glideVoices = [];
        if (glideCount > 0 && !synth._activeSources && !(synth instanceof Tone.Sampler)) {
          const n = Math.min(glideCount, 8);
          for (let i = 0; i < n; i++) {
            glideVoices.push(makeGlideVoice(track.instrument, { envelope: track.envelope }).connect(fadeGain));
          }
        }
        let glideRR = 0;
        const offlineSources = new Set();
        const scheduleGlide = (time, ev) => {
          const t = synth.toSeconds(time);
          const plan = planGlideSegments({
            headPitch: ev.note, segments: ev.glide.segments,
            startTicks: parseInt(ev.time, 10), map: tempoMap,
            PPQ: Tone.Transport.PPQ,
          });
          if (synth._activeSources) {
            scheduleGlideSamplerChain(synth, offlineSources, ev, t, plan);
          } else if (glideVoices.length) {
            scheduleGlideSynthVoice(glideVoices[glideRR++ % glideVoices.length], ev, t, plan);
          } else {
            synth.triggerAttackRelease(ev.note, durSecOf(ev), time, velOf(ev));
          }
        };
        new Tone.Part(
          isDrum
            ? (time, ev) => {
                const t = synth.toSeconds(time);
                for (const tgt of chokeTargetsFor(ev.note)) synth.triggerRelease(tgt, t);
                synth.triggerAttack(ev.note, t, velOf(ev));
              }
            : (time, ev) => {
                if (ev.glide !== undefined) { scheduleGlide(time, ev); return; }
                synth.triggerAttackRelease(ev.note, durSecOf(ev), time, velOf(ev));
              },
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
    : tempoMap.secondsAtMeasure(minOnsetTicks / (Tone.Transport.PPQ * 4));
  return { buffer: buffer.get(), firstOnsetSec };
}
