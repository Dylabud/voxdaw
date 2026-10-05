// VCO Core + Hard Sync AudioWorklet Processor (Moog Phase 68b)
//
// This is the full oscillator CORE for every Vox Modular VCO — not just a sync helper.
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
// Output [0], channels:  STEREO PAIRS (Phase 106) — 0/1=sine L/R 2/3=triangle L/R
//                        4/5=sawtooth L/R 6/7=pulse L/R, each [-1, +1]. useVoxAudio
//                        gates the 8 channels with a single Gain, splits them and
//                        re-merges each pair into that waveform's tap. L === R exactly
//                        unless KEY PAN is engaged, and the taps downmix to mono
//                        ((L+R)/2 = the old value, bit-exact) until it is.
//
// KEY PAN (Phase 106): port.postMessage({ panSpread: 0..1 }). Each voice's stereo
// position follows its CURRENT frequency on the piano's range (A0 hard left → C8
// hard right, ≈E4 centre), scaled by panSpread and smoothed, so chords spread across
// the speakers and glides/bends travel. BALANCE law (centre = unity on both sides),
// never equal-power: equal-power's centre would be −3 dB, i.e. not the old sound.
//
// PARAPHONIC VOICES (Moog Phase 105): the core holds up to MAX_SLOTS phase
// accumulators ("voice slots") instead of one, so a single VCO can sound a chord
// from the 953 keyboard. Every slot reads the SAME params (slaveFreq, detune, SHAPE,
// sync), so each note is literally this VCO's sound at another pitch. A slot's
// frequency is slaveFreq × its ratio; the keyboard writes the chord's first note to
// the GlideBus (ratio 1) and posts the other notes' ratios here:
//   port.postMessage({ voices: [{ id, ratio }, …] })
// Slots whose id is missing fade out (FADE_OUT_SEC); new ids fade in from phase 0
// (FADE_IN_SEC) — no clicks either way. The mix is scaled by 1/√(voices), smoothed,
// so a chord is fuller but not N× louder. Default = one slot 'm' at ratio 1, full
// gain, norm 1 — sample-for-sample the pre-105 single-phase core, which is what
// every non-keyboard pitch source (seq/qnt/chord/knob) keeps getting.
//
// The processor returns true forever (keeps running). Its outputs are silenced
// while the synth is unpowered by the per-VCO waveform Gain nodes in useVoxAudio,
// which are held at 0 until powerOn (the worklet itself cannot be stopped).

