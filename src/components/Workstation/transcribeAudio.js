import { YIN } from 'pitchfinder';
import { NOTE_NAMES } from './pitchKeys';

// ─── Tuning constants ────────────────────────────────────────────────────────
const FRAME_SIZE  = 2048;  // YIN window — long enough for reliable F0 down to ~22 Hz
const HOP_SIZE    = 512;   // step between frames (~12 ms at 44100 Hz); fine enough resolution
const MIN_NOTE_MS = 80;    // discard runs shorter than this (reverb transients, noise pops)
const RMS_GATE    = 0.01;  // silence floor — gate-off steps and reverb tails fall below this
const YIN_THRESH  = 0.15;  // lower = more sensitive but more false positives

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hzToNoteName(hz) {
  if (!hz || hz < 20 || hz > 8000) return null;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  if (midi < 0 || midi > 127) return null;
  // Standard formula: octave C4 = 60 → floor(60/12)=5, 5-1=4 → "C4" ✓
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function frameRms(pcm, offset, len) {
  let sum = 0;
  const end = Math.min(offset + len, pcm.length);
  for (let i = offset; i < end; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.max(1, end - offset));
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Transcribes a decoded AudioBuffer to an array of note events using YIN
 * monophonic pitch detection (same library used by VoxTool's useAutotune).
 *
 * Works best with single-note Moog sequences (one pitch at a time). Polyphonic
 * or heavily reverberated recordings will produce approximate results.
 *
 * @param {AudioBuffer} nativeBuf - Decoded audio buffer from the Moog recording.
 * @param {number}      bpm       - Current Workstation BPM (for seconds → beats).
 * @returns {{ note: string, startBeat: number, durationBeats: number, velocity: number }[]}
 *   Beat positions are relative to the region start (startBeat=0 = first frame of recording).
 */
export function transcribeAudio(nativeBuf, bpm) {
  const sr          = nativeBuf.sampleRate;
  const pcm         = nativeBuf.getChannelData(0); // use left/mono channel
  const beatsPerSec = bpm / 60;
  const hopSec      = HOP_SIZE / sr;
  const detect      = YIN({ sampleRate: sr, threshold: YIN_THRESH });

  // ── Phase 1: pitch-detect every hop frame ───────────────────────────────
  const frames = [];
  for (let pos = 0; pos + FRAME_SIZE <= pcm.length; pos += HOP_SIZE) {
    const vol = frameRms(pcm, pos, FRAME_SIZE);
    const hz  = vol >= RMS_GATE
      ? detect(pcm.subarray(pos, pos + FRAME_SIZE))
      : null;
    frames.push({ name: hzToNoteName(hz), vol, startSec: pos / sr });
  }

  // ── Phase 2: merge consecutive same-pitch frames into note events ────────
  const notes = [];
  let run      = null; // current open note: { name, startSec, peakVol }

  const flush = (endSec) => {
    if (!run) return;
    const durSec = endSec - run.startSec;
    if (durSec * 1000 >= MIN_NOTE_MS) {
      notes.push({
        note:          run.name,
        startBeat:     run.startSec * beatsPerSec,
        durationBeats: Math.max(0.0625, durSec * beatsPerSec), // floor at 1/16th note
        velocity:      Math.min(1, Math.max(0.1, run.peakVol * 5)),
      });
    }
    run = null;
  };

  for (const f of frames) {
    if (!f.name) {
      flush(f.startSec);
      continue;
    }
    if (run?.name === f.name) {
      run.peakVol = Math.max(run.peakVol, f.vol);
    } else {
      flush(f.startSec);
      run = { name: f.name, startSec: f.startSec, peakVol: f.vol };
    }
  }

  const last = frames.at(-1);
  flush(last ? last.startSec + hopSec : 0);

  return notes;
}
