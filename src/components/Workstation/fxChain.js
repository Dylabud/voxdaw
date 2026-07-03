import * as Tone from 'tone';

/**
 * Per-track insert-effect DSP factory — peer to synthFactory.js.
 *
 * makeFxGraph(type, params) builds the bare effect graph for a type as a
 * uniform { in, out, apply, dispose } object — shared by the live wrapper
 * (makeFx) and the offline bounce (audioBounce.js). Most types are a single
 * Tone node (in === out); the delay is a composite (see below) so its
 * "dry thru" toggle is a pure gain move with zero topology change.
 *
 * makeFx(type, params, bypass) wraps a graph with click-free bypass:
 *
 *   input(Gain 1) ─→ graph ─→ onGain ─┐
 *             └──────────→ offGain ───┴→ output(Gain 1)
 *
 * Bypass is a complementary crossfade of onGain/offGain (the proven setArpFx
 * pattern from useAudioEngine) — the graph stays static, so toggling never
 * pops and never churns nodes. Tone effects keep their own built-in `wet`
 * mix as a user param; the wrapper adds bypass ONLY (no second dry/wet stage).
 *
 * Writers (single-writer per node, CLAUDE.md):
 *   - onGain/offGain  ← setBypass() only (after construction)
 *   - graph params    ← updateParams()/apply() only (after construction)
 *   - input/output    ← chain topology owner (useWorkstationAudio effect 1b)
 */

// State-param key → Tone node param, per type. Types absent here use identity
// mapping. All Signal/Param targets are rampable in Tone 15 (verified: Filter
// frequency/Q, AutoFilter frequency/wet, AutoWah Q/wet, Chorus frequency/wet,
// Freeverb roomSize/wet); plain-setter targets (Chorus.depth, octaves on the
// wahs) are assigned directly by applyMappedParams below.
const KEY_MAPS = {
  filter:     { q: 'Q' },
  autofilter: { rate: 'frequency', depth: 'octaves' },
  autowah:    { depth: 'octaves', q: 'Q' },
};

// Generic applier: rampable targets get rampTo (live) or .value (offline/init);
// plain getter/setter properties get direct assignment. Booleans and unknown
// keys are skipped (composite types handle their own booleans in a custom apply).
function applyMappedParams(node, keyMap, params, rampSec) {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'number') continue;
    const mapped = keyMap[key] ?? key;
    const target = node[mapped];
    if (target != null && typeof target.rampTo === 'function') {
      if (rampSec > 0) target.rampTo(value, rampSec);
      else target.value = value;
    } else if (mapped in node) {
      node[mapped] = value; // plain setter (e.g. Chorus.depth, octaves)
    }
  }
}

// Single-node graph helper.
function simpleGraph(node, type) {
  const keyMap = KEY_MAPS[type] ?? {};
  return {
    in: node,
    out: node,
    apply: (params, rampSec = 0) => applyMappedParams(node, keyMap, params, rampSec),
    dispose: () => node.dispose(),
  };
}

// Delay composite — FeedbackDelay held fully wet with explicit parallel
// dry/wet level gains, so "dry thru" (dry pinned at 1 while echoes ride on
// top) is expressible. With dryThru off, dry = 1 − wet (linear complement —
// correct for correlated dry/wet of the same source).
//
//   in(Gain 1) → FeedbackDelay(wet:1, maxDelay:1) → wetLvl ─┐
//         └──────────────→ dryLvl ─────────────────────────┴→ out(Gain 1)
//
// maxDelay caps delayTime.maxValue — a rampTo above it throws. The UI time
// slider is capped at 1.0s to match (effectDefs.js).
function delayGraph(params = {}) {
  let wet     = params.wet ?? 0.3;
  let dryThru = !!params.dryThru;
  const inGain  = new Tone.Gain(1);
  const outGain = new Tone.Gain(1);
  const delay   = new Tone.FeedbackDelay({
    maxDelay: 1,
    delayTime: params.time ?? 0.25,
    feedback: params.feedback ?? 0.3,
    wet: 1,
  });
  const wetLvl = new Tone.Gain(wet).connect(outGain);
  const dryLvl = new Tone.Gain(dryThru ? 1 : 1 - wet).connect(outGain);
  inGain.connect(delay);
  delay.connect(wetLvl);
  inGain.connect(dryLvl);

  const setLevel = (g, v, rampSec) => {
    if (rampSec > 0) g.gain.rampTo(v, rampSec);
    else g.gain.value = v;
  };

  return {
    in: inGain,
    out: outGain,
    apply(p, rampSec = 0) {
      if (typeof p.time === 'number')     setLevelParam(delay.delayTime, p.time, rampSec);
      if (typeof p.feedback === 'number') setLevelParam(delay.feedback, p.feedback, rampSec);
      // wet and dryThru are coupled: dryLvl depends on both. Recompute from
      // the full params object (updateEffectSettings merges, so p is complete;
      // fall back to the last-applied values for legacy saves missing a key).
      wet     = typeof p.wet === 'number' ? p.wet : wet;
      dryThru = 'dryThru' in p ? !!p.dryThru : dryThru;
      setLevel(wetLvl, wet, rampSec);
      setLevel(dryLvl, dryThru ? 1 : 1 - wet, rampSec);
    },
    dispose() {
      inGain.dispose();
      delay.dispose();
      wetLvl.dispose();
      dryLvl.dispose();
      outGain.dispose();
    },
  };
}

