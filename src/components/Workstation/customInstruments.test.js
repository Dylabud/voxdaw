// jsdom has no crypto.randomUUID (browsers do) — mintId reads a bare `crypto`.
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `test-${Math.random().toString(36).slice(2)}` };
}

import { saveToLibrary, getCustomInstrument, customInstrumentsForIds } from './customInstruments';

// Regression for the "a saved layer went silent in the workstation" report: prove
// the SAVE path never drops layer data. A 3-layer patch (layer 3 = a twinkle:
// fast decay, sustain 0, a delay effect, an octave up) must survive
// saveToLibrary → registry (and the .voxdaw embed) with every layer, effect, and
// per-layer param intact. (The audible bug was the workstation clobbering each
// layer's envelope via defaultEnvelopeFor — fixed in synthFactory — not a drop.)
describe('custom-instrument save round-trip', () => {
  const raw = {
    name: 'Twinkle Pad',
    volume: -8,
    layers: [
      { voice: { engine: 'simple', oscillator: 'sine' }, volume: -2, octave: -1 },
      { voice: { engine: 'am', oscillator: 'triangle' }, volume: 0, octave: 0 },
      {
        voice: { engine: 'fm', oscillator: 'sine' },
        envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 1.2 },
        effects: [{ type: 'delay', params: { time: 0.25, feedback: 0.4, wet: 0.5 } }],
        volume: -6, octave: 1, semitone: 7,
      },
    ],
  };

  it('preserves all three layers, effects, and per-layer params through the library', () => {
    const id = saveToLibrary('Twinkle Pad', raw);
    const def = getCustomInstrument(id);
    expect(def.patch.layers).toHaveLength(3);

    const twinkle = def.patch.layers[2];
    expect(twinkle.octave).toBe(1);
    expect(twinkle.semitone).toBe(7);
    expect(twinkle.envelope.sustain).toBe(0);      // its plucky character survives
    expect(twinkle.envelope.release).toBe(1.2);
    expect(twinkle.effects).toHaveLength(1);
    expect(twinkle.effects[0].type).toBe('delay');
    expect(twinkle.effects[0].params.wet).toBe(0.5);

    expect(def.patch.layers[0].octave).toBe(-1);   // sub octave down
    expect(def.patch.volume).toBe(-8);             // master
  });

  it('embeds all three layers for the .voxdaw file', () => {
    const id = saveToLibrary('Twinkle Pad 2', raw);
    const embedded = customInstrumentsForIds([id]);
    expect(embedded).toHaveLength(1);
    expect(embedded[0].patch.layers).toHaveLength(3);
    expect(embedded[0].patch.layers[2].effects[0].type).toBe('delay');
    expect(embedded[0].patch.layers[2].octave).toBe(1);
  });
});
