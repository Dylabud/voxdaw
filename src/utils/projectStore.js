// Browser-local project store (IndexedDB). Backs the HomePage "Projects" grid
// and the Workstation [ save ] action. Native IndexedDB behind a tiny promise
// wrapper — no dependency needed for one store and five operations.
//
// Record shape:
//   {
//     id: string,          // crypto.randomUUID()
//     name: string,
//     createdAt: number,   // Date.now(); preserved across upserts
//     updatedAt: number,   // stamped by saveProject on every write
//     bpm: number,         // denormalized for card display
//     trackCount: number,  // denormalized for card display
//     dataHash: string,    // hashProjectData(data) — compared against the
//                          //   preview's dataHash for dashboard freshness
//     data: object,        // full serializeProject() output (source of truth)
//   }
//
// Preview store (`previews`, out-of-line keys — two records per project so
// listing metas never reads WAV bytes; meta written LAST = completeness marker):
//   'meta:<projectId>' → { projectId, peaks: number[], durationSec, dataHash, exportedAt }
//   'wav:<projectId>'  → ArrayBuffer (16-bit PCM WAV)

const DB_NAME = 'voxdaw';
// v2 adds the `customSamples` store (rendered custom-instrument WAV notes —
// see Workstation/customSampleStore.js, which owns that store's record layout).
// v3 adds the `previews` store (dashboard audio previews of exported mixes).
const DB_VERSION = 3;
const STORE = 'projects';
const SAMPLE_STORE = 'customSamples';
const PREVIEW_STORE = 'previews';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
        db.createObjectStore(SAMPLE_STORE); // out-of-line string keys
      }
      if (!db.objectStoreNames.contains(PREVIEW_STORE)) {
        db.createObjectStore(PREVIEW_STORE); // out-of-line string keys
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error ?? new Error('failed to open project store'));
    req.onblocked = () => reject(new Error('project store is blocked by another tab'));
  });
  // Let a failed open be retried on the next call (e.g. transient private-mode denial).
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Promisify a single IDBRequest.
export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error ?? new Error('project store request failed'));
  });
}

async function store(mode) {
  const db = await openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Object store for rendered custom-instrument samples — record layout is owned
// by Workstation/customSampleStore.js; this module only owns the DB plumbing.
export async function sampleStore(mode) {
  const db = await openDB();
  return db.transaction(SAMPLE_STORE, mode).objectStore(SAMPLE_STORE);
}

// Metadata only (no `data`), newest first — feeds the HomePage grid.
export async function listProjects() {
  const s = await store('readonly');
  const all = await req(s.getAll());
  return all
    .map(({ id, name, createdAt, updatedAt, bpm, trackCount, dataHash }) =>
      ({ id, name, createdAt, updatedAt, bpm, trackCount, dataHash }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getProject(id) {
  const s = await store('readonly');
  return req(s.get(id));
}

// Upsert. Stamps updatedAt; preserves the existing record's createdAt so the
// caller never needs a read-before-write. Any extra fields on `record`
// (e.g. `dataHash`) pass through via the spread.
export async function saveProject(record) {
  const s = await store('readwrite');
  const existing = await req(s.get(record.id));
  const now = Date.now();
  const out = {
    ...record,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: now,
  };
  await req(s.put(out));
  return out;
}

// Deletes the project row AND its audio preview (both keys) in one transaction.
export async function deleteProject(id) {
  const db = await openDB();
  const tx = db.transaction([STORE, PREVIEW_STORE], 'readwrite');
  const projects = tx.objectStore(STORE);
  const previews = tx.objectStore(PREVIEW_STORE);
  await Promise.all([
    req(projects.delete(id)),
    req(previews.delete(`meta:${id}`)),
    req(previews.delete(`wav:${id}`)),
  ]);
}

// Patches both the card name and the name embedded in the serialized project,
// so a later download of the record produces a correctly-named .voxdaw file.
// The stored dataHash needs NO recompute here: hashProjectData excludes `name`
// by design, so a rename never invalidates the audio preview.
export async function renameProject(id, name) {
  const s = await store('readwrite');
  const rec = await req(s.get(id));
  if (!rec) throw new Error('project not found');
  rec.name = name;
  rec.updatedAt = Date.now();
  if (rec.data && typeof rec.data === 'object') rec.data = { ...rec.data, name };
  await req(s.put(rec));
  return rec;
}

// ---------- Audio previews (dashboard play button + waveform) ----------

async function previewStore(mode) {
  const db = await openDB();
  return db.transaction(PREVIEW_STORE, mode).objectStore(PREVIEW_STORE);
}

// One transaction; wav first, meta LAST so a meta record always implies a
// complete wav (the customSampleStore completeness-marker pattern).
export async function savePreview(projectId, { wav, peaks, durationSec, dataHash, exportedAt }) {
  const s = await previewStore('readwrite');
  await req(s.put(wav, `wav:${projectId}`));
  await req(s.put(
    { projectId, peaks, durationSec, dataHash, exportedAt: exportedAt ?? Date.now() },
    `meta:${projectId}`,
  ));
}

export async function getPreviewWav(projectId) {
  const s = await previewStore('readonly');
  return req(s.get(`wav:${projectId}`)); // ArrayBuffer | undefined
}

// All meta records (never touches wav bytes) — feeds the dashboard rows.
export async function listPreviewMetas() {
  const s = await previewStore('readonly');
  return req(s.getAll(IDBKeyRange.bound('meta:', 'meta:\uffff')));
}

export async function deletePreview(projectId) {
  const s = await previewStore('readwrite');
  await Promise.all([
    req(s.delete(`meta:${projectId}`)),
    req(s.delete(`wav:${projectId}`)),
  ]);
}

// Used by project duplication — the copy's data differs only by name, which the
// hash excludes, so the copied preview is immediately fresh. No-op if absent.
export async function copyPreview(srcId, dstId) {
  const s = await previewStore('readwrite');
  const [wav, meta] = await Promise.all([
    req(s.get(`wav:${srcId}`)),
    req(s.get(`meta:${srcId}`)),
  ]);
  if (!wav || !meta) return;
  await req(s.put(wav, `wav:${dstId}`));
  await req(s.put({ ...meta, projectId: dstId }, `meta:${dstId}`));
}
