import { buildTempoMap, TEMPO_META } from './tempoMath';

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
