import { sanitizePatch, DEFAULT_PATCH, MAX_EFFECTS, MAX_LAYERS, maxLayersForTier, layerDetuneCents } from './patchSchema';

// A patch is always { name, volume, layers: [...] }. sanitizePatch normalizes a
// legacy flat patch (voice/envelope/… at the top level) into a single layer.
const only = (p) => p.layers[0];

describe('sanitizePatch', () => {
  it('returns a complete playable patch from garbage input', () => {
    for (const raw of [null, undefined, 42, 'x', {}, { voice: 'nope', effects: 'nope' }]) {
      const p = sanitizePatch(raw);
      expect(Array.isArray(p.layers)).toBe(true);
      expect(p.layers.length).toBeGreaterThanOrEqual(1);
      expect(only(p).voice.engine).toBe('simple');
      expect(only(p).envelope.attack).toBeGreaterThan(0);
      expect(Array.isArray(only(p).effects)).toBe(true);
      expect(p.volume).toBe(DEFAULT_PATCH.volume);
    }
  });

  it('normalizes a legacy flat patch into one layer, volume → master', () => {
    const p = sanitizePatch({
      name: 'Old', volume: -12,
      voice: { engine: 'fm', oscillator: 'sine' },
      envelope: { attack: 0.2, decay: 0.1, sustain: 0.4, release: 0.5 },
      filter: { type: 'lowpass', frequency: 8000, q: 2 },
      effects: [{ type: 'reverb', params: { wet: 0.5 } }],
    });
    expect(p.name).toBe('Old');
    expect(p.layers).toHaveLength(1);
    expect(p.volume).toBe(-12);          // flat volume becomes master
    expect(only(p).volume).toBe(0);      // the single layer sits at unity — no double attenuation
    expect(only(p).voice.engine).toBe('fm');
    expect(only(p).octave).toBe(0);
  });

  it('accepts a multi-layer patch and clamps layer count to MAX_LAYERS', () => {
    const layer = () => ({ voice: { engine: 'simple', oscillator: 'sawtooth' } });
    const p = sanitizePatch({
      volume: -4,
      layers: Array.from({ length: 6 }, layer),
    });
    expect(p.layers).toHaveLength(MAX_LAYERS);
    expect(p.volume).toBe(-4);
  });

  it('clamps per-layer volume, octave and semitone', () => {
    const p = sanitizePatch({
      layers: [{ voice: { engine: 'simple', oscillator: 'sine' }, volume: 99, octave: 50, semitone: -99 }],
    });
    expect(only(p).volume).toBe(6);      // LAYER_VOL_META max
    expect(only(p).octave).toBe(4);      // OCTAVE_META max
    expect(only(p).semitone).toBe(-12);  // SEMITONE_META min
    expect(Number.isInteger(only(p).octave)).toBe(true);
    expect('transpose' in only(p)).toBe(false);
    expect('detune' in only(p)).toBe(false);
  });

  it('defaults semitone to 0 when absent', () => {
    expect(only(sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine' } }] })).semitone).toBe(0);
  });

  it('maxLayersForTier unlocks 5 only on xhigh', () => {
    expect(maxLayersForTier('medium')).toBe(3);
    expect(maxLayersForTier('high')).toBe(3);
    expect(maxLayersForTier('xhigh')).toBe(5);
  });

  it('caps the layer array at MAX_LAYERS (5)', () => {
    const layer = () => ({ voice: { engine: 'simple', oscillator: 'sine' } });
    expect(MAX_LAYERS).toBe(5);
    expect(sanitizePatch({ layers: Array.from({ length: 7 }, layer) }).layers).toHaveLength(5);
  });

  it('layerDetuneCents sums octave and semitone', () => {
    expect(layerDetuneCents({ octave: 1, semitone: 7 })).toBe(1200 + 700);
    expect(layerDetuneCents({ octave: -1, semitone: -3 })).toBe(-1200 - 300);
    expect(layerDetuneCents({})).toBe(0);
  });

  it('migrates a legacy transpose (semitones) to octave', () => {
    expect(only(sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine' }, transpose: 12 }] })).octave).toBe(1);
    expect(only(sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine' }, transpose: -24 }] })).octave).toBe(-2);
  });

  it('keeps fat-oscillator unison only for fat* oscillators', () => {
    const fat = sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'fatsawtooth', count: 20, spread: 200 } }] });
    expect(fat.layers[0].voice.count).toBe(8);    // COUNT_META max
    expect(fat.layers[0].voice.spread).toBe(100); // SPREAD_META max
    const thin = sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine', count: 4, spread: 50 } }] });
    expect('count' in thin.layers[0].voice).toBe(false);
    expect('spread' in thin.layers[0].voice).toBe(false);
  });

  it('clamps portamento when present and drops it when absent', () => {
    const withGlide = sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine', portamento: 5 } }] });
    expect(withGlide.layers[0].voice.portamento).toBe(0.5); // PORTAMENTO_META max
    const noGlide = sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine' } }] });
    expect('portamento' in noGlide.layers[0].voice).toBe(false);
  });

  it('clamps the load-bearing fxChain ranges (per layer)', () => {
    const p = sanitizePatch({
      layers: [{
        voice: { engine: 'simple', oscillator: 'sine' },
        effects: [{ type: 'delay', params: { time: 10, feedback: 3 } },
                  { type: 'reverb', params: { roomSize: 1.5 } }],
      }],
    });
    expect(only(p).effects[0].params.time).toBe(1.0);       // maxDelay:1 — rampTo above throws
    expect(only(p).effects[0].params.feedback).toBe(0.9);   // loop stability
    expect(only(p).effects[1].params.roomSize).toBe(0.95);  // Freeverb comb stability
  });

  it('drops unknown effect types and caps the chain length per layer', () => {
    const p = sanitizePatch({
      layers: [{
        voice: { engine: 'simple', oscillator: 'sine' },
        effects: [
          { type: 'megaverb', params: {} },
          ...Array.from({ length: 6 }, () => ({ type: 'filter', params: {} })),
        ],
      }],
    });
    expect(only(p).effects).toHaveLength(MAX_EFFECTS);
    expect(only(p).effects.every(e => e.type === 'filter')).toBe(true);
  });

  it('carries fm voice params only when relevant and clamps them', () => {
    const fm = sanitizePatch({ layers: [{ voice: { engine: 'fm', oscillator: 'sawtooth', harmonicity: 100, modulationIndex: -5 } }] });
    expect(fm.layers[0].voice.harmonicity).toBe(8);
    expect(fm.layers[0].voice.modulationIndex).toBe(0);
    const simple = sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine', harmonicity: 4 } }] });
    expect('harmonicity' in simple.layers[0].voice).toBe(false);
  });

  it('accepts a null layer filter', () => {
    expect(sanitizePatch({ layers: [{ voice: { engine: 'simple', oscillator: 'sine' }, filter: null }] }).layers[0].filter).toBeNull();
  });
});
