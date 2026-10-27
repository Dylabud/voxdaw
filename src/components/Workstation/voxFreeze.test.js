/**
 * The REAL photo session (voxFreeze.openPhotoSession) run against a simulated
 * Vox rack in virtual time (Vox Phase 132b). The photograph only ever runs in a
 * browser, and it has shipped broken twice where no build or unit test could see
 * it (130b: native worklet node; 132: a droning sequencer part "reached no
 * input"), so this pins its whole probe → route → sweep behaviour.
 *
 * Simulated rack: 8 I/O channels at 8 kHz.
 *   seq-pitch-out       → IN 1, VCA rests OPEN — only its VCO mute ends a note
 *   kbd-pitch-out       → IN 2, envelope-gated (τ = 0.1 s release)
 *   chordseq-root/3rd   → IN 5, envelope-gated, sharing one input
 *   a free 60 Hz hum on IN 3 that belongs to no recorded part
 */

// Shared with the hoisted jest.mock factory (only `mock`-prefixed names may be).
const mockEnv = { vt: 0, node: null, SR: 8000, LOOK: 0.1 };
const SR = mockEnv.SR;
const CH = 4096;
const timers = [];
let genFrame = 0;

jest.mock('tone', () => ({
  now: () => mockEnv.vt + mockEnv.LOOK,
  getContext: () => ({
    rawContext: { sampleRate: mockEnv.SR, audioWorklet: { addModule: async () => {} }, destination: {} },
    createAudioWorkletNode: (_n, o) => {
      mockEnv.node = { N: o.numberOfInputs, port: { onmessage: null, postMessage() {} }, connect() {}, disconnect() {} };
      return mockEnv.node;
    },
  }),
}));

// eslint-disable-next-line import/first
import { openPhotoSession, FREEZE_MIDIS } from './voxFreeze';

const GROUPS = {
  'seq-pitch-out':     { ch: [1], drone: true },
  'kbd-pitch-out':     { ch: [2], drone: false },
  'chordseq-root-out': { ch: [5], drone: false },
  'chordseq-3rd-out':  { ch: [5], drone: false },
};
let st;
const valAt = (ev, t) => { let v = ev[0][1]; for (const [tt, x] of ev) if (tt <= t) v = x; return v; };
const lastOff = (ev, t) => {
  let off = -1; let prev = 0;
  for (const [tt, x] of ev) { if (tt > t) break; if (prev === 1 && x === 0) off = tt; prev = x; }
  return off;
};
const amp = (g, t) => {
  const s = st[g];
  if (!valAt(s.bus, t)) return 0;
  if (GROUPS[g].drone || valAt(s.gate, t)) return 0.3;
  const off = lastOff(s.gate, t);
  return off < 0 ? 0 : 0.3 * Math.exp(-(t - off) / 0.1);
};
const sample = (ch, f) => {
  const t = f / SR;
  let v = ch === 3 ? 0.01 * Math.sin(2 * Math.PI * 60 * t) : 0;
  for (const g in GROUPS) if (GROUPS[g].ch.includes(ch)) v += amp(g, t) * Math.sin(2 * Math.PI * st[g].hz * t);
  return v;
};
const at = () => mockEnv.vt + mockEnv.LOOK;
const api = {
  getIoChannels: () => [1, 2, 3, 4, 5, 6, 7, 8].map(c => ({ ch: c, label: `IN ${c}`, node: { connect() {}, disconnect() {} } })),
  releaseAllKeys() {}, setSpeakerMuted: jest.fn(), suspendGlide: () => () => {}, getMasterGain: () => 1,
  setPhotoGroupLevels(open, mute) {
    const saved = []; const t = at();
    for (const g of [...open, ...mute]) { saved.push([g, valAt(st[g].bus, t)]); st[g].bus.push([t, open.includes(g) ? 1 : 0]); }
    return () => { const t2 = at(); for (const [g, v] of saved) st[g].bus.push([t2, v]); };
  },
  // Mirrors the engine (Phase 133): the keyboard opens its VCOs with its note; a
  // sequencer group's VCOs open with its GATE, not with the early pitch write.
  photoNoteOn(g, midi) {
    const t = at();
    st[g].hz = 440 * 2 ** ((midi - 69) / 12) / 4;
    if (g === 'kbd-pitch-out') { st[g].bus.push([t, 1]); st[g].gate.push([t, 1]); }
  },
  photoNoteOff(g) { if (g === 'kbd-pitch-out') st[g].gate.push([at(), 0]); },
  photoGate(g, down) {
    if (g === 'kbd-pitch-out') return;
    if (down) st[g].bus.push([at(), 1]);
    st[g].gate.push([at(), down ? 1 : 0]);
  },
  photoMute(g) { st[g].bus.push([at(), 0]); },
};

