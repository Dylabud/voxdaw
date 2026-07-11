// .voxdaw project serialization / deserialization.

import { EFFECT_DEFS, isAutomatableParam } from './effectDefs';
import { sanitizeGlide } from './glideMath';

const SCHEMA_VERSION = 1;
const KIND = 'voxdaw-project';

export function serializeProject({ bpm, totalMeasures, tracks, regions, notes, name, globalAutomations, groups }) {
  return {
    version: SCHEMA_VERSION,
    kind: KIND,
    // Additive field (SCHEMA_VERSION intentionally NOT bumped — the strict-
    // equality version check would reject every existing .voxdaw file).
    name: String(name ?? 'untitled'),
    bpm,
    totalMeasures,
    // Global automation lanes (tempo) — optional, additive.
    ...(Array.isArray(globalAutomations) && globalAutomations.length
      ? {
          globalAutomations: globalAutomations.map(a => ({
            id: a.id,
            target: { ...a.target },
            points: (a.points ?? []).map(p => ({ time: p.time, value: p.value })),
          })),
        }
      : {}),
    // Track groups — optional, additive (membership travels on track.groupId).
    ...(Array.isArray(groups) && groups.length
      ? {
          groups: groups.map(g => ({
            id: g.id, name: g.name, color: g.color,
            isMuted: !!g.isMuted, isSolo: !!g.isSolo,
            volume: g.volume ?? 75, pan: g.pan ?? 0,
            effects: Array.isArray(g.effects)
              ? g.effects.map(e => ({ id: e.id, type: e.type, bypass: !!e.bypass, params: { ...e.params } }))
              : [],
            ...(Array.isArray(g.automations) && g.automations.length
              ? {
                  automations: g.automations.map(a => ({
                    id: a.id,
                    target: { ...a.target },
                    points: (a.points ?? []).map(p => ({ time: p.time, value: p.value })),
                  })),
                }
              : {}),
          })),
        }
      : {}),
    tracks:  tracks.map(t => ({
      id: t.id, name: t.name, instrument: t.instrument, color: t.color,
      isMuted: !!t.isMuted, isSolo: !!t.isSolo, volume: t.volume ?? 75, pan: t.pan ?? 0,
      effects: Array.isArray(t.effects)
        ? t.effects.map(e => ({ id: e.id, type: e.type, bypass: !!e.bypass, params: { ...e.params } }))
        : [],
      // ADSR override (optional) — omitted when the track uses the instrument default.
      ...(t.envelope && typeof t.envelope === 'object' ? { envelope: { ...t.envelope } } : {}),
      // Group membership (optional, additive) — the groups array is top-level.
      ...(t.groupId ? { groupId: t.groupId } : {}),
      // Automation lanes (optional, additive — SCHEMA_VERSION intentionally NOT bumped).
      ...(Array.isArray(t.automations) && t.automations.length
        ? {
            automations: t.automations.map(a => ({
              id: a.id,
              target: { ...a.target },
              points: (a.points ?? []).map(p => ({ time: p.time, value: p.value })),
            })),
          }
        : {}),
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
    notes: notes.map(n => {
      // Glide is additive too (SCHEMA_VERSION intentionally NOT bumped) and
      // omitted entirely for inert glides — sanitizeGlide prunes defaults.
      const glide = sanitizeGlide(n.glide, n.note);
      return {
        id: n.id, trackId: n.trackId, regionId: n.regionId,
        note: n.note, startBeat: n.startBeat, durationBeats: n.durationBeats,
        // Additive field (SCHEMA_VERSION intentionally NOT bumped) — 1–120 int.
        velocity: sanitizeVelocity(n.velocity),
        ...(glide ? { glide } : {}),
      };
    }),
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
    const noteName = String(n.note);
    const glide = sanitizeGlide(n.glide, noteName);
    outNotes.push({
      id,
      trackId,
      regionId: region.id,
      note: noteName,
      startBeat: Number(n.startBeat) || 0,
      durationBeats: Number(n.durationBeats) || 1,
      velocity: sanitizeVelocity(n.velocity),
      ...(glide ? { glide } : {}),
    });
  }

  // Groups first, so track groupIds can be validated against them. Dangling
  // groupIds are dropped; groups whose members all vanished are dropped; the
  // surviving tracks are reordered so group runs are CONTIGUOUS (the render's
  // one-header-per-run invariant).
  const outGroups = deserializeGroups(raw.groups);
  const groupIds = new Set(outGroups.map(g => g.id));
  let outTracks = tracks.map(t => {
    const effects = deserializeEffects(t.effects);
    const groupId = groupIds.has(String(t.groupId)) ? String(t.groupId) : undefined;
    return {
      id: String(t.id),
      name: String(t.name ?? 'track'),
      instrument: String(t.instrument ?? 'fm pluck'),
      color: String(t.color ?? '#5DCAA5'),
      isMuted: !!t.isMuted,
      isSolo:  !!t.isSolo,
      volume:  typeof t.volume === 'number' ? t.volume : 75,
      pan:     typeof t.pan    === 'number' ? Math.max(-1, Math.min(1, t.pan)) : 0,
      effects,
      envelope: deserializeEnvelope(t.envelope),
      automations: deserializeAutomations(t.automations, effects),
      ...(groupId ? { groupId } : {}),
    };
  });
  const memberCounts = new Map();
  for (const t of outTracks) {
    if (t.groupId) memberCounts.set(t.groupId, (memberCounts.get(t.groupId) ?? 0) + 1);
  }
  const liveGroups = outGroups.filter(g => (memberCounts.get(g.id) ?? 0) > 0);
  const liveGroupIds = new Set(liveGroups.map(g => g.id));
  outTracks = outTracks.map(t =>
    (t.groupId && !liveGroupIds.has(t.groupId)) ? { ...t, groupId: undefined } : t);
  outTracks = normalizeGroupContiguity(outTracks);

  return {
    // Additive field — old files have no name; default matches a fresh session.
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'untitled',
    bpm,
    totalMeasures,
    tracks: outTracks,
    regions: outRegions,
    notes: outNotes,
    globalAutomations: deserializeGlobalAutomations(raw.globalAutomations),
    groups: liveGroups,
    nextId:       nextSuffix(tracks),
    nextRegionId: nextSuffix(regions),
    nextEffectId: nextSuffix([
      ...tracks.flatMap(t => (Array.isArray(t.effects) ? t.effects : [])),
      ...liveGroups.flatMap(g => g.effects ?? []),
    ]),
    nextNoteId,       // post-repair value — already past any re-minted ids
    // Track/group automations and global automations share the a<n> namespace;
    // track and group effects share e<n>.
    nextAutomationId: nextSuffix([
      ...tracks.flatMap(t => (Array.isArray(t.automations) ? t.automations : [])),
      ...(Array.isArray(raw.globalAutomations) ? raw.globalAutomations : []),
      ...liveGroups.flatMap(g => g.automations ?? []),
    ]),
    nextGroupId: nextSuffix(liveGroups),
    repairedCount,
  };
}

// Rebuild the top-level groups array defensively (old projects → []).
// Group automations reuse the track validator against the GROUP's own effects.
function deserializeGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(g => g && typeof g === 'object' && g.id != null)
    .map(g => {
      const effects = deserializeEffects(g.effects);
      return {
        id: String(g.id),
        name: String(g.name ?? 'group'),
        color: String(g.color ?? '#5DCAA5'),
        isMuted: !!g.isMuted,
        isSolo:  !!g.isSolo,
        volume:  typeof g.volume === 'number' ? g.volume : 75,
        pan:     typeof g.pan    === 'number' ? Math.max(-1, Math.min(1, g.pan)) : 0,
        effects,
        automations: deserializeAutomations(g.automations, effects),
      };
    });
}

// Pull each group's members together at the run's first occurrence — the
// render emits one header per contiguous run, so a fragmented group (hand-
// edited file) would otherwise draw duplicate headers.
function normalizeGroupContiguity(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    if (t.groupId) {
      if (seen.has(t.groupId)) continue;
      seen.add(t.groupId);
      out.push(...tracks.filter(x => x.groupId === t.groupId));
    } else {
      out.push(t);
    }
  }
  return out;
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

// Note velocity: 1–120 int, default 100 (old projects have no `velocity`
// field). Additive, backward-compatible — SCHEMA_VERSION intentionally NOT
// bumped. Shared by serialize (normalizes legacy floats) and deserialize.
function sanitizeVelocity(raw) {
  if (typeof raw !== 'number' || !isFinite(raw)) return 100;
  return Math.max(1, Math.min(120, Math.round(raw)));
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

// Shared point sanitizer: coerced numeric, time >= 0, value clamped 0–1,
// sorted by time.
function sanitizePoints(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(p => p && typeof p === 'object'
      && typeof p.time === 'number' && isFinite(p.time) && p.time >= 0
      && typeof p.value === 'number' && isFinite(p.value))
    .map(p => ({ time: p.time, value: Math.max(0, Math.min(1, p.value)) }))
    .sort((x, y) => x.time - y.time);
}

// Rebuild a track's automation lanes defensively (old projects → []).
// Additive, backward-compatible — SCHEMA_VERSION intentionally NOT bumped.
// fx targets must reference a live effect on the SAME track and an automatable
// param in EFFECT_DEFS (regionId-authoritative-style orphan drop).
function deserializeAutomations(raw, effects) {
  if (!Array.isArray(raw)) return [];
  const effectById = new Map(effects.map(e => [e.id, e]));
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || !a.target || typeof a.target !== 'object') continue;
    const kind = a.target.kind;
    let target;
    if (kind === 'volume' || kind === 'pan') {
      target = { kind };
    } else if (kind === 'fx') {
      const e = effectById.get(String(a.target.effectId));
      const meta = e ? EFFECT_DEFS[e.type]?.params?.[a.target.param] : null;
      if (!meta || !isAutomatableParam(meta)) continue; // orphan / non-automatable
      target = { kind: 'fx', effectId: e.id, param: String(a.target.param) };
    } else {
      continue;
    }
    out.push({ id: String(a.id), target, points: sanitizePoints(a.points) });
  }
  return out;
}

// Rebuild the project-level automation lanes (old projects → []). Only the
// tempo target exists today; unknown kinds are dropped defensively.
function deserializeGlobalAutomations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || a.target?.kind !== 'tempo') continue;
    out.push({ id: String(a.id), target: { kind: 'tempo' }, points: sanitizePoints(a.points) });
  }
  return out;
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
