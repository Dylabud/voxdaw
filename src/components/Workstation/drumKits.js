// Drum kit configs for Tone.Sampler. Pure data — no Tone.js imports.
// Samples vendored at public/samples/<kit>/<file>.m4a (see each folder's
// CREDITS.txt for source + license; acoustic/electro are CC0 Sonic Pi
// samples, 808 is the Music Machines TR-808 archive via oramics/sampled).
//
// Shared key layout (Dylan's spec):
//   C4  kick            B3/A3/G3… alt kicks down the white keys
//   E4  snare           D4 alt snare
//   F4/A4/C5 toms low→high — G4/B4 are UNMAPPED on purpose: Tone.Sampler
//     repitches from the nearest mapped key, so they land on neighboring
//     toms (F4/A4 and C5), giving 5 playable tom keys from 3 samples
//   C#5 closed hat      D#5 open hat (choke group — see DRUM_CHOKE_GROUPS)
//   F#5 crash  G#5 ride  A#5 crash 2
//   D5/E5/F5 bonus percussion where the kit has it (clap / rim / cowbell…)
//
// `release` doubles as the choke fade: ToneBufferSource bakes it in as
// fadeOut at attack time, and triggerRelease/stop ramps over it. 0.05 s is
// a real-hat choke (20–50 ms) — abrupt but click-free (exponential curve).

export const DRUM_KITS = {
  'drums acoustic': {
    baseUrl: '/samples/drums-acoustic/',
    release: 0.05,
    urls: {
      'C4': 'kick.m4a', 'B3': 'kick-2.m4a', 'A3': 'kick-3.m4a',
      'E4': 'snare.m4a', 'D4': 'snare-2.m4a',
      'F4': 'tom-low.m4a', 'A4': 'tom-mid.m4a', 'C5': 'tom-high.m4a',
      'C#5': 'hat-closed.m4a', 'D#5': 'hat-open.m4a',
      'F#5': 'crash.m4a', 'G#5': 'ride.m4a', 'A#5': 'crash-2.m4a',
      'D5': 'cowbell.m4a', 'E5': 'hat-pedal.m4a',
    },
  },
  'drums 808': {
    baseUrl: '/samples/drums-808/',
    release: 0.05,
    urls: {
      'C4': 'kick.m4a', 'B3': 'kick-2.m4a', 'A3': 'kick-3.m4a',
      'G3': 'kick-4.m4a', 'F3': 'kick-5.m4a', 'E3': 'kick-6.m4a',
      'D3': 'kick-7.m4a', 'C3': 'kick-8.m4a',
      'E4': 'snare.m4a', 'D4': 'snare-2.m4a',
      'F4': 'tom-low.m4a', 'A4': 'tom-mid.m4a', 'C5': 'tom-high.m4a',
      'C#5': 'hat-closed.m4a', 'D#5': 'hat-open.m4a',
      'F#5': 'crash.m4a', 'G#5': 'ride.m4a', 'A#5': 'crash-2.m4a',
      'D5': 'clap.m4a', 'E5': 'rim.m4a', 'F5': 'cowbell.m4a',
    },
  },
  'drums electro': {
    baseUrl: '/samples/drums-electro/',
    release: 0.05,
    urls: {
      'C4': 'kick.m4a', 'B3': 'kick-2.m4a', 'A3': 'kick-3.m4a',
      'G3': 'kick-4.m4a', 'F3': 'kick-5.m4a', 'E3': 'kick-6.m4a',
      'D3': 'kick-7.m4a', 'C3': 'kick-8.m4a',
      'E4': 'snare.m4a', 'D4': 'snare-2.m4a',
      'F4': 'tom-low.m4a', 'A4': 'tom-mid.m4a', 'C5': 'tom-high.m4a',
      'C#5': 'hat-closed.m4a', 'D#5': 'hat-open.m4a',
      'F#5': 'crash.m4a', 'G#5': 'ride.m4a', 'A#5': 'crash-2.m4a',
      'D5': 'clap.m4a', 'E5': 'rim.m4a', 'F5': 'pop.m4a',
    },
  },
};

export const DRUM_KIT_NAMES = Object.keys(DRUM_KITS);

export function isDrumKit(name) {
  return Object.prototype.hasOwnProperty.call(DRUM_KITS, name);
}

// Choke groups: attacking any note in a group immediately releases the OTHER
// notes in that group (fade = the kit's `release`). One group today — the
// hi-hat pair: a closed-hat hit cuts a ringing open hat (and vice versa,
// which is inaudible since the closed hat is short but keeps the pair mono,
// like a real hi-hat that can't be open and closed at once).
export const DRUM_CHOKE_GROUPS = [['C#5', 'D#5']];

export function chokeTargetsFor(note) {
  const out = [];
  for (const group of DRUM_CHOKE_GROUPS) {
    if (!group.includes(note)) continue;
    for (const n of group) if (n !== note) out.push(n);
  }
  return out;
}
