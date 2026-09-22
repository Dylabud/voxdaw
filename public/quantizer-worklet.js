// Musical Quantizer AudioWorklet Processor
//
// Reads a continuous CV signal in Hz (matching the VCO frequency range), snaps each
// sample to the nearest note in the selected scale, and outputs the quantized Hz value.
// Running at audio rate produces a true staircase effect when CV sweeps through notes.
//
// Scale configuration is sent via port.postMessage({ scale: number[], root: number }).
//   scale — semitone offsets from root (e.g. [0,2,4,5,7,9,11] for major)
//   root  — root note class 0–11 (0=C, 1=C#, 2=D, …, 11=B)
//
// When the quantized note class changes, the processor posts { noteClass: 0–11 } back
// to the main thread for LED display. The delta check limits port traffic to at most
// one message per 128-sample block (≈ 2.9 ms at 44100 Hz).
//
// Input  [0]: Hz-range CV signal (from seq-pitch-out, kbd-pitch-out, or another pitch CV)
// Output [0]: quantized Hz signal — passes directly to vco-cv jacks
//
// Modulation mode (Phase 58): samples with |v| ≤ MOD_MAX are modulator-range CV
// (LFOs output ±1 · depth — far below any musical Hz). They are mapped to a
// ±12-semitone offset around baseHz (posted by the main thread — the FREQ knob
// of the qnt-patched VCO) and the sum is quantized: LFO sweeps become stepped
// scale runs. The decision is per-sample, so Hz-range pitch CV keeps its
// direct behavior. For a SMOOTH (unquantized) sweep, patch the modulator
// straight to the VCO's cv-in — that is the modular answer, and it is why
// BYPASS was removed in Phase 95.

// Boundary between modulator-range CV (LFO ±1) and pitch CV (Hz ≥ 32.7 = C1).
const MOD_MAX = 8;

// Output clamp (Phase 95) — the MIDI range, C-1 … G9. Two paths can leave it:
// modulation mode is baseHz · 2^v and v is only bounded by MOD_MAX, so several
// modulators summed into one cv-in (Web Audio adds them) reach 2^8 = 8 octaves
// above base — 56 kHz, past Nyquist; and a high pitch CV plus OCT +3 clears
// 16 kHz. Both drive a VCO somewhere it cannot render. 0 passes through
// untouched: it is the "no signal" value, not a pitch.
const HZ_MIN = 8.1758;     // MIDI 0
const HZ_MAX = 12543.854;  // MIDI 127
const clampHz = (hz) => (hz <= 0 ? 0 : Math.min(HZ_MAX, Math.max(HZ_MIN, hz)));

// Hysteresis (Phase 100), in semitones. The input must travel this far PAST the
// point where the output would change before the new note is accepted.
//
// Without it, a CV sitting near a note boundary flips back and forth on every
// wobble — and since Phase 96 every note change also fires TRIG^, so the flutter
// machine-guns whatever envelope is patched. Measured on a 2 s E4->F4 sweep that
// should produce exactly 2 note changes: a perfectly clean CV gave 2, but 10
// cents of vibrato gave 6, 25 cents gave 14, and 50 cents gave 26. A perfectly
// clean CV does not exist in a real patch.
//
// 35 cents is comfortably more than the wobble of an LFO or a glide, and well
// under the 50 cents it would take to reach the next note — so it removes the
// chatter without ever letting the output sit on the wrong note.
const HYST_SEMI = 0.35;

// Snap direction (Phase 100). 0 = nearest, 1 = up (ceiling), 2 = down (floor).
const SNAP_NEAR = 0, SNAP_UP = 1, SNAP_DOWN = 2;

class QuantizerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return []; // all runtime config sent via MessagePort
  }

  constructor() {
    super();
    // Default: C major, no octave shift
    this._scale    = [0, 2, 4, 5, 7, 9, 11];
    this._root     = 0;  // C
    this._octShift = 0;  // semitones = octShift * 12
    this._lastMidiNote = -1; // full MIDI note (not just class) — avoids missing C3→C4 transitions

    this._hadSignal = false; // for IN LED: fires only on cable connect/disconnect
    this._baseHz    = 220;   // modulation-mode center — the qnt-patched VCO's FREQ knob
    this._snapMode  = SNAP_NEAR;
    this._heldMidi  = null;  // the note currently being held against HYST_SEMI
    this._inScale   = [];    // pitch class -> in the scale? (rebuilt on config change)
    this._rebuildInScale();

    this.port.onmessage = ({ data }) => {
      let rescale = false;
      if (data.scale    !== undefined) { this._scale = data.scale; rescale = true; }
      if (data.root     !== undefined) { this._root  = data.root;  rescale = true; }
      if (data.octShift !== undefined) this._octShift = data.octShift;
      if (data.baseHz   !== undefined) this._baseHz   = data.baseHz;
      if (data.snapMode !== undefined) this._snapMode = data.snapMode;
      if (rescale) this._rebuildInScale();
    };
  }

  // Pitch-class lookup, so the hysteresis and ceiling/floor walks are O(1) per step
  // instead of scanning the scale array at audio rate.
  _rebuildInScale() {
    this._inScale = new Array(12).fill(false);
    for (let i = 0; i < this._scale.length; i++)
      this._inScale[(((this._root + this._scale[i]) % 12) + 12) % 12] = true;
  }

  _isIn(midi) { return this._inScale[((midi % 12) + 12) % 12]; }

  // Nearest in-scale note in the given direction (+1 up, −1 down). Bounded by an
  // octave: any non-empty scale has a member within 12 semitones.
  _stepTo(midi, dir) {
    for (let i = 1; i <= 12; i++) {
      const m = midi + dir * i;
      if (this._isIn(m)) return m;
    }
    return midi;
  }

  // Snap a fractional MIDI note into the scale, honouring the snap direction.
  // Algorithm:
  //   1. For each scale degree, find the nearest MIDI note at any octave
  //      (nearest k such that 12k + root + degree is closest to midiIn)
  //   2. UP / DOWN then walk to the next in-scale note on the required side if
  //      the nearest landed on the wrong one.
  _snap(midiIn) {
    let bestMidi = Math.round(midiIn);
    let minDist  = Infinity;

    for (let s = 0; s < this._scale.length; s++) {
      const base = this._root + this._scale[s]; // absolute chromatic position
      const k    = Math.round((midiIn - base) / 12);
      const cand = 12 * k + base;
      const dist = Math.abs(cand - midiIn);
      // Plain `<`, deliberately. An input EXACTLY halfway between two in-scale
      // notes would be a tie this breaks arbitrarily (first matching scale degree
      // wins) — but the input arrives as Float32 audio, so a value that is an
      // exact tie in double precision is not one by the time it is in the buffer.
      // The case is unreachable here, and this loop runs per sample, so it does
      // not get a tie-break branch it can never use (Phase 100).
      if (dist < minDist) {
        minDist  = dist;
        bestMidi = cand;
      }
    }

    if (this._snapMode === SNAP_UP   && bestMidi < midiIn - 1e-6) bestMidi = this._stepTo(bestMidi, +1);
    if (this._snapMode === SNAP_DOWN && bestMidi > midiIn + 1e-6) bestMidi = this._stepTo(bestMidi, -1);
    return bestMidi;
  }

  // Snap with hysteresis: hold the current note until the input has moved
  // HYST_SEMI past the point where the output would otherwise change.
  //
  // The test is "re-snap the input, biased back toward the note we are holding".
  // If that biased input still resolves to the held note, we have not travelled
  // far enough yet. Doing it this way is MODE-AGNOSTIC — a plain distance
  // comparison works for nearest (whose boundary is the midpoint) but is wrong
  // for UP/DOWN, whose boundary sits on the note itself.
  _quantizeMidi(midiIn) {
    const cand = this._snap(midiIn);
    const held = this._heldMidi;
    // Nothing held yet, or the scale changed under us and the held note is no
    // longer in it — take the candidate without argument.
    if (held === null || !this._isIn(held)) { this._heldMidi = cand; return cand; }
    if (cand === held) return held;
    const biased = this._snap(midiIn + (cand > held ? -HYST_SEMI : HYST_SEMI));
    if (biased === held) return held;
    this._heldMidi = cand;
    return cand;
  }

  // Hz in → quantized Hz out, octave shift applied last.
  _quantize(hz) {
    if (hz <= 0) return 0;
    const midiIn = 12 * Math.log2(hz / 440) + 69;
    const midi   = this._quantizeMidi(midiIn);
    return clampHz(440 * Math.pow(2, (midi + this._octShift * 12 - 69) / 12));
  }

  process(inputs, outputs, parameters) {
    const inputCh  = inputs[0]?.[0];
    const outputCh = outputs[0][0];

    // IN LED: notify main thread only when cable connect/disconnect state changes.
    // inputCh === undefined → no cable; Float32Array → cable connected.
    const hasSignal = !!inputCh;
    if (hasSignal !== this._hadSignal) {
      this._hadSignal = hasSignal;
      // Forget the last note on EVERY transition (Phase 95). The panel clears its
      // note LED and Hz readout when the cable is pulled, so the stored note no
      // longer matches what is on screen — without this reset, re-patching the
      // same source at the same pitch loses the delta check and the display
      // stays blank until the note happens to change.
      this._lastMidiNote = -1;
      this._heldMidi     = null;   // a new cable starts fresh — nothing to hold against
      this.port.postMessage({ hasSignal });
    }

    if (!inputCh) {
      outputCh.fill(0);
      return true;
    }

    for (let i = 0; i < outputCh.length; i++) {
      let v = inputCh[i];
      // Modulation mode: modulator-range sample → ±12 semitones around baseHz.
      if (Math.abs(v) <= MOD_MAX) v = this._baseHz * Math.pow(2, v);
      outputCh[i] = this._quantize(v);
    }

    // Notify the main thread when the output MIDI note changes.
    // Compare full midiOut (not just noteClass) so octave changes (C3→C4, or OCT SHIFT)
    // always trigger a display update even when the note letter is the same.
    const lastHz = outputCh[outputCh.length - 1];
    if (lastHz > 0) {
      const midiOut   = Math.round(12 * Math.log2(lastHz / 440) + 69);
      if (midiOut !== this._lastMidiNote) {
        this._lastMidiNote = midiOut;
        const noteClass = ((midiOut % 12) + 12) % 12;
        this.port.postMessage({ noteClass, midiNote: midiOut });
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('quantizer-processor', QuantizerProcessor);
