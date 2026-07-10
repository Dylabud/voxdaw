/**
 * Pure math for track automation lanes — no Tone.js, no React.
 *
 * An automation is `{ id: 'a<n>', target, points }` on track.automations:
 *   target: { kind: 'volume' } | { kind: 'pan' }
 *         | { kind: 'fx', effectId: 'e3', param: 'wet' }
 *   points: [{ time, value }] — time in MEASURES (like region.startMeasure,
 *           BPM-independent), value normalized 0–1, ALWAYS sorted by time.
 *
 * Envelope semantics: 0 points = inert lane (null — callers skip it entirely);
 * hold-before-first / linear-between / hold-after-last, so 1 point = flat line.
 *
 * Normalization contract (single source of truth — lanes, EffectsRack knobs,
 * live scheduler, and offline bounce all share it):
 *   volume  v01 → slider value v01*100 → gain via volForSliderValue (hook-side)
 *   pan     v01 → v01*2 − 1
 *   fx      v01 → denorm(v01, meta)  (log scaling per EFFECT_DEFS metadata)
 */

// Lane geometry constants. TRACK_H must match .trackRow/.trackLane height in
// WorkstationShell.module.css; the shell imports it from here.
export const TRACK_H        = 72; // main track row
export const AUTO_LANE_H    = 72; // one automation sub-lane ("same as track height")
export const AUTO_ADD_H     = 24; // the [+ automation] strip under the sub-lanes
export const GLOBAL_STRIP_H = 24; // the always-present "global" row above track rows
export const GROUP_H        = 48; // a group header row (before its first member)

// ── Envelope sampling ─────────────────────────────────────────────────────

// Normalized envelope value (0–1) at a musical time, or null for an empty lane.
export function automationValueAt(points, timeMeasures) {
  if (!points || points.length === 0) return null;
  if (timeMeasures <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (timeMeasures >= last.time) return last.value;
  for (let i = 1; i < points.length; i++) {
    if (timeMeasures <= points[i].time) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      return a.value + (b.value - a.value) * ((timeMeasures - a.time) / span);
    }
  }
  return last.value;
}

// ── Knob-space (0..1) ↔ param-value mapping ──────────────────────────────
// Log scale for perceptual params (hz cutoffs, rates, attack):
// value = min * (max/min)^v; linear otherwise. Shared by EffectsRack knobs
// (quantized via fromKnob) and automation (continuous via denorm).

export function toKnob(value, meta) {
  if (meta.scale === 'log') return Math.log(value / meta.min) / Math.log(meta.max / meta.min);
  return (value - meta.min) / (meta.max - meta.min);
}

// Quantizes to the metadata step so knob readouts land on clean values.
export function fromKnob(v, meta) {
  let out = meta.scale === 'log'
    ? meta.min * Math.pow(meta.max / meta.min, v)
    : meta.min + (meta.max - meta.min) * v;
  if (meta.step) out = Math.round(out / meta.step) * meta.step;
  return Math.min(meta.max, Math.max(meta.min, out));
}

// Continuous variant for automation ramps — no step quantization (a stepped
// line would zipper), input clamped to 0..1.
export function denorm(v01, meta) {
  const v = Math.max(0, Math.min(1, v01));
  return meta.scale === 'log'
    ? meta.min * Math.pow(meta.max / meta.min, v)
    : meta.min + (meta.max - meta.min) * v;
}

// ── Ownership helpers ─────────────────────────────────────────────────────
// "Automation takes over": a lane with ≥1 point makes the automation scheduler
// the sole writer of its target — the manual control dims and the audio hook's
// sync effects (#3 volume / #3b pan / #1d fx params) skip that param.

const hasPoints = (a) => Array.isArray(a.points) && a.points.length > 0;

export function isVolumeAutomated(track) {
  return (track.automations ?? []).some(a => a.target?.kind === 'volume' && hasPoints(a));
}

export function isPanAutomated(track) {
  return (track.automations ?? []).some(a => a.target?.kind === 'pan' && hasPoints(a));
}

// Set of "effectId:param" keys with active (≥1 point) automation.
export function automatedFxKeys(track) {
  const keys = new Set();
  for (const a of track.automations ?? []) {
    if (a.target?.kind === 'fx' && hasPoints(a)) keys.add(`${a.target.effectId}:${a.target.param}`);
  }
  return keys;
}

// Stable identity for a target — dedupe in the add-dropdown, applied-map keys.
export function targetKey(target) {
  return target.kind === 'fx' ? `fx:${target.effectId}:${target.param}` : target.kind;
}

// ── Stacked-lane geometry ─────────────────────────────────────────────────
// Open automation areas break the uniform trackIndex * TRACK_H mapping.
// tops[i] = content-Y of track i's main row; tops[tracks.length] = total height.

export function trackExtraHeight(track, openSet) {
  if (!openSet?.has(track.id)) return 0;
  return (track.automations?.length ?? 0) * AUTO_LANE_H + AUTO_ADD_H;
}

// topOffset = height of rows ABOVE track 0 in the same flow (the global
// automation area). Every consumer measures content-Y from the same origin
// (below the ruler / tracks header), so as long as tops mirror the DOM flow
// nothing else changes.
//
// groupView (optional) = { collapsedIds: Set<groupId> }. A group header row
// (GROUP_H) is emitted before the FIRST member of each contiguous group run
// (contiguity is an invariant: createGroup reorders, deserialize normalizes);
// a collapsed group's member rows contribute ZERO height (tops[i+1] ===
// tops[i]), which also makes them unreachable by yToTrackIndex — its
// `y < tops[i+1]` scan naturally skips zero-height rows.
export function computeLaneTops(tracks, openSet, topOffset = 0, groupView = null) {
  const tops = new Array(tracks.length + 1);
  let y = topOffset;
  let prevGroupId = null;
  for (let i = 0; i < tracks.length; i++) {
    const gid = tracks[i].groupId ?? null;
    if (gid && gid !== prevGroupId) y += GROUP_H; // group header row
    prevGroupId = gid;
    tops[i] = y;
    if (gid && groupView?.collapsedIds?.has(gid)) continue; // hidden member
    y += TRACK_H + trackExtraHeight(tracks[i], openSet);
  }
  tops[tracks.length] = y;
  return tops;
}

// Inverse of computeLaneTops: a y anywhere in a track's strip (main row OR its
// open sub-lanes) resolves to that track. Out-of-range values extrapolate in
// TRACK_H steps, matching the legacy Math.floor(y / TRACK_H) pre-clamp
// behavior that the drag code's own clamping depends on.
export function yToTrackIndex(y, tops) {
  const n = tops.length - 1;
  if (n <= 0) return 0;
  if (y < 0) return Math.floor(y / TRACK_H);
  for (let i = 0; i < n; i++) {
    if (y < tops[i + 1]) return i;
  }
  return n + Math.floor((y - tops[n]) / TRACK_H);
}
