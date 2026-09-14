# VoxDaw

A browser-based music-making suite built on React, [Tone.js](https://tonejs.github.io/), and [MediaPipe](https://developers.google.com/mediapipe) — no plugins, no installs, everything runs in the page.

> **Status: alpha.** Actively developed; projects are stored locally in your browser (IndexedDB) and as `.voxdaw` files.

## The three instruments

| Page | What it is |
|---|---|
| **VoxTool** | Gesture-controlled synthesizer: your webcam + MediaPipe hand tracking drive pitch, chords, filter, arpeggiator, vocoder, and autotune in real time. Fully user-configurable signal/trigger routing. |
| **Workstation** | A DAW: multitrack arrangement with piano-roll editing, per-track insert effects (16 types), sampled + synth instruments (incl. three drum kits), ADSR overrides, WAV/MP3/`.voxdaw` export, and audio transcription from the Moog. |
| **Moog Modular** | A photorealistic 1960s System 55-style modular synth: drag patch cables between 18 module types (VCOs, VCFs, LFOs, multi-colour noise, envelopes, 960 sequencers, chord sequencer, CV quantizer, 16-band vocoder, 914 filter bank, kick, formant/vowel, stereo panner, multi-zone delay, wavefolder…), add/remove/duplicate modules from a library, and the whole custom rack — modules **and** cables — persists across reloads. The VCO core, hard sync, and CV quantization run in AudioWorklets. |

Projects live on a homepage dashboard (create, rename, duplicate, import/export `.voxdaw`).

## Running it

```bash
npm install
npm start        # dev server on http://localhost:3000
npm run build    # production build
npm test         # Jest + React Testing Library (watch mode)
```

Chrome is the primary target (Web Audio + AudioWorklet + MediaPipe). Grant camera access for VoxTool and microphone access for the vocoder/autotune features. Headphones recommended when using the mic.

## Documentation

| File | Contents |
|---|---|
| `CLAUDE.md` | Coding standards, architectural invariants (Zero-Re-render Rule, Single Writer per node), and the condensed architecture reference |
| `ARCHITECTURE.md` | Full technical architecture: audio graphs, data flow, per-subsystem design |
| `PLAN.md` | Project state and completed-work log |
| `src/components/MoogModular/MOOG_ARCHITECTURE.md` | Moog module specs, signal flow, and the Dynamic Rack as-built design |
| `src/components/MoogModular/MOOG_PLAN.md` | The Moog sub-project's phase-by-phase log |

## Stack

React 18 (CRA) · Tone.js 15 · MediaPipe Tasks Vision (hand landmarks) · pitchfinder (YIN pitch detection) · lamejs (MP3 encode) · native Web Audio AudioWorklets (hard sync, CV quantizer) · IndexedDB (project store)
