/**
 * Vox audio take clips (Vox Phase 134) — the IndexedDB round-trip (segments,
 * meta last), the .voxdaw pack → unpack round-trip, and the region field
 * through serialize/deserialize. IndexedDB is hand-mocked at the projectStore
 * boundary (the customSampleStore.test.js pattern).
 */
import {
  saveClip, primeClip, getClip, getClipStatus, encodeWav, decodeWav, SEGMENT_SEC,
} from './voxClipStore';
import { mintClipId } from './audioClipMath';
import { withVoxSamples, ingestVoxSamples } from './voxSamplePack';
import { serializeProject, deserializeProject } from './projectIO';
// eslint-disable-next-line camelcase
import { __records } from '../../utils/projectStore';

if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `test-${Math.random().toString(36).slice(2)}` };
}

jest.mock('../../utils/projectStore', () => {
  const records = new Map();
  const inRange = (key, range) => key >= range.lower && key <= range.upper;
  return {
    __records: records,
    req: (v) => Promise.resolve(v),
    sampleStore: async () => ({
      get: (key) => records.get(key),
      getAll: (range) => [...records.entries()].filter(([k]) => inRange(k, range)).map(([, v]) => v),
      put: (value, key) => { records.set(key, value); return key; },
      delete: (range) => {
        for (const k of [...records.keys()]) if (inRange(k, range)) records.delete(k);
      },
    }),
  };
});

beforeAll(() => {
  global.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  global.AudioBuffer = class {
    constructor({ numberOfChannels, length, sampleRate }) {
      this.numberOfChannels = numberOfChannels;
      this.length = length;
      this.sampleRate = sampleRate;
      this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    copyToChannel(src, ch) { this.data[ch].set(src); }
    getChannelData(ch) { return this.data[ch]; }
  };
});

const SR = 100; // tiny rate: a 70 s clip = 7000 frames, three 30 s segments
const ramp = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i));

describe('voxClipStore', () => {
  it('WAV encode/decode round-trips within 16-bit precision', () => {
    const L = ramp(50, i => Math.sin(i / 3) * 0.8);
    const R = ramp(50, i => -L[i]);
    const back = decodeWav(encodeWav([L, R], 44100));
    expect(back.sampleRate).toBe(44100);
    expect(back.channels).toHaveLength(2);
    back.channels[0].forEach((v, i) => expect(Math.abs(v - L[i])).toBeLessThan(1 / 16000));
  });

  it('a long take is stored in segments and loads back whole', async () => {
    const id = mintClipId();
    const L = ramp(7000, i => ((i % 200) - 100) / 200);
    await saveClip(id, [L], SR);
    expect(getClipStatus(id)).toBe('ready');                 // playable at once
    const segs = [...__records.keys()].filter(k => k.startsWith(`${id}|s`));
    expect(segs).toHaveLength(Math.ceil(7000 / (SEGMENT_SEC * SR)));
    expect(__records.get(`${id}|meta`)).toMatchObject({ length: 7000, channels: 1, segments: 3 });

    // "After a reload": drop the cache entry by re-importing the module state is
    // not possible, so load a copy under another id from the same records.
    const id2 = mintClipId();
    for (const [k, v] of [...__records.entries()]) if (k.startsWith(`${id}|`)) __records.set(k.replace(id, id2), v);
    await primeClip(id2);
    const clip = getClip(id2);
    expect(clip.durationSec).toBeCloseTo(70, 6);
    const data = clip.buffer.getChannelData(0);
    expect(data).toHaveLength(7000);
    expect(Math.abs(data[6543] - L[6543])).toBeLessThan(1e-4);
    expect(clip.peaks.length).toBeGreaterThan(0);
  });

  it('an incomplete clip (no meta) is missing, not broken', async () => {
    const id = mintClipId();
    __records.set(`${id}|s0`, { wav: encodeWav([ramp(10, () => 0.1)], SR), seg: 0 });
    await primeClip(id);
    expect(getClipStatus(id)).toBe('missing');
    expect(getClip(id)).toBeNull();
  });
});

describe('audio regions in a .voxdaw', () => {
  it('the region keeps its clip through serialize → deserialize', () => {
    const payload = serializeProject({
      bpm: 120, totalMeasures: 32, name: 'p',
      tracks: [{ id: 't1', name: 'Vox audio 1', instrument: 'audio', color: '#fff', effects: [] }],
      regions: [
        { id: 'r1', trackId: 't1', startMeasure: 2, durationMeasures: 3.25, audio: { clipId: 'voxclip:x', secPerMeasure: 2 } },
        { id: 'r2', trackId: 't1', startMeasure: 9, durationMeasures: 1 },
      ],
      notes: [],
    });
    expect(payload.regions[0].audio).toEqual({ clipId: 'voxclip:x', secPerMeasure: 2 });
    expect('audio' in payload.regions[1]).toBe(false);   // note regions unchanged
    const back = deserializeProject(JSON.parse(JSON.stringify(payload)));
    expect(back.regions[0].audio).toEqual({ clipId: 'voxclip:x', secPerMeasure: 2 });
    expect(back.tracks[0].instrument).toBe('audio');
    // A junk audio field is dropped (the region loads as an empty region).
    const junk = deserializeProject({ ...payload, regions: [{ ...payload.regions[0], audio: { clipId: 'vox:nope', secPerMeasure: 2 } }] });
    expect('audio' in junk.regions[0]).toBe(false);
  });

  it('the recording packs into a download and unpacks on another machine', async () => {
    const id = mintClipId();
    const L = ramp(4000, i => Math.sin(i / 7) * 0.5);
    const R = ramp(4000, i => Math.cos(i / 7) * 0.5);
    await saveClip(id, [L, R], SR);
    const payload = { kind: 'voxdaw-project', regions: [{ id: 'r1', audio: { clipId: id, secPerMeasure: 2 } }] };
    const file = JSON.parse(JSON.stringify(await withVoxSamples(payload)));
    expect(file.voxClips).toHaveLength(1);
    expect(file.voxClips[0]).toMatchObject({ id, sampleRate: SR, channels: 2, length: 4000 });

    __records.clear();                                   // "another machine"
    const { raw, skipped } = await ingestVoxSamples(file);
    expect(skipped).toBe(0);
    expect('voxClips' in raw).toBe(false);
    expect(__records.get(`${id}|meta`)).toMatchObject({ length: 4000, channels: 2 });
  });

  it('a malformed packed clip is skipped, not fatal', async () => {
    const { raw, skipped } = await ingestVoxSamples({
      kind: 'voxdaw-project',
      voxClips: [{ id: 'voxclip:bad', segments: [], length: 5 }, { id: 'nope', segments: ['AAAA'], length: 1 }],
    });
    expect(skipped).toBe(2);
    expect('voxClips' in raw).toBe(false);
  });
});
