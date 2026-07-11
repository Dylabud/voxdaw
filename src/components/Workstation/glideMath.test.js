import {
  keyIndexOf, semitonesUp, tickOf, glideShape, TENSION_LIMIT,
  normalizeGlide, sanitizeGlide,
  curveSampleCount, sampleCentsCurve, sampleGainCurve,
  svgPathFor, tensionHandlePoint,
  compileGlideChains, clipSegments, segmentsAreInert,
  indexNotesByStartTick, resolveGlideTarget,
  retargetConnectedGlides, planChordConnections,
} from './glideMath';
import { KEYS } from './pitchKeys';

describe('pitch helpers', () => {
  test('KEYS ordering: high pitches have LOWER indices', () => {
    expect(keyIndexOf('C5')).toBeLessThan(keyIndexOf('C4'));
  });
  test('semitonesUp sign convention: up = positive', () => {
    expect(semitonesUp('C4', 'D4')).toBe(2);
    expect(semitonesUp('C4', 'C5')).toBe(12);
    expect(semitonesUp('C4', 'B3')).toBe(-1);
    expect(semitonesUp('C4', 'C4')).toBe(0);
  });
  test('keyIndexOf unknown name → -1', () => {
    expect(keyIndexOf('H9')).toBe(-1);
  });
});

describe('tickOf adjacency', () => {
  const PPQ = 192;
  test('float-noise sums land on the same tick', () => {
    // 1/3-beat snap drags accumulate float noise; end tick must equal start tick.
    const end = 0.1 + 0.2 + (1 / 3); // 0.6333…333? — classic float noise
    const start = 19 / 30;           // same musical value, different arithmetic
    expect(tickOf(end, PPQ)).toBe(tickOf(start, PPQ));
  });
  test('a full tick apart does NOT match', () => {
    expect(tickOf(1, PPQ)).not.toBe(tickOf(1 + 1 / PPQ, PPQ));
  });
});

