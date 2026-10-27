/**
 * MIDI export (Phase 159): the file is parsed back with a minimal reader and
 * checked note by note — timing, length, velocity, channel, drum mapping — and
 * a tempo ramp's events must put every 16th at the time the Workstation plays it.
 */
import { buildMidiFile, noteToMidi, unrollRegionNotes, gmDrumNote, midiTrackIdsForProject, MIDI_PPQ } from './midiExport';
import { buildTempoMap } from './tempoMath';

// ── Minimal Standard MIDI File reader ──
function parseMidi(bytes) {
  let p = 0;
  const str = (n) => String.fromCharCode(...bytes.slice(p, p += n));
  const u32 = () => (bytes[p++] << 24 | bytes[p++] << 16 | bytes[p++] << 8 | bytes[p++]) >>> 0;
  const u16 = () => (bytes[p++] << 8) | bytes[p++];
  const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  expect(str(4)).toBe('MThd');
  expect(u32()).toBe(6);
  const format = u16(); const ntrks = u16(); const division = u16();
  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    expect(str(4)).toBe('MTrk');
    const end = u32() + p;
    const evs = [];
    let tick = 0;
    while (p < end) {
      tick += vlq();
      const st = bytes[p++];
      if (st === 0xff) {
        const type = bytes[p++]; const len = vlq();
        evs.push({ tick, meta: type, data: [...bytes.slice(p, p += len)] });
      } else {
        const kind = st & 0xf0; const ch = st & 0x0f;
        const n = kind === 0xc0 ? 1 : 2;
        evs.push({ tick, kind, ch, data: [...bytes.slice(p, p += n)] });
      }
    }
    tracks.push(evs);
  }
  return { format, ntrks, division, tracks };
}
const notesOf = (evs) => {
  const open = new Map(); const out = [];
  for (const e of evs) {
    if (e.kind === 0x90) open.set(e.data[0], e);
    if (e.kind === 0x80) { const on = open.get(e.data[0]); open.delete(e.data[0]); out.push({ key: e.data[0], on: on.tick, off: e.tick, vel: on.data[1], ch: on.ch }); }
  }
  return out.sort((a, b) => a.on - b.on || a.key - b.key);
};
const nameOf = (evs) => String.fromCharCode(...evs.find(e => e.meta === 0x03).data);

const base = {
  name: 'song', bpm: 120, globalAutomations: [],
  tracks: [
    { id: 't1', name: 'Keys', instrument: 'piano' },
    { id: 't2', name: 'Beat', instrument: 'drums 808' },
    { id: 't3', name: 'Empty', instrument: 'analog' },
  ],
  regions: [
    { id: 'r1', trackId: 't1', startMeasure: 1, durationMeasures: 2, clipOffset: 0, loopInterval: null },
    { id: 'r2', trackId: 't2', startMeasure: 0, durationMeasures: 1, clipOffset: 0, loopInterval: null },
  ],
  notes: [
    { id: 'n1', regionId: 'r1', trackId: 't1', note: 'C4', startBeat: 0, durationBeats: 1, velocity: 120 },
    { id: 'n2', regionId: 'r1', trackId: 't1', note: 'E4', startBeat: 2.5, durationBeats: 9, velocity: 60 }, // clipped at the region end
    { id: 'n3', regionId: 'r2', trackId: 't2', note: 'C4', startBeat: 0, durationBeats: 0.25 },
    { id: 'n4', regionId: 'r2', trackId: 't2', note: 'D5', startBeat: 1, durationBeats: 0.25 },
  ],
};

