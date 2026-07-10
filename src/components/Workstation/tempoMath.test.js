import { buildTempoMap, tempoScheduleOps, TEMPO_META, TEMPO_STEP_EPS } from './tempoMath';

// value normalization helper: bpm → 0..1 against TEMPO_META (linear)
const n = (bpm) => (bpm - TEMPO_META.min) / (TEMPO_META.max - TEMPO_META.min);

describe('buildTempoMap', () => {
  test('empty points → constant-bpm identity map', () => {
    const map = buildTempoMap(120, []);
    expect(map.anchors).toHaveLength(0);
    expect(map.bpmAtMeasure(7)).toBe(120);
    expect(map.secondsAtMeasure(1)).toBeCloseTo(2, 10);     // 4 beats @ 120 = 2s
    expect(map.secondsAtMeasure(10)).toBeCloseTo(20, 10);
    expect(map.measureAtSeconds(20)).toBeCloseTo(10, 10);
  });

  test('single point → flat line at that bpm everywhere', () => {
    const map = buildTempoMap(120, [{ time: 4, value: n(60) }]);
    expect(map.bpmAtMeasure(0)).toBeCloseTo(60, 10);
    expect(map.bpmAtMeasure(100)).toBeCloseTo(60, 10);
    expect(map.secondsAtMeasure(1)).toBeCloseTo(4, 10);     // 240/60
    expect(map.measureAtSeconds(8)).toBeCloseTo(2, 10);
  });

  test('hold-before-first, ramp-between, hold-after-last', () => {
    const map = buildTempoMap(999, [
      { time: 4, value: n(120) },
      { time: 8, value: n(240) },
    ]);
    // hold 120 over measures 0–4: 4 * 240/120 = 8s
    expect(map.secondsAtMeasure(4)).toBeCloseTo(8, 10);
    // ramp 120→240 over 4 measures: trapezoid Δt = 240*4/180
    const rampDt = (240 * 4) / 180;
    expect(map.secondsAtMeasure(8)).toBeCloseTo(8 + rampDt, 10);
    // hold 240 after: one more measure = 1s
    expect(map.secondsAtMeasure(9)).toBeCloseTo(8 + rampDt + 1, 10);
    expect(map.bpmAtMeasure(2)).toBeCloseTo(120, 10);
    expect(map.bpmAtMeasure(8)).toBeCloseTo(240, 10);
    expect(map.bpmAtMeasure(20)).toBeCloseTo(240, 10);
    // base bpm (999) is irrelevant once points exist
    expect(map.bpmAtMeasure(0)).toBeCloseTo(120, 10);
  });

  test('mid-ramp bpm follows b² closed form (linear-in-seconds ramp)', () => {
    const map = buildTempoMap(120, [
      { time: 0, value: n(120) },
      { time: 8, value: n(240) },
    ]);
    // b(m)² = b0² + (b1²−b0²)·(m−m0)/Δm at m=4
    const expected = Math.sqrt(120 * 120 + (240 * 240 - 120 * 120) * 0.5);
    expect(map.bpmAtMeasure(4)).toBeCloseTo(expected, 8);
    // NOT the linear-in-measures midpoint (180)
    expect(map.bpmAtMeasure(4)).toBeGreaterThan(180);
  });

  test('secondsAtMeasure and measureAtSeconds are exact inverses', () => {
    const map = buildTempoMap(120, [
      { time: 2, value: n(90) },
      { time: 6, value: n(200) },
      { time: 10, value: n(140) },
    ]);
    for (const m of [0, 0.5, 2, 3.7, 6, 8.21, 10, 15]) {
      expect(map.measureAtSeconds(map.secondsAtMeasure(m))).toBeCloseTo(m, 8);
    }
  });

  test('trapezoid matches TickSignal integration: ticks(Δt) = avg-bpm rate', () => {
    // Tone integrates a linear bpm ramp as ticks += PPQ/60 · (b0+b1)/2 · Δt.
    // Our anchor spacing must satisfy exactly that with Δticks = Δm·4·PPQ.
    const map = buildTempoMap(120, [
      { time: 0, value: n(60) },
      { time: 5, value: n(180) },
    ]);
    const [a0, a1] = [map.anchors[0], map.anchors[1]];
    const dt = a1.seconds - a0.seconds;
    const beatsIntegrated = ((a0.bpm + a1.bpm) / 2 / 60) * dt; // beats, PPQ cancels
    expect(beatsIntegrated).toBeCloseTo(5 * 4, 10);
  });

  test('coincident points form a step; later value wins at the boundary', () => {
    const map = buildTempoMap(120, [
      { time: 4, value: n(100) },
      { time: 4, value: n(200) },
      { time: 8, value: n(200) },
    ]);
    const s4 = map.secondsAtMeasure(4);
    expect(s4).toBeCloseTo(4 * (240 / 100), 10);       // held 100 before the step
    expect(map.bpmAtMeasure(4)).toBeCloseTo(200, 10);   // post-step value
    expect(map.secondsAtMeasure(8)).toBeCloseTo(s4 + 4 * (240 / 200), 10);
  });

  test('unsorted input tolerated', () => {
    const a = buildTempoMap(120, [{ time: 8, value: n(240) }, { time: 4, value: n(120) }]);
    const b = buildTempoMap(120, [{ time: 4, value: n(120) }, { time: 8, value: n(240) }]);
    expect(a.secondsAtMeasure(10)).toBeCloseTo(b.secondsAtMeasure(10), 10);
  });
});