describe('glideShape', () => {
  test('endpoints exact for any tension', () => {
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      expect(glideShape(0, t)).toBe(0);
      expect(glideShape(1, t)).toBe(1);
    }
  });
  test('tension 0 is the identity line', () => {
    expect(glideShape(0.25, 0)).toBeCloseTo(0.25, 12);
    expect(glideShape(0.7, 0)).toBeCloseTo(0.7, 12);
  });
  test('tension −1 = u² (late sweep), +1 = 2u−u² (early sweep)', () => {
    expect(glideShape(0.5, -1)).toBeCloseTo(0.25, 12);
    expect(glideShape(0.5, 1)).toBeCloseTo(0.75, 12);
  });
  test('monotonic (never overshoots) for |tension| ≤ 1', () => {
    for (const t of [-1, -0.99, 0.99, 1]) {
      let prev = -Infinity;
      for (let i = 0; i <= 100; i++) {
        const v = glideShape(i / 100, t);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
  test('beyond ±1 the curve intentionally overshoots (peak at u=(1+t)/2t)', () => {
    expect(glideShape(0.75, 2)).toBeCloseTo(1.125, 12);  // 12.5% past the target
    expect(glideShape(0.25, -2)).toBeCloseTo(-0.125, 12); // dips below the source
    // Endpoints stay exact at the extended limit.
    expect(glideShape(0, TENSION_LIMIT)).toBe(0);
    expect(glideShape(1, TENSION_LIMIT)).toBe(1);
  });
});

describe('normalizeGlide / sanitizeGlide', () => {
  test('inert glide prunes to undefined', () => {
    expect(normalizeGlide({ startOffset: 0, endPitch: 'C4', tension: 0, connected: false }, 'C4'))
      .toBeUndefined();
    // offset/tension without a pitch change are meaningless → still pruned
    expect(normalizeGlide({ startOffset: 0.5, endPitch: 'C4', tension: 0.8, connected: false }, 'C4'))
      .toBeUndefined();
  });
  test('connected same-pitch glide survives (legato tie)', () => {
    expect(normalizeGlide({ endPitch: 'C4', connected: true }, 'C4'))
      .toEqual({ startOffset: 0, endPitch: 'C4', tension: 0, connected: true });
  });
  test('clamps and coerces (tension bound = ±TENSION_LIMIT)', () => {
    expect(normalizeGlide({ startOffset: 7, endPitch: 'E4', tension: -9, connected: 1 }, 'C4'))
      .toEqual({ startOffset: 1, endPitch: 'E4', tension: -TENSION_LIMIT, connected: true });
    expect(normalizeGlide({ startOffset: 0, endPitch: 'E4', tension: 1.5 }, 'C4').tension)
      .toBe(1.5); // overshoot range survives normalization
  });
  test('invalid endPitch falls back to the note pitch (→ pruned when unconnected)', () => {
    expect(normalizeGlide({ endPitch: 'X#9' }, 'C4')).toBeUndefined();
    expect(normalizeGlide({ endPitch: 'X#9', connected: true }, 'C4'))
      .toEqual({ startOffset: 0, endPitch: 'C4', tension: 0, connected: true });
  });
  test('garbage inputs → undefined', () => {
    expect(sanitizeGlide(null, 'C4')).toBeUndefined();
    expect(sanitizeGlide('glide', 'C4')).toBeUndefined();
    expect(sanitizeGlide({ startOffset: NaN, endPitch: 'D4', tension: 'x' }, 'C4'))
      .toEqual({ startOffset: 0, endPitch: 'D4', tension: 0, connected: false });
  });
  test('round-trips through itself (idempotent)', () => {
    const g = normalizeGlide({ startOffset: 0.25, endPitch: 'G4', tension: 0.5 }, 'C4');
    expect(normalizeGlide(g, 'C4')).toEqual(g);
  });
});

describe('curve sampling', () => {
  test('sample count bounds: ≥64 always, ≤512, ~96/s between', () => {
    expect(curveSampleCount(0.01)).toBe(64);
    expect(curveSampleCount(1)).toBe(96);
    expect(curveSampleCount(60)).toBe(512);
  });
  test('cents curve endpoints exact, straight line linear', () => {
    const c = sampleCentsCurve({ fromCents: 0, toCents: 1200, tension: 0, n: 5 });
    expect(Array.from(c)).toEqual([0, 300, 600, 900, 1200]);
  });
  test('cents curve respects tension shape', () => {
    const c = sampleCentsCurve({ fromCents: 0, toCents: 100, tension: -1, n: 3 });
    expect(c[1]).toBeCloseTo(25, 6); // g(0.5, −1) = 0.25
    expect(c[2]).toBeCloseTo(100, 6);
  });
  test('custom uAt remaps sample positions (tempo-ramp path)', () => {
    const c = sampleCentsCurve({ fromCents: 0, toCents: 100, tension: 0, n: 3, uAt: () => 1 });
    expect(Array.from(c)).toEqual([100, 100, 100]);
  });
  test('gain curve lerps', () => {
    const g = sampleGainCurve({ fromGain: 0.5, toGain: 1, n: 3 });
    expect(Array.from(g)).toEqual([0.5, 0.75, 1]);
  });
  test('overshoot tension: interior samples exceed toCents, endpoints exact', () => {
    const c = sampleCentsCurve({ fromCents: 0, toCents: 100, tension: 2, n: 5 });
    expect(c[0]).toBe(0);
    expect(c[4]).toBeCloseTo(100, 6);
    expect(Math.max(...c)).toBeGreaterThan(100); // peak 112.5 at u=0.75
    expect(c[3]).toBeCloseTo(112.5, 6);
  });
});

describe('SVG geometry', () => {
  test('bezier control point encodes tension; flat hold prefixes when xFlat < x0', () => {
    expect(svgPathFor({ xFlat: 0, x0: 10, y0: 100, x1: 50, y1: 60, tension: 0 }))
      .toBe('M 0 100 L 10 100 Q 30 80 50 60');
    expect(svgPathFor({ x0: 10, y0: 100, x1: 50, y1: 60, tension: 1 }))
      .toBe('M 10 100 Q 30 60 50 60');
  });
  test('tension handle sits on the curve at u=0.5', () => {
    const p = tensionHandlePoint({ x0: 0, y0: 0, x1: 100, y1: 100, tension: 1 });
    expect(p).toEqual({ x: 50, y: 75 }); // g(0.5, 1) = 0.75
  });
  test('screen⇔audio lockstep holds at overshoot tension (t=2)', () => {
    // Mid-x control point ⇒ bezier y at u=0.5 = (y0 + 2cy + y1)/4 must equal
    // y0 + (y1−y0)·g(0.5, t) — the identity is tension-independent.
    const y0 = 0, y1 = 100, t = 2;
    const cy = y0 + (y1 - y0) * (0.5 + t / 2);
    const bezierMidY = (y0 + 2 * cy + y1) / 4;
    expect(bezierMidY).toBeCloseTo(y0 + (y1 - y0) * glideShape(0.5, t), 12);
    expect(tensionHandlePoint({ x0: 0, y0, x1: 100, y1, tension: t }).y)
      .toBeCloseTo(bezierMidY, 12);
  });
  test('KEYS import sanity (module under test shares the app key table)', () => {
    expect(KEYS[keyIndexOf('C4')].name).toBe('C4');
  });
});

describe('compileGlideChains', () => {
  const PPQ = 192;
  const note = (id, pitch, startBeat, durationBeats, extra = {}) =>
    ({ id, note: pitch, startBeat, durationBeats, velocity: 100, ...extra });
  const glide = (endPitch, connected = true, extra = {}) =>
    ({ glide: { startOffset: 0, endPitch, tension: 0, connected, ...extra } });

  test('glide-free notes come back as plain units (segments null)', () => {
    const units = compileGlideChains([note('a', 'C4', 0, 1), note('b', 'E4', 1, 1)], PPQ);
    expect(units).toHaveLength(2);
    expect(units.every(u => u.segments === null)).toBe(true);
  });

  test('connected pair merges: one chain unit, target suppressed', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, glide('E4')),
      note('b', 'E4', 1, 1),
    ], PPQ);
    expect(units).toHaveLength(1);
    const [u] = units;
    expect(u.note).toBe('C4');
    expect(u.totalBeats).toBe(2);
    expect(u.segments).toHaveLength(2);
    expect(u.segments[0]).toMatchObject({ fromPitch: 'C4', toPitch: 'E4', durTicks: 192 });
    expect(u.segments[1]).toMatchObject({ fromPitch: 'E4', toPitch: 'E4' }); // glide-less tail holds flat
  });

  test('three-note chain A→B→C walks head to tail', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, glide('D4')),
      note('b', 'D4', 1, 1, glide('E4')),
      note('c', 'E4', 2, 2),
    ], PPQ);
    expect(units).toHaveLength(1);
    expect(units[0].totalBeats).toBe(4);
    expect(units[0].segments.map(s => s.toPitch)).toEqual(['D4', 'E4', 'E4']);
  });

  test('no target at end tick → unconnected glide unit; next note plays itself', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, glide('E4')),
      note('b', 'E4', 1.5, 1), // gap — not adjacent
    ], PPQ);
    expect(units).toHaveLength(2);
    const host = units.find(u => u.note === 'C4');
    expect(host.segments).toHaveLength(1);
    expect(host.segments[0].toPitch).toBe('E4'); // still glides
  });

  test('wrong-pitch next note does not connect', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, glide('E4')),
      note('b', 'G4', 1, 1),
    ], PPQ);
    expect(units).toHaveLength(2);
  });

  test('two hosts racing for one target: one wins, loser degrades to unconnected', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, glide('E4')),
      note('b', 'G4', 0, 1, glide('E4')),
      note('t', 'E4', 1, 1),
    ], PPQ);
    // 2 units: the winning chain (2 segments) + the losing single-segment glide
    expect(units).toHaveLength(2);
    const chain = units.find(u => u.segments?.length === 2);
    const loser = units.find(u => u.segments?.length === 1);
    expect(chain).toBeTruthy();
    expect(loser.segments[0].toPitch).toBe('E4');
  });

  test('velocity crossfade values: fromVel = member, toVel = next member', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0, 1, { velocity: 120, ...glide('E4') }),
      note('b', 'E4', 1, 1, { velocity: 40 }),
    ], PPQ);
    expect(units[0].segments[0]).toMatchObject({ fromVel: 120, toVel: 40 });
    expect(units[0].segments[1]).toMatchObject({ fromVel: 40, toVel: 40 });
  });

  test('float-noise adjacency connects through tickOf', () => {
    const units = compileGlideChains([
      note('a', 'C4', 0.1 + 0.2, 1 / 3, glide('D4')), // ends at 0.6333…
      note('b', 'D4', 19 / 30, 1),
    ], PPQ);
    expect(units).toHaveLength(1);
  });
});

