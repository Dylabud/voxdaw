import { computePeaks } from './audioExport';

// computePeaks is duck-typed (jsdom has no AudioBuffer) — a plain stub works.
function makeBuffer(channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (ch) => channels[ch],
  };
}

describe('computePeaks', () => {
  it('honors the requested bucket count', () => {
    const buf = makeBuffer([new Float32Array(44100)]);
    expect(computePeaks(buf, 200)).toHaveLength(200);
    expect(computePeaks(buf, 50)).toHaveLength(50);
  });

  it('takes the max absolute value across all channels per bucket', () => {
    const left  = Float32Array.from([0.1, -0.8, 0.0, 0.2]);
    const right = Float32Array.from([0.3,  0.1, -0.5, 0.0]);
    const peaks = computePeaks(makeBuffer([left, right]), 2);
    expect(peaks[0]).toBeCloseTo(0.8); // |−0.8| beats 0.3
    expect(peaks[1]).toBeCloseTo(0.5); // |−0.5| beats 0.2
  });

  it('clamps buckets to the sample count for very short buffers', () => {
    const peaks = computePeaks(makeBuffer([Float32Array.from([0.4, 0.6])]), 200);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(0.4);
    expect(peaks[1]).toBeCloseTo(0.6);
  });

  it('returns all zeros for silence', () => {
    const peaks = computePeaks(makeBuffer([new Float32Array(1000)]), 10);
    expect(peaks.every(p => p === 0)).toBe(true);
  });
});
