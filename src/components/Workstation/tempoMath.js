// Pure tempo-map math for the global tempo automation lane. No React, no Tone.
//
// The tempo curve is scheduled on Tone.Transport.bpm as linearRampToValueAtTime
// segments — i.e. bpm is LINEAR IN SECONDS between anchors. Tone's TickSignal
// integrates such a ramp as a trapezoid (ticks ∝ ∫bpm dt), and this module
// uses the exact same trapezoid, so Transport ticks and this map agree exactly
// at every anchor. The lane DRAWS the curve linear in measures; between
// anchors the real curve bows very slightly (b(m) = sqrt(b0² + (b1²−b0²)·
// (m−m0)/Δm)) — anchor times/values are exact, which is the trade that keeps
// note scheduling (tick-based) and this map in perfect agreement.
//
// Closed forms per segment (b0 at m0 → b1 at m1, 4 beats/measure):
//   Δt      = 240·Δm / ((b0+b1)/2)                (PPQ cancels — none needed)
//   b(m)²   = b0² + (b1²−b0²)·(m−m0)/Δm
//   t(m)    = Δt·(b(m)−b0)/(b1−b0)   (or 240·(m−m0)/b0 when b1 == b0)
//   m(t)    = m0 + (b0·t + k·t²/2)/240,  k = (b1−b0)/Δt
//
// Envelope semantics match automationValueAt: hold-before-first / ramp-
// between / hold-after-last; empty points = constant baseBpm.

import { denorm } from './automationMath';

export const TEMPO_META = {
  default: 120, min: 40, max: 240, step: 1, label: 'tempo', unit: 'bpm',
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// The tempo lane's points out of the shell's globalAutomations array (only
// one tempo automation exists, but keep this the single lookup site).
export function tempoPointsOf(globalAutomations) {
  return (globalAutomations ?? []).find((a) => a.target?.kind === 'tempo')?.points ?? [];
}

/**
 * Build a tempo map from the project's base bpm and the tempo lane's points
 * (normalized {time: measures, value: 0–1}, unsorted tolerated).
 * Always returns a usable map — empty points yields the constant-bpm identity,
 * so consumers never branch on null.
 *
 * Returns { anchors, bpmAtMeasure, secondsAtMeasure, measureAtSeconds } where
 * anchors = [{ measure, bpm, seconds }] (empty for the identity map). Two
 * anchors may share a measure/seconds (a step) — schedulers should emit
 * setValueAtTime for zero-width segments and linear ramps otherwise.
 */
export function buildTempoMap(baseBpm, points, meta = TEMPO_META) {
  const pts = (points ?? []).filter(
    (p) => Number.isFinite(p?.time) && Number.isFinite(p?.value)
  );
  if (!pts.length) {
    const spm = 240 / baseBpm; // seconds per measure
    return {
      anchors: [],
      bpmAtMeasure: () => baseBpm,
      secondsAtMeasure: (m) => Math.max(0, m) * spm,
      measureAtSeconds: (s) => Math.max(0, s) / spm,
    };
  }

  const sorted = [...pts].sort((a, b) => a.time - b.time);
  // Implicit anchor at measure 0 holding the first point's bpm (hold-before-first).
  const anchors = [{ measure: 0, bpm: denorm(clamp01(sorted[0].value), meta), seconds: 0 }];
  for (const p of sorted) {
    const prev = anchors[anchors.length - 1];
    const m = Math.max(p.time, prev.measure); // tolerate float noise; keep non-decreasing
    const b = denorm(clamp01(p.value), meta);
    if (m === prev.measure && b === prev.bpm) continue; // e.g. a point at measure 0 twins the implicit anchor
    const seconds = prev.seconds + (m > prev.measure
      ? (240 * (m - prev.measure)) / ((prev.bpm + b) / 2)
      : 0); // coincident points = instantaneous step
    anchors.push({ measure: m, bpm: b, seconds });
  }

  const last = anchors[anchors.length - 1];

  // Segment lookup by measure: greatest i with anchors[i].measure <= m, then
  // the segment [i, i+1]. For steps (equal measures) the LATER anchor wins.
  const segByMeasure = (m) => {
    let i = anchors.length - 1;
    while (i > 0 && anchors[i].measure > m) i--;
    // skip backwards over the earlier twin of a step so a0 is the post-step value
    while (i < anchors.length - 1 && anchors[i + 1].measure === anchors[i].measure) i++;
    return i;
  };

  const bpmAtMeasure = (m) => {
    if (m <= 0) return anchors[0].bpm;
    if (m >= last.measure) return last.bpm;
    const i = segByMeasure(m);
    const a0 = anchors[i], a1 = anchors[i + 1];
    const dm = a1.measure - a0.measure;
    if (dm <= 0) return a1.bpm;
    const b2 = a0.bpm * a0.bpm + (a1.bpm * a1.bpm - a0.bpm * a0.bpm) * ((m - a0.measure) / dm);
    return Math.sqrt(Math.max(b2, 1e-6));
  };

  const secondsAtMeasure = (m) => {
    if (m <= 0) return 0;
    if (m >= last.measure) return last.seconds + (240 * (m - last.measure)) / last.bpm;
    const i = segByMeasure(m);
    const a0 = anchors[i], a1 = anchors[i + 1];
    const dm = a1.measure - a0.measure;
    if (dm <= 0) return a1.seconds;
    if (a1.bpm === a0.bpm) return a0.seconds + (240 * (m - a0.measure)) / a0.bpm;
    const dt = a1.seconds - a0.seconds;
    const b = bpmAtMeasure(m);
    return a0.seconds + (dt * (b - a0.bpm)) / (a1.bpm - a0.bpm);
  };

  const measureAtSeconds = (s) => {
    if (s <= 0) return 0;
    if (s >= last.seconds) return last.measure + ((s - last.seconds) * last.bpm) / 240;
    let i = anchors.length - 1;
    while (i > 0 && anchors[i].seconds > s) i--;
    while (i < anchors.length - 1 && anchors[i + 1].seconds === anchors[i].seconds) i++;
    const a0 = anchors[i], a1 = anchors[i + 1];
    const dt = a1.seconds - a0.seconds;
    if (dt <= 0) return a1.measure;
    const t = s - a0.seconds;
    const k = (a1.bpm - a0.bpm) / dt;
    return a0.measure + (a0.bpm * t + (k * t * t) / 2) / 240;
  };

  return { anchors, bpmAtMeasure, secondsAtMeasure, measureAtSeconds };
}
