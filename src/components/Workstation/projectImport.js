// Import another project into the current session as ONE new track group.
//
// Pure remap over a deserializeProject() output: counters in, advanced
// counters out — the caller mints eagerly in its event handler (never inside a
// setState updater; StrictMode double-invokes updaters). The duplicateTrack
// template generalized over N foreign tracks.
//
// Policy (deliberate, surfaced in the caller's toast):
// - The imported project's own groups are DISSOLVED — groups can't nest
//   (membership is a flat track.groupId), so every imported track joins the
//   single wrapper group and the foreign groups' bus volume/pan/FX/automations
//   are dropped.
// - Imported globalAutomations (tempo) are DROPPED — the host project's tempo
//   wins; note times are musical (beats/measures) so content adapts.
// - Regions keep their startMeasure (bar 1 = bar 1).
// - Custom-instrument ids (custom:<uuid>) are content-addressed, never
//   remapped — the caller registerInstruments()s the embedded defs.

export function remapProjectAsGroup(clean, {
  nextTrackId, nextRegionId, nextNoteId, nextEffectId, nextAutomationId, nextGroupId,
  groupColor,
}) {
  const srcTracks = clean.tracks ?? [];
  if (!srcTracks.length) return null;

  let trackN = nextTrackId, regionN = nextRegionId, noteN = nextNoteId;
  let effectN = nextEffectId, autoN = nextAutomationId;
  const groupN = nextGroupId;

  const group = {
    id: `g${groupN}`,
    name: clean.name ?? 'imported project',
    color: groupColor,
    isMuted: false, isSolo: false, volume: 75, pan: 0, effects: [], automations: [],
  };

  let droppedFxAutomations = 0;
  const trackIdMap = new Map(); // foreign trackId → fresh t<n>

  const tracks = srcTracks.map(src => {
    const newTrackId = `t${trackN++}`;
    trackIdMap.set(src.id, newTrackId);
    // Fresh effect ids are load-bearing (audio bypass delta-check keys on
    // them); the old→new map lets fx-target automations follow their effect.
    const effectIdMap = new Map();
    const effects = (src.effects ?? []).map(fx => {
      const nid = `e${effectN++}`;
      effectIdMap.set(fx.id, nid);
      return { ...fx, id: nid, params: { ...fx.params } };
    });
    const srcAutomations = src.automations ?? [];
    const automations = srcAutomations
      .filter(a => a.target?.kind !== 'fx' || effectIdMap.has(a.target.effectId))
      .map(a => ({
        id: `a${autoN++}`,
        target: a.target.kind === 'fx'
          ? { ...a.target, effectId: effectIdMap.get(a.target.effectId) }
          : { ...a.target },
        points: (a.points ?? []).map(p => ({ ...p })),
      }));
    droppedFxAutomations += srcAutomations.length - automations.length;
    return {
      ...src,
      id: newTrackId,
      effects,
      automations,
      groupId: group.id, // foreign groupId (if any) replaced by the wrapper's
    };
  });

  const regionIdMap = new Map(); // foreign regionId → fresh r<n>
  const regions = (clean.regions ?? [])
    .filter(r => trackIdMap.has(r.trackId))
    .map(r => {
      const id = `r${regionN++}`;
      regionIdMap.set(r.id, id);
      return { ...r, id, trackId: trackIdMap.get(r.trackId) };
    });

  // Select by region ownership (regionId is authoritative — the duplicateTrack
  // lesson); trackId reconciled to the owning region's new track. Glide stores
  // no target ids (connections resolve by adjacency) so it rides the spread.
  const regionTrackById = new Map(regions.map(r => [r.id, r.trackId]));
  const notes = (clean.notes ?? [])
    .filter(n => regionIdMap.has(n.regionId))
    .map(n => {
      const regionId = regionIdMap.get(n.regionId);
      return { ...n, id: `note_${noteN++}`, regionId, trackId: regionTrackById.get(regionId) };
    });

  const maxRegionEnd = regions.reduce(
    (max, r) => Math.max(max, (r.startMeasure ?? 0) + (r.durationMeasures ?? 0)), 0);

  return {
    group,
    tracks,
    regions,
    notes,
    maxRegionEnd,
    counters: {
      nextTrackId: trackN, nextRegionId: regionN, nextNoteId: noteN,
      nextEffectId: effectN, nextAutomationId: autoN, nextGroupId: groupN + 1,
    },
    warnings: {
      droppedGroups: (clean.groups ?? []).length,
      droppedTempoLanes: (clean.globalAutomations ?? []).length,
      droppedFxAutomations,
    },
  };
}
