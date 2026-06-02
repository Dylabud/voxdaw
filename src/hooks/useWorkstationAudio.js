import { useEffect, useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';
import { makeSynth, isSampledInstrument } from '../components/Workstation/synthFactory';
import { firstLoopOffsetMeasures } from '../components/Workstation/loopMath';

/**
 * Workstation playback engine — peer to useAudioEngine / useVocoder / useAutotune.
 *
 * Per-region signal flow:
 *   regionSynth → regionFadeGain → trackVolumeGain → trackMuteGain → Destination
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
export default function useWorkstationAudio({ tracks, regions, notes, bpm }) {
  // Per-track
  const mutesByTrackIdRef         = useRef(new Map()); // trackId → Gain
  const volumesByTrackIdRef       = useRef(new Map()); // trackId → Gain
  const pannersByTrackIdRef       = useRef(new Map()); // trackId → Panner
  const appliedVolumeByTrackIdRef = useRef(new Map()); // trackId → last v 0..100
  const appliedPanByTrackIdRef    = useRef(new Map()); // trackId → last pan -1..+1

  // Refs into latest props for recomputeFades (called by shell from event handlers)
  const regionsRef = useRef(regions); regionsRef.current = regions;
  const bpmRef     = useRef(bpm);     bpmRef.current     = bpm;

  // Per-region
  const synthsByRegionIdRef    = useRef(new Map()); // regionId → PolySynth | Sampler
  const fadeGainsByRegionIdRef = useRef(new Map()); // regionId → Gain
  const partsByRegionIdRef     = useRef(new Map()); // regionId → Part
  const fadeEventIdByRegionRef = useRef(new Map()); // regionId → Transport schedule id
  const appliedRegionStateRef  = useRef(new Map()); // regionId → { instrument, partKey, fadeKey, loaded }

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

  // ── 1. Track sync — owns volume + pan + mute nodes ─────────────────────
  // Signal:  regionFadeGain → volume → pan → mute → Destination
  useEffect(() => {
    const mutes   = mutesByTrackIdRef.current;
    const volumes = volumesByTrackIdRef.current;
    const panners = pannersByTrackIdRef.current;
    const volApp  = appliedVolumeByTrackIdRef.current;
    const panApp  = appliedPanByTrackIdRef.current;
    const liveIds = new Set(tracks.map(t => t.id));

    for (const id of [...mutes.keys()]) {
      if (!liveIds.has(id)) {
        volumes.get(id)?.dispose();
        panners.get(id)?.dispose();
        mutes.get(id)?.dispose();
        volumes.delete(id);
        panners.delete(id);
        mutes.delete(id);
        volApp.delete(id);
        panApp.delete(id);
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
      volApp.set(t.id, t.volume ?? 75);
      panApp.set(t.id, t.pan ?? 0);
    }
  }, [tracks]);

  // ── 2. Mute/solo sync ──────────────────────────────────────────────────
  useEffect(() => {
    const mutes     = mutesByTrackIdRef.current;
    const anySoloed = tracks.some(t => t.isSolo);
    for (const t of tracks) {
      const g = mutes.get(t.id);
      if (!g) continue;
      const audible = !t.isMuted && (!anySoloed || t.isSolo);
      g.gain.rampTo(audible ? 1 : 0, 0.02);
    }
  }, [tracks]);

  // ── 3. Volume sync ─────────────────────────────────────────────────────
  useEffect(() => {
    const volumes = volumesByTrackIdRef.current;
    const volApp  = appliedVolumeByTrackIdRef.current;
    for (const t of tracks) {
      const g = volumes.get(t.id);
      if (!g) continue;
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
      const v = Math.max(-1, Math.min(1, t.pan ?? 0));
      if (panApp.get(t.id) === v) continue;
      p.pan.rampTo(v, 0.02);
      panApp.set(t.id, v);
    }
  }, [tracks]);

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
    const buildSynthForRegion = (regionId, trackId, instrument, destination) => {
      const sampled = isSampledInstrument(instrument);
      if (sampled) {
        loadingRegionsRef.current.set(regionId, trackId);
        recomputeLoadingTrackIds();
      }
      const synth = makeSynth(instrument, sampled ? {
        onLoad: () => {
          // Mark this region loaded only if it still maps to this instrument.
          const st = applied.get(regionId);
          if (st) applied.set(regionId, { ...st, loaded: true });
          if (loadingRegionsRef.current.delete(regionId)) recomputeLoadingTrackIds();
        },
      } : undefined);
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
      const fadeKey = computeFadeKey(r, bpm);
      const instrumentChanged = !prev || prev.instrument !== track.instrument;
      const partChanged       = !prev || prev.partKey  !== partKey;
      const fadeChanged       = !prev || prev.fadeKey  !== fadeKey;

      // (Re)build synth + fadeGain on first appearance OR when track moved / instrument changed.
      if (!synths.has(r.id)) {
        const fadeGain = new Tone.Gain(1).connect(trackVolume);
        const synth    = buildSynthForRegion(r.id, r.trackId, track.instrument, fadeGain);
        synths.set(r.id, synth);
        fades.set(r.id, fadeGain);
      } else if (instrumentChanged) {
        // Clear any pending sampler load for the prior instrument.
        if (loadingRegionsRef.current.delete(r.id)) recomputeLoadingTrackIds();
        synths.get(r.id)?.dispose();
        const synth = buildSynthForRegion(r.id, r.trackId, track.instrument, fades.get(r.id));
        synths.set(r.id, synth);
      }

      // (Re)build Part
      if (partChanged || instrumentChanged) {
        const existing = parts.get(r.id);
        if (existing) { existing.dispose(); parts.delete(r.id); }
        const events = buildRegionEvents(r, notes);
        if (events.length > 0) {
          const synth = synths.get(r.id);
          const part = new Tone.Part(makePartCallback(synth), events);
          part.start(0);
          parts.set(r.id, part);
        }
      }

      // (Re)schedule fade envelope
      if (fadeChanged || instrumentChanged) {
        const prevEvt = fadeIds.get(r.id);
        if (prevEvt != null) Tone.Transport.clear(prevEvt);
        const fadeGain = fades.get(r.id);
        const evtId = scheduleFadeEnvelope(fadeGain, r, bpm);
        if (evtId != null) fadeIds.set(r.id, evtId);
        else               fadeIds.delete(r.id);
      }

      const prevLoaded = applied.get(r.id)?.loaded;
      const loaded = isSampledInstrument(track.instrument)
        ? (instrumentChanged ? !!synths.get(r.id)?.loaded : (prevLoaded ?? !!synths.get(r.id)?.loaded))
        : true;
      applied.set(r.id, { instrument: track.instrument, partKey, fadeKey, loaded });
    }
  }, [tracks, regions, notes, bpm, recomputeLoadingTrackIds]);

  // Silence in-flight voices on pause/stop (Tone.Transport.pause keeps tails alive).
  // releaseAll() still triggers each synth/sampler release tail, so we also ramp
  // every region's fade gain to 0 in ~20ms for a true hard cut. recomputeFades()
  // (called on resume before Transport.start) cancels this and restores the gain —
  // pause writes 0, play recomputes, never concurrent (single-writer preserved).
  const HARD_CUT_SEC = 0.02;
  const silenceAll = useCallback(() => {
    const audioNow = Tone.now();
    for (const s of synthsByRegionIdRef.current.values()) s?.releaseAll?.();
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
    const fades   = fadeGainsByRegionIdRef.current;
    const nowSec  = Tone.Transport.seconds;
    const bpm     = bpmRef.current;
    const audioNow = Tone.now();
    for (const r of regionsRef.current) {
      const fadeGain = fades.get(r.id);
      if (!fadeGain) continue;
      const startSec  = r.startMeasure * 4 * (60 / bpm);
      const endSec    = (r.startMeasure + r.durationMeasures) * 4 * (60 / bpm);
      const fInSec    = (r.fadeIn  ?? 0) * 4 * (60 / bpm);
      const fOutSec   = (r.fadeOut ?? 0) * 4 * (60 / bpm);
      const fInFloor  = Math.max(0, Math.min(1, r.fadeInFloor  ?? 0));
      const fOutFloor = Math.max(0, Math.min(1, r.fadeOutFloor ?? 0));

      const g = fadeGain.gain;
      g.cancelScheduledValues(audioNow);

      const currentValue = computeFadeGainAt(r, nowSec, bpm);
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
  }, []);

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
    return () => {
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      for (const id of fadeIds.values()) Tone.Transport.clear(id);
      for (const p of parts.values())   p.dispose();
      for (const s of synths.values())  s.dispose();
      for (const g of fades.values())   g.dispose();
      for (const g of volumes.values()) g.dispose();
      for (const p of panners.values()) p.dispose();
      for (const g of mutes.values())   g.dispose();
      mutes.clear();
      volumes.clear();
      panners.clear();
      synths.clear();
      fades.clear();
      parts.clear();
      fadeIds.clear();
      applied.clear();
      volApp.clear();
      panApp.clear();
    };
  }, []);

  return { silenceAll, recomputeFades, loadingTrackIds };
}

// Pure: envelope's expected linear gain at a given transport time (seconds).
export function computeFadeGainAt(r, transportSec, bpm) {
  const startSec  = r.startMeasure * 4 * (60 / bpm);
  const endSec    = (r.startMeasure + r.durationMeasures) * 4 * (60 / bpm);
  const fInSec    = (r.fadeIn  ?? 0) * 4 * (60 / bpm);
  const fOutSec   = (r.fadeOut ?? 0) * 4 * (60 / bpm);
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

function makePartCallback(synth) {
  return (time, ev) => {
    // A Tone.Sampler throws "buffer is either not set or not loaded" if triggered before
    // its buffers finish loading (instrument hot-swap or paste while the Transport runs).
    // `loaded === false` ONLY skips an unready Sampler — PolySynths have no `loaded`
    // (undefined !== false) so they always play. Re-checked at fire time, so once the
    // sampler loads, later events on the same Part play normally (no Part rebuild needed).
    if (!synth || synth.disposed || synth.loaded === false) return;
    synth.triggerAttackRelease(ev.note, ev.duration, time, 0.8);
  };
}

// ── Public helpers ────────────────────────────────────────────────────────

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
// Caveat: the envelope is computed in absolute audio-time at fire time using
// the bpm captured at scheduling. A BPM change mid-region desynchronizes the
// envelope until next playback cycle. Acceptable MVP limitation.
export function scheduleFadeEnvelope(fadeGain, r, bpm) {
  const PPQ = Tone.Transport.PPQ;
  const startTicks = Math.round(r.startMeasure * 4 * PPQ);
  const durSec = (m) => m * 4 * (60 / bpm);
  const totalSec = durSec(r.durationMeasures);
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

  // Merged-joint guard: clamp so fadeIn + fadeOut <= duration; if equal, fades meet at midpoint.
  let fInSec  = durSec(fadeIn);
  let fOutSec = durSec(fadeOut);
  if (fInSec + fOutSec > totalSec) {
    const scale = totalSec / (fInSec + fOutSec);
    fInSec  *= scale;
    fOutSec *= scale;
  }

  const id = Tone.Transport.schedule((time) => {
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
function computeFadeKey(r, bpm) {
  return `${r.startMeasure}|${r.durationMeasures}|${r.fadeIn ?? 0}|${r.fadeOut ?? 0}|${r.fadeInFloor ?? 0}|${r.fadeOutFloor ?? 0}|${bpm}`;
}