describe('MIDI export', () => {
  it('note names', () => {
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('A4')).toBe(69);
    expect(noteToMidi('Bb3')).toBe(58);
    expect(noteToMidi('C-1')).toBe(0);
    expect(noteToMidi('C-2')).toBeNull();
    expect(gmDrumNote('drums 808', 'C4')).toBe(36);
    expect(gmDrumNote('drums 808', 'D5')).toBe(39);      // clap
    expect(gmDrumNote('drums acoustic', 'D5')).toBe(56); // cowbell
  });

  it('writes a Type-1 file: conductor + one track per track with notes', () => {
    const { bytes, trackCount, noteCount } = buildMidiFile({ ...base, trackIds: ['t1', 't2', 't3'] });
    expect(trackCount).toBe(2);
    expect(noteCount).toBe(4);
    const f = parseMidi(bytes);
    expect(f).toMatchObject({ format: 1, ntrks: 3, division: MIDI_PPQ });
    expect(nameOf(f.tracks[0])).toBe('song');
    const tempo = f.tracks[0].find(e => e.meta === 0x51).data;
    expect((tempo[0] << 16) | (tempo[1] << 8) | tempo[2]).toBe(500000); // 120 bpm
    expect(f.tracks[0].find(e => e.meta === 0x58).data).toEqual([4, 2, 24, 8]);

    expect(nameOf(f.tracks[1])).toBe('Keys');
    expect(f.tracks[1].find(e => e.kind === 0xc0).data).toEqual([0]); // piano
    const keys = notesOf(f.tracks[1]);
    expect(keys).toEqual([
      { key: 60, on: 4 * MIDI_PPQ, off: 5 * MIDI_PPQ, vel: 127, ch: 0 },
      { key: 64, on: 6.5 * MIDI_PPQ, off: 12 * MIDI_PPQ, vel: 64, ch: 0 }, // ends with its region (bar 3)
    ]);

    const beat = notesOf(f.tracks[2]);
    expect(beat.map(n => [n.key, n.ch])).toEqual([[36, 9], [39, 9]]); // channel 10, GM kick + clap
    expect(f.tracks[2].some(e => e.kind === 0xc0)).toBe(false);
  });

  it('loops and windows unroll exactly like playback', () => {
    const r = { id: 'r', startMeasure: 2, durationMeasures: 3, clipOffset: 1, loopInterval: 1, loopPhase: 0 };
    const notes = [
      { regionId: 'r', note: 'C4', startBeat: 4, durationBeats: 1 },   // in the window (bar 1 of the bottle)
      { regionId: 'r', note: 'D4', startBeat: 0, durationBeats: 1 },   // outside the window: hidden
    ];
    expect(unrollRegionNotes(r, notes).map(n => n.startB)).toEqual([8, 12, 16]);
    expect(unrollRegionNotes({ ...r, isMuted: true }, notes)).toEqual([]);
  });

  it('a tempo ramp lands every 16th at the Workstation\'s time', () => {
    const autos = [{ target: { kind: 'tempo' }, points: [{ time: 0, value: (100 - 40) / 200 }, { time: 4, value: (180 - 40) / 200 }] }];
    const { bytes } = buildMidiFile({ ...base, globalAutomations: autos, trackIds: ['t1'],
      regions: [{ ...base.regions[0], durationMeasures: 6 }] });
    const tempos = parseMidi(bytes).tracks[0].filter(e => e.meta === 0x51)
      .map(e => ({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }));
    expect(tempos.length).toBeGreaterThan(60);
    const map = buildTempoMap(120, autos[0].points);
    const secAtTick = (tick) => {
      let sec = 0;
      for (let i = 0; i < tempos.length; i++) {
        const t0 = tempos[i].tick; const t1 = i + 1 < tempos.length ? Math.min(tempos[i + 1].tick, tick) : tick;
        if (t1 <= t0) break;
        sec += ((t1 - t0) / MIDI_PPQ) * tempos[i].us / 1e6;
      }
      return sec;
    };
    for (const m of [0.5, 1.25, 3, 4, 5.5]) {
      expect(secAtTick(m * 4 * MIDI_PPQ)).toBeCloseTo(map.secondsAtMeasure(m), 4);
    }
  });

  it('a project export follows mute / solo and leaves audio tracks out', () => {
    const tracks = [
      { id: 'a', instrument: 'piano' }, { id: 'b', instrument: 'piano', isMuted: true },
      { id: 'c', instrument: 'audio' }, { id: 'd', instrument: 'piano', groupId: 'g' },
    ];
    expect(midiTrackIdsForProject(tracks, [{ id: 'g', isMuted: true }])).toEqual(['a']);
    expect(midiTrackIdsForProject(tracks.map(t => t.id === 'd' ? { ...t, isSolo: true } : t), [{ id: 'g' }])).toEqual(['d']);
  });
});
