import { serializeProject, hashProjectData } from './projectIO';

function makeSession(overrides = {}) {
  return {
    bpm: 120,
    totalMeasures: 24,
    name: 'my song',
    globalAutomations: [],
    groups: [],
    customInstruments: [],
    tracks: [
      {
        id: 't1', name: 'track 1', instrument: 'fm pluck', color: '#f00',
        isMuted: false, isSolo: false, volume: 75, pan: 0, effects: [],
      },
    ],
    regions: [
      { id: 'r1', trackId: 't1', startMeasure: 0, durationMeasures: 4, clipOffset: 0 },
    ],
    notes: [
      { id: 'note_1', trackId: 't1', regionId: 'r1', note: 'C4', startBeat: 0, durationBeats: 1, velocity: 100 },
    ],
    ...overrides,
  };
}

describe('hashProjectData', () => {
  it('is stable: identical payloads hash identically across calls', () => {
    const a = hashProjectData(serializeProject(makeSession()));
    const b = hashProjectData(serializeProject(makeSession()));
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes when project content changes', () => {
    const base = hashProjectData(serializeProject(makeSession()));
    const edited = makeSession();
    edited.notes = [{ ...edited.notes[0], note: 'D4' }];
    expect(hashProjectData(serializeProject(edited))).not.toBe(base);
  });

  it('ignores the project name (renameProject patches data.name in place)', () => {
    const a = hashProjectData(serializeProject(makeSession({ name: 'my song' })));
    const b = hashProjectData(serializeProject(makeSession({ name: 'totally renamed' })));
    expect(a).toBe(b);
  });

  it('does not mutate the payload', () => {
    const payload = serializeProject(makeSession());
    hashProjectData(payload);
    expect(payload.name).toBe('my song');
  });
});