describe('clipSegments / segmentsAreInert', () => {
  const segs = [
    { durTicks: 192, fromPitch: 'C4', toPitch: 'D4', startOffset: 0, tension: 0, fromVel: 100, toVel: 100 },
    { durTicks: 192, fromPitch: 'D4', toPitch: 'D4', startOffset: 0, tension: 0, fromVel: 100, toVel: 100 },
  ];
  test('whole segments kept, straddler truncated with fullDurTicks', () => {
    const out = clipSegments(segs, 288);
    expect(out).toHaveLength(2);
    expect(out[0].durTicks).toBe(192);
    expect(out[1]).toMatchObject({ durTicks: 96, fullDurTicks: 192 });
  });
  test('clip inside the first segment drops the rest', () => {
    const out = clipSegments(segs, 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ durTicks: 100, fullDurTicks: 192 });
  });
  test('inert detection: single flat segment', () => {
    expect(segmentsAreInert([{ fromPitch: 'C4', toPitch: 'C4', fromVel: 100, toVel: 100 }])).toBe(true);
    expect(segmentsAreInert([{ fromPitch: 'C4', toPitch: 'D4', fromVel: 100, toVel: 100 }])).toBe(false);
    expect(segmentsAreInert(segs)).toBe(false);
  });
});

describe('resolveGlideTarget', () => {
  const PPQ = 192;
  test('ambiguous (2 same-tick same-pitch candidates) → null', () => {
    const notes = [
      { id: 'a', note: 'C4', startBeat: 0, durationBeats: 1,
        glide: { startOffset: 0, endPitch: 'E4', tension: 0, connected: true } },
      { id: 'b', note: 'E4', startBeat: 1, durationBeats: 1 },
      { id: 'c', note: 'E4', startBeat: 1, durationBeats: 2 },
    ];
    const idx = indexNotesByStartTick(notes, PPQ);
    expect(resolveGlideTarget(notes[0], idx, PPQ)).toBeNull();
  });
  test('unconnected glide → null even with a valid target', () => {
    const notes = [
      { id: 'a', note: 'C4', startBeat: 0, durationBeats: 1,
        glide: { startOffset: 0, endPitch: 'E4', tension: 0, connected: false } },
      { id: 'b', note: 'E4', startBeat: 1, durationBeats: 1 },
    ];
    const idx = indexNotesByStartTick(notes, PPQ);
    expect(resolveGlideTarget(notes[0], idx, PPQ)).toBeNull();
  });
});

