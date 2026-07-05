// .voxdaw project serialization / deserialization.

const SCHEMA_VERSION = 1;
const KIND = 'voxdaw-project';

export function serializeProject({ bpm, totalMeasures, tracks, regions, notes, name }) {
  return {
    version: SCHEMA_VERSION,
    kind: KIND,
    // Additive field (SCHEMA_VERSION intentionally NOT bumped — the strict-
    // equality version check would reject every existing .voxdaw file).
    name: String(name ?? 'untitled'),
    bpm,
    totalMeasures,
    tracks:  tracks.map(t => ({
      id: t.id, name: t.name, instrument: t.instrument, color: t.color,
      isMuted: !!t.isMuted, isSolo: !!t.isSolo, volume: t.volume ?? 75, pan: t.pan ?? 0,
      effects: Array.isArray(t.effects)
        ? t.effects.map(e => ({ id: e.id, type: e.type, bypass: !!e.bypass, params: { ...e.params } }))
        : [],
      // ADSR override (optional) — omitted when the track uses the instrument default.
      ...(t.envelope && typeof t.envelope === 'object' ? { envelope: { ...t.envelope } } : {}),
    })),
    regions: regions.map(r => ({
      id: r.id, trackId: r.trackId,
      startMeasure: r.startMeasure, durationMeasures: r.durationMeasures,
      clipOffset: r.clipOffset ?? 0,
      fadeIn: r.fadeIn ?? 0, fadeOut: r.fadeOut ?? 0,
      fadeInFloor: r.fadeInFloor ?? 0, fadeOutFloor: r.fadeOutFloor ?? 0,
      loopInterval: r.loopInterval ?? null,
      loopPhase: r.loopPhase ?? 0,
      isMuted: !!r.isMuted,
    })),
    notes: notes.map(n => ({
      id: n.id, trackId: n.trackId, regionId: n.regionId,
      note: n.note, startBeat: n.startBeat, durationBeats: n.durationBeats,
    })),
  };
}

export function deserializeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('invalid project file: not an object');
  if (raw.kind !== KIND)               throw new Error(`invalid project file: kind="${raw.kind}"`);
  if (raw.version !== SCHEMA_VERSION)  throw new Error(`unsupported project version ${raw.version}`);

  const bpm           = Number(raw.bpm) || 120;
  const totalMeasures = Number(raw.totalMeasures) || 24;
  const tracks  = Array.isArray(raw.tracks)  ? raw.tracks  : [];
  const regions = Array.isArray(raw.regions) ? raw.regions : [];
  const notes   = Array.isArray(raw.notes)   ? raw.notes   : [];

  const outRegions = regions.map(r => ({
    id: String(r.id),
    trackId: String(r.trackId),
    startMeasure: Number(r.startMeasure) || 0,
    durationMeasures: Number(r.durationMeasures) || 1,
    clipOffset: Number(r.clipOffset) || 0,
    fadeIn:  Number(r.fadeIn)  || 0,
    fadeOut: Number(r.fadeOut) || 0,
    fadeInFloor:  Number(r.fadeInFloor)  || 0,
    fadeOutFloor: Number(r.fadeOutFloor) || 0,
    loopInterval: r.loopInterval == null ? null : Number(r.loopInterval),
    loopPhase: Number(r.loopPhase) || 0,
    isMuted: !!r.isMuted,
  }));

  // ── Note repair pass ──────────────────────────────────────────────────
  // Files saved while the nextNoteId bug was live (the counter was never
  // persisted, so post-load mints collided) can contain duplicate note ids
  // and trackId/regionId desyncs. Heal them here so the corruption cannot
  // reload: regionId is authoritative (playback, mini-maps and deletion all
  // key on it), so trackId is reconciled to the owning region and notes
  // whose region no longer exists are dropped.
  let nextNoteId = nextSuffix(notes);
  let repairedCount = 0;
  const regionById = new Map(outRegions.map(r => [r.id, r]));
  const seenNoteIds = new Set();
  const outNotes = [];
  for (const n of notes) {
    const region = regionById.get(String(n.regionId));
    if (!region) { repairedCount++; continue; } // orphan — renders nowhere, never plays
    let id = String(n.id);
    if (seenNoteIds.has(id)) {
      id = `note_${nextNoteId++}`;
      repairedCount++;
    }
    seenNoteIds.add(id);
    let trackId = String(n.trackId);
    if (trackId !== region.trackId) {
      trackId = region.trackId;
      repairedCount++;
    }
    outNotes.push({
      id,
      trackId,
      regionId: region.id,
      note: String(n.note),
      startBeat: Number(n.startBeat) || 0,
      durationBeats: Number(n.durationBeats) || 1,
    });
  }

  return {
    // Additive field — old files have no name; default matches a fresh session.
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'untitled',
    bpm,
    totalMeasures,
    tracks: tracks.map(t => ({
      id: String(t.id),
      name: String(t.name ?? 'track'),
      instrument: String(t.instrument ?? 'fm pluck'),
      color: String(t.color ?? '#5DCAA5'),
      isMuted: !!t.isMuted,
      isSolo:  !!t.isSolo,
      volume:  typeof t.volume === 'number' ? t.volume : 75,
      pan:     typeof t.pan    === 'number' ? Math.max(-1, Math.min(1, t.pan)) : 0,
      effects: deserializeEffects(t.effects),
      envelope: deserializeEnvelope(t.envelope),
    })),
    regions: outRegions,
    notes: outNotes,
    nextId:       nextSuffix(tracks),
    nextRegionId: nextSuffix(regions),
    nextEffectId: nextSuffix(tracks.flatMap(t => (Array.isArray(t.effects) ? t.effects : []))),
    nextNoteId,       // post-repair value — already past any re-minted ids
    repairedCount,
  };
}

// Rebuild a track's effects array defensively (old projects have no `effects` field;
// missing/invalid → []). Mirrors the additive, backward-compatible field policy: the
// SCHEMA_VERSION is intentionally NOT bumped for this field.
function deserializeEffects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(e => e && typeof e === 'object' && e.type != null)
    .map(e => ({
      id: String(e.id),
      type: String(e.type),
      bypass: !!e.bypass,
      params: (e.params && typeof e.params === 'object') ? { ...e.params } : {},
    }));
}

// Rebuild a track's optional ADSR override (old projects have no `envelope`
// field → undefined = use the instrument default). Additive, backward-
// compatible — SCHEMA_VERSION intentionally NOT bumped. Only numeric keys
// survive; an empty/invalid object collapses to undefined.
function deserializeEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const k of ['attack', 'decay', 'sustain', 'release']) {
    if (typeof raw[k] === 'number' && isFinite(raw[k])) out[k] = raw[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function nextSuffix(items) {
  let max = 0;
  for (const it of items) {
    const id = String(it?.id ?? '');
    // Pull the last run of digits in the id (handles both 't12' and 'region_34').
    const m = id.match(/(\d+)(?!.*\d)/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      try { resolve(JSON.parse(reader.result)); }
      catch (e) { reject(new Error('file is not valid JSON')); }
    };
    reader.onerror = () => reject(new Error('failed to read file'));
    reader.readAsText(file);
  });
}
