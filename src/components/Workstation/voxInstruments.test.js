/**
 * Vox take instruments (Vox Phase 130) — registry naming / reuse lookup, the
 * .voxdaw def round-trip, and the sample pack → unpack round-trip through the
 * sample store. IndexedDB is hand-mocked at the projectStore boundary (the
 * customSampleStore.test.js pattern).
 */
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `test-${Math.random().toString(36).slice(2)}` };
}

import {
  isVoxInstrument, mintVoxInstrumentId, addVoxInstrument, getVoxInstrument,
  nextVoxPatchName, findVoxInstrumentByPhotoKey, hashRackSnapshot,
  registerVoxInstruments, voxInstrumentsForIds, voxInstrumentList, VOX_FORMAT,
} from './voxInstruments';
import { withVoxSamples, ingestVoxSamples } from './voxSamplePack';
import { serializeProject, deserializeProject } from './projectIO';
import { saveSampleSet, readSampleSetWavs, getSampleStatus, getSampleSet, primeSampleSet } from './customSampleStore';
// eslint-disable-next-line camelcase
import { __records } from '../../utils/projectStore';

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
  global.OfflineAudioContext = class {
    // eslint-disable-next-line no-useless-constructor
    constructor() {}
    decodeAudioData(ab) { return Promise.resolve({ decodedBytes: ab.byteLength }); }
  };
});

const fakeAudioBuffer = (length = 64, fill = 0.25) => ({
  numberOfChannels: 1, sampleRate: 48000, length,
  getChannelData: () => new Float32Array(length).fill(fill),
});

describe('vox instrument registry', () => {
  it('ids are vox:-prefixed and recognised', () => {
    const id = mintVoxInstrumentId();
    expect(id.startsWith('vox:')).toBe(true);
    expect(isVoxInstrument(id)).toBe(true);
    expect(isVoxInstrument('custom:abc')).toBe(false);
    expect(isVoxInstrument('analog')).toBe(false);
  });

  it('names count up past the highest "Vox patch N" in use', () => {
    const first = nextVoxPatchName();
    const n = Number(first.match(/\d+$/)[0]);
    addVoxInstrument({ id: mintVoxInstrumentId(), name: `Vox patch ${n + 4}`, rackHash: 'h-name', createdAt: 1 });
    expect(nextVoxPatchName()).toBe(`Vox patch ${n + 5}`);
  });

  it('rack fingerprint is stable', () => {
    const json = JSON.stringify({ modules: ['vco', 'vcf'], knobs: { cutoff: 0.4 } });
    expect(hashRackSnapshot(json)).toBe(hashRackSnapshot(json));
    expect(hashRackSnapshot(json)).not.toBe(hashRackSnapshot(json.replace('0.4', '0.5')));
    expect(hashRackSnapshot('')).toBeNull();
  });

  it('reuse needs the exact photo (same rack + same input + same voice), newest wins', () => {
    const key = 'h1|3|seq-pitch-out';
    const older = addVoxInstrument({ id: mintVoxInstrumentId(), name: 'A', photoKey: key, createdAt: 100, format: VOX_FORMAT });
    const newer = addVoxInstrument({ id: mintVoxInstrumentId(), name: 'B', photoKey: key, createdAt: 200, format: VOX_FORMAT });
    expect(findVoxInstrumentByPhotoKey(key).id).toBe(newer.id);
    expect(findVoxInstrumentByPhotoKey(key).id).not.toBe(older.id);
    expect(findVoxInstrumentByPhotoKey('h1|4|seq-pitch-out')).toBeNull();   // other input
    expect(findVoxInstrumentByPhotoKey('h1|3|kbd-pitch-out')).toBeNull();   // other voice
    expect(findVoxInstrumentByPhotoKey(null)).toBeNull();
  });

  it('an older-format photograph is never reused', () => {
    const key = 'h-old|1|kbd-pitch-out';
    addVoxInstrument({ id: mintVoxInstrumentId(), name: 'Old', photoKey: key, createdAt: 5e12, format: 2 });
    expect(findVoxInstrumentByPhotoKey(key)).toBeNull();
    const fresh = addVoxInstrument({ id: mintVoxInstrumentId(), name: 'New', photoKey: key, createdAt: 1, format: VOX_FORMAT });
    expect(findVoxInstrumentByPhotoKey(key).id).toBe(fresh.id);
  });

  it('registering a project def never overwrites a library entry, and lists newest first', () => {
    const id = mintVoxInstrumentId();
    addVoxInstrument({ id, name: 'Mine', rackHash: null, createdAt: 5000 });
    registerVoxInstruments([{ id, name: 'Imported rename', createdAt: 5000 }]);
    expect(getVoxInstrument(id).name).toBe('Mine');

    const later = mintVoxInstrumentId();
    registerVoxInstruments([{ id: later, name: 'From a file', createdAt: 9e12 }, { id: 'custom:x', name: 'nope' }]);
    expect(getVoxInstrument(later).name).toBe('From a file');
    expect(getVoxInstrument('custom:x')).toBeNull();
    expect(voxInstrumentList()[0].id).toBe(later);
  });
});

