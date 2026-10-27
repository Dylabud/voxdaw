/**
 * Vox audio takes (Vox Phase 134) — region window math, the playback plan, and
 * the live-capture accumulator.
 */
import {
  audioRegionSegments, audioRegionPlan, ClipAccumulator, computePeaks, matchToOutput, monoSum,
  isAudioRegion, isClipId, mintClipId,
} from './audioClipMath';
import { buildTempoMap } from './tempoMath';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `test-${Math.random().toString(36).slice(2)}` };
}

const map120 = buildTempoMap(120, []);          // 2 s per measure
const region = (over = {}) => ({
  id: 'r1', trackId: 't1', startMeasure: 4, durationMeasures: 3, clipOffset: 0,
  loopInterval: null, loopPhase: 0, audio: { clipId: 'voxclip:a', secPerMeasure: 2 }, ...over,
});
const close = (a, b) => expect(a).toBeCloseTo(b, 6);

describe('audio region window', () => {
  it('ids and region detection', () => {
    expect(isClipId(mintClipId())).toBe(true);
    expect(isClipId('vox:abc')).toBe(false);
    expect(isAudioRegion(region())).toBe(true);
    expect(isAudioRegion({ id: 'r' })).toBe(false);
  });

  it('a plain region plays its clip from the window start', () => {
    expect(audioRegionSegments(region({ clipOffset: 1 }))).toEqual([{ x0: 0, x1: 3, b0: 1 }]);
    const [seg] = audioRegionPlan(region({ clipOffset: 1 }), map120, 60);
    close(seg.startSec, 8); close(seg.endSec, 14); close(seg.offsetSec, 2);
  });

  it('a split keeps both halves on the same audio', () => {
    // A region at bar 4 split at bar 5.5: the right half starts 1.5 bars in.
    const left  = audioRegionPlan(region({ durationMeasures: 1.5 }), map120, 60)[0];
    const right = audioRegionPlan(region({ startMeasure: 5.5, durationMeasures: 1.5, clipOffset: 1.5 }), map120, 60)[0];
    close(left.endSec, right.startSec);
    close(right.offsetSec, left.offsetSec + (left.endSec - left.startSec));
  });

  it('a looped region repeats its window, honouring the phase', () => {
    const segs = audioRegionSegments(region({ durationMeasures: 5, loopInterval: 2, loopPhase: 0.5 }));
    expect(segs).toEqual([
      { x0: 0, x1: 1.5, b0: 0.5 },
      { x0: 1.5, x1: 3.5, b0: 0 },
      { x0: 3.5, x1: 5, b0: 0 },
    ]);
  });

  it('clips past the end of the recording and before its start', () => {
    // Window slid 1 bar before the clip (left edge dragged out): first 2 s silent.
    const [early] = audioRegionPlan(region({ clipOffset: -1 }), map120, 60);
    close(early.startSec, 10); close(early.offsetSec, 0);
    // A 3 s clip in a 6 s region: plays 3 s.
    const [short] = audioRegionPlan(region(), map120, 3);
    close(short.endSec - short.startSec, 3);
    // A window entirely past the clip plays nothing.
    expect(audioRegionPlan(region({ clipOffset: 10 }), map120, 3)).toEqual([]);
  });

  it('a muted region plays nothing', () => {
    expect(audioRegionPlan(region({ isMuted: true }), map120, 60)).toEqual([]);
  });

  it('tempo changes move the audio with its bar but never stretch it', () => {
    const map60 = buildTempoMap(60, []);          // 4 s per measure now
    const [seg] = audioRegionPlan(region(), map60, 60);
    close(seg.startSec, 16);                       // bar 4 at the new tempo
    close(seg.offsetSec, 0);
    close(seg.endSec - seg.startSec, 12);          // 3 bars of real time, unstretched
  });
});

