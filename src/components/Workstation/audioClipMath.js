// Audio clips on the Workstation timeline (Vox Phase 134) — pure, Tone-free,
// unit-tested (audioClipMath.test.js). Shared by live playback
// (useWorkstationAudio), the offline bounce (audioBounce) and the region
// waveform drawing (WorkstationShell).
//
// An AUDIO REGION is an ordinary region carrying `audio: { clipId, secPerMeasure }`.
// It obeys the same Bottle/Window model as a note region: the clip is the bottle
// (bottle measure b ↔ clip second b · secPerMeasure — the take's tempo, frozen at
// record time, so later tempo edits never stretch the audio), clipOffset slides
// the window, loopInterval/loopPhase tile it. So move / trim / split / loop /
// fade / copy / duplicate all work through the existing region code unchanged.

export const AUDIO_INSTRUMENT = 'audio';
export const isAudioTrack  = (t) => t?.instrument === AUDIO_INSTRUMENT;
export const isAudioRegion = (r) => typeof r?.audio?.clipId === 'string';
// Clip ids (voxClipStore keys) — `voxclip:` never shares a key range with a
// `vox:` / `custom:` instrument's samples.
const CLIP_PREFIX = 'voxclip:';
export const isClipId = (id) => typeof id === 'string' && id.startsWith(CLIP_PREFIX);
export const mintClipId = () => `${CLIP_PREFIX}${crypto.randomUUID()}`;

// Region-local measure spans and the bottle measure each one starts on.
// → [{ x0, x1, b0 }]   x in [0, durationMeasures), b0 = bottle measure at x0
export function audioRegionSegments(r) {
  const D  = r.durationMeasures;
  const co = r.clipOffset ?? 0;
  const li = r.loopInterval;
  if (!(D > 0)) return [];
  if (li == null || !(li > 0)) return [{ x0: 0, x1: D, b0: co }];
  const out = [];
  let h = (((r.loopPhase ?? 0) % li) + li) % li; // home-cycle position at the left edge
  for (let x = 0; x < D - 1e-9; h = 0) {
    const x1 = Math.min(D, x + (li - h));
    out.push({ x0: x, x1, b0: co + h });
    x = x1;
  }
  return out;
}

// When and what to play, in TRANSPORT seconds through the tempo map.
//   map: tempoMath buildTempoMap result (secondsAtMeasure)
//   clipDurSec: the clip's length
// → [{ startSec, endSec, offsetSec }] — skips window parts outside the clip
// (a window slid before the clip start or past its end plays silence there).
export function audioRegionPlan(r, map, clipDurSec) {
  if (!isAudioRegion(r) || r.isMuted) return [];
  const spm = r.audio.secPerMeasure;
  if (!(spm > 0) || !(clipDurSec > 0)) return [];
  const out = [];
  for (const { x0, x1, b0 } of audioRegionSegments(r)) {
    let startSec = map.secondsAtMeasure(r.startMeasure + x0);
    const endSec = map.secondsAtMeasure(r.startMeasure + x1);
    let offsetSec = b0 * spm;
    if (offsetSec < 0) { startSec -= offsetSec; offsetSec = 0; } // window starts before the clip
    const dur = Math.min(endSec - startSec, clipDurSec - offsetSec);
    if (dur <= 1e-4) continue;
    out.push({ startSec, endSec: startSec + dur, offsetSec });
  }
  return out;
}

// Waveform overview: the peak |sample| of every `binSec` slice, all channels.
export function computePeaks(channels, sampleRate, binSec = 0.02) {
  const len = channels[0]?.length ?? 0;
  const bin = Math.max(1, Math.round(binSec * sampleRate));
  const out = new Float32Array(Math.ceil(len / bin));
  for (const ch of channels) {
    for (let b = 0, i = 0; b < out.length; b++) {
      let p = out[b];
      const end = Math.min(len, i + bin);
      for (; i < end; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > p) p = v;
      }
      out[b] = p;
    }
  }
  return out;
}

const SILENT_CHUNK = 1e-4;    // −80 dBFS: a chunk this quiet is stored as nothing
export const SILENT_CLIP = 0.001; // −60 dBFS: a whole channel this quiet makes no track

// Collects a live multi-input capture (the vox-freeze-capture worklet's chunks:
// { start, n, chans: [[L, R] per input] }) into one clip per input, from
// `startFrame`. Memory stays proportional to what was actually PLAYED: a silent
// chunk is kept as nothing and a chunk whose L === R keeps one channel — so the
// eight I/O taps cost almost nothing when only one or two are in use.
// gain: the MASTER knob's gain (one number, or one per input — the rack's own
// output tap already carries it, so it gets 1), applied per chunk as a ramp from
// the previous chunk's value to this one's (a knob turn mid-take is recorded
// smoothly, never as a step).
export class ClipAccumulator {
  constructor(inputs, startFrame) {
    this.inputs = inputs;
    this.startFrame = startFrame;
    this.lastGain = null;
    this.chunks = Array.from({ length: inputs }, () => []); // per input: [{ at, L, R|null }]
    this.end = startFrame;
  }

