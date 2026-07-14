// Custom-instrument registry — user-saved AI-generator patches promoted to
// selectable workstation instruments. Two scopes share one runtime lookup:
//
//   • Library  — the user's saved instruments, persisted to
//     localStorage['voxdaw.customInstruments'], listed in the instrument
//     dropdown, survive across projects.
//   • Registered — definitions embedded in a loaded .voxdaw (registerInstruments)
//     so an imported project plays its custom instruments even when they aren't
//     in this machine's library. Runtime-only; never written to the library.
//
// makeSynth (synthFactory) resolves ids through getCustomInstrument, which reads
// the union. Ids are `custom:<uuid>`; isCustomInstrument keys off that prefix so
// a track referencing a not-yet-registered id still routes to the custom branch
// (→ graceful default-synth fallback in makeSynth).

import { sanitizePatch } from '../AIGen/patchSchema';

const LS_KEY = 'voxdaw.customInstruments';
const ID_PREFIX = 'custom:';

// id → { id, name, patch }. Library entries + project-registered entries.
const registry = new Map();

const mintId = () =>
  `${ID_PREFIX}${(crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)}`;

export function isCustomInstrument(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

// ── Library persistence ─────────────────────────────────────────────────────
function readLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function writeLibrary(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* private mode / quota */ }
}

// Hydrate the runtime registry from the library once at module load.
for (const rec of readLibrary()) {
  if (isCustomInstrument(rec?.id)) {
    registry.set(rec.id, { id: rec.id, name: String(rec.name ?? 'Custom'), patch: sanitizePatch(rec.patch) });
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────
export function getCustomInstrument(id) {
  return registry.get(id) ?? null;
}
// { id, name } list for the instrument dropdown, name-sorted.
export function customInstrumentList() {
  return [...registry.values()]
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Library mutations (persisted) ────────────────────────────────────────────
// Save a generated patch as a new library instrument. Returns its id.
export function saveToLibrary(name, patch) {
  const id = mintId();
  const def = { id, name: String(name ?? 'Custom').trim().slice(0, 48) || 'Custom', patch: sanitizePatch(patch) };
  registry.set(id, def);
  writeLibrary([...readLibrary(), { ...def, createdAt: Date.now() }]);
  return id;
}

// Is this id persisted in the library (vs. merely project-registered at runtime)?
export function isInLibrary(id) {
  return readLibrary().some((r) => r.id === id);
}

// Promote an already-registered runtime instrument into the permanent library
// (e.g. from an imported project). No-op if unknown or already persisted.
export function addToLibrary(id) {
  const def = registry.get(id);
  if (!def || isInLibrary(id)) return false;
  writeLibrary([...readLibrary(), { ...def, createdAt: Date.now() }]);
  return true;
}

export function renameCustom(id, name) {
  const def = registry.get(id);
  if (!def) return;
  def.name = String(name ?? '').trim().slice(0, 48) || def.name;
  writeLibrary(readLibrary().map((r) => (r.id === id ? { ...r, name: def.name } : r)));
}

export function deleteCustom(id) {
  registry.delete(id);
  writeLibrary(readLibrary().filter((r) => r.id !== id));
}

// ── Project-embedded registration (runtime only, not persisted) ──────────────
// Called on .voxdaw load BEFORE audio builds so makeSynth resolves embedded ids.
// Does not overwrite an existing library entry of the same id.
export function registerInstruments(list) {
  for (const rec of list ?? []) {
    if (isCustomInstrument(rec?.id) && !registry.has(rec.id)) {
      registry.set(rec.id, { id: rec.id, name: String(rec.name ?? 'Custom'), patch: sanitizePatch(rec.patch) });
    }
  }
}

// Serialize the subset of instruments referenced by the given instrument ids —
// used by serializeProject to embed only what a project actually uses.
export function customInstrumentsForIds(ids) {
  const seen = new Set(ids);
  return [...registry.values()]
    .filter((def) => seen.has(def.id))
    .map(({ id, name, patch }) => ({ id, name, patch }));
}
