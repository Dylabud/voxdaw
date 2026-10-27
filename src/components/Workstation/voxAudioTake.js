// Audio takes of the Vox Modular (Vox Phase 134).
//
// A NOTES take (Phases 130–133) photographs the patch once, at the end — so it
// can't hold what you do to the rack WHILE it plays. An AUDIO take records the
// rack itself, live: every knob turn, patch change and filter sweep is in the
// recording, exactly as heard. The cost: it's audio, so its notes can't be edited.
//
// Same taps as the photograph (voxFreeze): the capture worklet on all eight I/O
// channels, post-fader and pre-master, on separate inputs. So every I/O input
// played during the take becomes ONE audio track (Dylan's rule), and the MASTER
// knob's moves are applied to each as a smooth per-chunk ramp. Sample-accurate
// and lossless; frames are context frames, so a take placed at the Transport
// time it started lines up with the backing exactly.
//
// The speakers stay ON (this is a live performance) and nothing is muted.
//
// SAME SOUND AS LIVE (Phase 134b). A ninth input records the rack's OUTPUT —
// voxBus, after MASTER and its limiter, exactly what the speakers get. A take
// that used ONE input (the usual case) becomes that output itself: identical to
// what you heard, limiter, make-up gain and its few ms of look-ahead included.
// A take that used several inputs keeps one track per input (Dylan's rule), each
// lined up and level-matched to the output (matchToOutput), so their sum sounds
// like the rack; only peaks the limiter squashed can't be split per input, and
// the take says so (`limited`).

import * as Tone from 'tone';
import { ensureWorklet, CAPTURE_PROCESSOR } from './voxFreeze';
import { ClipAccumulator, monoSum, matchToOutput } from './audioClipMath';

const POLL_MS = 50;
const DRAIN_MAX_MS = 3000; // the last chunk is ≤ 4096 frames late; never hang a stop

/**
 * Open a recording on the live rack. Taps are live from now, but nothing is kept
 * until begin(frame). Call finish() or cancel() exactly once.
 *   begin(startFrame)
 *   finish(endFrame) → Promise<{ clips: Map(ioChannel → { channels: [Float32Array…], peak }),
 *                                limited }>   (only inputs that actually carried sound)
 *   cancel()
 */
export async function openAudioCapture(api) {
  const channels = api?.getIoChannels?.() ?? [];
  if (!channels.length) throw new Error('Vox Modular audio not available');
  const ctx = Tone.getContext().rawContext;
  await ensureWorklet(ctx);
  const sampleRate = ctx.sampleRate;
  const output = api.getBusNode?.() ?? null;   // post-MASTER, post-limiter tap
  const N = channels.length + (output ? 1 : 0); // inputs 0..7 = I/O channels, 8 = output
  const OUT = output ? channels.length : -1;

  let acc = null;
  let delivered = 0; // context frame the capture has reached
  const node = Tone.getContext().createAudioWorkletNode(CAPTURE_PROCESSOR, {
    numberOfInputs: N, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { inputs: N },
  });
  node.port.onmessage = (e) => {
    delivered = e.data.start + e.data.n;
    if (!acc) return;
    const g = api.getMasterGain?.() ?? 1;
    acc.push(e.data, Array.from({ length: N }, (_, k) => (k === OUT ? 1 : g)));
  };
  channels.forEach((c, i) => c.node.connect(node, 0, i));
  if (output) output.connect(node, 0, OUT);
  node.connect(ctx.destination); // pulled by the render graph; its output is silence

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    channels.forEach((c, i) => { try { c.node.disconnect(node, 0, i); } catch (_) { /* gone */ } });
    if (output) { try { output.disconnect(node, 0, OUT); } catch (_) { /* gone */ } }
    try { node.disconnect(); } catch (_) {}
    node.port.postMessage('stop');
    node.port.onmessage = null;
  };

  return {
    sampleRate,
    begin(startFrame) {
      acc = new ClipAccumulator(N, startFrame);
    },
    async finish(endFrame) {
      const t0 = Date.now();
      while (delivered < endFrame && Date.now() - t0 < DRAIN_MAX_MS) {
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      close();
      const clips = new Map();
      if (!acc) return { clips, limited: false };
      const all = acc.finish(endFrame);
      acc = null;
      const out = all.get(OUT) ?? null;
      for (const [k, clip] of all) if (k !== OUT) clips.set(channels[k].ch, clip);
      if (!out || !clips.size) return { clips, limited: false };
      if (clips.size === 1) {
        // One input: the rack's output IS this input's sound, exactly as heard.
        const [ch] = clips.keys();
        clips.set(ch, out);
        return { clips, limited: false };
      }
      const length = out.channels[0].length;
      const { lag, gain, limited } = matchToOutput(monoSum([...clips.values()], length), monoSum([out], length), sampleRate);
      for (const clip of clips.values()) {
        let peak = 0;
        for (const c of clip.channels) {
          c.copyWithin(lag, 0, c.length - lag);
          c.fill(0, 0, lag);
          for (let i = 0; i < c.length; i++) {
            c[i] *= gain;
            const a = c[i] < 0 ? -c[i] : c[i];
            if (a > peak) peak = a;
          }
        }
        clip.peak = peak;
      }
      return { clips, limited };
    },
    cancel() {
      acc = null;
      close();
    },
  };
}