describe('tempoScheduleOps', () => {
  // The load-bearing invariant: two differing-value events at one timestamp
  // corrupt Tone's TickParam tick↔time inversion (see TEMPO_STEP_EPS).
  const expectStrictlyIncreasing = (ops) => {
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].time).toBeGreaterThan(ops[i - 1].time);
    }
  };

  test('empty map → single re-anchor set at baseTime + eps', () => {
    const map = buildTempoMap(120, []);
    const ops = tempoScheduleOps(map, 0, 10);
    expect(ops).toEqual([{ kind: 'set', bpm: 120, time: 10 + TEMPO_STEP_EPS }]);
  });

  test('stacked points: ramp to the FIRST value at its true time, step to the second eps later', () => {
    const map = buildTempoMap(120, [
      { time: 0, value: n(120) },
      { time: 8, value: n(200) },  // ramp into the stack (the crash repro shape)
      { time: 8, value: n(60) },   // stacked twin — big downward step
    ]);
    const ops = tempoScheduleOps(map, 0, 0);
    expectStrictlyIncreasing(ops);
    const s8 = map.secondsAtMeasure(8);
    const ramp = ops.find(o => o.kind === 'ramp' && Math.abs(o.bpm - 200) < 1e-9);
    const step = ops.find(o => o.kind === 'set' && Math.abs(o.bpm - 60) < 1e-9);
    expect(ramp.time).toBeCloseTo(s8, 10);                  // follows the drawn line
    expect(step.time).toBeCloseTo(s8 + TEMPO_STEP_EPS, 10); // jump, never same-time
  });

  test('triple stack chains eps steps — times stay strictly increasing', () => {
    const map = buildTempoMap(120, [
      { time: 4, value: n(100) },
      { time: 4, value: n(180) },
      { time: 4, value: n(60) },
      { time: 8, value: n(60) },
    ]);
    const ops = tempoScheduleOps(map, 0, 5);
    expectStrictlyIncreasing(ops);
    const times = ops.map(o => o.time);
    expect(new Set(times).size).toBe(times.length); // no duplicates anywhere
  });

  test('mid-playback: only future anchors emitted, offsets measured from baseTime', () => {
    const map = buildTempoMap(120, [
      { time: 2, value: n(100) },
      { time: 6, value: n(200) },
    ]);
    const nowM = 4; // inside the 2→6 ramp
    const ops = tempoScheduleOps(map, nowM, 100);
    expectStrictlyIncreasing(ops);
    expect(ops[0]).toEqual({ kind: 'set', bpm: map.bpmAtMeasure(nowM), time: 100 + TEMPO_STEP_EPS });
    expect(ops).toHaveLength(2); // re-anchor + the m=6 anchor only
    expect(ops[1].kind).toBe('ramp');
    expect(ops[1].bpm).toBeCloseTo(200, 10);
    expect(ops[1].time).toBeCloseTo(100 + (map.secondsAtMeasure(6) - map.secondsAtMeasure(nowM)), 10);
  });
});
