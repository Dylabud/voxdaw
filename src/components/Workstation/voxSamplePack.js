// Pack / unpack vox take instrument samples in a .voxdaw file (Vox Phase 130).
//
// The project payload (serializeProject) only ever carries the small
// `voxInstruments` defs — that payload is also what [ save ] writes to
// IndexedDB and what the preview hash covers, and neither should grow by tens
// of MB. The WAVs travel ONLY in a downloaded file, under a top-level
// `voxSamples` key added at download time and stripped again on every read
// path before the payload is stored:
//
//   voxSamples: [{ id, sampleRate, release, notes: [{ midi, wav: <base64 WAV>, loop? }] }]
//   (loop = [startSec, endSec] sustain loop, Phase 131 — absent on decaying notes)
//
// Recorded audio clips (audio takes, Phase 134) ride the same way, for every
// clip a region plays:
//
//   voxClips: [{ id, sampleRate, channels, length, segments: [<base64 WAV>…] }]
//
// Additive — SCHEMA_VERSION NOT bumped (an older app ignores the key and plays
// a default synth for the unknown instrument id). Tone-free.

import { readSampleSetWavs, writeSampleSetWavs, hasSampleSet, cleanLoop } from './customSampleStore';
import { isVoxInstrument } from './voxInstruments';
import { isClipId } from './audioClipMath';
import { readClipWavs, writeClipWavs, hasClip } from './voxClipStore';

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // keep fromCharCode's argument list well under engine limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// payload → payload + voxSamples for every vox instrument it references whose
// set is on this machine. A set that isn't here is skipped (the file then
// plays a default synth for it, exactly as before it was packed).
export async function withVoxSamples(payload) {
  const ids = (payload.voxInstruments ?? []).map((d) => d.id).filter(isVoxInstrument);
  const clipIds = [...new Set((payload.regions ?? []).map((r) => r.audio?.clipId).filter(isClipId))];
  if (!ids.length && !clipIds.length) return payload;
  const voxClips = [];
  for (const id of clipIds) {
    const rec = await readClipWavs(id);
    if (!rec) continue;
    const { sampleRate, channels, length } = rec.meta;
    voxClips.push({ id, sampleRate, channels, length, segments: rec.wavs.map(bufToBase64) });
  }
  const voxSamples = [];
  for (const id of ids) {
    const set = await readSampleSetWavs(id);
    if (!set) continue;
    voxSamples.push({
      id,
      sampleRate: set.meta.sampleRate,
      release: set.meta.release,
      notes: set.notes.map(({ midi, wav, loop }) => ({ midi, wav: bufToBase64(wav), ...(loop ? { loop } : {}) })),
    });
  }
  if (!voxSamples.length && !voxClips.length) return payload;
  return {
    ...payload,
    ...(voxSamples.length ? { voxSamples } : {}),
    ...(voxClips.length ? { voxClips } : {}),
  };
}

// A read file → (its samples written to this machine's store, the raw payload
// WITHOUT voxSamples). Sets already present are left alone (ids are unique per
// photograph, so the same id is the same sound). Never throws for a bad entry
// — a malformed set is skipped and that instrument falls back to a default
// synth; returns how many sets were skipped so the caller can say so.
export async function ingestVoxSamples(raw) {
  if (!raw || typeof raw !== 'object' || (!Array.isArray(raw.voxSamples) && !Array.isArray(raw.voxClips))) {
    return { raw, skipped: 0 };
  }
  const { voxSamples = [], voxClips = [], ...rest } = raw;
  let skipped = 0;
  for (const clip of (Array.isArray(voxClips) ? voxClips : []).slice(0, 256)) {
    try {
      if (!isClipId(clip?.id) || !Array.isArray(clip.segments) || !clip.segments.length) throw new Error('bad clip');
      if (await hasClip(clip.id)) continue;
      const length = Math.floor(Number(clip.length));
      const channels = Number(clip.channels) === 2 ? 2 : 1;
      if (!(length > 0) || !clip.segments.every((b) => typeof b === 'string')) throw new Error('bad clip');
      await writeClipWavs(clip.id, { sampleRate: Number(clip.sampleRate) || 48000, channels, length },
        clip.segments.map(base64ToBuf));
    } catch (err) {
      console.error('vox clip unpack failed', err);
      skipped++;
    }
  }
  for (const set of (Array.isArray(voxSamples) ? voxSamples : []).slice(0, 64)) {
    try {
      if (!isVoxInstrument(set?.id) || !Array.isArray(set.notes)) throw new Error('bad set');
      if (await hasSampleSet(set.id)) continue;
      const notes = set.notes
        .filter((n) => Number.isInteger(n?.midi) && n.midi >= 0 && n.midi <= 127 && typeof n.wav === 'string')
        .slice(0, 128)
        .map((n) => ({ midi: n.midi, wav: base64ToBuf(n.wav), ...(cleanLoop(n.loop) ? { loop: cleanLoop(n.loop) } : {}) }));
      if (!notes.length) throw new Error('empty set');
      await writeSampleSetWavs(set.id, {
        sampleRate: Number(set.sampleRate) || 44100,
        release: Math.max(0.01, Math.min(10, Number(set.release) || 0.3)),
      }, notes);
    } catch (err) {
      console.error('vox sample unpack failed', err);
      skipped++;
    }
  }
  return { raw: rest, skipped };
}