// Ramp-or-set for Tone Params/Signals (delay composite helper).
function setLevelParam(param, v, rampSec) {
  if (rampSec > 0) param.rampTo(v, rampSec);
  else param.value = v;
}

// Bare effect graph for a type. Safe inside Tone.Offline: all five types are
// native-node graphs with no async generate step; .start() (Chorus/AutoFilter
// LFOs) is valid in the offline context when constructed in its callback.
// Unknown/legacy type → null (caller treats as passthrough).
export function makeFxGraph(type, params = {}) {
  switch (type) {
    case 'filter':
      return simpleGraph(new Tone.Filter({
        type: 'lowpass',
        frequency: params.frequency ?? 5000,
        Q: params.q ?? 1,
      }), type);
    case 'delay':
      return delayGraph(params);
    case 'reverb':
      return simpleGraph(new Tone.Freeverb({
        roomSize: params.roomSize ?? 0.7,
        wet: params.wet ?? 0.3,
      }), type);
    case 'doubler':
      // Vocal-doubler voicing: short modulated delay, slow LFO, full stereo spread.
      return simpleGraph(new Tone.Chorus({
        frequency: 1.5,
        delayTime: 3.5, // ms
        depth: params.depth ?? 0.7,
        spread: 180,
        wet: params.wet ?? 0.5,
      }).start(), type);
    case 'autofilter':
      // LFO-driven filter sweep (rhythmic "wah"). depth = octaves above base.
      return simpleGraph(new Tone.AutoFilter({
        frequency: params.rate ?? 2,
        baseFrequency: 200,
        octaves: params.depth ?? 4,
        wet: params.wet ?? 0.5,
      }).start(), type);
    case 'autowah':
      // Envelope-follower wah — opens with note attacks. No .start() (no LFO).
      return simpleGraph(new Tone.AutoWah({
        baseFrequency: 100,
        octaves: params.depth ?? 4,
        Q: params.q ?? 2,
        wet: params.wet ?? 0.5,
      }), type);
    default:
      return null;
  }
}

// Live wrapper. Gains are INITIALIZED to the bypass state (no startup ramp),
// so a saved project's bypassed effect starts silent-correct.
export function makeFx(type, params = {}, bypass = false) {
  const input   = new Tone.Gain(1);
  const output  = new Tone.Gain(1);
  const graph   = makeFxGraph(type, params);
  const offGain = new Tone.Gain(graph ? (bypass ? 1 : 0) : 1).connect(output);
  input.connect(offGain);

  let onGain = null;
  if (graph) {
    onGain = new Tone.Gain(bypass ? 0 : 1).connect(output);
    input.connect(graph.in);
    graph.out.connect(onGain);
  }

  return {
    type,
    input,
    output,
    setBypass(b) {
      if (!graph) return; // legacy passthrough — nothing to crossfade
      onGain.gain.rampTo(b ? 0 : 1, 0.05);
      offGain.gain.rampTo(b ? 1 : 0, 0.05);
    },
    updateParams(p) {
      graph?.apply(p, 0.02);
    },
    dispose() {
      // input first (severs upstream fan-out), then the graph (kills any
      // feedback loop), then gains. Tone dispose() auto-disconnects.
      input.dispose();
      graph?.dispose();
      onGain?.dispose();
      offGain.dispose();
      output.dispose();
    },
  };
}