describe('ClipAccumulator', () => {
  const chunk = (start, n, inputs) => ({ start, n, chans: inputs });
  const filled = (n, v) => new Float32Array(n).fill(v);

  it('keeps only played inputs, from the start frame, and folds mono', () => {
    const acc = new ClipAccumulator(3, 100);
    acc.push(chunk(0, 128, [[filled(128, 0.5), filled(128, 0.5)], [filled(128, 0), filled(128, 0)], [filled(128, 0.2), filled(128, -0.2)]]));
    acc.push(chunk(128, 128, [[filled(128, 0.5), filled(128, 0.5)], [filled(128, 0), filled(128, 0)], [filled(128, 0.2), filled(128, -0.2)]]));
    const out = acc.finish(200);
    expect([...out.keys()]).toEqual([0, 2]);          // input 1 was silent: no track
    expect(out.get(0).channels).toHaveLength(1);       // L === R → mono
    expect(out.get(0).channels[0]).toHaveLength(100);  // frames 100..199
    expect(out.get(2).channels).toHaveLength(2);       // a real stereo input stays stereo
    close(out.get(2).channels[1][5], -0.2);
  });

  it('a silent stretch costs nothing and plays back as silence in place', () => {
    const acc = new ClipAccumulator(1, 0);
    acc.push(chunk(0, 4, [[filled(4, 0.3), null]]));
    acc.push(chunk(4, 4, [[filled(4, 0), null]]));
    acc.push(chunk(8, 4, [[filled(4, 0.3), null]]));
    expect(acc.chunks[0]).toHaveLength(2);
    const [L] = acc.finish(12).get(0).channels;
    expect([...L]).toEqual([0.3, 0.3, 0.3, 0.3, 0, 0, 0, 0, 0.3, 0.3, 0.3, 0.3].map(Math.fround));
  });

  it('applies the MASTER knob as a ramp from chunk to chunk', () => {
    const acc = new ClipAccumulator(1, 0);
    acc.push(chunk(0, 4, [[filled(4, 1), null]]), 1);
    acc.push(chunk(4, 4, [[filled(4, 1), null]]), 0.5);
    const [L] = acc.finish(8).get(0).channels;
    close(L[3], 1);
    close(L[4], 0.875);   // ramping down…
    close(L[7], 0.5);     // …to the new level by the chunk's end
    expect(L[5]).toBeLessThan(L[4]);
  });

  it('peaks overview', () => {
    const p = computePeaks([Float32Array.from([0.1, -0.9, 0.2, 0.3])], 100, 0.02);
    expect([...p].map(v => +v.toFixed(2))).toEqual([0.9, 0.3]);
  });
});

describe('matching per-input tracks to the rack output (Phase 134b)', () => {
  const SR = 8000;
  // A busy, non-periodic test signal (two detuned partials + a slow swell).
  const sig = (i) => 0.4 * Math.sin(i * 0.031) * Math.sin(i * 0.0017) + 0.2 * Math.sin(i * 0.173 + 1);

  it('finds the limiter look-ahead delay and its make-up gain', () => {
    const n = 3 * SR;
    const sum = Float32Array.from({ length: n }, (_, i) => sig(i));
    const lag = 48;                                   // 6 ms at 8 kHz
    const out = Float32Array.from({ length: n }, (_, i) => (i >= lag ? sig(i - lag) * 1.068 : 0));
    const m = matchToOutput(sum, out, SR);
    expect(m.lag).toBe(lag);
    expect(m.gain).toBeCloseTo(1.068, 3);
    expect(m.limited).toBe(false);
  });

  it('flags a take whose inputs added up past the limiter', () => {
    const sum = Float32Array.from({ length: 2 * SR }, (_, i) => 2 * sig(i));
    expect(matchToOutput(sum, sum, SR).limited).toBe(true);
  });

  it('silence leaves the tracks alone', () => {
    const z = new Float32Array(2 * SR);
    expect(matchToOutput(z, z, SR)).toEqual({ lag: 0, gain: 1, limited: false });
  });

  it('monoSum folds stereo and adds inputs', () => {
    const a = { channels: [Float32Array.from([1, 1]), Float32Array.from([0, 1])] };
    const b = { channels: [Float32Array.from([0.5, 0])] };
    expect([...monoSum([a, b], 2)]).toEqual([1, 1]);
  });

  it('a stereo input stays stereo end to end (L ≠ R survives the accumulator)', () => {
    const acc = new ClipAccumulator(1, 0);
    const L = Float32Array.from({ length: 8 }, (_, i) => Math.sin(i));
    const R = Float32Array.from({ length: 8 }, (_, i) => -Math.sin(i));
    acc.push({ start: 0, n: 8, chans: [[L, R]] });
    const [cl, cr] = acc.finish(8).get(0).channels;
    expect(cr).toBeDefined();
    expect(cl[3]).toBeCloseTo(-cr[3], 6);
  });

  it('per-input master gain: the output tap is never scaled twice', () => {
    const acc = new ClipAccumulator(2, 0);
    const one = () => new Float32Array(4).fill(0.5);
    acc.push({ start: 0, n: 4, chans: [[one(), one()], [one(), one()]] }, [0.5, 1]);
    const out = acc.finish(4);
    expect(out.get(0).channels[0][3]).toBeCloseTo(0.25, 6);
    expect(out.get(1).channels[0][3]).toBeCloseTo(0.5, 6);
  });
});
