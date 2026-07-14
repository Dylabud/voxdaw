// AI Instrument Generator audio engine — a peer hook per the CLAUDE.md hook-
// modularity rule (nothing here touches useAudioEngine / useWorkstationAudio).
//
// A patch is a STACK of 1–3 layers (patchSchema). Each layer is its own
// subgraph, all summed into one persistent master Volume:
//
//   layerₙ:  makePatchSynth(layer) → Tone.Filter → [fxGraph…] → layerVol ─┐
//   …                                                                      ├→ master Volume → Destination
//   layer₀:  makePatchSynth(layer) → Tone.Filter → [fxGraph…] → layerVol ─┘
//
// The master Volume is persistent (created once, disposed on unmount); every
// layer's synth/filter/FX/level are per-patch (rebuilt by applyPatch — same
// accepted tail-cut as the workstation's structural FX rebuilds). Layer chains
// are built by customInstrumentSynth.buildLayerChain — shared with the baked
// workstation instrument so the two sound identical.
//
// Single Writer per node: setVolume owns the master; per layer, setLayerVolume
// owns its level, setFilter owns its filter, setEffectParam(i, …) owns graph i,
// setEnvelope/setVoiceParam/setLayerPitch own the layer's synth. Nothing else
// writes these.

import { useCallback, useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { buildLayerChain } from '../components/Workstation/customInstrumentSynth';
import { applyEnvelope } from '../components/Workstation/synthFactory';
import { makePatchSynth } from '../components/AIGen/patchSynth';
import { layersOf, layerDetuneCents } from '../components/AIGen/patchSchema';

// One instrument on one page — a generous voice cap so long-release stacked
// chords don't drop notes or log "max polyphony exceeded" (the workstation
// governs custom-instrument polyphony via its own quality tiers instead).
const GENERATOR_MAX_POLYPHONY = 64;

export default function useAIInstrument() {
  const volumeRef = useRef(null); // persistent master
  const layersRef = useRef([]);   // per-patch: [{ synth, filter, fx, vol }]

  // The master lives for the page's lifetime (Root keeps pages mounted, so in
  // practice this runs once per session).
  useEffect(() => {
    volumeRef.current = new Tone.Volume(-6).toDestination();
    return () => {
      disposeLayers();
      volumeRef.current?.dispose();
      volumeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disposeLayers = () => {
    for (const l of layersRef.current) {
      try { l.synth.releaseAll(); } catch { /* context may be closed */ }
      l.synth.dispose();
      l.filter.dispose();
      l.fx.forEach((g) => g.dispose());
      l.vol.dispose();
      l.mute.dispose();
    }
    layersRef.current = [];
  };

  // Rebuild the per-patch half of the graph. Values are set with `.value =`
  // (not ramps) — this is a structural rebuild, not a live tweak.
  const applyPatch = useCallback((patch) => {
    if (patch.mode === 'sample') {
      // STUB — future text-to-audio backend: fetch/generate a wav, then a
      // Tone.Sampler layer instead of makePatchSynth. Everything downstream
      // (filter → FX → level → master) is unchanged.
      throw new Error('sample mode is not implemented yet');
    }
    const master = volumeRef.current;
    if (!master) return;

    disposeLayers();
    layersRef.current = layersOf(patch).map((layer) => {
      const synth = makePatchSynth(layer, { maxPolyphony: GENERATOR_MAX_POLYPHONY });
      const { filter, fx, vol } = buildLayerChain(layer, synth);
      // Dedicated mute gain (transient — the mixer's mute writes it; never
      // persisted into the patch). Single writer per the Zero-Re-render rule.
      const mute = new Tone.Gain(1);
      vol.connect(mute);
      mute.connect(master);
      return { synth, filter, fx, vol, mute };
    });
    master.volume.value = patch.volume;
  }, []);

  // Tone.start() resolves immediately once the context is running; gating the
  // attack on it satisfies the user-gesture requirement on the first press.
  const noteOn = useCallback((note, velocity) => {
    Tone.start().then(() => {
      for (const l of layersRef.current) l.synth.triggerAttack(note, undefined, velocity);
    });
  }, []);
  const noteOff = useCallback((note) => {
    for (const l of layersRef.current) l.synth.triggerRelease(note);
  }, []);
  const releaseAll = useCallback(() => {
    for (const l of layersRef.current) {
      try { l.synth.releaseAll(); } catch { /* ignore */ }
    }
  }, []);

  // ── Live-edit setters ──────────────────────────────────────────────────
  // 50ms ramps against zipper noise (20ms for FX params, matching fxChain's
  // own live-update constant). Master + per-layer index (i).
  const setVolume = useCallback((db) => {
    volumeRef.current?.volume.rampTo(db, 0.05);
  }, []);
  const setLayerVolume = useCallback((i, db) => {
    layersRef.current[i]?.vol.volume.rampTo(db, 0.05);
  }, []);
  const setLayerMute = useCallback((i, muted) => {
    layersRef.current[i]?.mute.gain.rampTo(muted ? 0 : 1, 0.02);
  }, []);
  const setEnvelope = useCallback((i, partial) => {
    applyEnvelope(layersRef.current[i]?.synth, partial);
  }, []);
  // setObj is a (possibly nested) Tone .set() partial — Tone deep-merges, so
  // { oscillator: { spread } } touches only that sub-param. The UI builds it.
  const setVoiceParam = useCallback((i, setObj) => {
    layersRef.current[i]?.synth.set(setObj);
  }, []);
  // Per-layer pitch — transpose (semitones) + detune (cents) fold into the
  // synth's detune param (patchSchema.layerDetuneCents).
  const setLayerPitch = useCallback((i, layer) => {
    layersRef.current[i]?.synth.set({ detune: layerDetuneCents(layer) });
  }, []);
  const setFilter = useCallback((i, partial) => {
    const filter = layersRef.current[i]?.filter;
    if (!filter) return;
    if (partial.type != null) filter.type = partial.type;
    if (partial.frequency != null) filter.frequency.rampTo(partial.frequency, 0.05);
    if (partial.q != null) filter.Q.rampTo(partial.q, 0.05);
  }, []);
  const setEffectParam = useCallback((i, index, key, value) => {
    layersRef.current[i]?.fx[index]?.apply({ [key]: value }, 0.02);
  }, []);

  return {
    applyPatch,
    noteOn, noteOff, releaseAll,
    setVolume, setLayerVolume, setLayerMute, setEnvelope, setVoiceParam, setLayerPitch, setFilter, setEffectParam,
  };
}
