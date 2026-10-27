// Rendered-sample store for custom (AI-generated) instruments — the "sampled
// (CPU friendly)" mode. Persists one WAV per chromatic note per instrument in
// IndexedDB (db `voxdaw`, store `customSamples` — projectStore.js owns the DB
// plumbing, this module owns the record layout) and mirrors decoded sets in an
// in-memory cache that makeSynth can read SYNCHRONOUSLY.
//
// Record layout (all keys are strings; instrument ids are `custom:<uuid>`):
//   `${id}|n${midi}` → { wav: ArrayBuffer, midi, loop? }   one 16-bit PCM WAV per note
//                       loop = [startSec, endSec] sustain loop (vox takes, Phase 131)
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

// id → { urls: { <midi>: AudioBuffer }, release, loops: { <midi>: [startSec, endSec] } }
const cache = new Map();
// id → 'loading' | 'ready' | 'missing'   (absent = 'unknown': never probed)
const status = new Map();
const subscribers = new Set();

// A stored loop is trusted only as two ordered, non-negative numbers.
export const cleanLoop = (lp) =>
  (Array.isArray(lp) && lp.length === 2 && lp.every(Number.isFinite) && lp[0] >= 0 && lp[1] > lp[0])
    ? [lp[0], lp[1]] : null;

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
    const loops = {};
    for (const rec of records) {
      if (rec?.midi == null || !rec.wav) continue; // the meta record / junk
      // slice(): decodeAudioData detaches its input in some browsers.
      urls[rec.midi] = await ctx.decodeAudioData(rec.wav.slice(0));
      const lp = cleanLoop(rec.loop);
      if (lp) loops[rec.midi] = lp;
    }
    if (!Object.keys(urls).length) throw new Error('empty sample set');
    cache.set(id, { urls, release: meta.release, loops });
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
    for (const { midi, buffer, loop } of notes) {
      const wav = encodeWavArrayBuffer(buffer);
      const lp = cleanLoop(loop);
      const s = await sampleStore('readwrite');
      await req(s.put({ wav, midi, ...(lp ? { loop: lp } : {}) }, noteKey(id, midi)));
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
  const loops = {};
  for (const { midi, buffer, loop } of notes) {
    urls[midi] = buffer;
    const lp = cleanLoop(loop);
    if (lp) loops[midi] = lp;
  }
  cache.set(id, { urls, release, loops });
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

// ── Raw WAV transfer (Vox Phase 130 — .voxdaw packing) ─────────────────────
// Read a complete persisted set as its stored WAVs (no decode), or null when
// the set is absent/incomplete. Used to embed vox take instruments in a
// downloaded .voxdaw.
export async function readSampleSetWavs(id) {
  try {
    const s = await sampleStore('readonly');
    const [meta, records] = await Promise.all([
      req(s.get(metaKey(id))),
      req(s.getAll(idRange(id))),
    ]);
    if (!meta || meta.schemaVersion !== SAMPLE_SCHEMA_VERSION) return null;
    const notes = records
      .filter((r) => r?.midi != null && r.wav)
      .map((r) => ({ midi: r.midi, wav: r.wav, ...(cleanLoop(r.loop) ? { loop: cleanLoop(r.loop) } : {}) }));
    return notes.length ? { meta, notes } : null;
  } catch {
    return null;
  }
}

// Write a set from raw WAVs (notes: [{ midi, wav: ArrayBuffer, loop? }]) — the
// .voxdaw unpack path. Same completeness contract as saveSampleSet (notes
// first, meta LAST, range-delete on failure), then re-primes the cache from
// IDB so the decoded buffers are what every later reader sees.
export async function writeSampleSetWavs(id, { sampleRate, release }, notes) {
  try {
    for (const { midi, wav, loop } of notes) {
      const lp = cleanLoop(loop);
      const s = await sampleStore('readwrite');
      await req(s.put({ wav, midi, ...(lp ? { loop: lp } : {}) }, noteKey(id, midi)));
    }
    const midis = notes.map((n) => n.midi);
    const s = await sampleStore('readwrite');
    await req(s.put({
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      minMidi: Math.min(...midis), maxMidi: Math.max(...midis),
      sampleRate, release, createdAt: Date.now(),
    }, metaKey(id)));
  } catch (err) {
    try {
      const s = await sampleStore('readwrite');
      await req(s.delete(idRange(id)));
    } catch { /* rollback is best-effort */ }
    throw err;
  }
  cache.delete(id);
  status.delete(id);
  await primeSampleSet(id);
}
