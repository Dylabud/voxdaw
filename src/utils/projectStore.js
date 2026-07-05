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
//     data: object,        // full serializeProject() output (source of truth)
//   }

const DB_NAME = 'voxdaw';
const DB_VERSION = 1;
const STORE = 'projects';

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
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error ?? new Error('project store request failed'));
  });
}

async function store(mode) {
  const db = await openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Metadata only (no `data`), newest first — feeds the HomePage grid.
export async function listProjects() {
  const s = await store('readonly');
  const all = await req(s.getAll());
  return all
    .map(({ id, name, createdAt, updatedAt, bpm, trackCount }) =>
      ({ id, name, createdAt, updatedAt, bpm, trackCount }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getProject(id) {
  const s = await store('readonly');
  return req(s.get(id));
}

// Upsert. Stamps updatedAt; preserves the existing record's createdAt so the
// caller never needs a read-before-write.
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

export async function deleteProject(id) {
  const s = await store('readwrite');
  await req(s.delete(id));
}

// Patches both the card name and the name embedded in the serialized project,
// so a later download of the record produces a correctly-named .voxdaw file.
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
