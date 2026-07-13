import { useEffect, useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';
import { makeSynth, makeGlideVoice, applyEnvelope, defaultEnvelopeFor, isSampledInstrument, isDrumKit, chokeTargetsFor } from '../components/Workstation/synthFactory';
import { makeFx } from '../components/Workstation/fxChain';
import { HEAVY_EFFECT_TYPES, EFFECT_DEFS, metaForTarget } from '../components/Workstation/effectDefs';
import {
  automationValueAt, denorm, targetKey,
  isVolumeAutomated, isPanAutomated, automatedFxKeys,
} from '../components/Workstation/automationMath';
import { buildTempoMap, tempoPointsOf, tempoScheduleOps } from '../components/Workstation/tempoMath';
import { firstLoopOffsetMeasures } from '../components/Workstation/loopMath';
import {
  compileGlideChains, clipSegments, segmentsAreInert, planGlideSegments,
} from '../components/Workstation/glideMath';

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

// Concurrent glide mono-voices per region (chains beyond the cap steal the
// oldest voice — the REDUCED_MAX_POLYPHONY philosophy applied to glides).
const GLIDE_VOICE_CAP_HIGH = 8;
const GLIDE_VOICE_CAP_REDUCED = 4;

// Effective pan of a grouped track = clampPan(track.pan + group.pan): the
// group knob/lane is a member OFFSET, never a write to track.pan — so a
// fully-panned member pins at the wall and returns to its own value when the
// group un-pans. Shared by pan sync (#3b), the group-pan automation resolve,
// and the offline bounce (audioBounce.js).
export const clampPan = (v) => Math.max(-1, Math.min(1, v));

export default function useWorkstationAudio({ tracks, regions, notes, bpm, performanceQuality = 'high', globalAutomations = [], groups = [] }) {
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

  // ── Group sub-buses ─────────────────────────────────────────────────────
  // Per-group chain: memberMutes → groupIn(Gain) → groupVolume(Gain) →
  // groupPan(Panner) → [group FX wrappers] → groupMute(Gain) → Destination.
  // groupPan is INERT GLUE pinned at 0: group pan (knob AND lane) is applied
  // as a per-member offset on the member panners (see clampPan / #3b) — the
  // node only remains as the FX-splice head effect 1b expects per family.
  // Track ids (t<n>) and group ids (g<n>) are disjoint namespaces, so the
  // per-effect delta maps (appliedFxBypass/Params) and the automation
  // machinery treat a group as just another channel — node lookups union the
  // track and group maps by id.
  const groupInByIdRef         = useRef(new Map()); // groupId → Gain (bus input)
  const groupVolumesByIdRef    = useRef(new Map()); // groupId → Gain
  const groupPannersByIdRef    = useRef(new Map()); // groupId → Panner (always 0 — chain glue)
  const groupMutesByIdRef      = useRef(new Map()); // groupId → Gain
  const groupMuteConnByIdRef   = useRef(new Map()); // groupId → { connected, timer }
  const groupAudibleByIdRef    = useRef(new Map()); // groupId → bool (effect #2 writer)
  const appliedGroupVolByIdRef = useRef(new Map()); // groupId → last 0..100
  const fxChainsByGroupIdRef      = useRef(new Map()); // groupId → [makeFx wrapper]
  const appliedFxKeyByGroupIdRef  = useRef(new Map()); // groupId → structural key
  const appliedOutputByTrackIdRef = useRef(new Map()); // trackId → output node last wired (membership sync)

  // Reconnects an AUDIBLE track's mute node (no-op for inaudible tracks —
  // mute/solo connection state is owned by effect #2, and reconnecting a
  // muted track would just render silently). Gain is untouched: an idle-
  // pruned track's gain sits at 1, so the reconnect is instant; anything
  // frozen in its FX buffers is ≤ −60 dB by construction (see the sweeper).
  // A track's output target: its group's bus input, or the Destination for
  // ungrouped tracks. Read at CONNECT time (never cached in a closure) so a
  // membership change or group deletion can't wire into a disposed node.
  const outputForTrack = useCallback((trackId) => {
    const gid = tracksRef.current.find(t => t.id === trackId)?.groupId;
    const gin = gid ? groupInByIdRef.current.get(gid) : null;
    return (gin && !gin.disposed) ? gin : Tone.getDestination();
  }, []);

  // Group-bus twins of connectTrack/disconnectTrack — same audibility gate,
  // same { connected, timer } bookkeeping, owned by effect #2 + the sweeper.
  const connectGroup = useCallback((groupId) => {
    if (groupAudibleByIdRef.current.get(groupId) === false) return;
    const st = groupMuteConnByIdRef.current.get(groupId);
    const g  = groupMutesByIdRef.current.get(groupId);
    if (!st || !g || g.disposed || st.connected) return;
    g.connect(Tone.getDestination());
    st.connected = true;
  }, []);

  const disconnectGroup = useCallback((groupId) => {
    const st = groupMuteConnByIdRef.current.get(groupId);
    const g  = groupMutesByIdRef.current.get(groupId);
    if (!st || !g || g.disposed || !st.connected) return;
    g.disconnect();
    st.connected = false;
  }, []);

  const connectTrack = useCallback((trackId) => {
    if (audibleByTrackIdRef.current.get(trackId) === false) return;
    // The bus must be up whenever a member plays — before the early-return so
    // an already-connected track still revives an idle-pruned group bus.
    const gid = tracksRef.current.find(t => t.id === trackId)?.groupId;
    if (gid) connectGroup(gid);
    const st = muteConnByTrackIdRef.current.get(trackId);
    const g  = mutesByTrackIdRef.current.get(trackId);
    if (!st || !g || g.disposed || st.connected) return;
    g.connect(outputForTrack(trackId));
    st.connected = true;
  }, [outputForTrack, connectGroup]);

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
  const groupsRef  = useRef(groups);  groupsRef.current  = groups;
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

  // Glide voice pools — bare mono voices (makeGlideVoice) for synth-family
  // chain scheduling; PolySynth can't expose per-voice detune, so glide
  // events get dedicated voices connected to the region's fadeGain (they ride
  // fade → volume → pan → FX → mute like the region synth). LAZY: a
  // glide-free project never allocates one. The glide scheduler is the SINGLE
  // writer of a pool voice's detune/volume.
  const glideVoicesByRegionIdRef = useRef(new Map()); // regionId → { instrument, voices: [{ voice, busyUntil }] }

  const disposeGlidePool = useCallback((regionId) => {
    const pool = glideVoicesByRegionIdRef.current.get(regionId);
    if (!pool) return;
    for (const e of pool.voices) { if (!e.voice.disposed) e.voice.dispose(); }
    glideVoicesByRegionIdRef.current.delete(regionId);
  }, []);

  // Inline-synced (the mappingsRef pattern) so Part callbacks — which live for
  // the Part's lifetime — always acquire through live refs.
  const glideCtxRef = useRef({ acquire: () => null });
  glideCtxRef.current.acquire = (regionId, tStart, tEnd) => {
    const applied = appliedRegionStateRef.current.get(regionId);
    const instrument = applied?.instrument;
    const fadeGain = fadeGainsByRegionIdRef.current.get(regionId);
    if (!instrument || !fadeGain || fadeGain.disposed) return null;
    let pool = glideVoicesByRegionIdRef.current.get(regionId);
    if (pool && pool.instrument !== instrument) { disposeGlidePool(regionId); pool = null; }
    if (!pool) {
      pool = { instrument, voices: [] };
      glideVoicesByRegionIdRef.current.set(regionId, pool);
    }
    let entry = pool.voices.find(e => e.busyUntil <= tStart);
    if (!entry) {
      const cap = perfQualityRef.current === 'high' ? GLIDE_VOICE_CAP_HIGH : GLIDE_VOICE_CAP_REDUCED;
      if (pool.voices.length < cap) {
        const track = tracksRef.current.find(t => t.id === applied?.trackId);
        const voice = makeGlideVoice(instrument, { envelope: track?.envelope ?? undefined });
        voice.connect(fadeGain);
        entry = { voice, busyUntil: 0 };
        pool.voices.push(entry);
      } else {
        // Steal the oldest: cancel its scheduled curves and hard-release so
        // stale future events can't replay on the reused voice.
        entry = pool.voices.reduce((a, b) => (a.busyUntil <= b.busyUntil ? a : b));
        const now = Tone.now();
        const v = entry.voice;
        v.detune.cancelScheduledValues(now);
        v.volume.cancelScheduledValues(now);
        const orig = v.get?.()?.envelope?.release;
        if (orig != null) v.set({ envelope: { release: HARD_CUT_SEC } });
        v.triggerRelease(now);
        if (orig != null) v.set({ envelope: { release: orig } });
      }
    }
    const rel = Number(entry.voice.get?.()?.envelope?.release) || 0.3;
    entry.busyUntil = tEnd + rel;
    return entry.voice;
  };

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

  const auditionAttack = useCallback((trackId, note, velocity = 0.8) => {
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
    synth.triggerAttack(note, undefined, velocity);
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
  // `track` is any CHANNEL — a track or a group (disjoint id namespaces let
  // the node lookups union the two map families).
  const resolveAutomationTarget = useCallback((track, target) => {
    if (!track || !target) return null;
    if (target.kind === 'volume') {
      const g = volumesByTrackIdRef.current.get(track.id) ?? groupVolumesByIdRef.current.get(track.id);
      if (!g || g.disposed) return null;
      return {
        kind: 'ramp', exp: true,
        entries: [{ param: g.gain, map: (v) => v }],
        toParam: (v01) => volForSliderValue(v01 * 100),
      };
    }
    if (target.kind === 'pan') {
      const p = pannersByTrackIdRef.current.get(track.id);
      if (p && !p.disposed) {
        return {
          kind: 'ramp', exp: false,
          entries: [{ param: p.pan, map: (v) => v }],
          toParam: (v01) => v01 * 2 - 1,
        };
      }
      // Group pan lane = member OFFSET (the group PanKnob model): one entry
      // per member panner, ramped to clampPan(member base + offset). A member
      // with its own active pan lane keeps it (skipped here). The base is
      // baked into the map closure — effect 1e's chanKey includes grouped
      // members' pan, so a member knob turn re-schedules with the new base.
      if (!groupsRef.current.some(g => g.id === track.id)) return null;
      const entries = [];
      for (const t of tracksRef.current) {
        if (t.groupId !== track.id || isPanAutomated(t)) continue;
        const mp = pannersByTrackIdRef.current.get(t.id);
        if (!mp || mp.disposed) continue;
        const base = t.pan ?? 0;
        entries.push({ param: mp.pan, map: (v) => clampPan(base + v) });
      }
      if (!entries.length) return null;
      return { kind: 'ramp', exp: false, entries, toParam: (v01) => v01 * 2 - 1 };
    }
    if (target.kind === 'fx') {
      const e = (track.effects ?? []).find(x => x.id === target.effectId);
      const meta = metaForTarget(track, target);
      const w = (fxChainsByTrackIdRef.current.get(track.id) ?? fxChainsByGroupIdRef.current.get(track.id))
        ?.find(x => x.fxId === target.effectId);
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
  // automation consume tempoMapRef). cancelAndHoldAtTime (NOT
  // cancelScheduledValues) is load-bearing: Transport.ticks is DERIVED by
  // integrating the bpm curve, and a plain cancel mid-ramp deletes the
  // in-flight ramp's end event — rewriting the already-PLAYED curve shape, so
  // the tick integral (= musical position) jumps and Parts re-fire past notes;
  // the desynced per-event tick bookkeeping then drives TickParam.getTimeOfTick
  // into NaN/negative times → the "reading 'time' of undefined" crash inside
  // TickSource. cancelAndHold truncates the ramp AT audioNow instead,
  // preserving the played integral exactly. The op list comes from
  // tempoScheduleOps (shared with the offline bounce), whose STRICTLY
  // INCREASING event times are equally load-bearing: two differing-value bpm
  // events at one timestamp (a stacked-point step sharing a ramp's end time)
  // poison getTimeOfTick's ramp-endpoint lookup the same way — see
  // TEMPO_STEP_EPS in tempoMath.js. Anchor math: tempoMath.js trapezoid ==
  // TickSignal's own integration, so map seconds and transport ticks agree
  // exactly at every anchor (steps land eps late — inaudible, re-anchored).
  const recomputeTempo = useCallback(() => {
    const map = buildTempoMap(bpmRef.current, tempoPointsOf(globalAutosRef.current));
    tempoMapRef.current = map;
    const sig = Tone.Transport.bpm;
    const audioNow = Tone.now();
    const nowM = Tone.Transport.ticks / (Tone.Transport.PPQ * 4);
    sig.cancelAndHoldAtTime(audioNow);
    for (const op of tempoScheduleOps(map, nowM, audioNow)) {
      if (op.kind === 'set') sig.setValueAtTime(op.bpm, op.time);
      else sig.linearRampToValueAtTime(op.bpm, op.time);
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

    for (const t of [...tracksRef.current, ...groupsRef.current]) {
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
      const track = tracksRef.current.find(x => x.id === info.trackId)
        ?? groupsRef.current.find(x => x.id === info.trackId);
      const res = track ? resolveAutomationTarget(track, info.target) : null;
      if (!res) continue; // track/effect gone — nodes disposed, nothing to restore
      if (res.kind === 'ramp') {
        for (const { param } of res.entries) {
          param.cancelScheduledValues(audioNow);
          param.setValueAtTime(param.value, audioNow);
        }
      }
      if (info.target.kind === 'volume') {
        // effect #3 (tracks) / #3e (groups) re-owns this commit — deleting on
        // both maps is a harmless no-op for the other channel kind.
        appliedVolumeByTrackIdRef.current.delete(track.id);
        appliedGroupVolByIdRef.current.delete(track.id);
      } else if (info.target.kind === 'pan') {
        // Track lane → #3b re-owns that track this commit. Group lane
        // (member-offset) → #3b re-owns every member — the lane's schedules
        // lived on the MEMBER panners, so their applied entries must clear.
        appliedPanByTrackIdRef.current.delete(track.id);
        for (const t of tracksRef.current) {
          if (t.groupId === track.id) appliedPanByTrackIdRef.current.delete(t.id);
        }
      } else {
        // 1d already ran this commit — restore the manual value directly
        // (one-shot handback; 1d stays the steady-state writer).
        const e = (track.effects ?? []).find(x => x.id === info.target.effectId);
        const w = (fxChainsByTrackIdRef.current.get(track.id) ?? fxChainsByGroupIdRef.current.get(track.id))
          ?.find(x => x.fxId === info.target.effectId);
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
    const track = tracksRef.current.find(x => x.id === trackId)
      ?? groupsRef.current.find(x => x.id === trackId);
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

  // ── 0g. Group bus sync — owns the per-group node chains ────────────────
  // Declared BEFORE effect #1 (declaration order load-bearing, the #1/#1b
  // precedent): a loaded project's buses exist by the time the membership
  // sync (1a) wires member mutes into them, all in the same commit.
  useEffect(() => {
    const ins    = groupInByIdRef.current;
    const vols   = groupVolumesByIdRef.current;
    const pans   = groupPannersByIdRef.current;
    const mutesG = groupMutesByIdRef.current;
    const liveIds = new Set(groups.map(g => g.id));

    for (const id of [...mutesG.keys()]) {
      if (liveIds.has(id)) continue;
      // Group FX wrappers sit between pan and mute — dispose them with the bus.
      for (const w of fxChainsByGroupIdRef.current.get(id) ?? []) {
        appliedFxBypassByIdRef.current.delete(w.fxId);
        appliedFxParamsByIdRef.current.delete(w.fxId);
        w.dispose();
      }
      fxChainsByGroupIdRef.current.delete(id);
      appliedFxKeyByGroupIdRef.current.delete(id);
      const conn = groupMuteConnByIdRef.current.get(id);
      if (conn?.timer != null) clearTimeout(conn.timer);
      groupMuteConnByIdRef.current.delete(id);
      groupAudibleByIdRef.current.delete(id);
      ins.get(id)?.dispose();   // dispose also severs member mutes still wired in;
      vols.get(id)?.dispose();  // the membership sync (1a) re-parents them this commit
      pans.get(id)?.dispose();
      mutesG.get(id)?.dispose();
      ins.delete(id); vols.delete(id); pans.delete(id); mutesG.delete(id);
      appliedGroupVolByIdRef.current.delete(id);
    }
    for (const g of groups) {
      if (mutesG.has(g.id)) continue;
      const mute = new Tone.Gain(1).toDestination();
      const pan  = new Tone.Panner(0).connect(mute); // inert glue — group pan is a member offset
      const vol  = new Tone.Gain(volForSliderValue(g.volume ?? 75)).connect(pan);
      const gin  = new Tone.Gain(1).connect(vol);
      mutesG.set(g.id, mute);
      pans.set(g.id, pan);
      vols.set(g.id, vol);
      ins.set(g.id, gin);
      groupMuteConnByIdRef.current.set(g.id, { connected: true, timer: null });
      appliedGroupVolByIdRef.current.set(g.id, g.volume ?? 75);
    }
  }, [groups]);

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

  // ── 1a. Output routing sync — re-parents track mutes on membership change ─
  // A track's mute node feeds its group's bus input (or the Destination).
  // Delta-checked by node reference; only CONNECTED mutes are rewired here —
  // a disconnected (pruned/muted) track picks up the new target from
  // connectTrack's outputForTrack at reconnect time. Runs after #0g/#1 in the
  // same commit, so a loaded project is bused on the first pass.
  useEffect(() => {
    const outApp = appliedOutputByTrackIdRef.current;
    for (const t of tracks) {
      const g = mutesByTrackIdRef.current.get(t.id);
      if (!g || g.disposed) continue;
      const target = outputForTrack(t.id);
      if (outApp.get(t.id) === target) continue;
      const st = muteConnByTrackIdRef.current.get(t.id);
      if (st?.connected) {
        g.disconnect();
        g.connect(target);
      }
      outApp.set(t.id, target);
    }
    for (const id of [...outApp.keys()]) {
      if (!tracks.some(t => t.id === id)) outApp.delete(id);
    }
  }, [tracks, groups, outputForTrack]);

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
    const bypApp = appliedFxBypassByIdRef.current;
    const parApp = appliedFxParamsByIdRef.current;

    // One splice pass per channel family (tracks / groups) — identical logic,
    // family-specific node/chain/key maps. Effect ids are globally unique
    // (e<n> spans both), so the per-effect delta maps need no re-keying.
    const syncFamily = (channels, panners, mutes, chains, keyApp) => {
      const liveIds = new Set(channels.map(c => c.id));

      const disposeChain = (id) => {
        for (const w of chains.get(id) ?? []) {
          bypApp.delete(w.fxId);
          parApp.delete(w.fxId);
          w.dispose();
        }
        chains.delete(id);
      };

      // Teardown for removed channels (#1/#0g already disposed their nodes).
      for (const id of [...chains.keys()]) {
        if (liveIds.has(id)) continue;
        disposeChain(id);
        keyApp.delete(id);
      }

      for (const c of channels) {
        const pan  = panners.get(c.id);
        const mute = mutes.get(c.id);
        if (!pan || !mute) continue; // race during initial mount — will reconcile on next pass
        const fxList = c.effects ?? [];
        const key = fxList.map(e => `${e.id}:${e.type}`).join('|');
        // '' fallback: a fresh no-FX channel skips entirely — the pan→mute
        // wire from creation stands and is never touched.
        if ((keyApp.get(c.id) ?? '') === key) continue;

        // Rebuild: sever pan's output (disconnect() drops ALL its connections,
        // including the pan→mute made at creation — intended), then rewire
        // pan → w0 … wN → mute (or straight pan → mute when the rack is empty).
        // Wrappers are created with the EFFECTIVE bypass (user bypass OR low-
        // quality force-bypass) so a structural rebuild under low quality never
        // momentarily runs a heavy effect.
        pan.disconnect();
        disposeChain(c.id);
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
        chains.set(c.id, wrappers);
        keyApp.set(c.id, key);
        // Seed applied maps — makeFx already initialized bypass gains + params,
        // so 1c/1d must not re-ramp them this commit.
        for (const e of fxList) {
          bypApp.set(e.id, !!e.bypass || (forceOff && HEAVY_EFFECT_TYPES.has(e.type)));
          parApp.set(e.id, e.params);
        }
      }
    };

    syncFamily(tracks, pannersByTrackIdRef.current, mutesByTrackIdRef.current,
               fxChainsByTrackIdRef.current, appliedFxKeyByTrackIdRef.current);
    syncFamily(groups, groupPannersByIdRef.current, groupMutesByIdRef.current,
               fxChainsByGroupIdRef.current, appliedFxKeyByGroupIdRef.current);
  }, [tracks, groups]);

  // ── 1c. FX bypass sync — sole post-init writer of the crossfade gains ─
  // Applies the EFFECTIVE bypass: user bypass OR low-quality force-bypass of
  // heavy FX. track.effects is never mutated, so leaving low quality restores
  // the user's own bypass states in this same pass.
  useEffect(() => {
    const bypApp   = appliedFxBypassByIdRef.current;
    const forceOff = performanceQuality === 'low';
    const syncFamily = (channels, chains) => {
      for (const c of channels) {
        const wrappers = chains.get(c.id);
        if (!wrappers) continue;
        for (const e of c.effects ?? []) {
          const eff = !!e.bypass || (forceOff && HEAVY_EFFECT_TYPES.has(e.type));
          if (bypApp.get(e.id) === eff) continue;
          const w = wrappers.find(x => x.fxId === e.id);
          if (!w) continue;
          w.setBypass(eff);
          bypApp.set(e.id, eff);
        }
      }
    };
    syncFamily(tracks, fxChainsByTrackIdRef.current);
    syncFamily(groups, fxChainsByGroupIdRef.current);
  }, [tracks, groups, performanceQuality]);

  // ── 1d. FX param sync — sole post-construction writer of node params ──
  // Reference compare is a correct delta check: updateEffectSettings always
  // mints a new params object, and undo/redo restores different snapshot refs.
  useEffect(() => {
    const parApp = appliedFxParamsByIdRef.current;
    const syncFamily = (channels, chains) => {
      for (const c of channels) {
        const wrappers = chains.get(c.id);
        if (!wrappers) continue;
        // Automated params are owned by the automation scheduler — strip them
        // (plus dryThru while wet is automated: the composite's dry gain is
        // coupled to wet, so writing it would stomp the scheduled ramp).
        const autoKeys = automatedFxKeys(c);
        for (const e of c.effects ?? []) {
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
    };
    syncFamily(tracks, fxChainsByTrackIdRef.current);
    syncFamily(groups, fxChainsByGroupIdRef.current);
  }, [tracks, groups]);

  // ── 1e. Automation sync — re-anchor/re-schedule when automation data,
  // FX structure (1b just rebuilt wrappers this commit — schedules died with
  // the old nodes), delay dryThru, or BPM changes. Delta-keyed so unrelated
  // tracks-commits (slider drags, mute toggles, region edits) don't churn the
  // schedules mid-playback. Play/seek/stop/undo re-anchoring rides
  // recomputeFades (which calls recomputeAutomation at its end).
  useEffect(() => {
    // Grouped members carry `groupId:pan` in the key: a group PAN lane bakes
    // each member's base pan into its ramp entries, so a member knob turn or
    // membership change must re-schedule (groups have no groupId → no churn).
    const chanKey = (c) =>
      `${c.id}~${JSON.stringify(c.automations ?? [])}~${
        c.groupId ? `${c.groupId}:${c.pan ?? 0}` : ''}~${
        (c.effects ?? []).map(e => `${e.id}:${e.type}:${e.params?.dryThru ? 1 : 0}`).join('|')}`;
    const key = [...tracks, ...groups].map(chanKey).join('§') + `~${bpm}`;
    if (appliedAutomationKeyRef.current === key) return;
    appliedAutomationKeyRef.current = key;
    recomputeAutomation();
  }, [tracks, groups, bpm, recomputeAutomation]);

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
    const groupById = new Map(groups.map(g => [g.id, g]));
    // Group-aware audibility: a solo ANYWHERE (track or group) gates
    // everything; a track is heard iff neither it nor its group is muted AND
    // (nothing is soloed OR it/its group is soloed). audibleByTrackIdRef
    // stores this EFFECTIVE value, so makePartCallback's fire-time skip and
    // connectTrack's gate need no group knowledge.
    const anySoloed = tracks.some(t => t.isSolo) || groups.some(g => g.isSolo);
    for (const t of tracks) {
      const g = mutes.get(t.id);
      if (!g) continue;
      const grp = t.groupId ? groupById.get(t.groupId) : null;
      const audible = !t.isMuted && !grp?.isMuted
        && (!anySoloed || t.isSolo || !!grp?.isSolo);
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
    // Group buses: audible iff the group isn't muted AND (no solo anywhere OR
    // the group is soloed OR one of its members is — a soloed member must be
    // heard THROUGH its bus). Same ramp + delayed-disconnect pruning.
    for (const grp of groups) {
      const g = groupMutesByIdRef.current.get(grp.id);
      if (!g) continue;
      const memberSolo = tracks.some(t => t.groupId === grp.id && t.isSolo);
      const audible = !grp.isMuted && (!anySoloed || grp.isSolo || memberSolo);
      groupAudibleByIdRef.current.set(grp.id, audible);
      const st = groupMuteConnByIdRef.current.get(grp.id) ?? { connected: true, timer: null };
      groupMuteConnByIdRef.current.set(grp.id, st);
      if (st.timer != null) { clearTimeout(st.timer); st.timer = null; }
      if (audible) {
        connectGroup(grp.id);
        g.gain.rampTo(1, 0.02);
      } else {
        g.gain.rampTo(0, 0.02);
        if (st.connected) {
          st.timer = setTimeout(() => {
            st.timer = null;
            disconnectGroup(grp.id);
          }, 50);
        }
      }
    }
  }, [tracks, groups, connectTrack, disconnectTrack, connectGroup, disconnectGroup]);

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
      // Group buses: prune once NO member is connected and the bus's own FX
      // ring-out past the members' activity windows has elapsed. Inaudible
      // groups are effect #2's territory (same contract as tracks).
      for (const [gid, st] of groupMuteConnByIdRef.current) {
        if (!st.connected) continue;
        if (groupAudibleByIdRef.current.get(gid) === false) continue;
        const members = tracksRef.current.filter(t => t.groupId === gid);
        if (members.some(m => muteConnByTrackIdRef.current.get(m.id)?.connected)) continue;
        const grp = groupsRef.current.find(g => g.id === gid);
        const windowEnd = members.reduce(
          (m, t) => Math.max(m, activeUntilByTrackIdRef.current.get(t.id) ?? 0), 0
        ) + (grp ? estimateGroupTailSec(grp) : 2);
        if (now <= windowEnd) continue;
        disconnectGroup(gid);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [disconnectTrack, disconnectGroup]);

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
  // Single manual writer of member panners, group-aware: effective pan =
  // clampPan(track.pan + group.pan) — the group knob is a member OFFSET;
  // track.pan is never mutated, so un-panning the group restores each
  // member's own value exactly. Ownership: a track with its own pan lane is
  // the scheduler's (unchanged); a member of a group with an active PAN lane
  // is ALSO the scheduler's (the group lane ramps member panners directly).
  // panApp stores the applied EFFECTIVE value.
  useEffect(() => {
    const panners = pannersByTrackIdRef.current;
    const panApp  = appliedPanByTrackIdRef.current;
    const groupById = new Map(groups.map(g => [g.id, g]));
    for (const t of tracks) {
      const p = panners.get(t.id);
      if (!p) continue;
      const grp = t.groupId ? groupById.get(t.groupId) : null;
      if (isPanAutomated(t) || (grp && isPanAutomated(grp))) { panApp.delete(t.id); continue; }
      const v = clampPan((t.pan ?? 0) + (grp?.pan ?? 0));
      if (panApp.get(t.id) === v) continue;
      p.pan.rampTo(v, 0.02);
      panApp.set(t.id, v);
    }
  }, [tracks, groups]);

  // ── 3e. Group volume sync — mirrors #3 on the bus volume node ──────────
  // Same "automation takes over" contract: an automated group volume is owned
  // by recomputeAutomation; deleting the cache entry means the header control
  // re-applies the moment the lane empties. Group PAN has no bus writer —
  // knob and lane are member offsets applied via #3b / the automation
  // scheduler (the bus Panner is inert glue at 0).
  useEffect(() => {
    for (const g of groups) {
      const vol = groupVolumesByIdRef.current.get(g.id);
      if (!vol) continue;
      if (isVolumeAutomated(g)) {
        appliedGroupVolByIdRef.current.delete(g.id);
      } else {
        const v = g.volume ?? 75;
        if (appliedGroupVolByIdRef.current.get(g.id) !== v) {
          vol.gain.rampTo(volForSliderValue(v), 0.02);
          appliedGroupVolByIdRef.current.set(g.id, v);
        }
      }
    }
  }, [groups]);

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
      for (const rid of regsByTrack.get(t.id) ?? []) {
        applyEnvelope(synths.get(rid), env);
        const pool = glideVoicesByRegionIdRef.current.get(rid);
        if (pool) for (const e of pool.voices) applyEnvelope(e.voice, env);
      }
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
      disposeGlidePool(id); // glide voices hang off the fadeGain — free them first
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
          disposeGlidePool(r.id); // pool voices are instrument-specific
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

      // (Re)build Part. A region with a live Moog recording (hasAudio) plays via
      // its Tone.Player in WorkstationShell — its transcription notes are silenced
      // here so the two don't layer (the transcription is for piano-roll editing).
      if (partChanged || instrumentChanged) {
        const existing = parts.get(r.id);
        if (existing) { existing.dispose(); parts.delete(r.id); }
        const events = r.hasAudio ? [] : buildRegionEvents(r, notes);
        if (events.length > 0) {
          const synth = synths.get(r.id);
          const part = new Tone.Part(
            makePartCallback(synth, liveSamplerSourcesRef.current, isDrumKit(track.instrument),
                             r.id, appliedRegionStateRef, audibleByTrackIdRef, noteLifecycleRef,
                             tempoMapRef, glideCtxRef),
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
  }, [tracks, regions, notes, bpm, recomputeLoadingTrackIds, disposeGlidePool]);

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
    // Glide pool voices: cancel their scheduled detune/volume curves (stale
    // future events would replay after a seek-resume — Parts re-fire and
    // schedule fresh ones) and hard-release the voice.
    for (const pool of glideVoicesByRegionIdRef.current.values()) {
      for (const e of pool.voices) {
        const v = e.voice;
        if (v.disposed) continue;
        v.detune.cancelScheduledValues(audioNow);
        v.volume.cancelScheduledValues(audioNow);
        const orig = v.get?.()?.envelope?.release;
        if (orig != null) v.set({ envelope: { release: HARD_CUT_SEC } });
        v.triggerRelease(audioNow);
        if (orig != null) v.set({ envelope: { release: orig } });
        e.busyUntil = 0;
      }
    }
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
    const glidePools = glideVoicesByRegionIdRef.current;
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
    const groupIns   = groupInByIdRef.current;
    const groupVols  = groupVolumesByIdRef.current;
    const groupPans  = groupPannersByIdRef.current;
    const groupMutes = groupMutesByIdRef.current;
    const groupConns = groupMuteConnByIdRef.current;
    const groupAudible = groupAudibleByIdRef.current;
    const groupVolApp  = appliedGroupVolByIdRef.current;
    const groupChains  = fxChainsByGroupIdRef.current;
    const groupKeyApp  = appliedFxKeyByGroupIdRef.current;
    const outApp       = appliedOutputByTrackIdRef.current;
    return () => {
      // Transport.cancel(0) below wipes the automation schedules — reset the
      // delta keys so a remount (StrictMode's simulated one included) re-runs
      // recomputeAutomation/recomputeTempo instead of skipping on stale matches.
      appliedAutoKey.current = '';
      appliedTempoKey.current = '';
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
      // Transport.cancel does NOT clear bpm-SIGNAL automation, and the
      // Transport is a singleton shared with VoxTool (transport-clocked arp)
      // — leftover tempo ramps would warp it. Restore the flat base bpm.
      // Runs AFTER stop() so the timeline wipe never happens under a running
      // clock (a mid-ramp cancel would corrupt the tick integral — see
      // recomputeTempo); with the transport stopped, cancel(0) + flat reset
      // is safe.
      Tone.Transport.bpm.cancelScheduledValues(0);
      Tone.Transport.bpm.value = bpmR.current;
      Tone.Transport.cancel(0);
      for (const id of fadeIds.values()) Tone.Transport.clear(id);
      for (const p of parts.values())   p.dispose();
      for (const e of auditions.values()) e.synth.dispose();
      auditions.clear();
      for (const s of synths.values())  s.dispose();
      for (const pool of glidePools.values()) for (const e of pool.voices) e.voice.dispose();
      glidePools.clear();
      for (const g of fades.values())   g.dispose();
      for (const g of volumes.values()) g.dispose();
      for (const p of panners.values()) p.dispose();
      for (const ws of fxChains.values()) for (const w of ws) w.dispose();
      for (const g of mutes.values())   g.dispose();
      // Group buses
      for (const st of groupConns.values()) if (st.timer != null) clearTimeout(st.timer);
      for (const ws of groupChains.values()) for (const w of ws) w.dispose();
      for (const n of groupIns.values())   n.dispose();
      for (const n of groupVols.values())  n.dispose();
      for (const n of groupPans.values())  n.dispose();
      for (const n of groupMutes.values()) n.dispose();
      groupIns.clear(); groupVols.clear(); groupPans.clear(); groupMutes.clear();
      groupConns.clear(); groupAudible.clear();
      groupVolApp.clear();
      groupChains.clear(); groupKeyApp.clear();
      outApp.clear();
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

// ── Glide chain schedulers (shared live + offline bounce) ──────────────────
// Both consume a planGlideSegments() plan whose times are OFFSETS from chain
// start; `t` is the absolute chain start in the caller's context. Tone's
// setValueCurveAtTime is a setValueAtTime + linear-ramp series, so the
// strictly-sequential scheduling below is safe in live and Offline contexts.

export function scheduleGlideSynthVoice(voice, ev, t, plan) {
  if (!voice || voice.disposed) return;
  const headVel = ev.velocity ?? 100;
  // Re-anchor this voice's params at t — kills any stale events left by a
  // previous chain on the reused pool voice. Single writer: only this
  // scheduler ever touches a glide voice's detune/volume.
  voice.detune.cancelScheduledValues(t);
  voice.volume.cancelScheduledValues(t);
  voice.volume.setValueAtTime(0, t); // 0 dB ref — crossfades are relative to the attack velocity
  voice.triggerAttack(ev.note, t, headVel / 120);
  for (const op of plan.ops) {
    voice.detune.setValueAtTime(op.baseCents, t + op.holdStartSec);
    if (op.curve) voice.detune.setValueCurveAtTime(op.curve, t + op.glideStartSec, op.glideDurSec);
    if (op.fromVel !== op.toVel) {
      // Velocity crossfade in dB relative to the attack velocity, over the
      // glide window (flat tie segments crossfade across the whole segment).
      const start = op.curve ? op.glideStartSec : op.holdStartSec;
      const dur   = op.curve ? op.glideDurSec   : (op.segEndSec - op.holdStartSec);
      if (dur > 1e-4) {
        voice.volume.setValueAtTime(Tone.gainToDb(op.fromVel / headVel), t + start);
        voice.volume.linearRampToValueAtTime(Tone.gainToDb(op.toVel / headVel), t + start + dur);
      }
    }
  }
  voice.triggerRelease(t + plan.totalDurSec);
}

export function scheduleGlideSamplerChain(synth, liveSources, ev, t, plan) {
  const headVel = ev.velocity ?? 100;
  // Attack + capture, mirroring the plain sampler path (private
  // _activeSources — same caveat and graceful fallback).
  synth.triggerAttack(ev.note, t, headVel / 120);
  let captured = null;
  synth._activeSources?.forEach((srcs) => srcs.forEach((src) => {
    if (liveSources.has(src)) return;
    liveSources.add(src);
    const prev = src.onended;
    src.onended = () => { prev?.(); liveSources.delete(src); };
    captured = src;
  }));
  // Release at CHAIN end (true legato — consumed members never re-attack).
  // Ordering is load-bearing: stop() runs cancelStop(), which wipes gain
  // events after start — schedule it BEFORE the crossfade ramps below.
  synth.triggerRelease(ev.note, t + plan.totalDurSec);
  if (!captured) return; // _activeSources gone (future Tone bump) → plain long note, no glide
  // Pitch rides playbackRate: rate = r0 · 2^(cents/1200) where r0 is the
  // Sampler's own repitch rate for this key. Accepted limitation: the source
  // self-stops at buffer end, so a chain longer than the sample truncates.
  const r0 = captured.playbackRate.value;
  const gainParam = captured._gainNode?.gain ?? captured.output?.gain ?? null;
  const atk = Number(synth.attack) || 0;
  for (const op of plan.ops) {
    captured.playbackRate.setValueAtTime(r0 * 2 ** (op.baseCents / 1200), t + op.holdStartSec);
    if (op.curve) {
      const rates = new Float32Array(op.curve.length);
      for (let i = 0; i < op.curve.length; i++) rates[i] = r0 * 2 ** (op.curve[i] / 1200);
      captured.playbackRate.setValueCurveAtTime(rates, t + op.glideStartSec, op.glideDurSec);
    }
    if (gainParam && op.fromVel !== op.toVel) {
      // Absolute gains — velocity IS this param's start value (source.start's
      // gain arg). Window clamped inside (attack end, stop − ε) so it never
      // collides with OneShotSource's own fadeIn/fadeOut events.
      const start = Math.max(op.curve ? op.glideStartSec : op.holdStartSec, atk + 0.01);
      const end = Math.min(op.curve ? op.glideStartSec + op.glideDurSec : op.segEndSec,
                           plan.totalDurSec - 0.01);
      if (end - start > 1e-3) {
        gainParam.setValueAtTime(op.fromVel / 120, t + start);
        gainParam.linearRampToValueAtTime(op.toVel / 120, t + end);
      }
    }
  }
}

function makePartCallback(synth, liveSources, isDrum = false,
                          regionId = null, regionStateRef = null, audibleTracksRef = null,
                          noteLifecycleRef = null, mapRef = null, glideCtxRef = null) {
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
    // Per-note velocity: 1–120 int on the event → Tone's 0–1 NormalRange.
    const vel = (ev.velocity ?? 100) / 120;
    // Glide chain event — dedicated scheduling path (portamento curves + true
    // legato). Plain events carry no `glide` key, so the hot path pays exactly
    // one undefined comparison. Drums never glide (one-shots; the UI blocks
    // the tool, this is the defensive gate).
    if (ev.glide !== undefined && !isDrum && mapRef?.current) {
      const t = synth.toSeconds(time);
      const plan = planGlideSegments({
        headPitch: ev.note, segments: ev.glide.segments,
        startTicks: parseInt(ev.time, 10), map: mapRef.current,
        PPQ: Tone.Transport.PPQ,
      });
      if (synth._activeSources) {
        scheduleGlideSamplerChain(synth, liveSources, ev, t, plan);
      } else {
        const voice = glideCtxRef?.current?.acquire?.(regionId, t, t + plan.totalDurSec);
        if (voice) scheduleGlideSynthVoice(voice, ev, t, plan);
        // No voice (fadeGain gone mid-teardown / no pool context): degrade to
        // a plain note on the region synth rather than dropping the event.
        else synth.triggerAttackRelease(ev.note, durSec, time, vel);
      }
      return;
    }
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
      synth.triggerAttack(ev.note, t, vel);
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
      synth.triggerAttackRelease(ev.note, durSec, time, vel);
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

// FX-only ring-out for any channel (track OR group) — non-bypassed delay
// feedback decay to −60 dB + Freeverb heuristic, automation-aware.
function fxTailSec(c) {
  let tail = 0;
  for (const e of c.effects ?? []) {
    if (e.bypass) continue;
    const p = e.params ?? {};
    if (e.type === 'delay' && maxAutomatedParam(c, e.id, 'delay', 'wet', p.wet ?? 0) > 0) {
      // Repeats to decay to −60 dB through the feedback loop.
      const fb = maxAutomatedParam(c, e.id, 'delay', 'feedback', p.feedback ?? 0);
      const time = maxAutomatedParam(c, e.id, 'delay', 'time', p.time ?? 0.25);
      const repeats = fb > 0 ? Math.ceil(Math.log(1e-3) / Math.log(fb)) : 1;
      tail = Math.max(tail, time * repeats);
    } else if (e.type === 'reverb' && maxAutomatedParam(c, e.id, 'reverb', 'wet', p.wet ?? 0) > 0) {
      // Freeverb has no analytic decay; generous comb-decay heuristic.
      tail = Math.max(tail, 1 + maxAutomatedParam(c, e.id, 'reverb', 'roomSize', p.roomSize ?? 0.7) * 9);
    }
  }
  return tail;
}

export function estimateTrackTailSec(t) {
  // Synth release rings past the note end (drums: one-shots ignore duration
  // entirely, so a cymbal on the last note needs the 6 s floor).
  let tail = t.envelope?.release ?? defaultEnvelopeFor(t.instrument)?.release ?? 1;
  if (isDrumKit(t.instrument)) tail = Math.max(tail, 6);
  tail = Math.max(tail, fxTailSec(t));
  return Math.min(30, Math.max(2, tail));
}

// Group buses have no synth of their own — the member windows already carry
// their synth+FX tails; this bounds only the bus's OWN FX ring-out.
export function estimateGroupTailSec(g) {
  return Math.min(30, Math.max(2, fxTailSec(g)));
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

  const push = (events, globalStartB, dur, note, velocity) => {
    if (globalStartB >= regionEndB) return false;
    const clippedEnd = Math.min(globalStartB + dur, regionEndB);
    const durBeats   = clippedEnd - globalStartB;
    if (durBeats <= 0) return true;
    events.push({
      time:     `${Math.round(globalStartB * PPQ)}i`,
      note,
      duration: `${Math.round(durBeats     * PPQ)}i`,
      velocity: velocity ?? 100, // 1–120 int; consumed as velocity/120 at trigger
    });
    return true;
  };

  // Chain unit (glide) analogue of push(): same region-end clip, but emits a
  // `glide.segments` payload. A unit whose glide portion was clipped away
  // entirely degrades to a plain event (segmentsAreInert) — cheaper, identical.
  const pushUnit = (events, globalStartB, u) => {
    if (globalStartB >= regionEndB) return false;
    const clippedEnd = Math.min(globalStartB + u.totalBeats, regionEndB);
    const durBeats   = clippedEnd - globalStartB;
    if (durBeats <= 0) return true;
    const clippedTicks = Math.round(durBeats * PPQ);
    const segs = clipSegments(u.segments, clippedTicks);
    const ev = {
      time:     `${Math.round(globalStartB * PPQ)}i`,
      note:     u.note,
      duration: `${clippedTicks}i`,
      velocity: u.velocity,
    };
    if (!segmentsAreInert(segs)) ev.glide = { segments: segs };
    events.push(ev);
    return true;
  };

  // Home-window notes for this region. hasGlide gates the compiler — a
  // glide-free region takes ONE truthiness check per note and the original
  // per-note path below (hard performance contract: unused feature = no cost).
  const windowNotes = [];
  let hasGlide = false;
  for (const n of allNotes) {
    if (n.regionId !== r.id) continue;
    if (n.startBeat <  windowLoB) continue;
    if (n.startBeat >= windowHiB) continue;
    windowNotes.push(n);
    if (n.glide) hasGlide = true;
  }

  const events = [];
  // Chains compile ONCE in bottle-local beats, then unroll as whole units —
  // members are connected in bottle space, so every loop iteration replays the
  // identical chain. Chains never cross the loop-window edge by construction
  // (a target outside the window fails resolution → unconnected glide).
  const units = hasGlide ? compileGlideChains(windowNotes, PPQ) : null;

  const emit = (globalStartB, item) => (item.segments
    ? pushUnit(events, globalStartB, item)
    : push(events, globalStartB, item.totalBeats ?? item.durationBeats,
           item.note, item.velocity));

  for (const item of (units ?? windowNotes)) {
    if (!looped) {
      // Single window pass — bottle origin at (startMeasure − clipOffset).
      emit((r.startMeasure - co) * 4 + item.startBeat, item);
      continue;
    }
    // Looped: replay at firstLoopOffset + j*li, wrapping the home cycle by the
    // region's loopPhase (see loopMath). phase 0 ⇒ identical to the old
    // `i*baseLoop` unroll.
    const homeLocalMeasures = item.startBeat / 4 - co;         // [0, li)
    const firstOffM = firstLoopOffsetMeasures(homeLocalMeasures, phase, li);
    for (let j = 0; ; j++) {
      const globalStartB = (regionStartB / 4 + firstOffM + j * li) * 4;
      if (!emit(globalStartB, item)) break;
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
  // Anything that buildRegionEvents reads. `hasAudio` is included so a region
  // that gains/loses a live Moog recording rebuilds its Part — its transcription
  // notes are silenced while the recorded audio plays (they're edit-only).
  let key = `${r.id}|${r.startMeasure}|${r.durationMeasures}|${r.clipOffset ?? 0}|${r.loopInterval ?? 'n'}|${r.loopPhase ?? 0}|${r.isMuted ? 'm' : ''}|${r.hasAudio ? 'A' : ''}`;
  for (const n of notes) {
    if (n.regionId !== r.id) continue;
    key += `|${n.id}:${n.note}:${n.startBeat.toFixed(4)}:${n.durationBeats.toFixed(4)}:${n.velocity ?? 100}`;
    // Glide component only when present — glide-free keys stay byte-identical
    // (hot-path contract: an unused feature costs nothing, incl. rebuild churn).
    if (n.glide) {
      const g = n.glide;
      key += `:g${g.startOffset},${g.endPitch},${g.tension},${g.connected ? 1 : 0}`;
    }
  }
  return key;
}
// No bpm component: envelope durations resolve at fire time via tempoMapRef,
// so a BPM/tempo change needs no reschedule (startTicks is bpm-independent).
function computeFadeKey(r) {
  return `${r.startMeasure}|${r.durationMeasures}|${r.fadeIn ?? 0}|${r.fadeOut ?? 0}|${r.fadeInFloor ?? 0}|${r.fadeOutFloor ?? 0}`;
}
