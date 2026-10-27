// Recorded audio clips (Vox Phase 134 — audio takes of the Vox Modular).
//
// Same IndexedDB store as the sampled instruments (db `voxdaw`, store
// `customSamples`; projectStore.js owns the plumbing) under their own ids:
//   `${id}|s${i}` → { wav: ArrayBuffer, seg: i }   16-bit PCM WAV, ≤ SEGMENT_SEC each
//   `${id}|meta`  → { schemaVersion, sampleRate, channels, length, segments, createdAt }
// A take is minutes long — one record per 30 s keeps every structured clone a
// few MB (the customSampleStore rule). The meta record is written LAST = the
// completeness marker. Ids are `voxclip:<uuid>`, so a clip never shares a key
// range with a `vox:` / `custom:` instrument.
//
// The cache holds a decoded NATIVE AudioBuffer (context-free — valid live and
// inside Tone.Offline) plus a peak overview for the region waveform, read
// SYNCHRONOUSLY by the audio hook / bounce / timeline. Tone-free (jest).

import { sampleStore, req } from '../../utils/projectStore';
import { computePeaks, isClipId } from './audioClipMath';

export { isClipId, mintClipId } from './audioClipMath';

export const CLIP_SCHEMA_VERSION = 1;
export const SEGMENT_SEC = 30;
export const PEAK_BIN_SEC = 0.02;

const segKey  = (id, i) => `${id}|s${i}`;
const metaKey = (id) => `${id}|meta`;
const idRange = (id) => IDBKeyRange.bound(`${id}|`, `${id}|￿`);

const cache = new Map();   // id → { buffer, peaks, binSec, durationSec, sampleRate }
const status = new Map();  // id → 'loading' | 'ready' | 'missing'
const subscribers = new Set();
const notify = () => {
  for (const cb of subscribers) {
    try { cb(); } catch { /* a subscriber must not break the store */ }
  }
};

export const getClip = (id) => cache.get(id) ?? null;
export const getClipStatus = (id) => status.get(id) ?? 'unknown';
export function subscribeClips(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

// ── 16-bit PCM WAV, straight from / to Float32 channel arrays ──────────────
export function encodeWav(channels, sampleRate, a = 0, b = channels[0].length) {
  const nCh = channels.length;
  const n = Math.max(0, b - a);
  const data = n * nCh * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true); v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, data, true);
  const pcm = new Int16Array(buf, 44, n * nCh);
  for (let c = 0; c < nCh; c++) {
    const ch = channels[c];
    for (let i = 0, j = c; i < n; i++, j += nCh) {
      const s = ch[a + i];
      pcm[j] = s >= 1 ? 0x7FFF : s <= -1 ? -0x8000 : (s < 0 ? s * 0x8000 : s * 0x7FFF);
    }
  }
  return buf;
}

// Our own WAVs only (44-byte header, 16-bit PCM) → { channels, sampleRate }.
export function decodeWav(buf) {
  const v = new DataView(buf);
  const nCh = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const n = (v.getUint32(40, true) / 2 / nCh) | 0;
  const pcm = new Int16Array(buf, 44, n * nCh);
  const channels = Array.from({ length: nCh }, () => new Float32Array(n));
  for (let c = 0; c < nCh; c++) {
    const ch = channels[c];
    for (let i = 0, j = c; i < n; i++, j += nCh) ch[i] = pcm[j] / (pcm[j] < 0 ? 0x8000 : 0x7FFF);
  }
  return { channels, sampleRate };
}

function toAudioBuffer(channels, sampleRate) {
  const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: Math.max(1, channels[0].length), sampleRate });
  channels.forEach((ch, i) => buffer.copyToChannel(ch, i));
  return buffer;
}

function seed(id, channels, sampleRate) {
  cache.set(id, {
    buffer: toAudioBuffer(channels, sampleRate),
    peaks: computePeaks(channels, sampleRate, PEAK_BIN_SEC),
    binSec: PEAK_BIN_SEC,
    durationSec: channels[0].length / sampleRate,
    sampleRate,
  });
  status.set(id, 'ready');
  notify();
}

// Keep a fresh recording: playable at once (cache seeded synchronously from the
// same samples), then persisted segment by segment, meta LAST. A failed write
// rolls back its partial records and rethrows (the take still plays this session).
export async function saveClip(id, channels, sampleRate) {
  seed(id, channels, sampleRate);
  const seg = SEGMENT_SEC * sampleRate;
  const len = channels[0].length;
  const segments = Math.max(1, Math.ceil(len / seg));
  await writeRecords(id, { sampleRate, channels: channels.length, length: len, segments },
    (i) => encodeWav(channels, sampleRate, i * seg, Math.min(len, (i + 1) * seg)));
}

async function writeRecords(id, meta, wavAt) {
  try {
    for (let i = 0; i < meta.segments; i++) {
      const s = await sampleStore('readwrite');
      await req(s.put({ wav: wavAt(i), seg: i }, segKey(id, i)));
    }
    const s = await sampleStore('readwrite');
    await req(s.put({ schemaVersion: CLIP_SCHEMA_VERSION, ...meta, createdAt: Date.now() }, metaKey(id)));
  } catch (err) {
    try {
      const s = await sampleStore('readwrite');
      await req(s.delete(idRange(id)));
    } catch { /* rollback is best-effort */ }
    throw err;
  }
}

async function readRecords(id) {
  const s = await sampleStore('readonly');
  const [meta, records] = await Promise.all([req(s.get(metaKey(id))), req(s.getAll(idRange(id)))]);
  if (!meta || meta.schemaVersion !== CLIP_SCHEMA_VERSION) return null;
  const wavs = records.filter(r => Number.isInteger(r?.seg) && r.wav).sort((a, b) => a.seg - b.seg).map(r => r.wav);
  return wavs.length === meta.segments ? { meta, wavs } : null;
}

// Load + decode a stored clip into the cache. No-throw: failure → 'missing'.
export async function primeClip(id) {
  if (!isClipId(id)) return;
  const st = status.get(id);
  if (st === 'ready' || st === 'loading') return;
  status.set(id, 'loading');
  notify();
  try {
    const rec = await readRecords(id);
    if (!rec) throw new Error('no clip');
    const { meta, wavs } = rec;
    const channels = Array.from({ length: meta.channels }, () => new Float32Array(meta.length));
    let at = 0;
    for (const w of wavs) {
      const d = decodeWav(w);
      const m = Math.min(d.channels[0].length, meta.length - at);
      for (let c = 0; c < channels.length; c++) channels[c].set((d.channels[c] ?? d.channels[0]).subarray(0, m), at);
      at += m;
    }
    seed(id, channels, meta.sampleRate);
  } catch {
    cache.delete(id);
    status.set(id, 'missing');
    notify();
  }
}

export async function hasClip(id) {
  try {
    const s = await sampleStore('readonly');
    return !!(await req(s.get(metaKey(id))));
  } catch {
    return false;
  }
}

// ── .voxdaw packing (voxSamplePack) ────────────────────────────────────────
export async function readClipWavs(id) {
  try {
    return await readRecords(id);
  } catch {
    return null;
  }
}

export async function writeClipWavs(id, meta, wavs) {
  await writeRecords(id, { sampleRate: meta.sampleRate, channels: meta.channels, length: meta.length, segments: wavs.length }, (i) => wavs[i]);
  cache.delete(id);
  status.delete(id);
  await primeClip(id);
}