  push({ start, n, chans }, gainIn = 1) {
    const gains = Array.isArray(gainIn) ? gainIn : new Array(this.inputs).fill(gainIn);
    const prev = this.lastGain ?? gains;
    this.lastGain = gains;
    const from = Math.max(0, this.startFrame - start);
    if (from >= n) return;
    const len = n - from;
    const at = start + from - this.startFrame;
    this.end = Math.max(this.end, start + n);
    for (let k = 0; k < this.inputs; k++) {
      const [l, r] = chans[k] ?? [];
      if (!l) continue;
      const g0 = prev[k] ?? 1;
      const gain = gains[k] ?? 1;
      let peak = 0;
      let stereo = false;
      for (let i = from; i < n; i++) {
        const a = l[i] < 0 ? -l[i] : l[i];
        if (a > peak) peak = a;
        if (!stereo && r && Math.abs(l[i] - r[i]) > 1e-5) stereo = true;
      }
      if (peak * Math.max(g0, gain) < SILENT_CHUNK && !stereo) continue;
      const L = l.slice(from, n);
      const R = stereo ? r.slice(from, n) : null;
      for (let i = 0; i < len; i++) {
        const g = g0 + (gain - g0) * ((i + 1) / len);
        L[i] *= g;
        if (R) R[i] *= g;
      }
      this.chunks[k].push({ at, L, R });
    }
  }

  // → Map(input index → { channels: [Float32Array…], peak }) for every input
  // louder than SILENT_CLIP over [startFrame, endFrame).
  finish(endFrame) {
    const total = Math.max(0, endFrame - this.startFrame);
    const out = new Map();
    for (let k = 0; k < this.inputs; k++) {
      const list = this.chunks[k];
      if (!list.length || !total) continue;
      const stereo = list.some(c => c.R);
      const L = new Float32Array(total);
      const R = stereo ? new Float32Array(total) : null;
      let peak = 0;
      for (const { at, L: cl, R: cr } of list) {
        if (at >= total) continue;
        const m = Math.min(cl.length, total - at);
        L.set(cl.subarray(0, m), at);
        if (R) R.set((cr ?? cl).subarray(0, m), at);
        for (let i = 0; i < m; i++) {
          const a = Math.max(cl[i] < 0 ? -cl[i] : cl[i], cr ? Math.abs(cr[i]) : 0);
          if (a > peak) peak = a;
        }
      }
      if (peak < SILENT_CLIP) continue;
      out.set(k, { channels: R ? [L, R] : [L], peak });
    }
    this.chunks = [];
    return out;
  }
}

// Mono (L+R)/2 of a clip's channels, or the sum of several clips.
export function monoSum(clips, length) {
  const out = new Float32Array(length);
  for (const { channels } of clips) {
    const w = 1 / channels.length;
    for (const ch of channels) for (let i = 0, n = Math.min(length, ch.length); i < n; i++) out[i] += ch[i] * w;
  }
  return out;
}

// How the rack's OUTPUT differs from the plain sum of its inputs — the MASTER
// limiter (a DynamicsCompressor: a few ms of look-ahead delay, an automatic
// make-up gain, and gain reduction on peaks). Measured on the loudest second:
//   lag  = the delay (frames, 0–20 ms) that best lines the sum up with the output
//   gain = least-squares level match on the samples the limiter didn't squash
//   limited = whether the sum ever went over the limiter's threshold (−1 dBFS)
// → { lag, gain, limited }. No usable signal → { lag: 0, gain: 1 }.
export const LIMIT_THRESHOLD = 0.891; // −1 dBFS (useVoxAudio masterLimit)
export function matchToOutput(sum, out, sampleRate) {
  const n = Math.min(sum.length, out.length);
  let limited = false;
  for (let i = 0; i < n && !limited; i++) if (Math.abs(sum[i]) > LIMIT_THRESHOLD) limited = true;
  const win = Math.min(n, Math.round(sampleRate));
  const maxLag = Math.round(0.02 * sampleRate);
  if (win < maxLag * 4) return { lag: 0, gain: 1, limited };
  // Loudest window of the sum, in quarter-second steps.
  const hop = Math.max(1, Math.round(sampleRate / 4));
  let best = 0, bestE = -1;
  for (let a = 0; a + win <= n - maxLag; a += hop) {
    let e = 0;
    for (let i = a; i < a + win; i += 4) e += sum[i] * sum[i];
    if (e > bestE) { bestE = e; best = a; }
  }
  if (bestE <= 1e-6) return { lag: 0, gain: 1, limited };
  let lag = 0, bestC = -Infinity;
  for (let L = 0; L <= maxLag; L++) {
    let c = 0;
    for (let i = best; i < best + win; i += 2) c += sum[i] * out[i + L];
    if (c > bestC) { bestC = c; lag = L; }
  }
  let num = 0, den = 0;
  for (let i = best; i < best + win; i++) {
    const p = sum[i];
    if (Math.abs(p) >= LIMIT_THRESHOLD * 0.9) continue; // the limiter's work, not its make-up
    num += p * out[i + lag];
    den += p * p;
  }
  const gain = den > 1e-9 ? num / den : 1;
  return { lag, gain: gain > 0.25 && gain < 4 ? gain : 1, limited };
}