const pump = (toT) => {
  const node = mockEnv.node;
  while (node && genFrame + CH <= Math.floor(toT * SR)) {
    const chans = [];
    for (let k = 0; k < node.N; k++) {
      const L = new Float32Array(CH);
      for (let i = 0; i < CH; i++) L[i] = sample(k + 1, genFrame + i);
      chans.push([L, L.slice()]);
    }
    node.port.onmessage?.({ data: { start: genFrame, n: CH, chans } });
    genFrame += CH;
  }
};
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
// Drive a promise to completion by running the code's own timers in virtual time.
const run = async (promise) => {
  let done = false; let val; let err;
  promise.then(v => { done = true; val = v; }, e => { done = true; err = e; });
  for (;;) {
    await flush();
    if (done) break;
    timers.sort((a, b) => a.t - b.t);
    const h = timers.shift();
    if (!h) throw new Error('photo session stalled');
    pump(h.t);
    mockEnv.vt = h.t;
    h.fn();
  }
  if (err) throw err;
  return val;
};

let realSetTimeout; let realClearTimeout;
beforeAll(() => {
  realSetTimeout = global.setTimeout;
  realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => { const h = { t: mockEnv.vt + ms / 1000, fn }; timers.push(h); return h; };
  global.clearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  global.URL.createObjectURL = () => 'blob:x';
  global.URL.revokeObjectURL = () => {};
  global.AudioBuffer = class { constructor(o) { Object.assign(this, o); this.ch = []; } copyToChannel(a, c) { this.ch[c] = a; } };
  st = Object.fromEntries(Object.keys(GROUPS).map(g => [g, { bus: [[0, 1]], gate: [[0, 0]], hz: 220 }]));
});
afterAll(() => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; });

describe('photo session on a simulated rack', () => {
  let session; let probed;

  it('probe finds every part\'s input — including a droning (rest-gated) sequencer part', async () => {
    session = await run(openPhotoSession(api, {}));
    expect(api.setSpeakerMuted).toHaveBeenLastCalledWith(true); // silent photograph
    probed = await run(session.probe(Object.keys(GROUPS)));
    expect(probed.routes).toEqual({
      'seq-pitch-out': [1], 'kbd-pitch-out': [2],
      'chordseq-root-out': [5], 'chordseq-3rd-out': [5],
    });
    expect([...probed.drones]).toEqual(['seq-pitch-out']); // only the open-VCA part
  });

  it('one pass photographs every input; enveloped notes keep their release, rest-gated ones end', async () => {
    const passes = [{ play: ['seq-pitch-out', 'kbd-pitch-out', 'chordseq-root-out'], record: [1, 2, 5] }];
    const res = await run(session.sweep(passes, Object.keys(GROUPS), probed.drones));
    session.close();
    expect(api.setSpeakerMuted).toHaveBeenLastCalledWith(false); // speakers back
    for (const ch of [1, 2, 5]) {
      const r = res.get(ch);
      expect(r.notes.map(n => n.midi)).toEqual(FREEZE_MIDIS);
      const secs = r.notes[12].buffer.length / SR;
      expect(secs).toBeGreaterThan(4);
      expect(secs).toBeLessThan(5.2);           // not a never-ending drone tail
      expect(r.notes[12].loop).toEqual([1.5, 3.7]);
      // Every note ends on a baked fade — never mid-waveform (Phase 133).
      const L = r.notes[12].buffer.ch[0];
      expect(Math.abs(L[L.length - 1])).toBeLessThan(1e-3);
      // …and a rest-gated note starts at its gate, not ~30 ms early: its first
      // millisecond is the very beginning of the note, which the playback fade-in softens.
      if (ch === 1) {
        let early = 0;
        for (let i = 0; i < Math.round(0.02 * SR); i++) early = Math.max(early, Math.abs(L[i]));
        expect(early).toBeGreaterThan(0);          // the note IS there from its onset
      }
    }
    expect(res.get(1).release).toBeCloseTo(0.05, 2);       // muted like a REST step
    expect(res.get(2).release).toBeGreaterThan(0.3);        // the envelope's own fade
    expect(res.get(3)).toBeUndefined();                     // the hum input was never recorded
  }, 60000);
});
