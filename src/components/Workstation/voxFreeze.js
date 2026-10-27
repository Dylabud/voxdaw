// Photograph Vox Modular voice groups into sampled instruments (Vox Phases 130–132).
//
// The rack is a live graph (worklets, feedback, free-running LFOs) that cannot
// be rebuilt inside Tone.Offline, so the photograph is taken in REAL TIME:
// play one note at a time through the rack and record what comes out.
//
// PER I/O CHANNEL (Phase 132): every I/O input is its own Workstation track
// (Dylan's rule — what is mixed into one input is one sound), so the capture
// worklet takes all eight channel taps (post-fader, pre-master) on separate
// inputs, and the MASTER knob's gain is applied afterwards. A session runs:
//   1. probe — one short note per voice group (others muted) to learn which
//      channel(s) it reaches, against a measured silence baseline;
//   2. sweep — per pass (voxTakePlan.planPhotoPasses), every playing group
//      plays the same note at once and each recorded channel is sliced from
//      its own input. Normally ONE pass covers every track.
// A voice group is played "as its source" (useVoxAudio photo drivers): the
// keyboard through keyboardNoteOn, a 960 / chord voice by writing its VCOs'
// pitch directly and firing its GATE's envelopes.
//
// Capture: sample-accurate lossless PCM; a note's slice starts at its own gate
// time (analytic — a threshold scan would eat slow attacks). The worklet node
// MUST come from Tone.context.createAudioWorkletNode — rawContext is a
// standardized-audio-context wrapper (Hotfix 130b).
//
// One note every FREEZE_STEP semitones (Tone.Sampler repitches between), held
// FREEZE_HOLD_SEC, recorded until its release goes quiet.
//
// SILENT (Phase 131): the rack's speakerGate is muted for the session — every
// tap sits before it.
//
// SUSTAIN LOOPS (Phase 131): every steady note gets a seamless, pre-crossfaded
// loop in [LOOP_START, LOOP_END] (bakeSustainLoop) that VoxLoopSampler plays
// until the note's release; decaying notes get none.

import * as Tone from 'tone';

export const FREEZE_MIN_MIDI = 24;  // C1
export const FREEZE_MAX_MIDI = 96;  // C7
export const FREEZE_STEP     = 3;   // every 3rd semitone (Dylan's call) → 25 notes
export const FREEZE_MIDIS = Array.from(
  { length: Math.floor((FREEZE_MAX_MIDI - FREEZE_MIN_MIDI) / FREEZE_STEP) + 1 },
  (_, i) => FREEZE_MIN_MIDI + i * FREEZE_STEP,
);
export const FREEZE_HOLD_SEC = 4;

// Sustain loop window inside the 4 s hold — after a typical attack/decay has
// settled, and clear of the note-off at 4.0 s.
export const LOOP_START_SEC = 1.5;
export const LOOP_END_SEC   = 3.7;
export const LOOP_XF_SEC    = 0.3;
const LOOP_MIN_RMS    = 0.002;  // quieter than this = decayed out, nothing to sustain
const LOOP_STEADY_MIN = 0.7;    // second-half / first-half RMS within ≈ ±3 dB = steady
const LOOP_STEADY_MAX = 1.41;

// Probe: middle C held long enough for a slow-attack pad to speak.
const PROBE_MIDI      = 60;
const PROBE_HOLD_SEC  = 1.0;
const PROBE_TAIL_MAX  = 2;
const PROBE_MIN_PEAK  = 0.002;  // −54 dBFS: below this the group doesn't reach that input
const PROBE_OVER_BASE = 2;      // …and it must be ≥ 6 dB over that input's own floor
const PITCH_SETTLE_MS = 30;     // pitch written before the gate, so no note starts on the old pitch
// Rest-gated ("drone") detection, Phase 132b: a VCA whose GAIN rests open means the
// gate never ends the note — live, only a 960 REST step's VCO mute does. If a probe
// note is still ≥ 25 % of its held level PROBE_TAIL_MAX after its gate closed, that
// group's photo notes are ended by muting its VCOs (photoMute), the way a rest would.
const DRONE_TAIL_RATIO = 0.25;
const DRONE_WINDOW_SEC = 0.3;

