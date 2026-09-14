/**
 * customSampleStore — WAV round-trip, record ordering (meta LAST), status
 * transitions, and prime/decode. IndexedDB is hand-mocked at the projectStore
 * boundary (jsdom ships no IDB); OfflineAudioContext is stubbed for decode.
 */
import {
  getSampleSet, getSampleStatus, subscribeSampleSets,
  primeSampleSet, hasSampleSet, saveSampleSet, deleteSampleSet,
  SAMPLE_SCHEMA_VERSION,
} from './customSampleStore';
import { encodeWavArrayBuffer } from '../../utils/audioExport';
// eslint-disable-next-line camelcase
import { __records, __putLog } from '../../utils/projectStore';

jest.mock('../../utils/projectStore', () => {
  const records = new Map(); // key → value
  const putLog = [];         // key insertion order across all puts
  const inRange = (key, range) => key >= range.lower && key <= range.upper;
  return {
    __records: records,
    __putLog: putLog,
    req: (v) => Promise.resolve(v),
    sampleStore: async () => ({
      get: (key) => records.get(key),
      getAll: (range) => [...records.entries()].filter(([k]) => inRange(k, range)).map(([, v]) => v),
      put: (value, key) => { records.set(key, value); putLog.push(key); return key; },
      delete: (range) => {
        for (const k of [...records.keys()]) if (inRange(k, range)) records.delete(k);
      },
    }),
  };
});

beforeAll(() => {
  global.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  global.OfflineAudioContext = class {
    // eslint-disable-next-line no-useless-constructor
    constructor() {}
    decodeAudioData(ab) { return Promise.resolve({ decodedBytes: ab.byteLength }); }
  };
});

const fakeAudioBuffer = (length = 100, sampleRate = 44100, fill = 0.5) => ({
  numberOfChannels: 2,
  sampleRate,
  length,
  getChannelData: () => new Float32Array(length).fill(fill),
});

describe('encodeWavArrayBuffer', () => {
  it('writes a valid 16-bit PCM RIFF header and all samples', () => {
    const buf = encodeWavArrayBuffer(fakeAudioBuffer(100, 44100));
    expect(buf.byteLength).toBe(44 + 100 * 2 * 2); // header + samples×ch×2B
    const v = new DataView(buf);
    const str = (off, n) => String.fromCharCode(...new Uint8Array(buf, off, n));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(2);        // channels
    expect(v.getUint32(24, true)).toBe(44100);    // sample rate
    expect(v.getUint16(34, true)).toBe(16);       // bits per sample
    expect(v.getUint32(40, true)).toBe(400);      // data chunk length
    expect(v.getInt16(44, true)).toBe(16383);     // 0.5 → 0.5×0x7FFF truncated
  });
});

describe('customSampleStore', () => {
  it('saveSampleSet writes note records first and meta LAST, then reads back sync', async () => {
    const id = 'custom:save-test';
    await saveSampleSet(id, [
      { midi: 60, buffer: fakeAudioBuffer() },
      { midi: 63, buffer: fakeAudioBuffer() },
    ], { release: 0.4 });

    const keys = __putLog.filter(k => k.startsWith(`${id}|`));
    expect(keys[keys.length - 1]).toBe(`${id}|meta`); // completeness marker last
    expect(keys.slice(0, -1)).toEqual([`${id}|n60`, `${id}|n63`]);
    expect(__records.get(`${id}|meta`)).toMatchObject({
      schemaVersion: SAMPLE_SCHEMA_VERSION, minMidi: 60, maxMidi: 63, release: 0.4,
    });
    // Cache seeded from the same buffers — no decode round-trip.
    expect(getSampleStatus(id)).toBe('ready');
    expect(Object.keys(getSampleSet(id).urls)).toEqual(['60', '63']);
    expect(getSampleSet(id).release).toBe(0.4);
    await expect(hasSampleSet(id)).resolves.toBe(true);
  });

  it('deleteSampleSet range-deletes records and drops the cache', async () => {
    const id = 'custom:delete-test';
    await saveSampleSet(id, [{ midi: 60, buffer: fakeAudioBuffer() }], { release: 1 });
    expect(getSampleStatus(id)).toBe('ready');

    await deleteSampleSet(id);
    expect(getSampleStatus(id)).toBe('missing');
    expect(getSampleSet(id)).toBeNull();
    expect([...__records.keys()].some(k => k.startsWith(`${id}|`))).toBe(false);
    await expect(hasSampleSet(id)).resolves.toBe(false);
  });

  it('primeSampleSet decodes a persisted set into the cache', async () => {
    const id = 'custom:prime-test';
    __records.set(`${id}|n60`, { wav: new ArrayBuffer(64), midi: 60 });
    __records.set(`${id}|meta`, {
      schemaVersion: SAMPLE_SCHEMA_VERSION, minMidi: 60, maxMidi: 60,
      sampleRate: 44100, release: 0.7, createdAt: 1,
    });
    await primeSampleSet(id);
    expect(getSampleStatus(id)).toBe('ready');
    expect(getSampleSet(id).urls[60]).toEqual({ decodedBytes: 64 });
    expect(getSampleSet(id).release).toBe(0.7);
  });

  it('primeSampleSet without a meta record (partial/absent render) → missing', async () => {
    const id = 'custom:no-meta';
    __records.set(`${id}|n60`, { wav: new ArrayBuffer(8), midi: 60 }); // orphan note
    await primeSampleSet(id);
    expect(getSampleStatus(id)).toBe('missing');
    expect(getSampleSet(id)).toBeNull();
  });

  it('notifies subscribers on every status change', async () => {
    const id = 'custom:notify-test';
    const seen = [];
    const unsub = subscribeSampleSets(() => seen.push(getSampleStatus(id)));
    await saveSampleSet(id, [{ midi: 60, buffer: fakeAudioBuffer() }], { release: 1 });
    await deleteSampleSet(id);
    unsub();
    expect(seen).toContain('ready');
    expect(seen[seen.length - 1]).toBe('missing');
  });
});
