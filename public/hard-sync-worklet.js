// Hard Sync AudioWorklet Processor
//
// Implements true hard sync: the slave oscillator's phase is reset to 0 on every
// positive-edge discontinuity detected in the master signal. This creates the
// characteristic "tearing" harmonic sweep — as the slave frequency rises (via envelope
// sweep on slaveFreq), its truncated partial cycles create harmonics phase-locked to
// the master's fundamental.
//
// Master signal detection: a sawtooth discontinuity appears as a large downward jump
// between adjacent samples (prev > 0, current < prev - 0.5). The threshold of 0.5
// safely exceeds any smooth waveform's per-sample slope (max ~0.031 at 220 Hz / 44100 Hz),
// so it only fires on actual discontinuities (sawtooth reset, square wave edges).
// Sine and triangle waveforms as master do NOT trigger sync — use sawtooth for authentic
// hard sync character, square for a harder edge.
//
// AudioParam:
//   slaveFreq   (k-rate, Hz)    — slave oscillator frequency; additive CV connections
//                                  (e.g. vco2fm Gain node) stack on top of the base value
//   slaveDetune (k-rate, cents) — fine-tune offset applied on top of slaveFreq
//
// Input  [0]: master oscillator signal (connect VCO1 SAW output here)
// Output [0]: synchronized slave sawtooth waveform [-1, +1]
//
// Usage note: the output is silent if gain on the vco2syncOut wrapper is 0 (sync toggle off).
// Patch VCO1-SAW → VCO2-SYNC-IN, then enable HARD SYNC toggle on VCO2 to hear the effect.

class HardSyncProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'slaveFreq',
        defaultValue: 220,
        minValue: 0.1,
        maxValue: 22050,
        automationRate: 'k-rate',
      },
      {
        name: 'slaveDetune',
        defaultValue: 0,
        minValue: -2400,
        maxValue: 2400,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this._slavePhase    = 0;
    this._prevMasterSample = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];

    // inputs[0][0] is undefined when no cable is patched to SYNC IN.
    // In that case the slave runs free (no phase resets) — audible as a normal
    // sawtooth so the user knows to patch a master cable for sync effect.
    const masterCh = inputs[0]?.[0];

    // k-rate: one scalar value covers the whole 128-sample block
    const slaveFreq   = Math.max(0.1, parameters.slaveFreq[0]);
    const slaveDetune = parameters.slaveDetune[0];

    // Apply cents offset: freq × 2^(cents/1200)
    const effFreq  = slaveFreq * Math.pow(2, slaveDetune / 1200);
    // sampleRate is a global in AudioWorkletGlobalScope
    const phaseInc = (2 * Math.PI * effFreq) / sampleRate;

    for (let i = 0; i < out.length; i++) {
      const m = masterCh ? masterCh[i] : 0;

      // Detect sawtooth/square reset: large downward discontinuity.
      // Condition: previous sample was positive AND the drop in one sample > 0.5.
      // This is impossible for smooth waveforms (sine, triangle) at any musical frequency
      // and sample rate ≥ 44100 Hz, so it fires exclusively on the sharp reset edge.
      if (this._prevMasterSample > 0 && m < this._prevMasterSample - 0.5) {
        this._slavePhase = 0; // hard sync: reset slave phase to cycle start
      }
      this._prevMasterSample = m;

      // Advance slave phase accumulator
      this._slavePhase += phaseInc;
      if (this._slavePhase >= 2 * Math.PI) {
        this._slavePhase -= 2 * Math.PI;
      }

      // Sawtooth output: [0, 2π] linearly mapped to [-1, +1]
      out[i] = (this._slavePhase / Math.PI) - 1;
    }

    return true; // keep processor alive indefinitely
  }
}

registerProcessor('hard-sync-processor', HardSyncProcessor);
