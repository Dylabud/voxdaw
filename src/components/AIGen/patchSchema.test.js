import { sanitizePatch, DEFAULT_PATCH, MAX_EFFECTS } from './patchSchema';

describe('sanitizePatch', () => {
  it('returns a complete playable patch from garbage input', () => {
    for (const raw of [null, undefined, 42, 'x', {}, { voice: 'nope', effects: 'nope' }]) {
      const p = sanitizePatch(raw);
      expect(p.voice.engine).toBe('simple');
      expect(p.envelope.attack).toBeGreaterThan(0);
      expect(Array.isArray(p.effects)).toBe(true);
      expect(p.volume).toBe(DEFAULT_PATCH.volume);
    }
  });

  it('clamps the load-bearing fxChain ranges', () => {
    const p = sanitizePatch({
      effects: [{ type: 'delay', params: { time: 10, feedback: 3 } },
                { type: 'reverb', params: { roomSize: 1.5 } }],
    });
    expect(p.effects[0].params.time).toBe(1.0);       // maxDelay:1 — rampTo above throws
    expect(p.effects[0].params.feedback).toBe(0.9);   // loop stability
    expect(p.effects[1].params.roomSize).toBe(0.95);  // Freeverb comb stability
  });

  it('drops unknown effect types and caps the chain length', () => {
    const p = sanitizePatch({
      effects: [
        { type: 'megaverb', params: {} },
        ...Array.from({ length: 6 }, () => ({ type: 'filter', params: {} })),
      ],
    });
    expect(p.effects).toHaveLength(MAX_EFFECTS);
    expect(p.effects.every(e => e.type === 'filter')).toBe(true);
  });

  it('fills unspecified effect params from registry defaults and drops unknown keys', () => {
    const p = sanitizePatch({ effects: [{ type: 'reverb', params: { wet: 0.8, bogus: 99 } }] });
    expect(p.effects[0].params.wet).toBe(0.8);
    expect(p.effects[0].params.roomSize).toBe(0.7); // registry default
    expect('bogus' in p.effects[0].params).toBe(false);
  });

  it('validates select and toggle params', () => {
    const p = sanitizePatch({
      filter: { type: 'notch', frequency: 1000, q: 1 },
      effects: [{ type: 'delay', params: { dryThru: 'yes' } },
                { type: 'filter', params: { type: 'allpass' } }],
    });
    expect(p.filter.type).toBe('lowpass');                 // invalid select → default
    expect(p.effects[0].params.dryThru).toBe(true);        // truthy → boolean
    expect(p.effects[1].params.type).toBe('lowpass');      // invalid select → default
  });

  it('carries fm voice params only when relevant and clamps them', () => {
    const fm = sanitizePatch({ voice: { engine: 'fm', oscillator: 'sawtooth', harmonicity: 100, modulationIndex: -5 } });
    expect(fm.voice.harmonicity).toBe(8);
    expect(fm.voice.modulationIndex).toBe(0);
    const simple = sanitizePatch({ voice: { engine: 'simple', oscillator: 'sine', harmonicity: 4 } });
    expect('harmonicity' in simple.voice).toBe(false);
  });

  it('accepts a null filter', () => {
    expect(sanitizePatch({ filter: null }).filter).toBeNull();
  });
});
