// Vox take instruments (Vox Phase 130) — a Vox Modular patch "photographed"
// into a sampled instrument: one recording every 3 semitones, played back by a
// real Tone.Sampler (synthFactory). The samples ARE the instrument — there is
// no patch to re-render from, so unlike custom (AI) instruments there is no
// live/sampled engine toggle.
//
// Ids are `vox:<uuid>`. The sample set lives in customSampleStore under the
// same id (the store is id-generic and accepts a sparse note map); this module
// only owns the small definitions:
//
//   { id, name, rackHash, photoKey, createdAt, format }
//
// photoKey (Phase 132) = `${rackHash}|${ioChannel}|${voiceGroup}` — what was
// photographed: this rack setup, heard at this I/O input, played through this
// voice group. A new take reuses an instrument only on an exact photoKey match.
// format 3 (Phase 132) = per-I/O-channel photo with sustain loops. Older formats
// (1: Phase 130, whole-rack tap, no loops; 2: Phase 131, whole-rack tap) still
// play, but are never reused — their sound is not one channel's.
//
//   • Library — every photographed instrument, persisted to
//     localStorage['voxdaw.voxInstruments'], listed in the instrument dropdown.
//   • Registered — defs embedded in a loaded .voxdaw (registerVoxInstruments),
//     runtime only, the customInstruments pattern. A .voxdaw download also
//     carries the sample WAVs (voxSamplePack.js), so these play on any machine.
//
// rackHash fingerprints the rack setup at photograph time: a new take on an
// unchanged rack reuses the instrument instead of photographing it again.
//
// Deliberately Tone-free (jest-safe, like customInstruments.js).

import { deleteSampleSet } from './customSampleStore';

const LS_KEY = 'voxdaw.voxInstruments';
const ID_PREFIX = 'vox:';

const registry = new Map(); // id → def

export const VOX_FORMAT = 3;

export const mintVoxInstrumentId = () =>
  `${ID_PREFIX}${(crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)}`;

export function isVoxInstrument(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

const cleanDef = (rec) => ({
  id: rec.id,
  name: String(rec.name ?? 'Vox patch').trim().slice(0, 48) || 'Vox patch',
  rackHash: typeof rec.rackHash === 'string' ? rec.rackHash : null,
  photoKey: typeof rec.photoKey === 'string' ? rec.photoKey : null,
  createdAt: Number(rec.createdAt) || Date.now(),
  format: Number(rec.format) || 1,
});

function readLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function writeLibrary(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* private mode / quota */ }
}

for (const rec of readLibrary()) {
  if (isVoxInstrument(rec?.id)) registry.set(rec.id, cleanDef(rec));
}

export function getVoxInstrument(id) {
  return registry.get(id) ?? null;
}

// { id, name } for the dropdown, newest first (takes are made in order).
export function voxInstrumentList() {
  return [...registry.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, name }) => ({ id, name }));
}

// Newest current-format instrument with exactly this photoKey, or null.
export function findVoxInstrumentByPhotoKey(photoKey) {
  if (!photoKey) return null;
  let best = null;
  for (const def of registry.values()) {
    if (def.photoKey === photoKey && def.format >= VOX_FORMAT
        && (!best || def.createdAt > best.createdAt)) best = def;
  }
  return best;
}

// "Vox patch N" — one past the highest N already in use. (The rack has no patch
// name of its own; the TRACK is the "Vox take", its instrument the "Vox patch".)
export function nextVoxPatchName() {
  let max = 0;
  for (const def of registry.values()) {
    const m = /^Vox patch (\d+)$/.exec(def.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Vox patch ${max + 1}`;
}

// FNV-1a 32-bit of the rack setup JSON — the projectIO hash, for a string.
export function hashRackSnapshot(json) {
  if (typeof json !== 'string' || !json) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function addVoxInstrument(def) {
  const clean = cleanDef(def);
  registry.set(clean.id, clean);
  writeLibrary([...readLibrary().filter((r) => r.id !== clean.id), clean]);
  return clean;
}

export function deleteVoxInstrument(id) {
  registry.delete(id);
  writeLibrary(readLibrary().filter((r) => r.id !== id));
  deleteSampleSet(id);
}

// .voxdaw load: make embedded defs resolvable. Never overwrites a library entry.
// Imported instruments join the library — their samples were just written to
// this machine's store, so they are as permanent as a locally made one.
export function registerVoxInstruments(list) {
  for (const rec of list ?? []) {
    if (!isVoxInstrument(rec?.id) || registry.has(rec.id)) continue;
    addVoxInstrument(rec);
  }
}

export function voxInstrumentsForIds(ids) {
  const seen = new Set(ids);
  return [...registry.values()].filter((d) => seen.has(d.id)).map((d) => ({ ...d }));
}