const TAIL_MAX_SEC    = 4;      // a drone never goes quiet — stop listening here
const SETTLE_MAX_SEC  = 3;      // longest wait for the rack to go quiet before note 1
const SILENT          = 0.001;  // −60 dBFS
const QUIET_HOLD_SEC  = 0.25;   // this long below SILENT = the release has ended
const END_PAD_SEC     = 0.05;
const POLL_MS         = 50;
const CHUNK_FRAMES    = 4096;
const KBD = 'kbd-pitch-out';
// Each photographed note ends with this fade baked in (Phase 133): an unlooped note
// held to the end of its recording would otherwise stop mid-waveform — a click.
const END_FADE_SEC    = 0.01;

// Inline worklet: N stereo inputs (one per I/O channel), batched into
// CHUNK_FRAMES so the port carries ~12 messages a second, not ~375.
const WORKLET_SRC = `
class VoxFreezeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputsN = (options && options.processorOptions && options.processorOptions.inputs) || 1;
    this.alive = true;
    this.reset();
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  reset() {
    this.chans = [];
    for (let i = 0; i < this.inputsN; i++)
      this.chans.push([new Float32Array(${CHUNK_FRAMES}), new Float32Array(${CHUNK_FRAMES})]);
    this.n = 0;
    this.start = -1;
  }
  process(inputs) {
    if (!this.alive) return false;
    const first = inputs[0] && inputs[0][0];
    const frames = first ? first.length : 128;
    if (this.n + frames > ${CHUNK_FRAMES}) this.flush();
    if (this.start < 0) this.start = currentFrame;
    for (let i = 0; i < this.inputsN; i++) {
      const ch = inputs[i] || [];
      const l = ch[0];
      if (!l) continue;              // unconnected / silent input: the chunk stays zeros
      this.chans[i][0].set(l, this.n);
      this.chans[i][1].set(ch[1] || l, this.n);
    }
    this.n += frames;
    if (this.n >= ${CHUNK_FRAMES}) this.flush();
    return true;
  }
  flush() {
    if (this.n === 0) return;
    const transfer = [];
    for (const [l, r] of this.chans) transfer.push(l.buffer, r.buffer);
    this.port.postMessage({ start: this.start, n: this.n, chans: this.chans }, transfer);
    this.reset();
  }
}
registerProcessor('vox-freeze-capture', VoxFreezeCapture);
`;

const loadedContexts = new WeakSet();
// Shared with the audio take recorder (voxAudioTake.js, Phase 134).
export const CAPTURE_PROCESSOR = 'vox-freeze-capture';
export async function ensureWorklet(ctx) {
  if (loadedContexts.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  loadedContexts.add(ctx);
}

// Rolling store of captured multi-input chunks, addressed by context frame.
export class CaptureStore {
  constructor() { this.chunks = []; this.end = 0; }
  push({ start, n, chans }) {
    this.chunks.push({ start, n, chans });
    this.end = start + n;
  }
  dropBefore(frame) {
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].n <= frame) this.chunks.shift();
  }
  // Last frame ≥ from with |sample| > SILENT on any of `inputs`, or -1.
  lastLoud(from, inputs) {
    let best = -1;
    for (const k of inputs) {
      for (let c = this.chunks.length - 1; c >= 0; c--) {
        const { start, n, chans } = this.chunks[c];
        if (start + n <= Math.max(from, best + 1)) break;
        const [L, R] = chans[k];
        let hit = -1;
        for (let i = n - 1; i >= 0 && start + i >= from; i--) {
          if (Math.abs(L[i]) > SILENT || Math.abs(R[i]) > SILENT) { hit = start + i; break; }
        }
        if (hit >= 0) { if (hit > best) best = hit; break; }
      }
    }
    return best;
  }
  // Peak |sample| per input over [f0, f1).
  peaks(f0, f1, count) {
    const out = new Array(count).fill(0);
    for (const { start, n, chans } of this.chunks) {
      const a = Math.max(f0, start) - start;
      const b = Math.min(f1, start + n) - start;
      if (a >= b) continue;
      for (let k = 0; k < count; k++) {
        const [L, R] = chans[k];
        let p = out[k];
        for (let i = a; i < b; i++) {
          const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
          if (v > p) p = v;
        }
        out[k] = p;
      }
    }
    return out;
  }
  slice(f0, f1, k) {
    const len = Math.max(0, f1 - f0);
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (const { start, n, chans } of this.chunks) {
      const a = Math.max(f0, start);
      const b = Math.min(f1, start + n);
      if (a >= b) continue;
      L.set(chans[k][0].subarray(a - start, b - start), a - f0);
      R.set(chans[k][1].subarray(a - start, b - start), a - f0);
    }
    return { L, R };
  }
}

