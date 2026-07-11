import * as Tone from 'tone';
import { EFFECT_DEFS, isAutomatableParam } from './effectDefs';

/**
 * Per-track insert-effect DSP factory — peer to synthFactory.js.
 *
 * makeFxGraph(type, params) builds the bare effect graph for a type as a
 * uniform { in, out, apply, dispose } object — shared by the live wrapper
 * (makeFx) and the offline bounce (audioBounce.js). Most types are a single
 * Tone node (in === out); delay and reverb are composites (see below) — delay
 * so its "dry thru" toggle and in-loop cut filters are expressible, reverb so
 * pre-delay hits only the wet path. Both keep param changes as pure gain/
 * param moves with zero topology change.
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
// Freeverb roomSize/wet, EQ3 low/mid/high, Compressor threshold/ratio/attack/
// release, Phaser frequency); plain-setter targets (Chorus.depth, octaves on
// the wahs/phaser, Distortion.distortion, Freeverb.dampening, Filter.type)
// are assigned directly by applyMappedParams below.
const KEY_MAPS = {
  filter:     { q: 'Q' },
  autofilter: { rate: 'frequency', depth: 'octaves' },
  autowah:    { depth: 'octaves', q: 'Q' },
  distortion: { drive: 'distortion' },
  phaser:     { rate: 'frequency', depth: 'octaves' },
  tremolo:    { rate: 'frequency' },
  vibrato:    { rate: 'frequency' },
  autopanner: { rate: 'frequency' },
};

// Per-type value clamps applied before ramp/assign. compressor.threshold must
// stay strictly below 0: Tone's Param.setRampPoint swaps an exact current
// value of 0 for +1e-7 (_minOutput — exponential ramps can't start at 0) and
// its own [-100, 0] assert then throws, crashing the React tree. The UI max
// is −0.1 (effectDefs.js); this clamp covers legacy saves holding 0.
const VALUE_CLAMPS = {
  compressor: { threshold: (v) => Math.min(v, -0.1) },
};

// Generic applier: rampable targets get rampTo (live) or .value (offline/init);
// plain getter/setter properties get direct assignment. Strings assign to
// plain setters only (enum params like Filter.type). Booleans and unknown
// keys are skipped (composite types handle their own booleans in a custom apply).
function applyMappedParams(node, keyMap, params, rampSec, clamps) {
  for (const [key, value] of Object.entries(params)) {
    const mapped = keyMap[key] ?? key;
    if (typeof value === 'string') {
      if (mapped in node) node[mapped] = value; // enum plain setter (e.g. Filter.type)
      continue;
    }
    if (typeof value !== 'number') continue;
    const clampedValue = clamps?.[key] ? clamps[key](value) : value;
    const target = node[mapped];
    if (target != null && typeof target.rampTo === 'function') {
      if (rampSec > 0) target.rampTo(clampedValue, rampSec);
      else target.value = clampedValue;
    } else if (mapped in node) {
      node[mapped] = clampedValue; // plain setter (e.g. Chorus.depth, octaves)
    }
  }
}

// ── Automation targets ──────────────────────────────────────────────────
// Each graph exposes `autoParams`: state-param key → one of
//   { kind: 'ramp', params: [{ param, map }] } — param is a Tone.Param/Signal
//     the automation scheduler can setValueAtTime/linearRamp directly (zero
//     main-thread cost). `map` converts the state-space value to that param's
//     value (identity for most; the coupled delay/reverb `wet` drives TWO
//     gains with affine maps, so linear ramps of wet stay exactly correct).
//     Coupled maps accept an optional ctx ({ dryThru }) so the scheduler can
//     read the CURRENT track state instead of a possibly-stale closure.
//   { kind: 'set', set(v) } — plain setter (Chorus.depth, PitchShift.pitch,
//     octaves, Distortion.distortion, Freeverb.dampening …); driven by the
//     scheduler's stepped ~30 Hz control-rate loop.
function buildAutoParams(node, type) {
  const keyMap = KEY_MAPS[type] ?? {};
  const clamps = VALUE_CLAMPS[type];
  const out = {};
  for (const [key, meta] of Object.entries(EFFECT_DEFS[type]?.params ?? {})) {
    if (!isAutomatableParam(meta)) continue;
    const mapped = keyMap[key] ?? key;
    const clamp = clamps?.[key];
    const target = node[mapped];
    if (target != null && typeof target.rampTo === 'function') {
      out[key] = { kind: 'ramp', params: [{ param: target, map: (v) => (clamp ? clamp(v) : v) }] };
    } else if (mapped in node) {
      out[key] = { kind: 'set', set: (v) => { node[mapped] = clamp ? clamp(v) : v; } };
    }
  }
  return out;
}

// Single-node graph helper.
function simpleGraph(node, type) {
  const keyMap = KEY_MAPS[type] ?? {};
  const clamps = VALUE_CLAMPS[type];
  return {
    in: node,
    out: node,
    apply: (params, rampSec = 0) => applyMappedParams(node, keyMap, params, rampSec, clamps),
    autoParams: buildAutoParams(node, type),
    dispose: () => node.dispose(),
  };
}

// Delay composite — explicit feedback loop on a raw Tone.Delay with the
// low/high cut filters INSIDE the loop, so each repeat passes through them
// again and echoes get progressively darker/thinner (standard DAW delay).
// (Tone.FeedbackDelay's internal loop is sealed — it can't be filtered.)
// Parallel dry/wet level gains make "dry thru" (dry pinned at 1 while echoes
// ride on top) expressible. With dryThru off, dry = 1 − wet (linear
// complement — correct for correlated dry/wet of the same source).
//
//   in(Gain 1) → sum(Gain 1) → Delay(maxDelay:1) → hp(lowCut) → lp(highCut) ─┬→ wetLvl ─┐
//         │           ↑                                                      │          │
//         │           └────────────── fbGain(feedback) ←──────────────────────┘          │
//         └──────────────→ dryLvl ───────────────────────────────────────────────────────┴→ out(Gain 1)
//
// Stability: cut-filter passband gain ≤ 1 and feedback ≤ 0.9 (effectDefs.js),
// so the loop gain never reaches unity. maxDelay caps delayTime.maxValue — a
// rampTo above it throws. The UI time knob is capped at 1.0s to match.
function delayGraph(params = {}) {
  let wet     = params.wet ?? 0.3;
  let dryThru = !!params.dryThru;
  const inGain  = new Tone.Gain(1);
  const outGain = new Tone.Gain(1);
  const sum     = new Tone.Gain(1);
  const delay   = new Tone.Delay({ delayTime: params.time ?? 0.25, maxDelay: 1 });
  // Q = 0.7071 (Butterworth) — flat passband, no resonance bump in the loop.
  const hp = new Tone.Filter({ type: 'highpass', frequency: params.lowCut ?? 20, Q: 0.7071 });
  const lp = new Tone.Filter({ type: 'lowpass', frequency: params.highCut ?? 18000, Q: 0.7071 });
  const fbGain = new Tone.Gain(params.feedback ?? 0.3);
  const wetLvl = new Tone.Gain(wet).connect(outGain);
  const dryLvl = new Tone.Gain(dryThru ? 1 : 1 - wet).connect(outGain);
  inGain.connect(sum);
  sum.connect(delay);
  delay.connect(hp);
  hp.connect(lp);
  lp.connect(wetLvl);
  lp.connect(fbGain);
  fbGain.connect(sum);
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
      if (typeof p.feedback === 'number') setLevel(fbGain, p.feedback, rampSec);
      if (typeof p.lowCut === 'number')   setLevelParam(hp.frequency, p.lowCut, rampSec);
      if (typeof p.highCut === 'number')  setLevelParam(lp.frequency, p.highCut, rampSec);
      // wet and dryThru are coupled: dryLvl depends on both. Recompute from
      // the full params object (updateEffectSettings merges, so p is complete;
      // fall back to the last-applied values for legacy saves missing a key).
      // Gated on the keys being present so an unrelated param edit can't stomp
      // the level gains while the automation scheduler owns them.
      if (typeof p.wet === 'number' || 'dryThru' in p) {
        wet     = typeof p.wet === 'number' ? p.wet : wet;
        dryThru = 'dryThru' in p ? !!p.dryThru : dryThru;
        setLevel(wetLvl, wet, rampSec);
        setLevel(dryLvl, dryThru ? 1 : 1 - wet, rampSec);
      }
    },
    autoParams: {
      time:     { kind: 'ramp', params: [{ param: delay.delayTime, map: (v) => v }] },
      feedback: { kind: 'ramp', params: [{ param: fbGain.gain,     map: (v) => v }] },
      lowCut:   { kind: 'ramp', params: [{ param: hp.frequency,    map: (v) => v }] },
      highCut:  { kind: 'ramp', params: [{ param: lp.frequency,    map: (v) => v }] },
      // Coupled: wet drives BOTH level gains. Both maps are affine in v, so a
      // linear ramp of wet schedules as exactly-correct linear ramps on each.
      // ctx.dryThru (current track state) wins over the closure fallback.
      wet: {
        kind: 'ramp',
        params: [
          { param: wetLvl.gain, map: (v) => v },
          { param: dryLvl.gain, map: (v, ctx) => ((ctx?.dryThru ?? dryThru) ? 1 : 1 - v) },
        ],
      },
    },
    dispose() {
      // fbGain first — severs the feedback loop before the loop nodes go down.
      fbGain.dispose();
      inGain.dispose();
      sum.dispose();
      delay.dispose();
      hp.dispose();
      lp.dispose();
      wetLvl.dispose();
      dryLvl.dispose();
      outGain.dispose();
    },
  };
}

// Reverb composite — pre-delay + dampening on Freeverb. The pre-delay must
// only delay the WET path: Freeverb's built-in wet CrossFade mixes dry
// internally, so a Delay in front of a bare Freeverb would delay the dry
// signal too. Same parallel-levels pattern as the delay composite; Freeverb
// is pinned wet:1 and dry = 1 − wet (linear complement).
//
//   in(Gain 1) → Delay(preDelay, maxDelay:0.25) → Freeverb(wet:1) → wetLvl ─┐
//         └──────────────→ dryLvl ───────────────────────────────────────────┴→ out(Gain 1)
function reverbGraph(params = {}) {
  let wet = params.wet ?? 0.3;
  const inGain   = new Tone.Gain(1);
  const outGain  = new Tone.Gain(1);
  const preDelay = new Tone.Delay({ delayTime: params.preDelay ?? 0, maxDelay: 0.25 });
  const verb     = new Tone.Freeverb({
    roomSize: params.roomSize ?? 0.7,
    dampening: params.dampening ?? 3000,
    wet: 1,
  });
  const wetLvl = new Tone.Gain(wet).connect(outGain);
  const dryLvl = new Tone.Gain(1 - wet).connect(outGain);
  inGain.connect(preDelay);
  preDelay.connect(verb);
  verb.connect(wetLvl);
  inGain.connect(dryLvl);

  const setLevel = (g, v, rampSec) => {
    if (rampSec > 0) g.gain.rampTo(v, rampSec);
    else g.gain.value = v;
  };

  return {
    in: inGain,
    out: outGain,
    apply(p, rampSec = 0) {
      if (typeof p.roomSize === 'number')  setLevelParam(verb.roomSize, p.roomSize, rampSec);
      if (typeof p.preDelay === 'number')  setLevelParam(preDelay.delayTime, p.preDelay, rampSec);
      if (typeof p.dampening === 'number') verb.dampening = p.dampening; // plain setter (Tone 15)
      if (typeof p.wet === 'number') {
        wet = p.wet;
        setLevel(wetLvl, wet, rampSec);
        setLevel(dryLvl, 1 - wet, rampSec);
      }
    },
    autoParams: {
      roomSize:  { kind: 'ramp', params: [{ param: verb.roomSize, map: (v) => v }] },
      preDelay:  { kind: 'ramp', params: [{ param: preDelay.delayTime, map: (v) => v }] },
      dampening: { kind: 'set',  set: (v) => { verb.dampening = v; } },
      // Coupled wet — same affine two-gain pattern as the delay composite.
      wet: {
        kind: 'ramp',
        params: [
          { param: wetLvl.gain, map: (v) => v },
          { param: dryLvl.gain, map: (v) => 1 - v },
        ],
      },
    },
    dispose() {
      inGain.dispose();
      preDelay.dispose();
      verb.dispose();
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

// Bare effect graph for a type. Safe inside Tone.Offline: all types are
// native-node graphs with no async generate step; .start() (Chorus/AutoFilter/
// Phaser LFOs) is valid in the offline context when constructed in its
// callback. Unknown/legacy type → null (caller treats as passthrough).
export function makeFxGraph(type, params = {}) {
  switch (type) {
    case 'filter':
      return simpleGraph(new Tone.Filter({
        type: params.type ?? 'lowpass',
        frequency: params.frequency ?? 5000,
        Q: params.q ?? 1,
      }), type);
    case 'delay':
      return delayGraph(params);
    case 'reverb':
      return reverbGraph(params);
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
    case 'eq':
      // 3-band gain (low/mid/high are rampable dB Params). No wet — inline tone
      // shaping; the wrapper's bypass is the off-switch.
      return simpleGraph(new Tone.EQ3({
        low: params.low ?? 0,
        mid: params.mid ?? 0,
        high: params.high ?? 0,
      }), type);
    case 'distortion':
      // WaveShaper drive. `distortion` is a plain setter (regenerates the
      // shaping curve — fine at UI/knob rate, never touched per-frame).
      return simpleGraph(new Tone.Distortion({
        distortion: params.drive ?? 0.4,
        wet: params.wet ?? 0.5,
      }), type);
    case 'compressor':
      // Native DynamicsCompressorNode wrapper — all params rampable. No wet.
      // threshold clamped below 0 (see VALUE_CLAMPS) — legacy saves may hold 0.
      return simpleGraph(new Tone.Compressor({
        threshold: Math.min(-0.1, params.threshold ?? -24),
        ratio: params.ratio ?? 4,
        attack: params.attack ?? 0.01,
        release: params.release ?? 0.2,
      }), type);
    case 'phaser':
      // LFO-swept allpass ladder. LFOs auto-start in the constructor (no
      // .start() method); octaves is a plain setter, frequency rampable.
      return simpleGraph(new Tone.Phaser({
        frequency: params.rate ?? 0.5,
        octaves: params.depth ?? 3,
        baseFrequency: 350,
        wet: params.wet ?? 0.5,
      }), type);
    case 'bitcrusher':
      // AudioWorklet bit-depth reduction. bits is a worklet Param (rampable).
      return simpleGraph(new Tone.BitCrusher({
        bits: params.bits ?? 4,
        wet: params.wet ?? 1,
      }), type);
    case 'tremolo':
      // Stereo amplitude LFO — needs .start() (Chorus/AutoFilter precedent).
      // frequency/depth are Signals (rampable); spread is a plain setter.
      return simpleGraph(new Tone.Tremolo({
        frequency: params.rate ?? 4,
        depth: params.depth ?? 0.6,
        spread: params.spread ?? 0,
        wet: params.wet ?? 1,
      }).start(), type);
    case 'vibrato':
      // Delay-line pitch LFO. Its LFO auto-starts in the constructor (like
      // Phaser); frequency/depth are rampable Params.
      return simpleGraph(new Tone.Vibrato({
        frequency: params.rate ?? 5,
        depth: params.depth ?? 0.1,
        wet: params.wet ?? 1,
      }), type);
    case 'widener':
      // Mid/side width — width is a rampable Signal (0.5 = unity). No wet.
      return simpleGraph(new Tone.StereoWidener({
        width: params.width ?? 0.75,
      }), type);
    case 'pitchshift':
      // Granular semitone shifter (autotune precedent). pitch and windowSize
      // are plain setters (each rebuilds the grain windows — knob-rate only).
      return simpleGraph(new Tone.PitchShift({
        pitch: params.pitch ?? 0,
        windowSize: params.windowSize ?? 0.1,
        wet: params.wet ?? 1,
      }), type);
    case 'autopanner':
      // LFO-driven stereo panning — needs .start() (LFOEffect subclass).
      return simpleGraph(new Tone.AutoPanner({
        frequency: params.rate ?? 1,
        depth: params.depth ?? 1,
        wet: params.wet ?? 1,
      }).start(), type);
    default:
      return null;
  }
}

// Live wrapper. Gains are INITIALIZED to the bypass state (no startup ramp),
// so a saved project's bypassed effect starts silent-correct.
//
// Bypass is ALSO a render-graph prune: the audio thread only processes nodes
// transitively connected to the destination, so once the crossfade lands,
// graph.out is disconnected from onGain and the effect's DSP (incl. always-
// running LFOs and feedback loops) stops costing CPU entirely — this is what
// makes bypassing a Freeverb/PitchShift on 17 tracks actually matter.
// Un-bypass reconnects BEFORE ramping, so it stays click-free.
// Accepted limitation: delay/reverb buffers freeze while pruned, so
// un-bypassing can briefly replay a stale tail at wet level (same class of
// tradeoff as the add/remove-while-playing rewire click).
export function makeFx(type, params = {}, bypass = false) {
  const input   = new Tone.Gain(1);
  const output  = new Tone.Gain(1);
  const graph   = makeFxGraph(type, params);
  const offGain = new Tone.Gain(graph ? (bypass ? 1 : 0) : 1).connect(output);
  input.connect(offGain);

  let onGain = null;
  let graphLive = false;   // graph.out → onGain edge present
  let pruneTimer = null;   // pending post-crossfade disconnect
  if (graph) {
    onGain = new Tone.Gain(bypass ? 0 : 1).connect(output);
    input.connect(graph.in);
    if (!bypass) {
      graph.out.connect(onGain); // created-bypassed wrappers start pruned
      graphLive = true;
    }
  }

  return {
    type,
    input,
    output,
    autoParams: graph?.autoParams ?? {}, // automation scheduler targets (see buildAutoParams)
    setBypass(b) {
      if (!graph) return; // legacy passthrough — nothing to crossfade
      if (pruneTimer != null) { clearTimeout(pruneTimer); pruneTimer = null; }
      if (!b && !graphLive) {
        graph.out.connect(onGain); // onGain is still 0 — silent reconnect
        graphLive = true;
      }
      onGain.gain.rampTo(b ? 0 : 1, 0.05);
      offGain.gain.rampTo(b ? 1 : 0, 0.05);
      if (b && graphLive) {
        pruneTimer = setTimeout(() => {
          pruneTimer = null;
          if (!graphLive || input.disposed) return;
          graph.out.disconnect(onGain);
          graphLive = false;
        }, 70); // > the 50ms crossfade — the wet path is already silent
      }
    },
    updateParams(p) {
      graph?.apply(p, 0.02);
    },
    dispose() {
      if (pruneTimer != null) { clearTimeout(pruneTimer); pruneTimer = null; }
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