describe('vox instruments in a .voxdaw', () => {
  it('defs round-trip through serialize → deserialize; tracks keep the vox id', () => {
    const id = mintVoxInstrumentId();
    const def = addVoxInstrument({ id, name: 'Vox patch 9', rackHash: 'abc', photoKey: 'abc|5|seq-pitch-out', createdAt: 42, format: 3 });
    const payload = serializeProject({
      bpm: 120, totalMeasures: 32, name: 'p',
      tracks: [{ id: 't1', name: 'Vox take 1', instrument: id, color: '#fff', effects: [] }],
      regions: [], notes: [],
      voxInstruments: voxInstrumentsForIds([id, 'analog']),
    });
    expect(payload.voxInstruments).toEqual([{ id, name: 'Vox patch 9', rackHash: 'abc', photoKey: 'abc|5|seq-pitch-out', createdAt: 42, format: 3 }]);
    expect(payload.voxSamples).toBeUndefined(); // samples never ride the save payload
    const back = deserializeProject(JSON.parse(JSON.stringify(payload)));
    expect(back.tracks[0].instrument).toBe(id);
    expect(back.voxInstruments).toEqual([{ id: def.id, name: 'Vox patch 9', rackHash: 'abc', photoKey: 'abc|5|seq-pitch-out', createdAt: 42, format: 3 }]);
  });

  it('a project with no vox tracks carries no voxInstruments key (byte-identical old saves)', () => {
    const payload = serializeProject({
      bpm: 120, totalMeasures: 32, name: 'p', tracks: [], regions: [], notes: [], voxInstruments: [],
    });
    expect('voxInstruments' in payload).toBe(false);
  });

  it('samples pack into a download and unpack into another machine\'s store', async () => {
    const id = mintVoxInstrumentId();
    await saveSampleSet(id, [
      { midi: 48, buffer: fakeAudioBuffer(64, 0.25), loop: [1.5, 3.7] },
      { midi: 51, buffer: fakeAudioBuffer(80, -0.5) },                    // a decaying note: no loop
    ], { release: 0.7 });
    expect(getSampleSet(id).loops).toEqual({ 48: [1.5, 3.7] });          // seeded cache carries loops
    const original = await readSampleSetWavs(id);

    const payload = { kind: 'voxdaw-project', voxInstruments: [{ id, name: 'Vox patch P' }] };
    const file = JSON.parse(JSON.stringify(await withVoxSamples(payload)));
    expect(file.voxSamples).toHaveLength(1);
    expect(file.voxSamples[0]).toMatchObject({ id, sampleRate: 48000, release: 0.7 });

    // "Another machine": wipe the store, then read the file back in.
    __records.clear();
    const { raw, skipped } = await ingestVoxSamples(file);
    expect(skipped).toBe(0);
    expect('voxSamples' in raw).toBe(false);          // the stored record never holds them
    expect(raw.voxInstruments).toEqual(payload.voxInstruments);
    const restored = await readSampleSetWavs(id);
    expect(restored.meta.release).toBe(0.7);
    const bytes = (set) => Object.fromEntries(set.notes.map(n => [n.midi, [...new Uint8Array(n.wav)]]));
    expect(bytes(restored)).toEqual(bytes(original));  // identical WAV bytes
    expect(getSampleStatus(id)).toBe('ready');         // primed, playable at once
    expect(getSampleSet(id).loops).toEqual({ 48: [1.5, 3.7] }); // loops survive the trip
    expect(file.voxSamples[0].notes.find(n => n.midi === 51).loop).toBeUndefined();
  });

  it('a malformed packed set is skipped, not fatal', async () => {
    const { raw, skipped } = await ingestVoxSamples({
      kind: 'voxdaw-project',
      voxSamples: [{ id: 'vox:broken', notes: 'nope' }, { id: 'custom:wrong', notes: [] }],
    });
    expect(skipped).toBe(2);
    expect('voxSamples' in raw).toBe(false);
  });

  it('a payload without vox instruments passes through untouched', async () => {
    const p = { kind: 'voxdaw-project', tracks: [] };
    expect(await withVoxSamples(p)).toBe(p);
    expect((await ingestVoxSamples(p)).raw).toBe(p);
  });
});

describe('sustain loops in the sample store', () => {
  it('a junk loop on a stored note is dropped at prime, the note still plays', async () => {
    const id = mintVoxInstrumentId();
    __records.set(`${id}|n60`, { wav: new ArrayBuffer(50), midi: 60, loop: [3, 1] });       // reversed
    __records.set(`${id}|n63`, { wav: new ArrayBuffer(50), midi: 63, loop: ['a', 2] });     // not numbers
    __records.set(`${id}|n66`, { wav: new ArrayBuffer(50), midi: 66, loop: [0.5, 2.5] });   // good
    __records.set(`${id}|meta`, { schemaVersion: 1, sampleRate: 48000, release: 0.3 });
    await primeSampleSet(id);
    const set = getSampleSet(id);
    expect(Object.keys(set.urls).sort()).toEqual(['60', '63', '66']);
    expect(set.loops).toEqual({ 66: [0.5, 2.5] });
  });
});