describe('planChordConnections', () => {
  const PPQ = 192;
  const note = (id, pitch, startBeat, durationBeats = 1) =>
    ({ id, regionId: 'r1', note: pitch, startBeat, durationBeats });
  // Three adjacent uniform triads: C-major → F-major → G-major.
  const A = [note('a1', 'G4', 0), note('a2', 'E4', 0), note('a3', 'C4', 0)];
  const B = [note('b1', 'A4', 1), note('b2', 'F4', 1), note('b3', 'C4', 1)];
  const C = [note('c1', 'B4', 2), note('c2', 'G4', 2), note('c3', 'D4', 2)];
  const all = [...A, ...B, ...C];

  test('select-all across a 3-chord progression: every edge maps top→top / mid→mid / bottom→bottom', () => {
    const plan = planChordConnections(all.map(n => n.id), all, PPQ);
    // A → B
    expect(plan.get('a1')).toBe('A4');
    expect(plan.get('a2')).toBe('F4');
    expect(plan.get('a3')).toBe('C4');
    // B → C
    expect(plan.get('b1')).toBe('B4');
    expect(plan.get('b2')).toBe('G4');
    expect(plan.get('b3')).toBe('D4');
    // C has no next chord — unmapped
    expect(plan.has('c1')).toBe(false);
    expect(plan.size).toBe(6);
  });

  test('3-note chord → 2-note chord: bass host unmapped', () => {
    const B2 = [note('b1', 'A4', 1), note('b2', 'F4', 1)];
    const notes = [...A, ...B2];
    const plan = planChordConnections([...A, ...B2].map(n => n.id), notes, PPQ);
    expect(plan.get('a1')).toBe('A4');
    expect(plan.get('a2')).toBe('F4');
    expect(plan.has('a3')).toBe(false); // lowest bass note just doesn't glide
  });

  test('2-note chord → 3-note chord: lowest target not glided into', () => {
    const A2 = [note('a1', 'G4', 0), note('a2', 'E4', 0)];
    const notes = [...A2, ...B];
    const plan = planChordConnections(A2.map(n => n.id), notes, PPQ);
    expect(plan.get('a1')).toBe('A4');
    expect(plan.get('a2')).toBe('F4');
    expect([...plan.values()]).not.toContain('C4'); // b3 untouched
  });

  test('non-adjacent chords (gap) → no mappings', () => {
    const far = [note('b1', 'A4', 1.5), note('b2', 'F4', 1.5)];
    const plan = planChordConnections(A.map(n => n.id), [...A, ...far], PPQ);
    expect(plan.size).toBe(0);
  });

  test('candidates include unselected notes at the target tick', () => {
    // Only chord A selected; chord B unselected — still pairs against B.
    const plan = planChordConnections(A.map(n => n.id), all, PPQ);
    expect(plan.get('a1')).toBe('A4');
    expect(plan.get('a3')).toBe('C4');
    expect(plan.size).toBe(3);
  });

  test('single selected host pairs with the top candidate (documents current behavior)', () => {
    const plan = planChordConnections(['a3'], all, PPQ);
    expect(plan.get('a3')).toBe('A4'); // alone in its group → index 0 ↔ index 0
  });

  test('unknown ids are ignored', () => {
    const plan = planChordConnections(['nope', 'a1'], all, PPQ);
    expect(plan.size).toBe(1);
  });
});

