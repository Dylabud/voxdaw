const SCALE_INTERVALS = {
  cMajor:           [0, 2, 4, 5, 7, 9, 11],
  cMinorPentatonic: [0, 3, 5, 7, 10],
  chromatic:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Iterates MIDI 0–127 (monotonically increasing) → output is pre-sorted, no sort() needed
function buildScaleFreqs(intervals, minHz = 20, maxHz = 2000) {
  const freqs = [];
  for (let n = 0; n <= 127; n++) {
    if (intervals.includes(n % 12)) {
      const hz = midiToHz(n);
      if (hz >= minHz && hz <= maxHz) freqs.push(hz);
    }
  }
  return new Float32Array(freqs);
}

export const SCALES = {
  cMajor:           buildScaleFreqs(SCALE_INTERVALS.cMajor),
  cMinorPentatonic: buildScaleFreqs(SCALE_INTERVALS.cMinorPentatonic),
  chromatic:        buildScaleFreqs(SCALE_INTERVALS.chromatic),
};

export const SCALE_LABELS = {
  cMajor:           'C Major',
  cMinorPentatonic: 'C Minor Pent.',
  chromatic:        'Chromatic',
};

export const OSC_TYPES = ['sine', 'triangle', 'square', 'sawtooth'];

const _CHROMATIC_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const _IS_BLACK_KEY    = [false,true,false,true,false,false,true,false,true,false,true,false];

// 25 chromatic notes, highest→lowest: C5 (MIDI 72) → C3 (MIDI 48).
// Single source of truth — both the audio engine and PianoRoll divide by NOTE_GRID.length.
export const NOTE_GRID = [];
for (let midi = 72; midi >= 48; midi--) {
  const semitone = midi % 12;
  const octave   = Math.floor(midi / 12) - 1;
  NOTE_GRID.push({ note: `${_CHROMATIC_SHARP[semitone]}${octave}`, isBlack: _IS_BLACK_KEY[semitone] });
}
