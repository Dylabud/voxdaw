import { useEffect, useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';
import { makeSynth, applyEnvelope, defaultEnvelopeFor, isSampledInstrument, isDrumKit, chokeTargetsFor } from '../components/Workstation/synthFactory';
import { makeFx } from '../components/Workstation/fxChain';
import { HEAVY_EFFECT_TYPES, EFFECT_DEFS, metaForTarget } from '../components/Workstation/effectDefs';
import {
  automationValueAt, denorm, targetKey,
  isVolumeAutomated, isPanAutomated, automatedFxKeys,
} from '../components/Workstation/automationMath';
import { buildTempoMap, tempoPointsOf } from '../components/Workstation/tempoMath';
import { firstLoopOffsetMeasures } from '../components/Workstation/loopMath';

/**
 * Workstation playback engine — peer to useAudioEngine / useVocoder / useAutotune.
 *
 * Per-region signal flow:
 *   regionSynth → regionFadeGain → trackVolumeGain → trackPanner
 *     → [insert FX wrappers, track.effects order] → trackMuteGain → Destination
 *
 * - regionFadeGain runs a per-region linear fade envelope (in→out, with floors).
 *   Scheduled via Tone.Transport.schedule so it fires synchronously with the
 *   Tone.Parts that drive note events.
 * - trackVolumeGain is the slider writer (per-track).
 * - trackMuteGain is the mute/solo writer (per-track).
 *
 * Single-writer per node (CLAUDE.md): sliders never touch mute, mute never
 * touches volume, the fade scheduler never touches either.
 *
 * Hook does NOT call Tone.start() — kept on the user-gesture path (handlePlayPause,
 * RegionEditor preview clicks).
 */
// Performance-quality tiers (machine capability, not project data):
//   high   — current behavior (default).
//   medium — invisible savings: PolySynth voice cap 32→12 + lookAhead 0.2s.
//   low    — medium + force-bypass HEAVY_EFFECT_TYPES (real render-graph
//            prune via makeFx). track.effects state is never mutated, so
//            flipping back to high restores the user's settings instantly.
const REDUCED_MAX_POLYPHONY = 12;

export default function useWorkstationAudio({ tracks, regions, notes, bpm, performanceQuality = 'high', globalAutomations = [] }) {
  // Read at synth-creation time (effect #4 / audition) so synths built while
  // quality is reduced get the voice cap without waiting for the sync effect.
  const perfQualityRef = useRef(performanceQuality);
  perfQualityRef.current = performanceQuality;
  // Per-track
  const mutesByTrackIdRef         = useRef(new Map()); // trackId → Gain
  const volumesByTrackIdRef       = useRef(new Map()); // trackId → Gain
  const pannersByTrackIdRef       = useRef(new Map()); // trackId → Panner
  const appliedVolumeByTrackIdRef = useRef(new Map()); // trackId → last v 0..100
  const appliedPanByTrackIdRef    = useRef(new Map()); // trackId → last pan -1..+1
  const appliedEnvByTrackIdRef    = useRef(new Map()); // trackId → last envelope object (ref-compared)

  // Render-graph pruning for inaudible tracks (mute/solo). The audio thread
  // only renders nodes transitively connected to the destination, so
  // disconnecting the mute node drops the ENTIRE track subtree (synths,
  // fades, FX incl. always-running LFOs and feedback loops) from rendering.
  // Effect #2 is the sole writer of both maps; Part callbacks read
  // audibleByTrackIdRef at fire time to skip triggering wasted voices.
  const muteConnByTrackIdRef = useRef(new Map()); // trackId → { connected, timer }
  const audibleByTrackIdRef  = useRef(new Map()); // trackId → bool

  // Activity-based pruning (third prune mechanism, lossless, all quality
  // tiers): an AUDIBLE track with no notes sounding still renders its whole
  // FX chain. Track a per-track "provably silent after" time (last note end
  // + release/FX tail from estimateTrackTailSec); the 1 Hz sweeper below
  // disconnects idle tracks and note-fire/audition reconnect them. Part
  // callbacks fire lookAhead (~0.1s) before the audible moment, so the
  // reconnect always lands before any sound — zero quality loss.
  const tailByTrackIdRef        = useRef(new Map()); // trackId → tailSec (cache of estimateTrackTailSec)
  const activeUntilByTrackIdRef = useRef(new Map()); // trackId → absolute audio time (Tone.now domain)

  // Reconnects an AUDIBLE track's mute node (no-op for inaudible tracks —
  // mute/solo connection state is owned by effect #2, and reconnecting a
  // muted track would just render silently). Gain is untouched: an idle-
  // pruned track's gain sits at 1, so the reconnect is instant; anything
  // frozen in its FX buffers is ≤ −60 dB by construction (see the sweeper).
  const connectTrack = useCallback((trackId) => {
    if (audibleByTrackIdRef.current.get(trackId) === false) return;
    const st = muteConnByTrackIdRef.current.get(trackId);
    const g  = mutesByTrackIdRef.current.get(trackId);
    if (!st || !g || g.disposed || st.connected) return;
    g.connect(Tone.getDestination());
    st.connected = true;
  }, []);

  const disconnectTrack = useCallback((trackId) => {
    const st = muteConnByTrackIdRef.current.get(trackId);
    const g  = mutesByTrackIdRef.current.get(trackId);
    if (!st || !g || g.disposed || !st.connected) return;
    g.disconnect();
    st.connected = false;
  }, []);

  const bumpActivity = useCallback((trackId, untilSec) => {
    const m = activeUntilByTrackIdRef.current;
    m.set(trackId, Math.max(m.get(trackId) ?? 0, untilSec));
  }, []);

  // Inline-synced (the mappingsRef pattern) so Part callbacks — which live
  // for the Part's lifetime — always call the current helpers.
  const noteLifecycleRef = useRef({ onNoteScheduled: () => {} });
  noteLifecycleRef.current.onNoteScheduled = (trackId, startSec, durSec) => {
    connectTrack(trackId);
    bumpActivity(trackId, startSec + durSec + (tailByTrackIdRef.current.get(trackId) ?? 2));
  };

  // Per-track tail cache — pure function of tracks, rebuilt whole.
  useEffect(() => {
    const tails = tailByTrackIdRef.current;
    tails.clear();
    for (const t of tracks) tails.set(t.id, estimateTrackTailSec(t));
  }, [tracks]);

  // Per-track insert-FX chain (pan → wrappers → mute)
  const fxChainsByTrackIdRef     = useRef(new Map()); // trackId → [makeFx wrapper] (parallel to track.effects)
  const appliedFxKeyByTrackIdRef = useRef(new Map()); // trackId → structural key "id:type|id:type"
  const appliedFxBypassByIdRef   = useRef(new Map()); // fxId → last bypass bool
  const appliedFxParamsByIdRef   = useRef(new Map()); // fxId → last params object reference

  // Track automation (see automationMath.js). "Automation takes over": a lane
  // with ≥1 point makes recomputeAutomation the sole writer of its target —
  // effects #3/#3b/#1d skip those params while automated.
  const steppedRepeatIdRef      = useRef(null);      // Transport.scheduleRepeat id — ~30 Hz set-kind driver
  const steppedTargetsRef       = useRef([]);        // [{ set, toParam, points }] sampled by the driver
  const prevAutomatedTargetsRef = useRef(new Map()); // "tId|targetKey" → { trackId, target } (release-restore diff)
  const appliedAutomationKeyRef = useRef('');        // delta key so unrelated tracks-commits don't re-schedule

  // Refs into latest props for recomputeFades (called by shell from event handlers)
  const regionsRef = useRef(regions); regionsRef.current = regions;
  const bpmRef     = useRef(bpm);     bpmRef.current     = bpm;
  const tracksRef  = useRef(tracks);  tracksRef.current  = tracks;
  const globalAutosRef = useRef(globalAutomations); globalAutosRef.current = globalAutomations;

  // Tempo map (tempoMath.js) — the measures↔seconds source of truth once the
  // global tempo lane has points. Rebuilt by recomputeTempo (which is also the
  // SINGLE writer of Transport.bpm); consumed by recomputeFades /
  // recomputeAutomation / scheduleFadeEnvelope / Part-callback durations.
  // Seeded with the constant-bpm identity so pre-first-recompute consumers
  // (effect 1e on mount) never see null.
  const tempoMapRef = useRef(null);
  if (tempoMapRef.current === null) tempoMapRef.current = buildTempoMap(bpm, tempoPointsOf(globalAutomations));
  const appliedTempoKeyRef = useRef(''); // delta key for the tempo sync effect

  // Per-track audition synth (instrument-tab performance UI). Hook-owned so
  // it can connect into the track chain at the stable `volume` node — that
  // node's output edge (volume → pan) is never rewired by effect 1b, so the
  // audition signal rides volume → pan → FX → mute like region playback.
  const auditionByTrackIdRef = useRef(new Map()); // trackId → { synth, instrument }

  // Per-region
  const synthsByRegionIdRef    = useRef(new Map()); // regionId → PolySynth | Sampler
  const fadeGainsByRegionIdRef = useRef(new Map()); // regionId → Gain
  const partsByRegionIdRef     = useRef(new Map()); // regionId → Part
  const fadeEventIdByRegionRef = useRef(new Map()); // regionId → Transport schedule id
  const appliedRegionStateRef  = useRef(new Map()); // regionId → { instrument, partKey, fadeKey, loaded }

  // Live sampler buffer sources, tracked by us because Tone.Sampler forgets
  // them at schedule time (see makePartCallback). Consumed by silenceAll.
  const liveSamplerSourcesRef  = useRef(new Set()); // ToneBufferSource

  // Sampler-load tracking: which regions are still downloading buffers,
  // and the derived per-track set for the UI loading indicator.
  const loadingRegionsRef = useRef(new Map()); // regionId → trackId
  const [loadingTrackIds, setLoadingTrackIds] = useState(() => new Set());

  const recomputeLoadingTrackIds = useCallback(() => {
    const next = new Set();
    for (const tid of loadingRegionsRef.current.values()) next.add(tid);
    setLoadingTrackIds(prev => {
      if (prev.size === next.size && [...prev].every(id => next.has(id))) return prev;
      return next;
    });
  }, []);

  // ── Audition API — per-track synth for the instrument-tab performance UI ──
  // Lazily builds (and rebuilds on instrument change) a synth cached by
  // trackId. Sampled instruments join the existing loading bookkeeping under
  // a synthetic 'audition:<trackId>' key (values are trackIds, so the derived
  // per-track indicator just works).
  const ensureAuditionSynth = useCallback((trackId) => {
    const volume = volumesByTrackIdRef.current.get(trackId);
    const track  = tracksRef.current.find(t => t.id === trackId);
    if (!volume || !track) return null;
    const cache = auditionByTrackIdRef.current;
    const entry = cache.get(trackId);
    if (entry && entry.instrument === track.instrument) return entry.synth;

    if (entry) {
      entry.synth.dispose();
      if (loadingRegionsRef.current.delete(`audition:${trackId}`)) recomputeLoadingTrackIds();
    }
    const instrument = track.instrument;
    const sampled = isSampledInstrument(instrument);
    if (sampled) {
      loadingRegionsRef.current.set(`audition:${trackId}`, trackId);
      recomputeLoadingTrackIds();
    }
    const opts = { envelope: track.envelope };
    if (perfQualityRef.current !== 'high') opts.maxPolyphony = REDUCED_MAX_POLYPHONY;
    if (sampled) {
      opts.onLoad = () => {
        // Only clear if this load still matches the cached instrument —
        // a stale load must not clear a newer instrument's indicator.
        if (auditionByTrackIdRef.current.get(trackId)?.instrument !== instrument) return;
        if (loadingRegionsRef.current.delete(`audition:${trackId}`)) recomputeLoadingTrackIds();
      };
    }
    const synth = makeSynth(instrument, opts);
    synth.connect(volume);
    cache.set(trackId, { synth, instrument });
    return synth;
  }, [recomputeLoadingTrackIds]);

  const auditionAttack = useCallback((trackId, note) => {
    const synth = ensureAuditionSynth(trackId);
    // `loaded === false` skips an unready Sampler; PolySynths have no `loaded`.
    if (!synth || synth.disposed || synth.loaded === false) return;
    // Activity pruning: an idle track's chain may be disconnected — reconnect
    // (audible-gated inside connectTrack) and mark it ringing. Notes held
    // past the tail window are covered by the sweeper's synthIsRinging check.
    connectTrack(trackId);
    bumpActivity(trackId, Tone.now() + (tailByTrackIdRef.current.get(trackId) ?? 2));
    const instrument = auditionByTrackIdRef.current.get(trackId)?.instrument;
    if (isDrumKit(instrument)) {
      // Hi-hat choke, mirroring makePartCallback — every caller gets it.
      for (const tgt of chokeTargetsFor(note)) synth.triggerRelease(tgt);
    }
    synth.triggerAttack(note, undefined, 0.8);
  }, [ensureAuditionSynth, connectTrack, bumpActivity]);

  // Drums are one-shots: releases are no-ops so cymbals ring out (the buffer
  // sources self-stop; silenceAll's _activeSources sweep still covers them).
  const auditionRelease = useCallback((trackId, note) => {
    const entry = auditionByTrackIdRef.current.get(trackId);
    if (!entry || entry.synth.disposed || isDrumKit(entry.instrument)) return;
    entry.synth.triggerRelease(note);
    // Release tail is inside the track tail estimate — keep the window open.
    bumpActivity(trackId, Tone.now() + (tailByTrackIdRef.current.get(trackId) ?? 2));
  }, [bumpActivity]);

  const auditionReleaseAll = useCallback((trackId) => {
    const entry = auditionByTrackIdRef.current.get(trackId);
    if (!entry || entry.synth.disposed || isDrumKit(entry.instrument)) return;
    entry.synth.releaseAll?.();
    bumpActivity(trackId, Tone.now() + (tailByTrackIdRef.current.get(trackId) ?? 2));
  }, [bumpActivity]);

  // ── Automation scheduler ────────────────────────────────────────────────
  // Resolve an automation target to its live audio handles + value mapping.
  //   volume → track volume Gain (same volForSliderValue curve as the slider,
  //            gain floor 0.063 > 0 → exponential ramps are safe and match
  //            the slider's dB feel)
  //   pan    → Panner.pan (linear — crosses 0)
  //   fx     → wrapper.autoParams[param] (fxChain.js): 'ramp' entries are Tone
  //            Params scheduled natively; 'set' entries feed the stepped driver.
  // ctx carries current track state (delay dryThru) into coupled maps so they
  // never read a stale closure.
  const resolveAutomationTarget = useCallback((track, target) => {
    if (!track || !target) return null;
    if (target.kind === 'volume') {
      const g = volumesByTrackIdRef.current.get(track.id);
      if (!g || g.disposed) return null;
      return {
        kind: 'ramp', exp: true,
        entries: [{ param: g.gain, map: (v) => v }],
        toParam: (v01) => volForSliderValue(v01 * 100),
      };
    }
    if (target.kind === 'pan') {
      const p = pannersByTrackIdRef.current.get(track.id);
      if (!p || p.disposed) return null;
      return {
        kind: 'ramp', exp: false,
        entries: [{ param: p.pan, map: (v) => v }],
        toParam: (v01) => v01 * 2 - 1,
      };
    }
    if (target.kind === 'fx') {
      const e = (track.effects ?? []).find(x => x.id === target.effectId);
      const meta = metaForTarget(track, target);
      const w = fxChainsByTrackIdRef.current.get(track.id)?.find(x => x.fxId === target.effectId);
      const ap = w?.autoParams?.[target.param];
      if (!e || !meta || !ap) return null;
      const ctx = { dryThru: !!e.params?.dryThru };
      const toParam = (v01) => denorm(v01, meta);
      if (ap.kind === 'set') return { kind: 'set', set: ap.set, toParam, ctx };
      // Never exponential-ramp a param whose range can touch 0 (wet/depth);
      // log-scale metas have min > 0 by construction.
      return { kind: 'ramp', entries: ap.params, toParam, exp: meta.scale === 'log', ctx };
    }
    return null;
  }, []);

  // Re-anchor + re-schedule every automation envelope from the CURRENT
  // transport position — the recomputeFades pattern: cancel at Tone.now(),
  // set the envelope's current value, then schedule the remaining point ramps
  // in absolute audio time (valid because the shell calls this right before
  // Transport.start() on every resume path). Also (re)builds the single
  // stepped ~30 Hz driver for 'set'-kind targets (scheduleRepeat only fires
  // while the transport runs, so paused = held — correct).
  //
  // Release-restore: a target that WAS automated and no longer is gets its
  // schedule cancelled and its applied-cache entry deleted, so effects #3/#3b
  // (which run later in this same commit) hand ownership back by ramping to
  // the manual slider/dial value; fx params are restored directly here (1d
  // already ran this commit).
  // ── Tempo re-anchor — the SINGLE writer of Transport.bpm ────────────────
  // Rebuilds the tempo map from the global tempo lane and (re)schedules the
  // bpm curve as linear ramps from the CURRENT transport position. bpm signal
  // automation lives in absolute audio time, so — exactly like fades and
  // param automation — it desyncs across any pause/seek and is re-anchored by
  // every recomputeFades call site (recomputeTempo runs FIRST there: fades and
  // automation consume tempoMapRef). Only the future is touched (cancel at
  // Tone.now()), so Transport.ticks never jumps. Anchor math: tempoMath.js
  // trapezoid == TickSignal's own integration, so map seconds and transport
  // ticks agree exactly at every anchor.
  const recomputeTempo = useCallback(() => {
    const map = buildTempoMap(bpmRef.current, tempoPointsOf(globalAutosRef.current));
    tempoMapRef.current = map;
    const sig = Tone.Transport.bpm;
    const audioNow = Tone.now();
    const nowM = Tone.Transport.ticks / (Tone.Transport.PPQ * 4);
    sig.cancelScheduledValues(audioNow);
    sig.setValueAtTime(map.bpmAtMeasure(nowM), audioNow);
    const nowSec = map.secondsAtMeasure(nowM);
    let prevAt = audioNow;
    for (const a of map.anchors) {
      if (a.measure <= nowM) continue;
      const at = audioNow + (a.seconds - nowSec);
      if (at <= prevAt + 1e-6) sig.setValueAtTime(a.bpm, at); // coincident points = step
      else sig.linearRampToValueAtTime(a.bpm, at);
      prevAt = at;
    }
  }, []);

  const recomputeAutomation = useCallback(() => {
    if (steppedRepeatIdRef.current != null) {
      Tone.Transport.clear(steppedRepeatIdRef.current);
      steppedRepeatIdRef.current = null;
    }
    const stepped  = [];
    const nowAuto  = new Map(); // "tId|targetKey" → { trackId, target }
    const audioNow = Tone.now();
    const map      = tempoMapRef.current;
    const nowM     = Tone.Transport.ticks / (Tone.Transport.PPQ * 4);
    const nowSec   = map.secondsAtMeasure(nowM);

    for (const t of tracksRef.current) {
      for (const a of t.automations ?? []) {
        const pts = a.points ?? [];
        if (pts.length === 0) continue;
        const res = resolveAutomationTarget(t, a.target);
        if (!res) continue;
        nowAuto.set(`${t.id}|${targetKey(a.target)}`, { trackId: t.id, target: a.target });
        const v01Now = automationValueAt(pts, nowM);
        if (res.kind === 'ramp') {
          for (const { param, map: entryMap } of res.entries) {
            const cur = entryMap(res.toParam(v01Now), res.ctx);
            param.cancelScheduledValues(audioNow);
            param.setValueAtTime(cur, audioNow);
            let prev = cur;
            for (const p of pts) {
              const tSec = map.secondsAtMeasure(p.time); // tempo-map, not constant-bpm
              if (tSec <= nowSec) continue;
              const val = entryMap(res.toParam(p.value), res.ctx);
              const at  = audioNow + (tSec - nowSec);
              if (res.exp && val > 0 && prev > 0) param.exponentialRampToValueAtTime(val, at);
              else                                param.linearRampToValueAtTime(val, at);
              prev = val;
            }
          }
        } else {
          res.set(res.toParam(v01Now)); // hold correct value while paused/idle
          stepped.push({ set: res.set, toParam: res.toParam, points: pts });
        }
      }
    }

    steppedTargetsRef.current = stepped;
    if (stepped.length > 0) {
      steppedRepeatIdRef.current = Tone.Transport.scheduleRepeat(() => {
        // Ticks are canonical musical time — correct under tempo automation
        // (seconds/constant-bpm would drift the moment the tempo lane ramps).
        const tM = Tone.Transport.ticks / (Tone.Transport.PPQ * 4);
        for (const s of steppedTargetsRef.current) {
          const v01 = automationValueAt(s.points, tM);
          if (v01 != null) s.set(s.toParam(v01));
        }
      }, 1 / 30);
    }

    // Release-restore: targets automated last pass but not this one.
    for (const [key, info] of prevAutomatedTargetsRef.current) {
      if (nowAuto.has(key)) continue;
      const track = tracksRef.current.find(x => x.id === info.trackId);
      const res = track ? resolveAutomationTarget(track, info.target) : null;
      if (!res) continue; // track/effect gone — nodes disposed, nothing to restore
      if (res.kind === 'ramp') {
        for (const { param } of res.entries) {
          param.cancelScheduledValues(audioNow);
          param.setValueAtTime(param.value, audioNow);
        }
      }
      if (info.target.kind === 'volume') {
        appliedVolumeByTrackIdRef.current.delete(track.id); // effect #3 re-owns this commit
      } else if (info.target.kind === 'pan') {
        appliedPanByTrackIdRef.current.delete(track.id);    // effect #3b re-owns this commit
      } else {
        // 1d already ran this commit — restore the manual value directly
        // (one-shot handback; 1d stays the steady-state writer).
        const e = (track.effects ?? []).find(x => x.id === info.target.effectId);
        const w = fxChainsByTrackIdRef.current.get(track.id)?.find(x => x.fxId === info.target.effectId);
        if (e && w && info.target.param in (e.params ?? {})) {
          const p = { [info.target.param]: e.params[info.target.param] };
          if (info.target.param === 'wet' && 'dryThru' in e.params) p.dryThru = e.params.dryThru;
          w.updateParams(p);
        }
      }
    }
    prevAutomatedTargetsRef.current = nowAuto;
  }, [resolveAutomationTarget]);

  // Imperative live-preview for lane point drags (Zero-Re-render path): cancel
  // any schedule and ramp to the dragged value like a knob turn; the commit's
  // setTracks → automation-sync effect re-schedules everything on mouseup.
  const applyAutomationValue = useCallback((trackId, target, v01) => {
    const track = tracksRef.current.find(x => x.id === trackId);
    const res = resolveAutomationTarget(track, target);
    if (!res) return;
    if (res.kind === 'set') { res.set(res.toParam(v01)); return; }
    const audioNow = Tone.now();
    for (const { param, map } of res.entries) {
      param.cancelScheduledValues(audioNow);
      param.setValueAtTime(param.value, audioNow);
      param.linearRampToValueAtTime(map(res.toParam(v01), res.ctx), audioNow + 0.02);
    }
  }, [resolveAutomationTarget]);

  // ── 1. Track sync — owns volume + pan + mute nodes ─────────────────────
  // Signal:  regionFadeGain → volume → pan → [FX chain, effect 1b] → mute → Destination
  // Creation wires pan → mute directly; effect 1b re-splices the FX chain in
  // between whenever track.effects structure changes (and is the ONLY code
  // that touches pan's output after creation).
  useEffect(() => {
    const mutes   = mutesByTrackIdRef.current;
    const volumes = volumesByTrackIdRef.current;
    const panners = pannersByTrackIdRef.current;
    const volApp  = appliedVolumeByTrackIdRef.current;
    const panApp  = appliedPanByTrackIdRef.current;
    const liveIds = new Set(tracks.map(t => t.id));

    for (const id of [...mutes.keys()]) {
      if (!liveIds.has(id)) {
        const audition = auditionByTrackIdRef.current.get(id);
        if (audition) {
          audition.synth.dispose();
          auditionByTrackIdRef.current.delete(id);
          if (loadingRegionsRef.current.delete(`audition:${id}`)) recomputeLoadingTrackIds();
        }
        const conn = muteConnByTrackIdRef.current.get(id);
        if (conn?.timer != null) clearTimeout(conn.timer);
        muteConnByTrackIdRef.current.delete(id);
        audibleByTrackIdRef.current.delete(id);
        tailByTrackIdRef.current.delete(id);
        activeUntilByTrackIdRef.current.delete(id);
        volumes.get(id)?.dispose();
        panners.get(id)?.dispose();
        mutes.get(id)?.dispose();
        volumes.delete(id);
        panners.delete(id);
        mutes.delete(id);
        volApp.delete(id);
        panApp.delete(id);
        appliedEnvByTrackIdRef.current.delete(id);
      }
    }
    for (const t of tracks) {
      if (mutes.has(t.id)) continue;
      const mute   = new Tone.Gain(1).toDestination();
      const pan    = new Tone.Panner(t.pan ?? 0).connect(mute);
      const volume = new Tone.Gain(volForSliderValue(t.volume ?? 75)).connect(pan);
      mutes.set(t.id, mute);
      panners.set(t.id, pan);
      volumes.set(t.id, volume);
      muteConnByTrackIdRef.current.set(t.id, { connected: true, timer: null });
      volApp.set(t.id, t.volume ?? 75);
      panApp.set(t.id, t.pan ?? 0);
    }
  }, [tracks, recomputeLoadingTrackIds]);

  // ── 1b. FX chain structural sync — owns pan's output topology ─────────
  // Rebuilds a track's wrapper chain only when the effects STRUCTURE changes
  // (ids/types/order — bypass toggles and param drags never rebuild). Runs
  // after effect #1 in the same commit, so a loaded project's chain is wired
  // on the first pass for free. Declaration order is load-bearing.
  //
  // Accepted limitation: add/remove while the Transport plays is a synchronous
  // rewire — a momentary click on that track is possible. Bypass (the frequent
  // live action) is click-free via the wrapper crossfade.
  useEffect(() => {
    const chains  = fxChainsByTrackIdRef.current;
    const keyApp  = appliedFxKeyByTrackIdRef.current;
    const bypApp  = appliedFxBypassByIdRef.current;
    const parApp  = appliedFxParamsByIdRef.current;
    const panners = pannersByTrackIdRef.current;
    const mutes   = mutesByTrackIdRef.current;
    const liveIds = new Set(tracks.map(t => t.id));

    const disposeChain = (trackId) => {
      for (const w of chains.get(trackId) ?? []) {
        bypApp.delete(w.fxId);
        parApp.delete(w.fxId);
        w.dispose();
      }
      chains.delete(trackId);
    };

    // Teardown for removed tracks (effect #1 already disposed their nodes).
    for (const id of [...chains.keys()]) {
      if (liveIds.has(id)) continue;
      disposeChain(id);
      keyApp.delete(id);
    }

    for (const t of tracks) {
      const pan  = panners.get(t.id);
      const mute = mutes.get(t.id);
      if (!pan || !mute) continue; // race during initial mount — will reconcile on next pass
      const fxList = t.effects ?? [];
      const key = fxList.map(e => `${e.id}:${e.type}`).join('|');
      // '' fallback: a fresh no-FX track skips entirely — the pan→mute wire
      // from effect #1 stands and is never touched.
      if ((keyApp.get(t.id) ?? '') === key) continue;

      // Rebuild: sever pan's output (disconnect() drops ALL its connections,
      // including the pan→mute made at creation — intended), then rewire
      // pan → w0 … wN → mute (or straight pan → mute when the rack is empty).
      // Wrappers are created with the EFFECTIVE bypass (user bypass OR low-
      // quality force-bypass) so a structural rebuild under low quality never
      // momentarily runs a heavy effect.
      pan.disconnect();
      disposeChain(t.id);
      const forceOff = perfQualityRef.current === 'low';
      const wrappers = fxList.map(e =>
        Object.assign(
          makeFx(e.type, e.params, !!e.bypass || (forceOff && HEAVY_EFFECT_TYPES.has(e.type))),
          { fxId: e.id }));
      let prevOut = pan;
      for (const w of wrappers) {
        prevOut.connect(w.input);
        prevOut = w.output;
      }
      prevOut.connect(mute);
      chains.set(t.id, wrappers);
      keyApp.set(t.id, key);
      // Seed applied maps — makeFx already initialized bypass gains + params,
      // so 1c/1d must not re-ramp them this commit.
      for (const e of fxList) {
        bypApp.set(e.id, !!e.bypass || (forceOff && HEAVY_EFFECT_TYPES.has(e.type)));
        parApp.set(e.id, e.params);
      }
    }
  }, [tracks]);

  // ── 1c. FX bypass sync — sole post-init writer of the crossfade gains ─
  // Applies the EFFECTIVE bypass: user bypass OR low-quality force-bypass of
  // heavy FX. track.effects is never mutated, so leaving low quality restores
  // the user's own bypass states in this same pass.
  useEffect(() => {
    const chains   = fxChainsByTrackIdRef.current;
    const bypApp   = appliedFxBypassByIdRef.current;
    const forceOff = performanceQuality === 'low';
    for (const t of tracks) {
      const wrappers = chains.get(t.id);
      if (!wrappers) continue;
      for (const e of t.effects ?? []) {
        const eff = !!e.bypass || (forceOff && HEAVY_EFFECT_TYPES.has(e.type));
        if (bypApp.get(e.id) === eff) continue;
        const w = wrappers.find(x => x.fxId === e.id);
        if (!w) continue;
        w.setBypass(eff);
        bypApp.set(e.id, eff);
      }
    }
  }, [tracks, performanceQuality]);

  // ── 1d. FX param sync — sole post-construction writer of node params ──
  // Reference compare is a correct delta check: updateEffectSettings always
  // mints a new params object, and undo/redo restores different snapshot refs.
  useEffect(() => {
    const chains = fxChainsByTrackIdRef.current;
    const parApp = appliedFxParamsByIdRef.current;
    for (const t of tracks) {
      const wrappers = chains.get(t.id);
      if (!wrappers) continue;
      // Automated params are owned by the automation scheduler — strip them
      // (plus dryThru while wet is automated: the composite's dry gain is
      // coupled to wet, so writing it would stomp the scheduled ramp).
      const autoKeys = automatedFxKeys(t);
      for (const e of t.effects ?? []) {
        if (parApp.get(e.id) === e.params) continue;
        const w = wrappers.find(x => x.fxId === e.id);
        if (!w) continue;
        let params = e.params;
        if (autoKeys.size > 0) {
          const wetAuto = autoKeys.has(`${e.id}:wet`);
          const filtered = {};
          let stripped = false;
          for (const [k, v] of Object.entries(e.params ?? {})) {
            if (autoKeys.has(`${e.id}:${k}`) || (k === 'dryThru' && wetAuto)) { stripped = true; continue; }
            filtered[k] = v;
          }
          if (stripped) params = filtered;
        }
        w.updateParams(params);
        parApp.set(e.id, e.params);
      }
    }
  }, [tracks]);

  // ── 1e. Automation sync — re-anchor/re-schedule when automation data,
  // FX structure (1b just rebuilt wrappers this commit — schedules died with
  // the old nodes), delay dryThru, or BPM changes. Delta-keyed so unrelated
  // tracks-commits (slider drags, mute toggles, region edits) don't churn the
  // schedules mid-playback. Play/seek/stop/undo re-anchoring rides
  // recomputeFades (which calls recomputeAutomation at its end).
  useEffect(() => {
    const key = tracks.map(t =>
      `${t.id}~${JSON.stringify(t.automations ?? [])}~${
        (t.effects ?? []).map(e => `${e.id}:${e.type}:${e.params?.dryThru ? 1 : 0}`).join('|')}`
    ).join('§') + `~${bpm}`;
    if (appliedAutomationKeyRef.current === key) return;
    appliedAutomationKeyRef.current = key;
    recomputeAutomation();
  }, [tracks, bpm, recomputeAutomation]);

  // ── 2. Mute/solo sync — gain ramp + render-graph pruning ──────────────
  // An inaudible track's mute node is disconnected from Destination once its
  // 20ms ramp has landed: unreachable subgraphs aren't rendered, so the whole
  // track (synths, fades, FX incl. LFOs/feedback loops) stops costing audio-
  // thread CPU. Reconnect happens while the gain is still 0, then ramps up —
  // click-free in both directions. Voices triggered while disconnected are
  // skipped at fire time via audibleByTrackIdRef (see makePartCallback).
  useEffect(() => {
    const mutes     = mutesByTrackIdRef.current;
    const conns     = muteConnByTrackIdRef.current;
    const anySoloed = tracks.some(t => t.isSolo);
    for (const t of tracks) {
      const g = mutes.get(t.id);
      if (!g) continue;
      const audible = !t.isMuted && (!anySoloed || t.isSolo);
      audibleByTrackIdRef.current.set(t.id, audible);
      const st = conns.get(t.id) ?? { connected: true, timer: null };
      conns.set(t.id, st);
      if (st.timer != null) { clearTimeout(st.timer); st.timer = null; }
      if (audible) {
        // No-op if connected; otherwise the track was either muted (gain 0)
        // or idle-pruned (silent, gain 1) — reconnect is click-free either way.
        connectTrack(t.id);
        g.gain.rampTo(1, 0.02);
      } else {
        g.gain.rampTo(0, 0.02);
        if (st.connected) {
          st.timer = setTimeout(() => {
            st.timer = null;
            disconnectTrack(t.id);
          }, 50); // > the 20ms ramp — nothing audible left to cut
        }
      }
    }
  }, [tracks, connectTrack, disconnectTrack]);

  // ── 2b. Idle sweeper — activity-based pruning ──────────────────────────
  // 1 Hz: disconnect audible tracks whose activity window has passed and
  // whose synths report no live voices (belt-and-braces for held audition
  // notes — analytic windows already cover Part-scheduled notes). Inaudible
  // tracks are effect #2's territory and are skipped. Wall-clock based, so a
  // paused/idle project also falls to near-zero audio CPU.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Tone.now();
      const ringing = new Set();
      for (const [rid, st] of appliedRegionStateRef.current) {
        if (ringing.has(st.trackId)) continue;
        if (synthIsRinging(synthsByRegionIdRef.current.get(rid))) ringing.add(st.trackId);
      }
      for (const [tid, entry] of auditionByTrackIdRef.current) {
        if (synthIsRinging(entry.synth)) ringing.add(tid);
      }
      for (const [tid, st] of muteConnByTrackIdRef.current) {
        if (!st.connected) continue;
        if (audibleByTrackIdRef.current.get(tid) === false) continue;
        if (now <= (activeUntilByTrackIdRef.current.get(tid) ?? 0)) continue;
        if (ringing.has(tid)) continue;
        disconnectTrack(tid);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [disconnectTrack]);

  // ── 3. Volume sync ─────────────────────────────────────────────────────
  // Skips volume-automated tracks (automation takes over; deleting the cache
  // entry means the slider value re-applies the moment automation is removed).
  useEffect(() => {
    const volumes = volumesByTrackIdRef.current;
    const volApp  = appliedVolumeByTrackIdRef.current;
    for (const t of tracks) {
      const g = volumes.get(t.id);
      if (!g) continue;
      if (isVolumeAutomated(t)) { volApp.delete(t.id); continue; }
      const v = t.volume ?? 75;
      if (volApp.get(t.id) === v) continue;
      g.gain.rampTo(volForSliderValue(v), 0.02);
      volApp.set(t.id, v);
    }
  }, [tracks]);

  // ── 3b. Pan sync ───────────────────────────────────────────────────────
  useEffect(() => {
    const panners = pannersByTrackIdRef.current;
    const panApp  = appliedPanByTrackIdRef.current;
    for (const t of tracks) {
      const p = panners.get(t.id);
      if (!p) continue;
      if (isPanAutomated(t)) { panApp.delete(t.id); continue; }
      const v = Math.max(-1, Math.min(1, t.pan ?? 0));
      if (panApp.get(t.id) === v) continue;
      p.pan.rampTo(v, 0.02);
      panApp.set(t.id, v);
    }
  }, [tracks]);

  // ── 3c. Envelope sync — per-track ADSR override ────────────────────────
  // track.envelope (optional) overrides the instrument default. Applied live
  // to the audition synth (immediate feedback while turning knobs) and every
  // region synth on the track (correct on next play — no synth rebuild).
  // Object-reference compare, mirroring the FX param sync: onEnvelopeChange
  // mints a fresh envelope object each edit. `undefined → default` is handled
  // by resolving to defaultEnvelopeFor so clearing the override (on instrument
  // change) restores the instrument's baseline.
  useEffect(() => {
    const envApp   = appliedEnvByTrackIdRef.current;
    const synths   = synthsByRegionIdRef.current;
    const regsByTrack = new Map();
    for (const r of regions) {
      if (!regsByTrack.has(r.trackId)) regsByTrack.set(r.trackId, []);
      regsByTrack.get(r.trackId).push(r.id);
    }
    for (const t of tracks) {
      if (envApp.get(t.id) === t.envelope) continue;
      envApp.set(t.id, t.envelope);
      const env = t.envelope ?? defaultEnvelopeFor(t.instrument);
      const audition = auditionByTrackIdRef.current.get(t.id);
      if (audition && audition.instrument === t.instrument) applyEnvelope(audition.synth, env);
      for (const rid of regsByTrack.get(t.id) ?? []) applyEnvelope(synths.get(rid), env);
    }
  }, [tracks, regions]);

  // ── 3d. Performance-quality sync — voice cap + scheduling headroom ────
  // medium/low cap every live PolySynth at REDUCED_MAX_POLYPHONY (Samplers
  // have no voice pool) and raise the context lookAhead — late Tone events
  // from a starved main thread are the "eventually plays nothing" failure
  // mode, and more lookahead buys scheduling headroom. lookAhead is context-
  // global: it adds gesture latency on VoxTool while quality is reduced.
  // Synths created later get the cap at build time via perfQualityRef.
  useEffect(() => {
    const reduced = performanceQuality !== 'high';
    const cap = reduced ? REDUCED_MAX_POLYPHONY : 32; // 32 = Tone.PolySynth default
    const applyCap = (s) => {
      if (s && !s.disposed && s.maxPolyphony !== undefined) s.maxPolyphony = cap;
    };
    for (const s of synthsByRegionIdRef.current.values()) applyCap(s);
    for (const entry of auditionByTrackIdRef.current.values()) applyCap(entry.synth);
    Tone.getContext().lookAhead = reduced ? 0.2 : 0.1;
  }, [performanceQuality]);

  // ── 4. Region/Note sync — per-region synth + fade gain + Part ─────────
  useEffect(() => {
    const synths   = synthsByRegionIdRef.current;
    const fades    = fadeGainsByRegionIdRef.current;
    const parts    = partsByRegionIdRef.current;
    const fadeIds  = fadeEventIdByRegionRef.current;
    const applied  = appliedRegionStateRef.current;
    const volumes  = volumesByTrackIdRef.current;
    const liveIds  = new Set(regions.map(r => r.id));
    const trackById = new Map(tracks.map(t => [t.id, t]));

    // Dispose removed regions
    for (const id of [...synths.keys()]) {
      if (liveIds.has(id)) continue;
      const evtId = fadeIds.get(id);
      if (evtId != null) Tone.Transport.clear(evtId);
      parts.get(id)?.dispose();
      synths.get(id)?.dispose();
      fades.get(id)?.dispose();
      parts.delete(id);
      synths.delete(id);
      fades.delete(id);
      fadeIds.delete(id);
      applied.delete(id);
      if (loadingRegionsRef.current.delete(id)) recomputeLoadingTrackIds();
    }

    // Helper — build a synth, wire sampler loading bookkeeping if needed.
    const buildSynthForRegion = (regionId, trackId, instrument, destination, envelope) => {
      const sampled = isSampledInstrument(instrument);
      if (sampled) {
        loadingRegionsRef.current.set(regionId, trackId);
        recomputeLoadingTrackIds();
      }
      const opts = { envelope };
      if (perfQualityRef.current !== 'high') opts.maxPolyphony = REDUCED_MAX_POLYPHONY;
      if (sampled) {
        opts.onLoad = () => {
          // Mark this region loaded only if it still maps to this instrument.
          const st = applied.get(regionId);
          if (st) applied.set(regionId, { ...st, loaded: true });
          if (loadingRegionsRef.current.delete(regionId)) recomputeLoadingTrackIds();
        };
      }
      const synth = makeSynth(instrument, opts);
      synth.connect(destination);
      return synth;
    };

    for (const r of regions) {
      const track = trackById.get(r.trackId);
      if (!track) continue;
      const trackVolume = volumes.get(r.trackId);
      if (!trackVolume) continue; // race during initial mount — will reconcile on next pass

      const prev = applied.get(r.id);
      const partKey = computePartKey(r, notes);
      const fadeKey = computeFadeKey(r);
      const instrumentChanged = !prev || prev.instrument !== track.instrument;
      const partChanged       = !prev || prev.partKey  !== partKey;
      const fadeChanged       = !prev || prev.fadeKey  !== fadeKey;

      // (Re)build synth + fadeGain on first appearance OR when instrument changed.
      if (!synths.has(r.id)) {
        const fadeGain = new Tone.Gain(1).connect(trackVolume);
        const synth    = buildSynthForRegion(r.id, r.trackId, track.instrument, fadeGain, track.envelope);
        synths.set(r.id, synth);
        fades.set(r.id, fadeGain);
      } else {
        if (instrumentChanged) {
          // Clear any pending sampler load for the prior instrument.
          if (loadingRegionsRef.current.delete(r.id)) recomputeLoadingTrackIds();
          synths.get(r.id)?.dispose();
          const synth = buildSynthForRegion(r.id, r.trackId, track.instrument, fades.get(r.id), track.envelope);
          synths.set(r.id, synth);
        }
        // Region moved to another track: re-parent its fadeGain into the new
        // track's chain (volume → pan → FX → mute). The track volume node is
        // the fadeGain's only downstream connection, so a full disconnect is
        // safe; the synth → fadeGain edge is untouched.
        if (prev && prev.trackId !== r.trackId) {
          const fadeGain = fades.get(r.id);
          fadeGain.disconnect();
          fadeGain.connect(trackVolume);
        }
      }

      // (Re)build Part
      if (partChanged || instrumentChanged) {
        const existing = parts.get(r.id);
        if (existing) { existing.dispose(); parts.delete(r.id); }
        const events = buildRegionEvents(r, notes);
        if (events.length > 0) {
          const synth = synths.get(r.id);
          const part = new Tone.Part(
            makePartCallback(synth, liveSamplerSourcesRef.current, isDrumKit(track.instrument),
                             r.id, appliedRegionStateRef, audibleByTrackIdRef, noteLifecycleRef,
                             tempoMapRef),
            events
          );
          part.start(0);
          parts.set(r.id, part);
        }
      }

      // (Re)schedule fade envelope — durations resolve at fire time through
      // tempoMapRef, so BPM/tempo-lane changes need no reschedule here.
      if (fadeChanged || instrumentChanged) {
        const prevEvt = fadeIds.get(r.id);
        if (prevEvt != null) Tone.Transport.clear(prevEvt);
        const fadeGain = fades.get(r.id);
        const evtId = scheduleFadeEnvelope(fadeGain, r, tempoMapRef);
        if (evtId != null) fadeIds.set(r.id, evtId);
        else               fadeIds.delete(r.id);
      }

      const prevLoaded = applied.get(r.id)?.loaded;
      const loaded = isSampledInstrument(track.instrument)
        ? (instrumentChanged ? !!synths.get(r.id)?.loaded : (prevLoaded ?? !!synths.get(r.id)?.loaded))
        : true;
      applied.set(r.id, { instrument: track.instrument, partKey, fadeKey, loaded, trackId: r.trackId });
    }
  }, [tracks, regions, notes, bpm, recomputeLoadingTrackIds]);

  // Silence in-flight voices on pause/stop/seek (Tone.Transport.pause keeps
  // tails alive). Three layers:
  //
  // 0. TRACKED-SOURCE KILL — the real sampler ghost-note fix. Sampler.
  //    triggerAttackRelease pre-schedules source.stop() at an ABSOLUTE audio
  //    time and empties _activeSources at schedule time (Tone 15.1.22
  //    Sampler.triggerRelease) — so every Part-scheduled sampler note is
  //    invisible to releaseAll()/layer 1 from the instant it's scheduled,
  //    and Transport.pause doesn't pause the AudioContext, so the buffer
  //    keeps playing in wall-clock time behind the layer-2 mute. When
  //    recomputeFades() restored the fade gain on resume/seek, the still-
  //    running source resurfaced ("ghost note"). makePartCallback therefore
  //    captures each source between triggerAttack and triggerRelease into
  //    liveSamplerSourcesRef; here we re-stop them NOW — valid because
  //    OneShotSource.stop() calls cancelStop() first, so an already-
  //    scheduled future stop can be pulled earlier.
  //
  // 1. SOURCE-LEVEL KILL — releaseAll() alone leaves each voice's release
  //    tail sounding: sampled instruments carry release: 1 (baked into every
  //    ToneBufferSource's fadeOut at trigger time), and on the seek path
  //    recomputeFades() runs synchronously right after this and restores the
  //    fade gain instantly — so a 1s tail would ride through at full gain
  //    (the "sampler ghost note"). Fix at the voice source, so fade-restore
  //    timing stops mattering:
  //      · Sampler — pre-set fadeOut = HARD_CUT_SEC on every active source
  //        before releaseAll(); OneShotSource._stopGain reads _fadeOut at
  //        stop-call time (verified Tone 15.1.22). _activeSources is private
  //        API — optional-chained so a future Tone bump degrades to the old
  //        tail behavior instead of crashing.
  //      · PolySynth — Envelope.triggerRelease reads envelope.release at call
  //        time, so temporarily set it to HARD_CUT_SEC around releaseAll()
  //        (strings' 0.8s release was the synth-side ghost) and restore in
  //        the same tick — Part callbacks can't interleave with sync JS.
  //
  // 2. FADE-GAIN BACKSTOP — ramp every region's fade gain to 0 in ~20ms.
  //    recomputeFades() (on resume/seek) restores it — pause writes 0, play
  //    recomputes, never concurrent (single-writer preserved).
  const HARD_CUT_SEC = 0.02;
  const silenceAll = useCallback(() => {
    const audioNow = Tone.now();
    for (const src of liveSamplerSourcesRef.current) {
      if (!src.disposed) {
        src.fadeOut = HARD_CUT_SEC; // _stopGain reads _fadeOut at stop-call time
        src.stop(audioNow);
      }
    }
    liveSamplerSourcesRef.current.clear();
    const hardCutSynth = (s) => {
      if (!s || s.disposed) return;
      if (s._activeSources) {
        // Tone.Sampler — hard-cut each active buffer source.
        s._activeSources.forEach?.((sources) => {
          sources?.forEach?.((src) => { src.fadeOut = HARD_CUT_SEC; });
        });
        s.releaseAll?.();
      } else if (typeof s.releaseAll === 'function') {
        // Tone.PolySynth — shorten the amplitude release around the releaseAll.
        const origRelease = s.get?.()?.envelope?.release;
        if (origRelease != null) s.set({ envelope: { release: HARD_CUT_SEC } });
        s.releaseAll();
        if (origRelease != null) s.set({ envelope: { release: origRelease } });
      }
    };
    for (const s of synthsByRegionIdRef.current.values()) hardCutSynth(s);
    // Audition synths too — a held performance note must not survive
    // stop/pause/seek. They bypass region fadeGains, so layer 2 below never
    // touches them and audition stays usable immediately after.
    for (const entry of auditionByTrackIdRef.current.values()) hardCutSynth(entry.synth);
    for (const g of fadeGainsByRegionIdRef.current.values()) {
      if (!g) continue;
      g.gain.cancelScheduledValues(audioNow);
      g.gain.setValueAtTime(g.gain.value, audioNow);
      g.gain.linearRampToValueAtTime(0, audioNow + HARD_CUT_SEC);
    }
  }, []);

  // Reset every region's fade gain to its correct value at the current Transport
  // position. Schedules the remaining envelope ramps in absolute AudioContext
  // time, so it's only valid right before/while the transport is playing.
  // Called by WorkstationShell on play, seek, BPM commit, and stop.
  const recomputeFades = useCallback(() => {
    // Tempo FIRST — everything below (and recomputeAutomation at the end)
    // consumes the freshly rebuilt tempoMapRef.
    recomputeTempo();
    const map     = tempoMapRef.current;
    const fades   = fadeGainsByRegionIdRef.current;
    const nowM    = Tone.Transport.ticks / (Tone.Transport.PPQ * 4);
    const nowSec  = map.secondsAtMeasure(nowM);
    const audioNow = Tone.now();
    for (const r of regionsRef.current) {
      const fadeGain = fades.get(r.id);
      if (!fadeGain) continue;
      // Region boundaries through the tempo map — a fade spanning a tempo ramp
      // lands exactly on its measure boundaries (constant-bpm math wouldn't).
      const startSec  = map.secondsAtMeasure(r.startMeasure);
      const endSec    = map.secondsAtMeasure(r.startMeasure + r.durationMeasures);
      const fInSec    = map.secondsAtMeasure(r.startMeasure + (r.fadeIn ?? 0)) - startSec;
      const fOutSec   = endSec - map.secondsAtMeasure(r.startMeasure + r.durationMeasures - (r.fadeOut ?? 0));
      const fOutFloor = Math.max(0, Math.min(1, r.fadeOutFloor ?? 0));

      const g = fadeGain.gain;
      g.cancelScheduledValues(audioNow);

      const currentValue = computeFadeGainAt(r, nowSec, map);
      g.setValueAtTime(currentValue, audioNow);

      if (nowSec >= endSec) continue;
      if (nowSec < startSec) continue; // pre-region: existing Transport.schedule will fire

      // Inside the region — schedule remaining ramps in absolute audio time.
      const audioAt = (transportSec) => audioNow + (transportSec - nowSec);
      const fadeInEnd     = startSec + fInSec;
      const fadeOutStart  = endSec - fOutSec;

      if (nowSec < fadeInEnd && fInSec > 0) {
        g.linearRampToValueAtTime(1, audioAt(fadeInEnd));
      }
      if (fadeOutStart > nowSec && fadeOutStart > fadeInEnd) {
        g.setValueAtTime(1, audioAt(fadeOutStart));
      }
      if (fOutSec > 0 && nowSec < endSec) {
        g.linearRampToValueAtTime(fOutFloor, audioAt(endSec));
      }
    }
    // Automation rides the same re-anchor moments (play/seek/BPM/stop/undo) —
    // recomputeFades' 7 call sites in the shell cover every transport
    // transition, so automation needs zero new shell wiring.
    recomputeAutomation();
  }, [recomputeTempo, recomputeAutomation]);

  // ── 1f. Tempo sync — re-anchor the bpm curve (and everything that consumes
  // the tempo map: fades + automation) when the global tempo lane or the base
  // bpm changes. Declared here (after recomputeFades — TDZ) so it runs AFTER
  // 1e in a shared-trigger commit; 1e's recomputeAutomation may briefly use
  // the previous map, but this effect immediately recomputes the full chain
  // (recomputeTempo → fades → recomputeAutomation) with the fresh one.
  useEffect(() => {
    const key = JSON.stringify(globalAutomations ?? []) + '~' + bpm;
    if (appliedTempoKeyRef.current === key) return;
    appliedTempoKeyRef.current = key;
    recomputeFades();
  }, [globalAutomations, bpm, recomputeFades]);

  // ── 5. Cleanup on unmount ──────────────────────────────────────────────
  useEffect(() => {
    const mutes   = mutesByTrackIdRef.current;
    const volumes = volumesByTrackIdRef.current;
    const panners = pannersByTrackIdRef.current;
    const synths  = synthsByRegionIdRef.current;
    const fades   = fadeGainsByRegionIdRef.current;
    const parts   = partsByRegionIdRef.current;
    const fadeIds = fadeEventIdByRegionRef.current;
    const applied = appliedRegionStateRef.current;
    const volApp  = appliedVolumeByTrackIdRef.current;
    const panApp  = appliedPanByTrackIdRef.current;
    const fxChains = fxChainsByTrackIdRef.current;
    const fxKeyApp = appliedFxKeyByTrackIdRef.current;
    const fxBypApp = appliedFxBypassByIdRef.current;
    const fxParApp = appliedFxParamsByIdRef.current;
    const liveSrcs = liveSamplerSourcesRef.current;
    const auditions = auditionByTrackIdRef.current;
    const muteConns = muteConnByTrackIdRef.current;
    const audible   = audibleByTrackIdRef.current;
    const tails     = tailByTrackIdRef.current;
    const actives   = activeUntilByTrackIdRef.current;
    const steppedId = steppedRepeatIdRef;
    const steppedTargets = steppedTargetsRef;
    const prevAutomated = prevAutomatedTargetsRef;
    const appliedAutoKey = appliedAutomationKeyRef;
    const appliedTempoKey = appliedTempoKeyRef;
    const bpmR = bpmRef;
    return () => {
      // Transport.cancel(0) below wipes the automation schedules — reset the
      // delta keys so a remount (StrictMode's simulated one included) re-runs
      // recomputeAutomation/recomputeTempo instead of skipping on stale matches.
      appliedAutoKey.current = '';
      appliedTempoKey.current = '';
      // Transport.cancel does NOT clear bpm-SIGNAL automation, and the
      // Transport is a singleton shared with VoxTool (transport-clocked arp)
      // — leftover tempo ramps would warp it. Restore the flat base bpm.
      Tone.Transport.bpm.cancelScheduledValues(0);
      Tone.Transport.bpm.value = bpmR.current;
      for (const st of muteConns.values()) if (st.timer != null) clearTimeout(st.timer);
      muteConns.clear();
      audible.clear();
      tails.clear();
      actives.clear();
      liveSrcs.clear(); // sources die with their synths below
      steppedId.current = null; // Transport.cancel(0) below clears the repeat
      steppedTargets.current = [];
      prevAutomated.current.clear();
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      for (const id of fadeIds.values()) Tone.Transport.clear(id);
      for (const p of parts.values())   p.dispose();
      for (const e of auditions.values()) e.synth.dispose();
      auditions.clear();
      for (const s of synths.values())  s.dispose();
      for (const g of fades.values())   g.dispose();
      for (const g of volumes.values()) g.dispose();
      for (const p of panners.values()) p.dispose();
      for (const ws of fxChains.values()) for (const w of ws) w.dispose();
      for (const g of mutes.values())   g.dispose();
      mutes.clear();
      volumes.clear();
      panners.clear();
      fxChains.clear();
      fxKeyApp.clear();
      fxBypApp.clear();
      fxParApp.clear();
      synths.clear();
      fades.clear();
      parts.clear();
      fadeIds.clear();
      applied.clear();
      volApp.clear();
      panApp.clear();
    };
  }, []);

  return {
    silenceAll, recomputeFades, loadingTrackIds,
    auditionAttack, auditionRelease, auditionReleaseAll,
    auditionPrime: ensureAuditionSynth,
    applyAutomationValue,
  };
}

// Pure: envelope's expected linear gain at a given transport time (seconds).
// `map` is a tempoMath buildTempoMap result — boundaries land on the region's
// measure positions through any tempo curve; the fade itself stays linear in
// seconds (what the scheduled Web Audio ramps actually do).
export function computeFadeGainAt(r, transportSec, map) {
  const startSec  = map.secondsAtMeasure(r.startMeasure);
  const endSec    = map.secondsAtMeasure(r.startMeasure + r.durationMeasures);
  const fInSec    = map.secondsAtMeasure(r.startMeasure + (r.fadeIn ?? 0)) - startSec;
  const fOutSec   = endSec - map.secondsAtMeasure(r.startMeasure + r.durationMeasures - (r.fadeOut ?? 0));
  const fInFloor  = Math.max(0, Math.min(1, r.fadeInFloor  ?? 0));
  const fOutFloor = Math.max(0, Math.min(1, r.fadeOutFloor ?? 0));
  if (fInSec === 0 && fOutSec === 0) return 1;
  if (transportSec <  startSec) return fInSec > 0 ? fInFloor : 1;
  if (transportSec >= endSec)   return fOutSec > 0 ? fOutFloor : 1;
  const fadeInEnd    = startSec + fInSec;
  const fadeOutStart = endSec - fOutSec;
  if (transportSec < fadeInEnd && fInSec > 0) {
    const t = (transportSec - startSec) / fInSec;
    return fInFloor + (1 - fInFloor) * t;
  }
  if (transportSec >= fadeOutStart && fOutSec > 0) {
    const t = (transportSec - fadeOutStart) / fOutSec;
    return 1 + (fOutFloor - 1) * t;
  }
  return 1;
}

function makePartCallback(synth, liveSources, isDrum = false,
                          regionId = null, regionStateRef = null, audibleTracksRef = null,
                          noteLifecycleRef = null, mapRef = null) {
  return (time, ev) => {
    // Note duration through the tempo map: event time/duration are "<ticks>i"
    // strings, so the note's real length under a tempo ramp is the map's
    // seconds difference across its tick span. toSeconds(ev.duration) is the
    // fallback (instantaneous bpm — slightly off for notes held THROUGH a
    // ramp).
    const durSec = (mapRef?.current && typeof ev.duration === 'string')
      ? (() => {
          const beatsPerMeasure = Tone.Transport.PPQ * 4;
          const m0 = parseInt(ev.time, 10) / beatsPerMeasure;
          const m1 = m0 + parseInt(ev.duration, 10) / beatsPerMeasure;
          return mapRef.current.secondsAtMeasure(m1) - mapRef.current.secondsAtMeasure(m0);
        })()
      : (synth?.toSeconds(ev.duration) ?? 0);
    // Inaudible track (muted, or another track soloed): skip triggering
    // entirely — the track subtree is disconnected from the destination
    // (effect #2), so voices would be pure allocation/GC waste. The trackId
    // is looked up LIVE through appliedRegionStateRef because dragging a
    // region to another track does NOT rebuild its Part (partKey unchanged)
    // — a trackId captured at build time would go stale. Missing entries
    // default to audible. Trade-off: unmuting mid-note waits for the next
    // note onset.
    const trackId = regionStateRef?.current.get(regionId)?.trackId;
    if (trackId != null && audibleTracksRef?.current.get(trackId) === false) return;
    // Activity pruning: reconnect an idle-pruned (audible) track and extend
    // its ringing window. This runs BEFORE the load guard on purpose — even
    // a skipped unready-sampler note marks the track active, so its chain is
    // up when the sampler finishes loading mid-playback.
    if (trackId != null && noteLifecycleRef?.current) {
      noteLifecycleRef.current.onNoteScheduled(
        trackId, synth?.toSeconds(time) ?? Tone.now(), durSec);
    }
    // A Tone.Sampler throws "buffer is either not set or not loaded" if triggered before
    // its buffers finish loading (instrument hot-swap or paste while the Transport runs).
    // `loaded === false` ONLY skips an unready Sampler — PolySynths have no `loaded`
    // (undefined !== false) so they always play. Re-checked at fire time, so once the
    // sampler loads, later events on the same Part play normally (no Part rebuild needed).
    if (!synth || synth.disposed || synth.loaded === false) return;
    if (synth._activeSources) {
      // Tone.Sampler — split triggerAttackRelease into its exact internal steps
      // (attack at t, release at t + duration; behavior-identical) so the new
      // buffer source can be captured while it's still in _activeSources.
      // triggerRelease deregisters it synchronously, which is why silenceAll's
      // releaseAll() sweep could never see Part-scheduled notes (ghost-note bug).
      // _activeSources is private API — the else branch is the graceful fallback
      // if a future Tone bump removes it.
      const t = synth.toSeconds(time);
      // Hi-hat choke: a closed-hat attack cuts a ringing open hat (and vice
      // versa). Safe no-op when nothing in the group is ringing; the fade is
      // the kit's `release` (~50 ms).
      if (isDrum) for (const tgt of chokeTargetsFor(ev.note)) synth.triggerRelease(tgt, t);
      synth.triggerAttack(ev.note, t, 0.8);
      synth._activeSources.forEach((srcs) => srcs.forEach((src) => {
        if (liveSources.has(src)) return;
        liveSources.add(src);
        const prev = src.onended;
        src.onended = () => { prev?.(); liveSources.delete(src); };
      }));
      // Drums are one-shots: skip the note-end release so short drawn notes
      // never truncate a cymbal — the buffer source self-stops at sample end
      // (ToneBufferSource.start pre-schedules its own stop).
      if (!isDrum) synth.triggerRelease(ev.note, t + durSec);
    } else {
      synth.triggerAttackRelease(ev.note, durSec, time, 0.8);
    }
  };
}

// ── Public helpers ────────────────────────────────────────────────────────

// Per-track ring-out bound: how long a track can stay audible past its last
// note END (synth release, drum one-shots, non-bypassed delay/reverb decay to
// −60 dB). Pure — shared by the live activity pruner (idle sweeper) and
// audioBounce's whole-project tail estimate. Clamp [2, 30]: the floor covers
// ramps and short releases; the ceiling is the documented compromise for
// pathological delay settings (time 1.0 / feedback 0.9 would need ~66 s).
// Automation can push a delay/reverb param past its static value — take the
// max over the lane's points so the analytic tail bound still holds.
function maxAutomatedParam(t, effectId, type, param, staticVal) {
  const meta = EFFECT_DEFS[type]?.params?.[param];
  if (!meta) return staticVal;
  let m = staticVal;
  for (const a of t.automations ?? []) {
    if (a.target?.kind !== 'fx' || a.target.effectId !== effectId || a.target.param !== param) continue;
    for (const p of a.points ?? []) m = Math.max(m, denorm(p.value, meta));
  }
  return m;
}

export function estimateTrackTailSec(t) {
  // Synth release rings past the note end (drums: one-shots ignore duration
  // entirely, so a cymbal on the last note needs the 6 s floor).
  let tail = t.envelope?.release ?? defaultEnvelopeFor(t.instrument)?.release ?? 1;
  if (isDrumKit(t.instrument)) tail = Math.max(tail, 6);
  for (const e of t.effects ?? []) {
    if (e.bypass) continue;
    const p = e.params ?? {};
    if (e.type === 'delay' && maxAutomatedParam(t, e.id, 'delay', 'wet', p.wet ?? 0) > 0) {
      // Repeats to decay to −60 dB through the feedback loop.
      const fb = maxAutomatedParam(t, e.id, 'delay', 'feedback', p.feedback ?? 0);
      const time = maxAutomatedParam(t, e.id, 'delay', 'time', p.time ?? 0.25);
      const repeats = fb > 0 ? Math.ceil(Math.log(1e-3) / Math.log(fb)) : 1;
      tail = Math.max(tail, time * repeats);
    } else if (e.type === 'reverb' && maxAutomatedParam(t, e.id, 'reverb', 'wet', p.wet ?? 0) > 0) {
      // Freeverb has no analytic decay; generous comb-decay heuristic.
      tail = Math.max(tail, 1 + maxAutomatedParam(t, e.id, 'reverb', 'roomSize', p.roomSize ?? 0.7) * 9);
    }
  }
  return Math.min(30, Math.max(2, tail));
}

// True while a synth has live voices — the sweeper's guard against pruning a
// track whose audition note is held past the analytic window. PolySynth has
// a public activeVoices count; Sampler falls back to the private
// _activeSources map (optional-chained — same caveat as silenceAll: a future
// Tone bump degrades this to "never ringing", covered by the analytic window).
function synthIsRinging(s) {
  if (!s || s.disposed) return false;
  if (typeof s.activeVoices === 'number') return s.activeVoices > 0;
  let n = 0;
  s._activeSources?.forEach?.((srcs) => { n += srcs?.length ?? 0; });
  return n > 0;
}

export function volForSliderValue(v) {
  const clamped = Math.max(0, Math.min(100, v));
  return Tone.dbToGain(-24 + (clamped / 100) * 32);
}

// Tone.Part event list for a region. Pure — safe to call inside Tone.Offline.
export function buildRegionEvents(r, allNotes) {
  if (r.isMuted) return []; // muted region schedules nothing (live engine + offline bounce)
  const PPQ           = Tone.Transport.PPQ;
  const co            = r.clipOffset ?? 0;
  const looped        = r.loopInterval != null;
  const li            = looped ? r.loopInterval : r.durationMeasures; // home/base length
  const phase         = looped ? (r.loopPhase ?? 0) : 0;
  const regionStartB  = r.startMeasure * 4;
  const regionEndB    = (r.startMeasure + r.durationMeasures) * 4;
  const windowLoB     = co * 4;          // home window: bottle beats [co, co+li)
  const windowHiB     = (co + li) * 4;

  const push = (events, globalStartB, dur, note) => {
    if (globalStartB >= regionEndB) return false;
    const clippedEnd = Math.min(globalStartB + dur, regionEndB);
    const durBeats   = clippedEnd - globalStartB;
    if (durBeats <= 0) return true;
    events.push({
      time:     `${Math.round(globalStartB * PPQ)}i`,
      note,
      duration: `${Math.round(durBeats     * PPQ)}i`,
    });
    return true;
  };

  const events = [];
  for (const n of allNotes) {
    if (n.regionId !== r.id) continue;
    if (n.startBeat <  windowLoB) continue;
    if (n.startBeat >= windowHiB) continue;

    if (!looped) {
      // Single window pass — bottle origin at (startMeasure − clipOffset).
      push(events, (r.startMeasure - co) * 4 + n.startBeat, n.durationBeats, n.note);
      continue;
    }
    // Looped: replay this note at firstLoopOffset + j*li, wrapping the home cycle
    // by the region's loopPhase (see loopMath). phase 0 ⇒ identical to the old
    // `i*baseLoop` unroll.
    const homeLocalMeasures = n.startBeat / 4 - co;            // [0, li)
    const firstOffM = firstLoopOffsetMeasures(homeLocalMeasures, phase, li);
    for (let j = 0; ; j++) {
      const globalStartB = (regionStartB / 4 + firstOffM + j * li) * 4;
      if (!push(events, globalStartB, n.durationBeats, n.note)) break;
    }
  }
  return events;
}

// Schedule the fade envelope onto a Gain at the region's transport start tick.
// Returns the Tone.Transport schedule id (or null if nothing to schedule).
// `mapRef` is a { current: tempoMap } holder (live: tempoMapRef; offline: a
// plain object wrapping the bounce's map). Durations are computed INSIDE the
// fire-time callback from the CURRENT map, so a BPM change (or tempo-lane
// edit) before the region starts no longer desyncs the envelope — the old
// "computed at scheduling time" MVP caveat is gone.
export function scheduleFadeEnvelope(fadeGain, r, mapRef) {
  const PPQ = Tone.Transport.PPQ;
  const startTicks = Math.round(r.startMeasure * 4 * PPQ);
  const fadeIn   = Math.max(0, Math.min(r.fadeIn  ?? 0, r.durationMeasures));
  const fadeOut  = Math.max(0, Math.min(r.fadeOut ?? 0, r.durationMeasures));
  const fInFloor  = Math.max(0, Math.min(1, r.fadeInFloor  ?? 0));
  const fOutFloor = Math.max(0, Math.min(1, r.fadeOutFloor ?? 0));

  // Trivial case — no fades. Reset gain to 1 and skip scheduling.
  if (fadeIn === 0 && fadeOut === 0) {
    fadeGain.gain.cancelScheduledValues(0);
    fadeGain.gain.value = 1;
    return null;
  }

  const id = Tone.Transport.schedule((time) => {
    const map = mapRef.current;
    const startSec = map.secondsAtMeasure(r.startMeasure);
    const endSec   = map.secondsAtMeasure(r.startMeasure + r.durationMeasures);
    const totalSec = endSec - startSec;
    // Fade windows through the tempo map (each measured at its own end of the
    // region), then the merged-joint guard: fadeIn + fadeOut <= duration.
    let fInSec  = map.secondsAtMeasure(r.startMeasure + fadeIn) - startSec;
    let fOutSec = endSec - map.secondsAtMeasure(r.startMeasure + r.durationMeasures - fadeOut);
    if (fInSec + fOutSec > totalSec) {
      const scale = totalSec / (fInSec + fOutSec);
      fInSec  *= scale;
      fOutSec *= scale;
    }
    const g = fadeGain.gain;
    g.cancelScheduledValues(time);
    // Fade-in
    if (fInSec > 0) {
      g.setValueAtTime(fInFloor, time);
      g.linearRampToValueAtTime(1, time + fInSec);
    } else {
      g.setValueAtTime(1, time);
    }
    // Sustain segment (unity)
    const outStart = time + totalSec - fOutSec;
    if (outStart > time + fInSec) g.setValueAtTime(1, outStart);
    // Fade-out
    if (fOutSec > 0) {
      g.linearRampToValueAtTime(fOutFloor, time + totalSec);
    }
  }, `${startTicks}i`);

  return id;
}

// Internal — change-detection keys
function computePartKey(r, notes) {
  // Anything that buildRegionEvents reads.
  let key = `${r.id}|${r.startMeasure}|${r.durationMeasures}|${r.clipOffset ?? 0}|${r.loopInterval ?? 'n'}|${r.loopPhase ?? 0}|${r.isMuted ? 'm' : ''}`;
  for (const n of notes) {
    if (n.regionId !== r.id) continue;
    key += `|${n.id}:${n.note}:${n.startBeat.toFixed(4)}:${n.durationBeats.toFixed(4)}`;
  }
  return key;
}
// No bpm component: envelope durations resolve at fire time via tempoMapRef,
// so a BPM/tempo change needs no reschedule (startTicks is bpm-independent).
function computeFadeKey(r) {
  return `${r.startMeasure}|${r.durationMeasures}|${r.fadeIn ?? 0}|${r.fadeOut ?? 0}|${r.fadeInFloor ?? 0}|${r.fadeOutFloor ?? 0}`;
}
