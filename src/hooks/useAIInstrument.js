// AI Instrument Generator audio engine — a peer hook per the CLAUDE.md hook-
// modularity rule (nothing here touches useAudioEngine / useWorkstationAudio).
//
// Graph:  PolySynth → Tone.Filter → [fxGraph₁ … fxGraphₙ] → Tone.Volume → Destination
//
// Filter and Volume are persistent (created once, disposed on unmount); the
// synth and FX graphs are per-patch (rebuilt by applyPatch — regenerating cuts
// any ringing tail, same accepted limitation as the workstation's structural
// FX rebuilds). FX graphs come from fxChain.makeFxGraph — the bare
// {in, out, apply, dispose} surface, not makeFx: there's no bypass UI here so
// the crossfade wrapper is dead weight. LFO effects are .start()ed inside the
// factory.
//
// Single Writer per node: setVolume owns volume.volume, setFilter owns the
// filter params, setEffectParam(i, …) owns graph i's params, setEnvelope /
// setVoiceParam own the synth. Nothing else writes these.

import { useCallback, useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { makeFxGraph } from '../components/Workstation/fxChain';
import { applyEnvelope } from '../components/Workstation/synthFactory';
import { makePatchSynth } from '../components/AIGen/patchSynth';

// Transparent settings for a patch with filter: null — the node always exists
// (the chassis always shows filter knobs) but passes signal unchanged.
const FILTER_NEUTRAL = { type: 'lowpass', frequency: 18000, q: 0.7071 };

export default function useAIInstrument() {
  const filterRef   = useRef(null); // persistent
  const volumeRef   = useRef(null); // persistent
  const synthRef    = useRef(null); // per-patch
  const fxGraphsRef = useRef([]);   // per-patch

  // Persistent nodes live for the page's lifetime (Root keeps pages mounted,
  // so in practice this runs once per session).
  useEffect(() => {
    filterRef.current = new Tone.Filter({
      type: FILTER_NEUTRAL.type,
      frequency: FILTER_NEUTRAL.frequency,
      Q: FILTER_NEUTRAL.q,
    });
    volumeRef.current = new Tone.Volume(-6).toDestination();
    return () => {
      try { synthRef.current?.releaseAll(); } catch { /* context may be closed */ }
      synthRef.current?.dispose();
      synthRef.current = null;
      fxGraphsRef.current.forEach(g => g.dispose());
      fxGraphsRef.current = [];
      filterRef.current?.dispose();
      filterRef.current = null;
      volumeRef.current?.dispose();
      volumeRef.current = null;
    };
  }, []);

  // Rebuild the per-patch half of the graph. Values are set with `.value =`
  // (not ramps) — this is a structural rebuild, not a live tweak.
  const applyPatch = useCallback((patch) => {
    if (patch.mode === 'sample') {
      // STUB — future text-to-audio backend: fetch/generate a wav, then
      //   synth = new Tone.Sampler({ urls: { [patch.rootNote]: patch.sampleUrl } })
      // instead of makePatchSynth. Everything downstream (filter → FX →
      // volume) is unchanged.
      throw new Error('sample mode is not implemented yet');
    }
    const filter = filterRef.current;
    const volume = volumeRef.current;
    if (!filter || !volume) return;

    try { synthRef.current?.releaseAll(); } catch { /* ignore */ }
    synthRef.current?.dispose();
    filter.disconnect(); // detach from the old FX chain before disposing it
    fxGraphsRef.current.forEach(g => g.dispose());

    const synth = makePatchSynth(patch);
    const graphs = (patch.effects ?? []).map(e => makeFxGraph(e.type, e.params));
    synthRef.current = synth;
    fxGraphsRef.current = graphs;

    synth.connect(filter);
    let node = filter;
    for (const g of graphs) {
      node.connect(g.in);
      node = g.out;
    }
    node.connect(volume);

    const f = patch.filter ?? FILTER_NEUTRAL;
    filter.type = f.type;
    filter.frequency.value = f.frequency;
    filter.Q.value = f.q;
    volume.volume.value = patch.volume;
  }, []);

  // Tone.start() resolves immediately once the context is running; gating the
  // attack on it satisfies the user-gesture requirement on the first press.
  const noteOn = useCallback((note, velocity) => {
    Tone.start().then(() => synthRef.current?.triggerAttack(note, undefined, velocity));
  }, []);
  const noteOff = useCallback((note) => {
    synthRef.current?.triggerRelease(note);
  }, []);
  const releaseAll = useCallback(() => {
    try { synthRef.current?.releaseAll(); } catch { /* ignore */ }
  }, []);

  // Live-edit setters — 50ms ramps against zipper noise (20ms for FX params,
  // matching fxChain's own live-update constant).
  const setVolume = useCallback((db) => {
    volumeRef.current?.volume.rampTo(db, 0.05);
  }, []);
  const setEnvelope = useCallback((partial) => {
    applyEnvelope(synthRef.current, partial);
  }, []);
  const setVoiceParam = useCallback((key, value) => {
    synthRef.current?.set({ [key]: value });
  }, []);
  const setFilter = useCallback((partial) => {
    const filter = filterRef.current;
    if (!filter) return;
    if (partial.type != null) filter.type = partial.type;
    if (partial.frequency != null) filter.frequency.rampTo(partial.frequency, 0.05);
    if (partial.q != null) filter.Q.rampTo(partial.q, 0.05);
  }, []);
  const setEffectParam = useCallback((index, key, value) => {
    fxGraphsRef.current[index]?.apply({ [key]: value }, 0.02);
  }, []);

  return {
    applyPatch,
    noteOn, noteOff, releaseAll,
    setVolume, setEnvelope, setVoiceParam, setFilter, setEffectParam,
  };
}
