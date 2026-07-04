// Sampled instrument configs for Tone.Sampler.
// URL maps mirror nbrosowsky/tonejs-instruments exactly; samples vendored
// at public/samples/<name>/<file>.mp3. Pure data — no Tone.js imports.

import { DRUM_KITS } from './drumKits';

export const SAMPLED_INSTRUMENTS = {
  'bass-electric': {
    baseUrl: '/samples/bass-electric/',
    release: 1,
    urls: {
      'A#1':'As1.mp3','A#2':'As2.mp3','A#3':'As3.mp3','A#4':'As4.mp3',
      'C#1':'Cs1.mp3','C#2':'Cs2.mp3','C#3':'Cs3.mp3','C#4':'Cs4.mp3',
      'E1':'E1.mp3','E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3',
      'G1':'G1.mp3','G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3',
    },
  },
  bassoon: {
    baseUrl: '/samples/bassoon/',
    release: 1,
    urls: {
      'A4':'A4.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','E4':'E4.mp3',
      'G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3','A2':'A2.mp3','A3':'A3.mp3',
    },
  },
  cello: {
    baseUrl: '/samples/cello/',
    release: 1,
    urls: {
      'E3':'E3.mp3','E4':'E4.mp3','F2':'F2.mp3','F3':'F3.mp3','F4':'F4.mp3',
      'F#3':'Fs3.mp3','F#4':'Fs4.mp3','G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3',
      'G#2':'Gs2.mp3','G#3':'Gs3.mp3','G#4':'Gs4.mp3','A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3',
      'A#2':'As2.mp3','A#3':'As3.mp3','B2':'B2.mp3','B3':'B3.mp3','B4':'B4.mp3',
      'C2':'C2.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','C#3':'Cs3.mp3','C#4':'Cs4.mp3',
      'D2':'D2.mp3','D3':'D3.mp3','D4':'D4.mp3','D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3','E2':'E2.mp3',
    },
  },
  clarinet: {
    baseUrl: '/samples/clarinet/',
    release: 1,
    urls: {
      'D4':'D4.mp3','D5':'D5.mp3','D6':'D6.mp3','F3':'F3.mp3','F4':'F4.mp3','F5':'F5.mp3',
      'F#6':'Fs6.mp3','A#3':'As3.mp3','A#4':'As4.mp3','A#5':'As5.mp3','D3':'D3.mp3',
    },
  },
  contrabass: {
    baseUrl: '/samples/contrabass/',
    release: 1,
    urls: {
      'C2':'C2.mp3','C#3':'Cs3.mp3','D2':'D2.mp3','E2':'E2.mp3','E3':'E3.mp3',
      'F#1':'Fs1.mp3','F#2':'Fs2.mp3','G1':'G1.mp3','G#2':'Gs2.mp3','G#3':'Gs3.mp3',
      'A2':'A2.mp3','A#1':'As1.mp3','B3':'B3.mp3',
    },
  },
  flute: {
    baseUrl: '/samples/flute/',
    release: 1,
    urls: {
      'A6':'A6.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3','C7':'C7.mp3',
      'E4':'E4.mp3','E5':'E5.mp3','E6':'E6.mp3','A4':'A4.mp3','A5':'A5.mp3',
    },
  },
  'french-horn': {
    baseUrl: '/samples/french-horn/',
    release: 1,
    urls: {
      'D3':'D3.mp3','D5':'D5.mp3','D#2':'Ds2.mp3','F3':'F3.mp3','F5':'F5.mp3',
      'G2':'G2.mp3','A1':'A1.mp3','A3':'A3.mp3','C2':'C2.mp3','C4':'C4.mp3',
    },
  },
  'guitar-acoustic': {
    baseUrl: '/samples/guitar-acoustic/',
    release: 1,
    urls: {
      'F4':'F4.mp3','F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3',
      'G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3','G#2':'Gs2.mp3','G#3':'Gs3.mp3','G#4':'Gs4.mp3',
      'A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A#2':'As2.mp3','A#3':'As3.mp3','A#4':'As4.mp3',
      'B2':'B2.mp3','B3':'B3.mp3','B4':'B4.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3',
      'C#3':'Cs3.mp3','C#4':'Cs4.mp3','C#5':'Cs5.mp3','D2':'D2.mp3','D3':'D3.mp3','D4':'D4.mp3','D5':'D5.mp3',
      'D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds3.mp3','E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3','F2':'F2.mp3','F3':'F3.mp3',
    },
  },
  'guitar-electric': {
    baseUrl: '/samples/guitar-electric/',
    release: 1,
    urls: {
      'D#3':'Ds3.mp3','D#4':'Ds4.mp3','D#5':'Ds5.mp3','E2':'E2.mp3',
      'F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3',
      'A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3',
      'C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3','C#2':'Cs2.mp3',
    },
  },
  'guitar-nylon': {
    baseUrl: '/samples/guitar-nylon/',
    release: 1,
    urls: {
      'F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3',
      'G3':'G3.mp3','G5':'G3.mp3','G#2':'Gs2.mp3','G#4':'Gs4.mp3','G#5':'Gs5.mp3',
      'A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3','A#5':'As5.mp3',
      'B1':'B1.mp3','B2':'B2.mp3','B3':'B3.mp3','B4':'B4.mp3',
      'C#3':'Cs3.mp3','C#4':'Cs4.mp3','C#5':'Cs5.mp3',
      'D2':'D2.mp3','D3':'D3.mp3','D5':'D5.mp3','D#4':'Ds4.mp3',
      'E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3','E5':'E5.mp3',
    },
  },
  harmonium: {
    baseUrl: '/samples/harmonium/',
    release: 1,
    urls: {
      'C2':'C2.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3',
      'C#2':'Cs2.mp3','C#3':'Cs3.mp3','C#4':'Cs4.mp3','C#5':'Cs5.mp3',
      'D2':'D2.mp3','D3':'D3.mp3','D4':'D4.mp3','D5':'D5.mp3',
      'D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3',
      'E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3','F2':'F2.mp3','F3':'F3.mp3','F4':'F4.mp3',
      'F#2':'Fs2.mp3','F#3':'Fs3.mp3','G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3',
      'G#2':'Gs2.mp3','G#3':'Gs3.mp3','G#4':'Gs4.mp3',
      'A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A#2':'As2.mp3','A#3':'As3.mp3','A#4':'As4.mp3',
    },
  },
  harp: {
    baseUrl: '/samples/harp/',
    release: 1,
    urls: {
      'C5':'C5.mp3','D2':'D2.mp3','D4':'D4.mp3','D6':'D6.mp3','D7':'D7.mp3',
      'E1':'E1.mp3','E3':'E3.mp3','E5':'E5.mp3','F2':'F2.mp3','F4':'F4.mp3','F6':'F6.mp3','F7':'F7.mp3',
      'G1':'G1.mp3','G3':'G3.mp3','G5':'G5.mp3','A2':'A2.mp3','A4':'A4.mp3','A6':'A6.mp3',
      'B1':'B1.mp3','B3':'B3.mp3','B5':'B5.mp3','B6':'B6.mp3','C3':'C3.mp3',
    },
  },
  organ: {
    baseUrl: '/samples/organ/',
    release: 1,
    urls: {
      'C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3',
      'D#1':'Ds1.mp3','D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3','D#5':'Ds5.mp3',
      'F#1':'Fs1.mp3','F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3',
      'A1':'A1.mp3','A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3',
      'C1':'C1.mp3','C2':'C2.mp3',
    },
  },
  piano: {
    baseUrl: '/samples/piano/',
    release: 1,
    urls: {
      'A7':'A7.mp3','A1':'A1.mp3','A2':'A2.mp3','A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3','A6':'A6.mp3',
      'A#7':'As7.mp3','A#1':'As1.mp3','A#2':'As2.mp3','A#3':'As3.mp3','A#4':'As4.mp3','A#5':'As5.mp3','A#6':'As6.mp3',
      'B7':'B7.mp3','B1':'B1.mp3','B2':'B2.mp3','B3':'B3.mp3','B4':'B4.mp3','B5':'B5.mp3','B6':'B6.mp3',
      'C7':'C7.mp3','C1':'C1.mp3','C2':'C2.mp3','C3':'C3.mp3','C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3',
      'C#7':'Cs7.mp3','C#1':'Cs1.mp3','C#2':'Cs2.mp3','C#3':'Cs3.mp3','C#4':'Cs4.mp3','C#5':'Cs5.mp3','C#6':'Cs6.mp3',
      'D7':'D7.mp3','D1':'D1.mp3','D2':'D2.mp3','D3':'D3.mp3','D4':'D4.mp3','D5':'D5.mp3','D6':'D6.mp3',
      'D#7':'Ds7.mp3','D#1':'Ds1.mp3','D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3','D#5':'Ds5.mp3','D#6':'Ds6.mp3',
      'E7':'E7.mp3','E1':'E1.mp3','E2':'E2.mp3','E3':'E3.mp3','E4':'E4.mp3','E5':'E5.mp3','E6':'E6.mp3',
      'F7':'F7.mp3','F1':'F1.mp3','F2':'F2.mp3','F3':'F3.mp3','F4':'F4.mp3','F5':'F5.mp3','F6':'F6.mp3',
      'F#7':'Fs7.mp3','F#1':'Fs1.mp3','F#2':'Fs2.mp3','F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3','F#6':'Fs6.mp3',
      'G7':'G7.mp3','G1':'G1.mp3','G2':'G2.mp3','G3':'G3.mp3','G4':'G4.mp3','G5':'G5.mp3','G6':'G6.mp3',
      'G#7':'Gs7.mp3','G#1':'Gs1.mp3','G#2':'Gs2.mp3','G#3':'Gs3.mp3','G#4':'Gs4.mp3','G#5':'Gs5.mp3','G#6':'Gs6.mp3',
    },
  },
  saxophone: {
    baseUrl: '/samples/saxophone/',
    release: 1,
    urls: {
      'D#5':'Ds5.mp3','E3':'E3.mp3','E4':'E4.mp3','E5':'E5.mp3',
      'F3':'F3.mp3','F4':'F4.mp3','F5':'F5.mp3',
      'F#3':'Fs3.mp3','F#4':'Fs4.mp3','F#5':'Fs5.mp3',
      'G3':'G3.mp3','G4':'G4.mp3','G5':'G5.mp3',
      'G#3':'Gs3.mp3','G#4':'Gs4.mp3','G#5':'Gs5.mp3',
      'A4':'A4.mp3','A5':'A5.mp3','A#3':'As3.mp3','A#4':'As4.mp3',
      'B3':'B3.mp3','B4':'B4.mp3','C4':'C4.mp3','C5':'C5.mp3',
      'C#3':'Cs3.mp3','C#4':'Cs4.mp3','C#5':'Cs5.mp3',
      'D3':'D3.mp3','D4':'D4.mp3','D5':'D5.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3',
    },
  },
  trombone: {
    baseUrl: '/samples/trombone/',
    release: 1,
    urls: {
      'A#3':'As3.mp3','C3':'C3.mp3','C4':'C4.mp3','C#2':'Cs2.mp3','C#4':'Cs4.mp3',
      'D3':'D3.mp3','D4':'D4.mp3','D#2':'Ds2.mp3','D#3':'Ds3.mp3','D#4':'Ds4.mp3',
      'F2':'F2.mp3','F3':'F3.mp3','F4':'F4.mp3',
      'G#2':'Gs2.mp3','G#3':'Gs3.mp3','A#1':'As1.mp3','A#2':'As2.mp3',
    },
  },
  trumpet: {
    baseUrl: '/samples/trumpet/',
    release: 1,
    urls: {
      'C6':'C6.mp3','D5':'D5.mp3','D#4':'Ds4.mp3','F3':'F3.mp3','F4':'F4.mp3','F5':'F5.mp3',
      'G4':'G4.mp3','A3':'A3.mp3','A5':'A5.mp3','A#4':'As4.mp3','C4':'C4.mp3',
    },
  },
  tuba: {
    baseUrl: '/samples/tuba/',
    release: 1,
    urls: {
      'A#2':'As2.mp3','A#3':'As3.mp3','D3':'D3.mp3','D4':'D4.mp3','D#2':'Ds2.mp3',
      'F1':'F1.mp3','F2':'F2.mp3','F3':'F3.mp3','A#1':'As1.mp3',
    },
  },
  violin: {
    baseUrl: '/samples/violin/',
    release: 1,
    urls: {
      'A3':'A3.mp3','A4':'A4.mp3','A5':'A5.mp3','A6':'A6.mp3',
      'C4':'C4.mp3','C5':'C5.mp3','C6':'C6.mp3','C7':'C7.mp3',
      'E4':'E4.mp3','E5':'E5.mp3','E6':'E6.mp3',
      'G4':'G4.mp3','G5':'G5.mp3','G6':'G6.mp3',
    },
  },
  xylophone: {
    baseUrl: '/samples/xylophone/',
    release: 1,
    urls: {
      'C8':'C8.mp3','G4':'G4.mp3','G5':'G5.mp3','G6':'G6.mp3','G7':'G7.mp3',
      'C5':'C5.mp3','C6':'C6.mp3','C7':'C7.mp3',
    },
  },
};

// Melodic-only list captured BEFORE the drum-kit merge — feeds the
// "sampled" optgroup in the instrument dropdown (drums get their own).
export const SAMPLED_MELODIC_NAMES = Object.keys(SAMPLED_INSTRUMENTS);

// Drum kits ride the same registry so isSampledInstrument / makeSynth /
// the loading indicator / bounce Tone.loaded() all pick them up for free.
Object.assign(SAMPLED_INSTRUMENTS, DRUM_KITS);

export const SAMPLED_INSTRUMENT_NAMES = Object.keys(SAMPLED_INSTRUMENTS);
