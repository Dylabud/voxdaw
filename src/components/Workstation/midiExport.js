// Standard MIDI File export (Phase 159) — pure, Tone-free, unit-tested
// (midiExport.test.js).
//
// One Type-1 .mid per project (or per track): a conductor track carrying the
// project name, 4/4 and the tempo — including the tempo lane, ramps written as
// one tempo event per 16th whose average bpm lands every 16th at its exact
// time — then one MIDI track per Workstation track that has notes.
//
// Notes are unrolled exactly as playback schedules them (the Bottle/Window
// model: clipOffset window, loops with loopPhase, region-end clipping, muted
// regions skipped — mirrors useWorkstationAudio.buildRegionEvents' plain-note
// path). Each note is its own MIDI note: glides are written as the notes they
// connect, without the pitch slide. Velocity 1–120 → 1–127. Drum kits go to
// channel 10 with their keys mapped to General MIDI drum sounds; melodic tracks
// get a General MIDI program close to their instrument.

import { firstLoopOffsetMeasures } from './loopMath';
import { buildTempoMap, tempoPointsOf } from './tempoMath';
import { NOTE_NAMES } from './pitchKeys';
import { isDrumKit } from './drumKits';

export const MIDI_PPQ = 480;
const DRUM_CHANNEL = 9; // "channel 10"

