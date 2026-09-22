import { remapProjectAsGroup } from './projectImport';

// Minimal deserializeProject-output fixture: two tracks (one carrying FX +
// automations + a foreign group), two regions, notes with velocity/glide,
// a foreign group and a tempo lane (both must be dropped).
function makeClean() {
  return {
    name: 'donor',
    bpm: 140,
    totalMeasures: 32,
    customInstruments: [],
    globalAutomations: [
      { id: 'a1', target: { kind: 'tempo' }, points: [{ time: 0, value: 140 }] },
    ],
    groups: [
      { id: 'g1', name: 'foreign group', color: '#abc', isMuted: false, isSolo: false, volume: 60, pan: 0.2, effects: [], automations: [] },
    ],
    tracks: [
      {
        id: 't1', name: 'lead', instrument: 'fm pluck', color: '#f00',
        isMuted: false, isSolo: false, volume: 80, pan: -0.5,
        effects: [
          { id: 'e1', type: 'delay', bypass: false, params: { time: 0.3 } },
          { id: 'e2', type: 'reverb', bypass: true, params: { roomSize: 0.5 } },
        ],
        automations: [
          { id: 'a2', target: { kind: 'volume' }, points: [{ time: 0, value: 0.5 }] },
          { id: 'a3', target: { kind: 'fx', effectId: 'e1', param: 'time' }, points: [{ time: 1, value: 0.2 }] },
          { id: 'a4', target: { kind: 'fx', effectId: 'eGone', param: 'x' }, points: [] }, // orphan
        ],
        groupId: 'g1',
        envelope: { attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4 },
        useSampled: true,
      },
      {
        id: 't2', name: 'bass', instrument: 'synth bass', color: '#0f0',
        isMuted: true, isSolo: false, volume: 70, pan: 0, effects: [], automations: [],
      },
    ],
    regions: [
      { id: 'r1', trackId: 't1', startMeasure: 4, durationMeasures: 8, clipOffset: 0 },
      { id: 'r2', trackId: 't2', startMeasure: 10, durationMeasures: 6, clipOffset: 0 },
      { id: 'rOrphan', trackId: 'tGone', startMeasure: 0, durationMeasures: 2, clipOffset: 0 },
    ],
    notes: [
      { id: 'note_1', trackId: 't1', regionId: 'r1', note: 'C4', startBeat: 0, durationBeats: 1, velocity: 90, glide: { endPitch: 'E4', tension: 0.5, connected: false } },
      { id: 'note_2', trackId: 't2', regionId: 'r2', note: 'E2', startBeat: 2, durationBeats: 2, velocity: 60 },
      // trackId desynced on purpose — regionId is authoritative:
      { id: 'note_3', trackId: 'tWrong', regionId: 'r1', note: 'G4', startBeat: 1, durationBeats: 1, velocity: 100 },
      { id: 'note_orphan', trackId: 't1', regionId: 'rGone', note: 'A4', startBeat: 0, durationBeats: 1, velocity: 100 },
    ],
  };
}

const COUNTERS = {
  nextTrackId: 5, nextRegionId: 7, nextNoteId: 10,
  nextEffectId: 3, nextAutomationId: 4, nextGroupId: 2,
  groupColor: '#5DCAA5',
};

describe('remapProjectAsGroup', () => {
  it('returns null for a project with no tracks', () => {
    expect(remapProjectAsGroup({ ...makeClean(), tracks: [] }, COUNTERS)).toBeNull();
  });

  it('mints fresh ids from the passed counters with no duplicates, and advances counters', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    expect(out.tracks.map(t => t.id)).toEqual(['t5', 't6']);
    expect(out.regions.map(r => r.id)).toEqual(['r7', 'r8']);
    expect(out.notes.map(n => n.id)).toEqual(['note_10', 'note_11', 'note_12']);
    expect(out.group.id).toBe('g2');
    const effectIds = out.tracks.flatMap(t => t.effects.map(e => e.id));
    expect(effectIds).toEqual(['e3', 'e4']);
    const autoIds = out.tracks.flatMap(t => t.automations.map(a => a.id));
    expect(new Set(autoIds).size).toBe(autoIds.length);
    expect(out.counters).toEqual({
      nextTrackId: 7, nextRegionId: 9, nextNoteId: 13,
      nextEffectId: 5, nextAutomationId: 6, nextGroupId: 3,
    });
  });

  it('wraps every track in the new group and dissolves foreign groups', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    expect(out.tracks.every(t => t.groupId === out.group.id)).toBe(true);
    expect(out.group).toMatchObject({
      name: 'donor', color: '#5DCAA5',
      isMuted: false, isSolo: false, volume: 75, pan: 0, effects: [], automations: [],
    });
    expect(out.warnings.droppedGroups).toBe(1);
    expect(out.warnings.droppedTempoLanes).toBe(1);
  });

  it('selects notes by region ownership and reconciles trackId to the owning region', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    // orphan region (dead trackId) and orphan note (dead regionId) are dropped
    expect(out.regions).toHaveLength(2);
    expect(out.notes).toHaveLength(3);
    const desynced = out.notes.find(n => n.note === 'G4');
    expect(desynced.regionId).toBe('r7');       // r1 → r7
    expect(desynced.trackId).toBe('t5');        // reconciled to r1's track, not 'tWrong'
  });

  it('remaps fx-target automations through the new effect ids and drops orphans', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    const lead = out.tracks[0];
    expect(lead.automations).toHaveLength(2);   // orphan a4 dropped
    const fxLane = lead.automations.find(a => a.target.kind === 'fx');
    expect(fxLane.target.effectId).toBe('e3');  // e1 → e3
    expect(out.warnings.droppedFxAutomations).toBe(1);
  });

  it('preserves envelope, useSampled, velocity, and glide through the remap', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    const lead = out.tracks[0];
    expect(lead.envelope).toEqual({ attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4 });
    expect(lead.useSampled).toBe(true);
    const glideNote = out.notes.find(n => n.note === 'C4');
    expect(glideNote.velocity).toBe(90);
    expect(glideNote.glide).toEqual({ endPitch: 'E4', tension: 0.5, connected: false });
  });

  it('reports the rightmost region end and keeps startMeasure untouched', () => {
    const out = remapProjectAsGroup(makeClean(), COUNTERS);
    expect(out.regions.map(r => r.startMeasure)).toEqual([4, 10]);
    expect(out.maxRegionEnd).toBe(16); // 10 + 6
    const empty = remapProjectAsGroup({ ...makeClean(), regions: [], notes: [] }, COUNTERS);
    expect(empty.maxRegionEnd).toBe(0);
  });
});