const rms = (arr, a, b) => {
  let sum = 0;
  for (let i = a; i < b; i++) sum += arr[i] * arr[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
};

// Pure: decide a note's sustain loop and bake its crossfade into L/R in place.
// Returns [loopStartSec, loopEndSec] or null (decaying / silent / too short).
export function bakeSustainLoop(L, R, sr) {
  const a = Math.round(LOOP_START_SEC * sr);
  const b = Math.round(LOOP_END_SEC * sr);
  const xf = Math.round(LOOP_XF_SEC * sr);
  if (b > L.length || a < xf || b - a <= xf) return null;
  const mid = (a + b) >> 1;
  const first  = Math.max(rms(L, a, mid), rms(R, a, mid));
  const second = Math.max(rms(L, mid, b), rms(R, mid, b));
  if (Math.max(first, second) < LOOP_MIN_RMS) return null;
  const ratio = second / Math.max(first, 1e-9);
  if (ratio < LOOP_STEADY_MIN || ratio > LOOP_STEADY_MAX) return null;
  // out[b - xf + i] = cos·self + sin·(the audio leading into a): at i = xf−1 the
  // signal IS the frame before `a`, so wrapping b → a continues it seamlessly.
  for (const ch of R === L ? [L] : [L, R]) {
    for (let i = 0; i < xf; i++) {
      const t = (i + 0.5) / xf;
      const g0 = Math.cos(t * Math.PI / 2);
      const g1 = Math.sin(t * Math.PI / 2);
      ch[b - xf + i] = ch[b - xf + i] * g0 + ch[a - xf + i] * g1;
    }
  }
  return [a / sr, b / sr];
}

const abortError = () => new DOMException('photograph cancelled', 'AbortError');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Open a photograph session on the live rack. `api` is the Vox Modular bridge
 * (Root voxApiRef). The session mutes the speakers, suspends glide and taps all
 * eight I/O channels until close(). The caller must keep the Transport stopped
 * (the rack's sequencers ride it) and must call close() in a finally.
 *
 *   probe(groups, { onEach })   → { routes: { [group]: [ch…] }, drones: Set(group) }
 *                                 routes = the channels each reaches; drones = groups
 *                                 whose sound doesn't stop when their gate closes
 *   sweep(passes, groups, drones, { onNote })
 *                               → Map(ch → { notes: [{ midi, buffer, loop }], release } | null)
 *                                 null = that channel stayed silent
 * Both reject AbortError when `signal` fires.
 */
export async function openPhotoSession(api, { signal } = {}) {
  const channels = api?.getIoChannels?.() ?? [];
  if (!channels.length) throw new Error('Vox Modular audio not available');
  const ctx = Tone.getContext().rawContext;
  await ensureWorklet(ctx);
  const sr = ctx.sampleRate;
  const N = channels.length;
  const idxOf = new Map(channels.map((c, i) => [c.ch, i]));
  const all = channels.map((_, i) => i);

  const store = new CaptureStore();
  const node = Tone.getContext().createAudioWorkletNode('vox-freeze-capture', {
    numberOfInputs: N, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { inputs: N },
  });
  node.port.onmessage = (e) => store.push(e.data);
  channels.forEach((c, i) => c.node.connect(node, 0, i));
  // An unconnected worklet may not be pulled by the render graph; its output is
  // silence, so the destination hears nothing from it.
  node.connect(ctx.destination);

  api.releaseAllKeys?.();
  api.setSpeakerMuted?.(true);
  const restoreGlide = api.suspendGlide?.();
  const masterGain = api.getMasterGain?.() ?? 1;
  const frameAt = (t) => Math.round(t * sr);
  let closed = false;

  const waitQuiet = async (from, maxFrame, inputs) => {
    for (;;) {
      await sleep(POLL_MS, signal);
      const loud = store.lastLoud(from, inputs);
      const lastLoud = loud < 0 ? from - 1 : loud;
      if (store.end >= maxFrame) return lastLoud;
      if (store.end - Math.max(from, lastLoud) >= QUIET_HOLD_SEC * sr) return lastLoud;
    }
  };
  // Until the capture has actually DELIVERED audio up to frame f. A fixed sleep can
  // read a window before its chunk arrives (lookAhead + chunk latency) and take
  // silence for the floor — caught by the photo harness, Phase 132b.
  const waitFrames = async (f) => {
    while (store.end < f) await sleep(POLL_MS, signal);
  };
  const settle = async () => {
    const t0 = Tone.now();
    await waitQuiet(frameAt(t0), frameAt(t0 + SETTLE_MAX_SEC), all);
  };

  // One note on several groups at once. Non-keyboard pitch goes first so no
  // gate opens on the previous pitch; the keyboard sets pitch + gate together.
  // photoNoteOn also opens each group's VCO gate (every group starts muted);
  // `mutes` = the rest-gated groups, closed again at note-off.
  const play = async (groups, midi, holdSec, mutes = null) => {
    for (const g of groups) if (g !== KBD) api.photoNoteOn(g, midi);
    await sleep(PITCH_SETTLE_MS, signal);
    const tOn = Tone.now();
    for (const g of groups) {
      if (g === KBD) api.photoNoteOn(g, midi);
      else           api.photoGate(g, true);
    }
    try {
      await sleep(holdSec * 1000, signal);
    } finally {
      for (const g of groups) {
        api.photoGate(g, false);
        api.photoNoteOff(g, midi);
        if (mutes?.has(g)) api.photoMute?.(g);
      }
    }
    return { fOn: frameAt(tOn), fOff: frameAt(Tone.now()) };
  };

  const probe = async (groups, { onEach } = {}) => {
    const routes = {};
    const drones = new Set();
    // Every recorded group starts MUTED and only the probed one opens, at its note
    // (photoNoteOn). Phase 132 measured the floor with the probed group already open,
    // so on a patch whose VCA rests open the floor WAS that group's drone, its note
    // never cleared it, and every part came back "reached no input" (Phase 132b).
    const restoreAll = api.setPhotoGroupLevels([], groups);
    try {
      await settle();
      for (const g of groups) {
        // This input's floor with every recorded part silent (a free-running drone,
        // noise) — a route must stand clear of it.
        const tB = Tone.now();
        await waitFrames(frameAt(tB + 0.15));
        const base = store.peaks(frameAt(tB), frameAt(tB + 0.15), N);
        store.dropBefore(frameAt(tB));
        const { fOn, fOff } = await play([g], PROBE_MIDI, PROBE_HOLD_SEC);
        const deadline = fOff + PROBE_TAIL_MAX * sr;
        await waitQuiet(fOff, deadline, all);
        const held = store.peaks(fOn + Math.round(0.3 * sr), fOff, N);
        const tail = store.peaks(deadline - Math.round(DRONE_WINDOW_SEC * sr), deadline, N);
        routes[g] = [];
        channels.forEach((c, i) => {
          const floor = Math.max(PROBE_MIN_PEAK, base[i] * PROBE_OVER_BASE);
          if (!(held[i] > floor)) return;
          routes[g].push(c.ch);
          if (tail[i] > floor && tail[i] >= held[i] * DRONE_TAIL_RATIO) drones.add(g);
        });
        api.photoMute?.(g);
        if (drones.has(g)) await waitQuiet(frameAt(Tone.now()), frameAt(Tone.now() + 1), all);
        onEach?.();
      }
    } finally {
      restoreAll();
    }
    return { routes, drones };
  };

  const sweep = async (passes, groups, drones = new Set(), { onNote } = {}) => {
    const raw = new Map(); // ch → [{ midi, L, R, tail }]
    for (const pass of passes) {
      const rec = pass.record.filter(ch => idxOf.has(ch));
      // All recorded groups muted; each playing group opens at its own note.
      const restore = api.setPhotoGroupLevels([], groups);
      try {
        await settle();
        for (const midi of FREEZE_MIDIS) {
          const { fOn, fOff } = await play(pass.play, midi, FREEZE_HOLD_SEC, drones);
          const inputs = rec.map(ch => idxOf.get(ch));
          const lastLoud = await waitQuiet(fOff, fOff + TAIL_MAX_SEC * sr, inputs);
          const fEnd = Math.min(fOff + TAIL_MAX_SEC * sr, Math.max(fOff, lastLoud) + END_PAD_SEC * sr);
          for (const ch of rec) {
            const k = idxOf.get(ch);
            const own = store.lastLoud(fOff, [k]);
            const { L, R } = store.slice(fOn, fEnd, k);
            if (!raw.has(ch)) raw.set(ch, []);
            raw.get(ch).push({ midi, L, R, tail: Math.max(0, ((own < 0 ? fOff : own) - fOff) / sr) });
          }
          store.dropBefore(fEnd);
          onNote?.();
        }
      } finally {
        restore();
      }
    }

    const out = new Map();
    for (const [ch, notes] of raw) {
      let anySound = false;
      let stereo = false;
      for (const { L, R } of notes) {
        for (let i = 0; i < L.length; i++) {
          L[i] *= masterGain;
          R[i] *= masterGain;
          if (!anySound && Math.abs(L[i]) > SILENT) anySound = true;
          if (!stereo && Math.abs(L[i] - R[i]) > 1e-4) stereo = true;
        }
      }
      if (!anySound) { out.set(ch, null); continue; }
      const built = notes.map(({ midi, L, R }) => {
        const loop = bakeSustainLoop(L, stereo ? R : L, sr);
        const fadeN = Math.min(L.length, Math.round(END_FADE_SEC * sr));
        for (let i = 0; i < fadeN; i++) {
          const g = i / fadeN;                       // 0 at the last sample → 1 fadeN back
          L[L.length - 1 - i] *= g;
          R[R.length - 1 - i] *= g;
        }
        const buffer = new AudioBuffer({ numberOfChannels: stereo ? 2 : 1, length: Math.max(1, L.length), sampleRate: sr });
        buffer.copyToChannel(L, 0);
        if (stereo) buffer.copyToChannel(R, 1);
        return { midi, buffer, loop };
      });
      // The Sampler's note-off fade: this sound's typical release, measured.
      const tails = notes.map(n => n.tail).sort((a, b) => a - b);
      const median = tails[Math.floor(tails.length / 2)] ?? 0.3;
      out.set(ch, { notes: built, release: Math.max(0.05, Math.min(3, median)) });
    }
    return out;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    api.releaseAllKeys?.();
    restoreGlide?.();
    api.setSpeakerMuted?.(false);
    channels.forEach((c, i) => { try { c.node.disconnect(node, 0, i); } catch (_) { /* already gone */ } });
    try { node.disconnect(); } catch (_) {}
    node.port.postMessage('stop');
    node.port.onmessage = null;
  };

  return { probe, sweep, close, channels };
}