describe('retargetConnectedGlides', () => {
  const PPQ = 192;
  const note = (id, pitch, startBeat, durationBeats, extra = {}) =>
    ({ id, regionId: 'r1', note: pitch, startBeat, durationBeats, velocity: 100, ...extra });
  const glide = (endPitch, connected = true, extra = {}) =>
    ({ glide: { startOffset: 0, endPitch, tension: 0, connected, ...extra } });
  // Immutable "edit": clone every note, apply per-id patches.
  const edit = (notes, patches) =>
    notes.map(n => (patches[n.id] ? { ...n, ...patches[n.id] } : { ...n }));

  test('target moved alone → host endPitch pinned to the new pitch', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { b: { note: 'G4' } });
    const rt = retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ });
    expect(rt.get('a')).toEqual({ startOffset: 0, endPitch: 'G4', tension: 0, connected: true });
    expect(rt.size).toBe(1);
  });

  test('host + target moved together → no entry (endPitch already correct)', () => {
    // Simulates transposeNote: host pitch, host endPitch, and target pitch all shift.
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, {
      a: { note: 'D4', ...glide('F#4') },
      b: { note: 'F#4' },
    });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });

  test('host transposed alone → pin restores the stationary target pitch', () => {
    // transposeNote unconditionally shifts endPitch; the pin snaps it back.
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { a: { note: 'D4', ...glide('F#4') } });
    const rt = retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ });
    expect(rt.get('a').endPitch).toBe('E4');
  });

  test('horizontal move breaking adjacency → glide untouched', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { b: { note: 'G4', startBeat: 2 } });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });

  test('host + target dragged horizontally together → adjacency holds, no entry', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { a: { startBeat: 2 }, b: { startBeat: 3 } });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });

  test('skipHostIds respected (explicit glide edits are never overwritten)', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { b: { note: 'G4' } });
    const rt = retargetConnectedGlides({
      prevNotes: prev, nextNotes: next, PPQ, skipHostIds: new Set(['a']),
    });
    expect(rt.size).toBe(0);
  });

  test('ambiguous prev target (two same-pitch notes at the tick) → no entry', () => {
    const prev = [
      note('a', 'C4', 0, 1, glide('E4')),
      note('b', 'E4', 1, 1),
      note('c', 'E4', 1, 2),
    ];
    const next = edit(prev, { b: { note: 'G4' } });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });

  test('target deleted in next state → no entry', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = [{ ...prev[0] }];
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });

  test('chain A→B→C with B transposed → both edges pinned in one pass', () => {
    const prev = [
      note('a', 'C4', 0, 1, glide('D4')),
      note('b', 'D4', 1, 1, glide('E4')),
      note('c', 'E4', 2, 1),
    ];
    // B transposed via menu: its own pitch AND its endPitch shift; C stays.
    const next = edit(prev, { b: { note: 'F4', ...glide('G4') } });
    const rt = retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ });
    expect(rt.get('a').endPitch).toBe('F4'); // A follows B's new pitch
    expect(rt.get('b').endPitch).toBe('E4'); // B pinned back to stationary C
  });

  test('pin preserves next-state startOffset/tension', () => {
    const prev = [
      note('a', 'C4', 0, 1, glide('E4', true, { startOffset: 0.25, tension: 1.5 })),
      note('b', 'E4', 1, 1),
    ];
    const next = edit(prev, { b: { note: 'G4' } });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).get('a'))
      .toEqual({ startOffset: 0.25, endPitch: 'G4', tension: 1.5, connected: true });
  });

  test('pure: repeated calls on the same inputs are deep-equal (StrictMode)', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4')), note('b', 'E4', 1, 1)];
    const next = edit(prev, { b: { note: 'G4' } });
    const r1 = retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ });
    const r2 = retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ });
    expect([...r1.entries()]).toEqual([...r2.entries()]);
  });

  test('fast bail: no connected glides → empty map', () => {
    const prev = [note('a', 'C4', 0, 1, glide('E4', false)), note('b', 'E4', 1, 1)];
    const next = edit(prev, { b: { note: 'G4' } });
    expect(retargetConnectedGlides({ prevNotes: prev, nextNotes: next, PPQ }).size).toBe(0);
  });
});