const MAX_SLOTS    = 12;     // 8 held notes + headroom for notes still fading out
const FADE_IN_SEC  = 0.004;
const FADE_OUT_SEC = 0.012;
const NORM_TAU_SEC = 0.010;  // smoothing for the 1/√N level compensation
const PAN_TAU_SEC  = 0.020;  // per-block smoothing of each voice's pan position
const PAN_LO_HZ    = 27.5;   // A0 — hard left at full spread
const PAN_OCTAVES  = Math.log2(4186.01 / 27.5); // A0 → C8

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
    this._prevMasterSample = 0;
    // Voice slots (see header). Slot 0 starts as the mono voice 'm'.
    this._ids    = new Array(MAX_SLOTS).fill(null);
    this._phase  = new Float64Array(MAX_SLOTS);   // normalized phase [0, 1)
    this._ratio  = new Float64Array(MAX_SLOTS).fill(1);
    this._gain   = new Float32Array(MAX_SLOTS);
    this._target = new Float32Array(MAX_SLOTS);
    this._ids[0] = 'm'; this._gain[0] = 1; this._target[0] = 1;
    this._pan    = new Float32Array(MAX_SLOTS);   // smoothed pan position, −1..+1
    this._active = new Int32Array(MAX_SLOTS);     // scratch: indices of live slots
    this._panSpread = 0;
    this._norm   = 1;
    this._fadeInStep  = 1 / (FADE_IN_SEC  * sampleRate);
    this._fadeOutStep = 1 / (FADE_OUT_SEC * sampleRate);
    this._normCoef    = 1 - Math.exp(-1 / (NORM_TAU_SEC * sampleRate));
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.voices !== undefined) this._setVoices(d.voices);
      if (d.panSpread !== undefined) {
        const sp = +d.panSpread;
        this._panSpread = Number.isFinite(sp) ? Math.max(0, Math.min(1, sp)) : 0;
      }
    };
  }

  _setVoices(voices) {
    if (!Array.isArray(voices)) return;
    const want = new Map();
    for (const v of voices) {
      const r = +v?.ratio;
      if (v && v.id != null && r > 0 && Number.isFinite(r)) want.set(v.id, r);
    }
    for (let s = 0; s < MAX_SLOTS; s++) {
      const id = this._ids[s];
      if (id === null) continue;
      if (want.has(id)) { this._ratio[s] = want.get(id); this._target[s] = 1; want.delete(id); }
      else this._target[s] = 0;
    }
    for (const [id, ratio] of want) {
      let slot = this._ids.indexOf(null);
      if (slot < 0) {
        // Full: steal the quietest slot that is already fading out.
        let best = -1;
        for (let s = 0; s < MAX_SLOTS; s++)
          if (this._target[s] === 0 && (best < 0 || this._gain[s] < this._gain[best])) best = s;
        if (best < 0) continue;
        slot = best;
      }
      this._ids[slot] = id; this._ratio[slot] = ratio;
      this._phase[slot] = 0; this._gain[slot] = 0; this._target[slot] = 1;
      this._pan[slot] = NaN;   // snap to its own position on the first block
    }
  }

  process(inputs, outputs, parameters) {
    // Single output, four channels: 0=sine 1=triangle 2=sawtooth 3=pulse
    const out = outputs[0];
    if (!out || !out[7]) return true;
    const sinL = out[0], sinR = out[1];
    const triL = out[2], triR = out[3];
    const sawL = out[4], sawR = out[5];
    const pulL = out[6], pulR = out[7];

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
    const n = sinL.length;

    const ids = this._ids, phase = this._phase, ratio = this._ratio;
    const gain = this._gain, target = this._target, active = this._active;
    let nActive = 0, nTarget = 0;
    for (let s = 0; s < MAX_SLOTS; s++) {
      if (ids[s] === null) continue;
      active[nActive++] = s;
      nTarget += target[s];
    }
    const normGoal = 1 / Math.sqrt(nTarget > 1 ? nTarget : 1);

    // KEY PAN: per-voice balance gains, evaluated once per block from the voice's
    // current pitch (block-start frequency — FM wobble barely moves it, glides and
    // bends travel). Skipped entirely at spread 0, where L and R are identical.
    const spread = this._panSpread;
    const panned = spread > 0;
    const pan = this._pan;
    if (panned) {
      const f0 = Math.max(0.0001, freqArr[0]) * detuneRatio;
      const k  = 1 - Math.exp(-n / (PAN_TAU_SEC * sampleRate));
      for (let a = 0; a < nActive; a++) {
        const s = active[a];
        let pos = (Math.log2(f0 * ratio[s] / PAN_LO_HZ) / PAN_OCTAVES) * 2 - 1;
        pos = (pos < -1 ? -1 : pos > 1 ? 1 : pos) * spread;
        const cur = pan[s];
        pan[s] = cur !== cur ? pos : cur + (pos - cur) * k;   // NaN → first block snaps
      }
    }
    const inStep = this._fadeInStep, outStep = this._fadeOutStep, normCoef = this._normCoef;
    let norm = this._norm;

    for (let i = 0; i < n; i++) {
      // Hard-sync reset: large downward jump in the master = its cycle reset.
      // Resets every voice — they all share the one analog core's sync input.
      const m = masterCh ? masterCh[i] : 0;
      const reset = syncOn && this._prevMasterSample > 0 && m < this._prevMasterSample - 0.5;
      this._prevMasterSample = m;

      const f = Math.max(0.0001, (freqIsAr ? freqArr[i] : freqArr[0])) * detuneRatio * invSR;
      norm += (normGoal - norm) * normCoef;
      let sSin = 0, sTri = 0, sSaw = 0, sPul = 0;
      let rSin = 0, rTri = 0, rSaw = 0, rPul = 0;

      for (let a = 0; a < nActive; a++) {
        const s = active[a];
        let g = gain[s];
        const t = target[s];
        if (g !== t) {
          g = g < t ? Math.min(t, g + inStep) : Math.max(t, g - outStep);
          gain[s] = g;
        }
        if (reset) phase[s] = 0;
        // SHAPE: warp the phase so its midpoint (0.5) lands at w, then read all four
        // waveforms from the warped phase → sine leans (phase distortion), triangle
        // skews toward a ramp, saw bends, pulse duty = w. Continuous & monotonic, so
        // the saw reset edge (hard-sync-out source) stays sharp.
        const ph = phase[s];
        const wp = ph < w ? 0.5 * (ph / w) : 0.5 + 0.5 * (ph - w) / (1 - w);
        const vSin = Math.sin(TWO_PI * wp);
        const vTri = 1 - 4 * Math.abs(wp - 0.5);
        const vSaw = 2 * wp - 1;
        const vPul = wp < 0.5 ? 1 : -1;
        if (panned) {
          const p  = pan[s];
          const gl = g * (p > 0 ? 1 - p : 1);   // balance law: centre = unity both sides
          const gr = g * (p < 0 ? 1 + p : 1);
          sSin += gl * vSin; sTri += gl * vTri; sSaw += gl * vSaw; sPul += gl * vPul;
          rSin += gr * vSin; rTri += gr * vTri; rSaw += gr * vSaw; rPul += gr * vPul;
        } else {
          sSin += g * vSin; sTri += g * vTri; sSaw += g * vSaw; sPul += g * vPul;
        }

        // Advance this voice's phase (cycles per sample = Hz × ratio / sampleRate)
        let next = ph + f * ratio[s];
        if (next >= 1) next -= Math.floor(next);
        phase[s] = next;
      }

      sinL[i] = sSin * norm; triL[i] = sTri * norm; sawL[i] = sSaw * norm; pulL[i] = sPul * norm;
      if (panned) {
        sinR[i] = rSin * norm; triR[i] = rTri * norm; sawR[i] = rSaw * norm; pulR[i] = rPul * norm;
      } else {
        sinR[i] = sinL[i]; triR[i] = triL[i]; sawR[i] = sawL[i]; pulR[i] = pulL[i];
      }
    }
    this._norm = norm;

    // Free slots that have finished fading out.
    for (let a = 0; a < nActive; a++) {
      const s = active[a];
      if (target[s] === 0 && gain[s] === 0) ids[s] = null;
    }

    return true; // keep the processor alive indefinitely
  }
}

registerProcessor('hard-sync-processor', HardSyncProcessor);