// ── Note names → MIDI numbers ('C4' = 60; the piano roll spans C-2…B8) ──────
const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
export function noteToMidi(name) {
  const m = /^([A-G](?:#|b)?)(-?\d+)$/.exec(String(name));
  if (!m) return null;
  const idx = NOTE_NAMES.indexOf(FLATS[m[1]] ?? m[1]);
  if (idx < 0) return null;
  const midi = (Number(m[2]) + 1) * 12 + idx;
  return midi >= 0 && midi <= 127 ? midi : null;
}

// ── General MIDI mapping ───────────────────────────────────────────────────
const GM_PROGRAM = {
  piano: 0, 'fm pluck': 4, xylophone: 13, organ: 16, harmonium: 20,
  'guitar-nylon': 24, 'guitar-acoustic': 25, 'guitar-electric': 27, 'bass-electric': 33,
  violin: 40, cello: 42, contrabass: 43, pluck: 45, harp: 46, strings: 48,
  trumpet: 56, trombone: 57, tuba: 58, 'french-horn': 60, saxophone: 65,
  bassoon: 70, clarinet: 71, flute: 73,
  square: 80, sine: 80, triangle: 80, sawtooth: 81, analog: 81, am: 88,
};
const SYNTH_LEAD = 81; // custom / Vox-photographed instruments: a synth
export const gmProgramFor = (instrument) => GM_PROGRAM[instrument] ?? SYNTH_LEAD;

// The kits share one key layout (drumKits.js); only the bonus keys differ.
const GM_DRUMS = {
  B3: 35, C4: 36, A3: 36, G3: 36, F3: 36, E3: 36, D3: 36, C3: 36,   // kicks
  E4: 38, D4: 40,                                                     // snares
  F4: 41, G4: 43, A4: 45, B4: 47, C5: 50,                             // toms
  'C#5': 42, 'D#5': 46, 'F#5': 49, 'G#5': 51, 'A#5': 57,              // hats, cymbals
};
const GM_DRUM_BONUS = {
  'drums acoustic': { D5: 56, E5: 44 },          // cowbell, pedal hat
  'drums 808':      { D5: 39, E5: 37, F5: 56 },  // clap, rim, cowbell
  'drums electro':  { D5: 39, E5: 37, F5: 75 },  // clap, rim, pop → claves
};
export function gmDrumNote(kit, name) {
  return GM_DRUM_BONUS[kit]?.[name] ?? GM_DRUMS[name] ?? noteToMidi(name);
}

// ── Notes of one region, unrolled, in global beats ─────────────────────────
// → [{ startB, durB, note, velocity }]
export function unrollRegionNotes(r, allNotes) {
  if (r.isMuted) return [];
  const co = r.clipOffset ?? 0;
  const looped = r.loopInterval != null;
  const li = looped ? r.loopInterval : r.durationMeasures;
  const phase = looped ? (r.loopPhase ?? 0) : 0;
  const regionEndB = (r.startMeasure + r.durationMeasures) * 4;
  const lo = co * 4;
  const hi = (co + li) * 4;
  const out = [];
  const push = (startB, n) => {
    if (startB >= regionEndB) return false;
    const durB = Math.min(startB + n.durationBeats, regionEndB) - startB;
    if (durB > 0) out.push({ startB, durB, note: n.note, velocity: n.velocity ?? 100 });
    return true;
  };
  for (const n of allNotes) {
    if (n.regionId !== r.id || n.startBeat < lo || n.startBeat >= hi) continue;
    if (!looped) { push((r.startMeasure - co) * 4 + n.startBeat, n); continue; }
    const firstOff = firstLoopOffsetMeasures(n.startBeat / 4 - co, phase, li);
    for (let j = 0; ; j++) {
      if (!push((r.startMeasure + firstOff + j * li) * 4, n)) break;
    }
  }
  return out;
}

// The tracks a full-project export writes: what the mix plays (the audio
// export's mute/solo rule, groups included), minus audio tracks (no notes).
export function midiTrackIdsForProject(tracks, groups = []) {
  const groupById = new Map(groups.map(g => [g.id, g]));
  const anySoloed = tracks.some(t => t.isSolo) || groups.some(g => g.isSolo);
  return tracks.filter(t => {
    if (t.instrument === 'audio') return false;
    const grp = t.groupId ? groupById.get(t.groupId) : null;
    return !t.isMuted && !grp?.isMuted && (!anySoloed || t.isSolo || !!grp?.isSolo);
  }).map(t => t.id);
}

// ── Byte writing ───────────────────────────────────────────────────────────
const vlq = (n) => {
  const bytes = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
};
// UTF-8 bytes of a track / project name (no TextEncoder: jsdom lacks it).
const text = (s) => {
  const out = [];
  for (const ch of String(s ?? '').slice(0, 120)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
};
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// events: [{ tick, order, bytes }] — order breaks same-tick ties (meta < off < on).
function trackChunk(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [];
  let last = 0;
  for (const e of sorted) {
    body.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = Math.max(last, e.tick);
  }
  body.push(0, 0xff, 0x2f, 0x00); // end of track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}
const meta = (tick, type, data) => ({ tick, order: 0, bytes: [0xff, type, ...vlq(data.length), ...data] });
const tempoEvent = (tick, bpm) => {
  const us = Math.round(60e6 / Math.max(1, bpm));
  return meta(tick, 0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
};
const tickOfMeasure = (m) => Math.round(m * 4 * MIDI_PPQ);

// Tempo events for the whole project: a constant tempo is one event; a ramp is
// one event per 16th at that 16th's AVERAGE bpm, so every 16th falls at exactly
// the time the Workstation plays it.
export function tempoEvents(map, bpm) {
  if (!map.anchors.length) return [tempoEvent(0, bpm)];
  const out = [];
  const STEP = 1 / 16;
  const a = map.anchors;
  let lastBpm = null;
  const put = (m, b) => {
    if (lastBpm !== null && Math.abs(b - lastBpm) < 1e-3) return;
    out.push(tempoEvent(tickOfMeasure(m), b));
    lastBpm = b;
  };
  for (let i = 0; i < a.length; i++) {
    const seg0 = a[i];
    const seg1 = a[i + 1];
    if (!seg1) { put(seg0.measure, seg0.bpm); break; }
    if (seg1.measure <= seg0.measure) continue;        // a step: the next anchor writes it
    if (seg1.bpm === seg0.bpm) { put(seg0.measure, seg0.bpm); continue; }
    for (let m = seg0.measure; m < seg1.measure - 1e-9; m += STEP) {
      const m1 = Math.min(seg1.measure, m + STEP);
      put(m, (240 * (m1 - m)) / (map.secondsAtMeasure(m1) - map.secondsAtMeasure(m)));
    }
  }
  return out;
}

/**
 * Build a .mid file. trackIds: which Workstation tracks to write (in order);
 * tracks without notes are left out. → { bytes: Uint8Array, trackCount, noteCount }
 * (trackCount 0 = nothing to export).
 */
export function buildMidiFile({ name, tracks, regions, notes, bpm, globalAutomations, trackIds }) {
  const map = buildTempoMap(bpm, tempoPointsOf(globalAutomations));
  const chunks = [];
  let noteCount = 0;
  let nextChannel = 0;
  for (const id of trackIds) {
    const t = tracks.find(x => x.id === id);
    if (!t) continue;
    const drums = isDrumKit(t.instrument);
    const evs = [];
    for (const r of regions) {
      if (r.trackId !== id) continue;
      for (const n of unrollRegionNotes(r, notes)) {
        const key = drums ? gmDrumNote(t.instrument, n.note) : noteToMidi(n.note);
        if (key == null) continue;
        const on = Math.round(n.startB * MIDI_PPQ);
        const off = Math.max(on + 1, Math.round((n.startB + n.durB) * MIDI_PPQ));
        const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127 / 120)));
        evs.push({ on, off, key, vel });
      }
    }
    if (!evs.length) continue;
    // 15 melodic channels (10 is drums); a 16th+ melodic track shares one again.
    let ch = DRUM_CHANNEL;
    if (!drums) {
      ch = nextChannel % 15;
      if (ch >= DRUM_CHANNEL) ch += 1;
      nextChannel++;
    }
    const events = [meta(0, 0x03, text(t.name))];
    if (!drums) events.push({ tick: 0, order: 1, bytes: [0xc0 | ch, gmProgramFor(t.instrument)] });
    for (const e of evs) {
      events.push({ tick: e.on, order: 3, bytes: [0x90 | ch, e.key, e.vel] });
      events.push({ tick: e.off, order: 2, bytes: [0x80 | ch, e.key, 64] }); // offs before ons at a tick
    }
    chunks.push(trackChunk(events));
    noteCount += evs.length;
  }
  const conductor = trackChunk([
    meta(0, 0x03, text(name)),
    meta(0, 0x58, [4, 2, 24, 8]),
    ...tempoEvents(map, bpm),
  ]);
  const all = [conductor, ...chunks];
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, (all.length >> 8) & 0xff, all.length & 0xff,
    (MIDI_PPQ >> 8) & 0xff, MIDI_PPQ & 0xff];
  const bytes = new Uint8Array(header.length + all.reduce((s, c) => s + c.length, 0));
  bytes.set(header, 0);
  let at = header.length;
  for (const c of all) { bytes.set(c, at); at += c.length; }
  return { bytes, trackCount: chunks.length, noteCount };
}
