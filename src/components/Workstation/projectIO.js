// .voxdaw project serialization / deserialization.

const SCHEMA_VERSION = 1;
const KIND = 'voxdaw-project';

export function serializeProject({ bpm, totalMeasures, tracks, regions, notes }) {
  return {
    version: SCHEMA_VERSION,
    kind: KIND,
    bpm,
    totalMeasures,
    tracks:  tracks.map(t => ({
      id: t.id, name: t.name, instrument: t.instrument, color: t.color,
      isMuted: !!t.isMuted, isSolo: !!t.isSolo, volume: t.volume ?? 75, pan: t.pan ?? 0,
    })),
    regions: regions.map(r => ({
      id: r.id, trackId: r.trackId,
      startMeasure: r.startMeasure, durationMeasures: r.durationMeasures,
      clipOffset: r.clipOffset ?? 0,
      fadeIn: r.fadeIn ?? 0, fadeOut: r.fadeOut ?? 0,
      fadeInFloor: r.fadeInFloor ?? 0, fadeOutFloor: r.fadeOutFloor ?? 0,
      loopInterval: r.loopInterval ?? null,
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

  return {
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
    })),
    regions: regions.map(r => ({
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
    })),
    notes: notes.map(n => ({
      id: String(n.id),
      trackId: String(n.trackId),
      regionId: String(n.regionId),
      note: String(n.note),
      startBeat: Number(n.startBeat) || 0,
      durationBeats: Number(n.durationBeats) || 1,
    })),
    nextId:       nextSuffix(tracks),
    nextRegionId: nextSuffix(regions),
  };
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
