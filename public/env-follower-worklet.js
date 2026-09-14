// Asymmetric Envelope Follower AudioWorklet Processor
//
// Smooths the vocoder's 16 rectified modulator bands with INDEPENDENT attack and release
// time constants, one channel per band.
//
// Why this exists as a worklet when almost nothing else here needs one: a biquad/one-pole
// lowpass — which is what the vocoder used before — is inherently SYMMETRIC. One time
// constant has to serve both directions, which forces a losing trade:
//   fast  → consonant onsets punch, but the rectification ripple rides straight through
//           and wobbles the carrier VCA, and vowels get rough;
//   slow  → vowels are smooth, but consonants smear into the vowel that follows, which
//           is exactly "the vocals aren't clear".
// Asymmetric following wins both: a fast attack catches every consonant onset, while a
// slow release holds the envelope near the PEAK between ripple cycles — so it rejects
// ripple BETTER than a symmetric filter of the same speed, rather than worse.
//
// There is no native Web Audio node that smooths asymmetrically. A WaveShaper holds no
// state, and a DelayNode feedback loop is quantised to a 128-sample render block and
// would need a nonlinear element inside the cycle. Per-sample state is the whole job,
// which is precisely what an AudioWorklet is for.
//
// Input  [0]: 16 channels of already-rectified band energy (>= 0), via a ChannelMerger.
// Output [0]: 16 channels of smoothed envelope — split back out to the carrier band VCAs.
//
// Params (k-rate — both are global to the instance, not per band):
//   attack  — seconds. Pinned fast by the caller; the useful range is tiny and the
//             difference between 1 and 3 ms is not worth a panel control.
//   release — seconds. This is the DECAY knob.

const MAX_CHANNELS = 32;   // 16 bands, with headroom

class EnvFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'attack',  defaultValue: 0.0015, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.025,  minValue: 0.0005, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._y = new Float32Array(MAX_CHANNELS);   // per-channel envelope state, persists across blocks
  }

  process(inputs, outputs, params) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // One-pole coefficient for a given time constant: 1 - exp(-1 / (tau * sampleRate)).
    // Recomputed per block; k-rate params only change on knob moves.
    const atkTau = Math.max(1e-5, params.attack[0]);
    const relTau = Math.max(1e-5, params.release[0]);
    const aC = 1 - Math.exp(-1 / (atkTau * sampleRate));
    const rC = 1 - Math.exp(-1 / (relTau * sampleRate));

    for (let ch = 0; ch < output.length; ch++) {
      const outC = output[ch];
      const inC  = input && input[ch] ? input[ch] : null;
      let y = this._y[ch];

      if (!inC) {
        // Channel is silent/absent — decay toward 0 at the release rate rather than
        // snapping, so an instance whose carrier stops does not click its VCAs shut.
        for (let i = 0; i < outC.length; i++) { y += (0 - y) * rC; outC[i] = y; }
      } else {
        for (let i = 0; i < inC.length; i++) {
          const x = inC[i];
          // The asymmetry, and the entire point of this file.
          y += (x - y) * (x > y ? aC : rC);
          outC[i] = y;
        }
      }
      this._y[ch] = y;
    }
    return true;   // never let the node be garbage-collected — it runs for the session
  }
}

registerProcessor('env-follower-processor', EnvFollowerProcessor);
