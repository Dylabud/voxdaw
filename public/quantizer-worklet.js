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

    this._bypass    = false;
    this._hadSignal = false; // for IN LED: fires only on cable connect/disconnect

    this.port.onmessage = ({ data }) => {
      if (data.scale    !== undefined) this._scale    = data.scale;
      if (data.root     !== undefined) this._root     = data.root;
      if (data.octShift !== undefined) this._octShift = data.octShift;
      if (data.bypass   !== undefined) this._bypass   = data.bypass;
    };
  }

  // Map any Hz value to the nearest Hz in the configured scale.
  // Algorithm:
  //   1. Convert Hz → fractional MIDI note number
  //   2. For each scale degree, find the nearest MIDI note at any octave
  //      (nearest k such that 12k + root + degree is closest to midiIn)
  //   3. Convert the winning MIDI note back to Hz
  _quantize(hz) {
    if (hz <= 0) return 0;

    const midiIn = 12 * Math.log2(hz / 440) + 69;

    let bestMidi = Math.round(midiIn);
    let minDist  = Infinity;

    for (let s = 0; s < this._scale.length; s++) {
      const base = this._root + this._scale[s]; // absolute chromatic position
      // Find the octave k that puts this note nearest to midiIn
      const k    = Math.round((midiIn - base) / 12);
      const cand = 12 * k + base;
      const dist = Math.abs(cand - midiIn);
      if (dist < minDist) {
        minDist  = dist;
        bestMidi = cand;
      }
    }

    // Apply octave shift before converting back to Hz
    return 440 * Math.pow(2, (bestMidi + this._octShift * 12 - 69) / 12);
  }

  process(inputs, outputs, parameters) {
    const inputCh  = inputs[0]?.[0];
    const outputCh = outputs[0][0];

    // IN LED: notify main thread only when cable connect/disconnect state changes.
    // inputCh === undefined → no cable; Float32Array → cable connected.
    const hasSignal = !!inputCh;
    if (hasSignal !== this._hadSignal) {
      this._hadSignal = hasSignal;
      this.port.postMessage({ hasSignal });
    }

    if (!inputCh) {
      outputCh.fill(0);
      return true;
    }

    // BYPASS: pass input directly to output without quantizing.
    // Useful for confirming cables/patching before enabling the quantizer.
    for (let i = 0; i < outputCh.length; i++) {
      outputCh[i] = this._bypass ? inputCh[i] : this._quantize(inputCh[i]);
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
