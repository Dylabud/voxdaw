// Rendered-sample store for custom (AI-generated) instruments — the "sampled
// (CPU friendly)" mode. Persists one WAV per chromatic note per instrument in
// IndexedDB (db `voxdaw`, store `customSamples` — projectStore.js owns the DB
// plumbing, this module owns the record layout) and mirrors decoded sets in an
// in-memory cache that makeSynth can read SYNCHRONOUSLY.
//
// Record layout (all keys are strings; instrument ids are `custom:<uuid>`):
//   `${id}|n${midi}` → { wav: ArrayBuffer, midi }   one 16-bit PCM WAV per note
//   `${id}|meta`     → { schemaVersion, minMidi, maxMidi, sampleRate, release, createdAt }
//
// The meta record is written LAST — its presence is the completeness marker,
// so a cancelled/crashed render leaves invisible partials that the next render
// simply overwrites. One record per note keeps each structured-clone ~3 MB
// (vs one ~200 MB record) and lets deletes use a key range.
//
// Cache values hold NATIVE AudioBuffers: context-free sample data, safe to
// hand to a Tone.Sampler in the live context AND inside Tone.Offline (bounce).
//
// Deliberately Tone-free (Tone's ESM build doesn't parse under CRA jest, and
// customInstruments.test.js reaches this module through deleteCustom) —
// decoding uses a throwaway OfflineAudioContext at the WAV's own sample rate,
// which also means zero resampling on load.

import { sampleStore, req } from '../../utils/projectStore';
import { encodeWavArrayBuffer } from '../../utils/audioExport';

export const SAMPLE_SCHEMA_VERSION = 1;

const noteKey = (id, midi) => `${id}|n${midi}`;
const metaKey = (id) => `${id}|meta`;
// Key range covering every record of one instrument ('|' < '}' in UTF-16).
const idRange = (id) => IDBKeyRange.bound(`${id}|`, `${id}|￿`);

// id → { urls: { <midi>: AudioBuffer }, release }
const cache = new Map();
// id → 'loading' | 'ready' | 'missing'   (absent = 'unknown': never probed)
const status = new Map();
const subscribers = new Set();

function notify() {
  for (const cb of subscribers) {
    try { cb(); } catch { /* subscriber errors must not break the store */ }
  }
}

// ── Sync reads (makeSynth / synthKey / UI state) ───────────────────────────
export function getSampleSet(id) {
  return cache.get(id) ?? null;
}
export function getSampleStatus(id) {
  return status.get(id) ?? 'unknown';
}
export function subscribeSampleSets(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

// ── Async IDB operations ──────────────────────────────────────────────────
export async function hasSampleSet(id) {
  try {
    const s = await sampleStore('readonly');
    return !!(await req(s.get(metaKey(id))));
  } catch {
    return false;
  }
}

// Load + decode a persisted set into the cache. No-throw: any failure (no
// meta record, IDB unavailable, decode error) lands on status 'missing'.
export async function primeSampleSet(id) {
  if (status.get(id) === 'ready' || status.get(id) === 'loading') return;
  status.set(id, 'loading');
  notify();
  try {
    const s = await sampleStore('readonly');
    const [meta, records] = await Promise.all([
      req(s.get(metaKey(id))),
      req(s.getAll(idRange(id))),
    ]);
    if (!meta || meta.schemaVersion !== SAMPLE_SCHEMA_VERSION) throw new Error('no sample set');
    // Decode at the set's own rate — no resample. (AudioBufferSourceNode
    // resamples at playback time if the live context runs at another rate.)
    const ctx = new OfflineAudioContext(1, 1, meta.sampleRate || 44100);
    const urls = {};
    for (const rec of records) {
      if (rec?.midi == null || !rec.wav) continue; // the meta record / junk
      // slice(): decodeAudioData detaches its input in some browsers.
      urls[rec.midi] = await ctx.decodeAudioData(rec.wav.slice(0));
    }
    if (!Object.keys(urls).length) throw new Error('empty sample set');
    cache.set(id, { urls, release: meta.release });
    status.set(id, 'ready');
  } catch {
    cache.delete(id);
    status.set(id, 'missing');
  }
  notify();
}

// Persist a freshly rendered set (notes: [{ midi, buffer: AudioBuffer }]) and
// seed the cache from the same buffers (no decode round-trip). Notes are
// written one transaction each (small clones, main thread yielded between);
// meta goes LAST. On failure (e.g. QuotaExceededError) partial records are
// range-deleted and the error rethrown for the caller's toast.
export async function saveSampleSet(id, notes, { release }) {
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  let sampleRate = 0;
  try {
    for (const { midi, buffer } of notes) {
      const wav = encodeWavArrayBuffer(buffer);
      const s = await sampleStore('readwrite');
      await req(s.put({ wav, midi }, noteKey(id, midi)));
      minMidi = Math.min(minMidi, midi);
      maxMidi = Math.max(maxMidi, midi);
      sampleRate = buffer.sampleRate;
    }
    const s = await sampleStore('readwrite');
    await req(s.put({
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      minMidi, maxMidi, sampleRate, release,
      createdAt: Date.now(),
    }, metaKey(id)));
  } catch (err) {
    try {
      const s = await sampleStore('readwrite');
      await req(s.delete(idRange(id)));
    } catch { /* rollback is best-effort */ }
    throw err;
  }
  const urls = {};
  for (const { midi, buffer } of notes) urls[midi] = buffer;
  cache.set(id, { urls, release });
  status.set(id, 'ready');
  notify();
}

export async function deleteSampleSet(id) {
  cache.delete(id);
  status.set(id, 'missing');
  notify();
  try {
    const s = await sampleStore('readwrite');
    await req(s.delete(idRange(id)));
  } catch { /* orphan cleanup is best-effort */ }
}
