// VCO Core + Hard Sync AudioWorklet Processor (Moog Phase 68b)
//
// This is the full oscillator CORE for every Moog VCO — not just a sync helper.
// A single phase accumulator generates FOUR simultaneous waveforms (sine,
// triangle, sawtooth, pulse) on four separate mono outputs, so all four of a
// VCO's output jacks are live at once (a real 921/901 VCO behaviour).
//
// HARD SYNC: when syncEnabled is on AND a master signal is patched to the input,
// the shared phase is reset to 0 on every positive→negative discontinuity in the
// master (sawtooth reset / square edge). Because ALL FOUR waveforms read the same
// phase, they all sync together — exactly like an analog core. Sine/triangle
// masters do NOT trigger sync (no discontinuity); use saw/square as the master.
//
// AudioParams:
//   slaveFreq   (A-RATE, Hz)    — oscillator frequency. Additive CV connections
//                                  (glideBus Signal + fm Gain) sum onto the base 0.
//                                  A-rate so audio-rate FM stays clean (k-rate would alias).
//   slaveDetune (k-rate, cents) — fine-tune offset applied on top of slaveFreq
//   pulseWidth  (k-rate, 0..1)  — pulse duty cycle (0.5 = square); PW-CV sums here
//   syncEnabled (k-rate, 0/1)   — HARD SYNC toggle; when 0 the core free-runs
//
// Input  [0]:            master oscillator signal (patch another VCO's SAW/SYNC-OUT here)
// Output [0], channels:  0=sine 1=triangle 2=sawtooth 3=pulse, each [-1, +1]
//                        (one 4-channel output — useMoogAudio gates it with a single
//                         Gain then splits the channels to the four output jacks)
//
// The processor returns true forever (keeps running). Its outputs are silenced
// while the synth is unpowered by the per-VCO waveform Gain nodes in useMoogAudio,
// which are held at 0 until powerOn (the worklet itself cannot be stopped).

class HardSyncProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Intrinsic defaults are 0 for the connected params (slaveFreq / slaveDetune /
      // pulseWidth) so their driving Signal/Gain connections SUM cleanly onto 0
      // rather than onto a nonzero base. WidthSig supplies the ~0.5 square default.
      { name: 'slaveFreq',   defaultValue: 0, minValue: 0,     maxValue: 22050, automationRate: 'a-rate' },
      { name: 'slaveDetune', defaultValue: 0, minValue: -2400, maxValue: 2400,  automationRate: 'k-rate' },
      { name: 'pulseWidth',  defaultValue: 0, minValue: 0,     maxValue: 1,     automationRate: 'k-rate' },
      { name: 'syncEnabled', defaultValue: 0, minValue: 0,     maxValue: 1,     automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._phase = 0;                 // normalized phase [0, 1)
    this._prevMasterSample = 0;
  }

  process(inputs, outputs, parameters) {
    // Single output, four channels: 0=sine 1=triangle 2=sawtooth 3=pulse
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const sinO = out[0];
    const triO = out[1];
    const sawO = out[2];
    const pulO = out[3];

    const masterCh   = inputs[0]?.[0]; // undefined when SYNC IN is unpatched
    const freqArr    = parameters.slaveFreq;             // a-rate → length 128 (or 1 if steady)
    const freqIsAr   = freqArr.length > 1;
    const detuneRatio = Math.pow(2, parameters.slaveDetune[0] / 1200);
    // SHAPE (0..1, 0.5 = no warp) — the pulseWidth param now drives a phase warp
    // applied to ALL FOUR waveforms, not just the pulse (see the loop).
    const shape      = parameters.pulseWidth[0];
    const w          = shape < 0.001 ? 0.001 : (shape > 0.999 ? 0.999 : shape);
    const syncOn     = parameters.syncEnabled[0] > 0.5;
    const TWO_PI     = 2 * Math.PI;
    const invSR      = 1 / sampleRate;
    const n = sinO.length;

    for (let i = 0; i < n; i++) {
      // Hard-sync reset: large downward jump in the master = its cycle reset.
      const m = masterCh ? masterCh[i] : 0;
      if (syncOn && this._prevMasterSample > 0 && m < this._prevMasterSample - 0.5) {
        this._phase = 0;
      }
      this._prevMasterSample = m;

      // SHAPE: warp the phase so its midpoint (0.5) lands at w, then read all four
      // waveforms from the warped phase → sine leans (phase distortion), triangle
      // skews toward a ramp, saw bends, pulse duty = w. Continuous & monotonic, so
      // the saw reset edge (hard-sync-out source) stays sharp.
      const ph = this._phase;
      const wp = ph < w ? 0.5 * (ph / w) : 0.5 + 0.5 * (ph - w) / (1 - w);
      sinO[i] = Math.sin(TWO_PI * wp);
      triO[i] = 1 - 4 * Math.abs(wp - 0.5);
      sawO[i] = 2 * wp - 1;
      pulO[i] = wp < 0.5 ? 1 : -1;

      // Advance shared phase (cycles per sample = Hz / sampleRate)
      const f = Math.max(0.0001, (freqIsAr ? freqArr[i] : freqArr[0])) * detuneRatio;
      let next = ph + f * invSR;
      if (next >= 1) next -= 1;
      this._phase = next;
    }

    return true; // keep the processor alive indefinitely
  }
}

registerProcessor('hard-sync-processor', HardSyncProcessor);
