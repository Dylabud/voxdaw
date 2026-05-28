# MOOG_ARCHITECTURE.md
## 1960s Moog Modular Synthesizer — Module Specifications & Implementation Blueprint

> **How to use this file:**
> This is the canonical signal-flow and module-design reference for the Moog Modular sub-project.
> - All implementation decisions (audio graph wiring, Tone.js node choices, port types) must be consistent with this document.
> - When a module is implemented in a phase, annotate it with `[Implemented: Moog Phase N]`.
> - Do not modify this file without flagging changes to Dylan first.
> - Do NOT conflate this document with the root `ARCHITECTURE.md` (VoxTool/Workstation signal flow).

---

## Signal Type System

All connections carry one of two signal classes. The patch cable simulator must enforce type compatibility at connect time:

| Signal Class | Sub-type | Description |
|---|---|---|
| **AUDIO** | — | Audible waveforms (~20 Hz – 20 kHz). Flows through VCO → VCF → VCA → I/O. |
| **CV** | Continuous | Smoothly sweeping voltage (−5V to +5V or 0–10V). Used for pitch, cutoff, modulation. |
| **CV** | Gate | Max voltage held HIGH for note duration, snaps to 0 on release. Sustains envelopes. |
| **CV** | Trigger | Microsecond voltage spike. Fires one-shot attacks, resets sequences/LFOs. |
| **CV** | Clock | Steady rhythmic trigger stream. Synchronizes tempo between modules. |

**1 Volt per Octave (1V/Oct):** The universal CV pitch standard. Every 1V increase doubles the oscillator frequency (one octave up). All CV pitch outputs (Sequencer, keyboard) and all VCO CV inputs use this standard.

---

## Module Specifications

---

### 1. VCO — Voltage Controlled Oscillator

**Function:** The raw sound source. Generates a continuous waveform at a pitch determined by its Frequency knob and any incoming CV. It drones indefinitely — a VCA must gate it. Pitch tracks at 1V/Oct on the CV input.

**Controls:**
| Knob | Function |
|---|---|
| **Frequency** | Sets the base pitch (coarse, wide range — multiple octaves). **[Correction: Gemini omitted this — it's the primary control, not optional.]** |
| **Fine Tune** | Small pitch offset (±1 semitone range) for detuning against other VCOs. |
| **Range Switch** | Coarse octave selector (LO / 32' / 16' / 8' / 4' / 2'). Shifts the Frequency knob's range. |
| **Waveform Switch** | Selects which output waveform the primary output jack carries (Sine / Tri / Saw / Square). |

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| CV IN | Input | CV — Continuous (1V/Oct) | Pitch control. Add volts → pitch rises. Typically from Sequencer or keyboard. |
| Sine OUT | Output | AUDIO | Smooth, pure, round tone. Fundamental only. |
| Triangle OUT | Output | AUDIO | Slightly brighter. Odd harmonics at lower amplitudes. |
| Sawtooth OUT | Output | AUDIO | Brightest, richest. All harmonics. Classic Moog bass/lead. |
| Square OUT | Output | AUDIO | Hollow, woody. Odd harmonics only. |

**Tone.js Node:** `Tone.Oscillator` (type: sine / triangle / sawtooth / square). Frequency controlled via `oscillator.frequency.rampTo(hz, 0.02)`. Tune knob: `oscillator.detune.rampTo(cents, 0.02)`.

---

### 2. LFO — Low Frequency Oscillator

**Function:** Mechanically identical to the VCO but tuned to sub-audio rates (0.01 Hz – ~20 Hz). It is **never heard directly** — its output is always CV, used to automatically modulate other modules (vibrato, filter wobble, tremolo, etc.).

**Controls:**
| Knob | Function |
|---|---|
| **Speed** | Oscillation rate (very slow → ~20 Hz). |
| **Output Level** | Amplitude of the outgoing CV voltage (depth of the modulation effect). |

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Sync/Reset IN | Input | CV — Trigger | Forces the LFO wave to restart its cycle from 0. Phase-sync for rhythmic modulation. |
| Sine OUT | Output | CV — Continuous | Smooth, gentle sweep. Good for vibrato. |
| Triangle OUT | Output | CV — Continuous | Symmetric ramp. Subtle tremolo. |
| Square OUT | Output | CV — Continuous | Hard on/off switching. Tremolo chops or octave-jump effects. |
| Sawtooth OUT | Output | CV — Continuous | Rising ramp that resets. Rhythmic filter sweeps. |

**Tone.js Node:** `Tone.LFO` (type selectable). `lfo.frequency.rampTo(hz, 0.05)`. Output connects to destination node's AudioParam via `lfo.connect(filter.frequency)`.

---

### 3. Sequencer

**Function:** The conductor. Stores a loop of 8 programmable steps and steps through them in time with an incoming clock (or its own internal clock). Outputs a pitch CV and a Gate signal for each step.

**Step Count:** **8 steps** (the classic Moog 960 Sequential Controller standard). **[Correction: Gemini omitted the step count — this is essential for implementation.]**

**Controls:**
| Control | Function |
|---|---|
| **Step Activation Switches (×8)** | Toggle each step ON (outputs gate + pitch) or OFF (rest — gate stays LOW). |
| **Step Voltage Dials (×8)** | Sets the specific pitch voltage for each step. UI: small rotary knobs mapped to semitones or continuous Hz. |
| **Internal Clock Speed** | Sets BPM of the built-in clock when no external clock is patched. |

**Ports (4 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Clock IN | Input | CV — Clock | External clock pulse forces the sequencer forward one step. Overrides internal clock. |
| Clock OUT | Output | CV — Clock | Outputs the sequencer's own clock pulse (internal or re-fired external) for daisy-chaining. |
| Pitch CV OUT | Output | CV — Continuous (1V/Oct) | Outputs the voltage of the currently active step's dial. Patch to VCO CV IN. |
| Gate OUT | Output | CV — Gate | Goes HIGH when an active step fires, LOW at the step boundary. Patch to Envelope Gate IN. |

**Tone.js Node:** `Tone.Sequence` or a custom `setInterval`-based stepper. Step voltages map to Hz via the 1V/Oct formula: `hz = 440 * Math.pow(2, (volts - 0.75))`. Clock IN: advance the sequence on each trigger event.

---

### 4. VCA — Voltage Controlled Amplifier

**Function:** The volume gate. The VCO is always on — the VCA is the dam that lets sound through only when CV tells it to. Without a VCA, every note drones forever.

**Controls:**
| Knob | Function |
|---|---|
| **Gain** | Sets a static base volume boost. At zero, audio passes only when CV is present. At max, audio passes at full level regardless of CV. Can drive into soft clipping at extreme settings. |
| **CV Attenuator** | Scales how strongly the incoming CV moves the gain. 0 = CV has no effect; max = full CV range. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Audio IN | Input | AUDIO | Receives the raw (forever-on) audio signal from VCO or VCF. |
| Volume CV IN | Input | CV — Gate / Continuous | Tells the VCA when and how much to open. Usually from an Envelope OUT. |
| Audio OUT | Output | AUDIO | The gated, shaped audio signal. Patch to VCF IN or I/O From-Rig IN. |

**Tone.js Node:** `Tone.AmplitudeEnvelope` or `Tone.Gain` with `.gain.rampTo()`. For true CV control: a `Tone.Gain` node whose `.gain` AudioParam is driven by a connected CV source (connect the Envelope's output signal to `gain.gain`).

---

### 5. Envelope Generator — ADSR

**Function:** The shaper. When triggered, it outputs a single, non-repeating voltage curve that mimics the physical dynamics of an acoustic instrument. Most often used to control the VCA (volume shape) and VCF (timbre shape) simultaneously.

**[Correction vs Gemini spec]:** Gemini merged Trigger and Gate into one port. The real Moog 911 has **separate Trigger and Gate inputs** because they behave differently:
- **Trigger IN:** A microsecond spike — fires the Attack phase even if gate never opens (percussive hits, ping mode).
- **Gate IN:** A held HIGH signal — sustains the envelope until it drops LOW, then fires Release.
For MVP a single combined port is acceptable, but the distinction must be understood.

**Controls:**
| Knob | Function |
|---|---|
| **Attack** | Time for voltage to rise from 0 to peak after a trigger (0.001s – ~10s). |
| **Decay** | Time to fall from peak down to the Sustain level. |
| **Sustain** | The level held while the gate stays HIGH (0 = fully off, max = stays at peak). |
| **Release** | Time to fade from Sustain level back to 0 after gate closes. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Trigger IN | Input | CV — Trigger | Fires the Attack phase. A brief spike suffices. |
| Gate IN | Input | CV — Gate | Holds the Sustain phase open while HIGH. Closing fires Release. **[MVP: combine with Trigger as one port]** |
| Envelope CV OUT | Output | CV — Continuous | The ADSR voltage shape. Patch to VCA CV IN and/or VCF Cutoff CV IN. |

**Tone.js Node:** `Tone.AmplitudeEnvelope` for VCA control. For VCF control: use `Tone.Envelope` whose output signal is scaled and added to the filter frequency AudioParam.

---

### 6. VCF — Voltage Controlled Filter

**Function:** The tone sculptor. Takes a harmonically rich waveform (Sawtooth is ideal) and removes frequencies above (or below) the Cutoff point. Resonance boosts the frequencies at the cutoff for the iconic Moog squelch. This is subtractive synthesis.

**Filter Type:** **24 dB/octave Moog Ladder Filter** — a 4-pole lowpass design with distinctive resonance character. **[Note: Tone.js's built-in `Tone.Filter` uses a `BiquadFilterNode` which maxes at 12 dB/oct. For true Moog ladder sound, consider `Tone.Filter` at 24 dB or a custom `MoogLadderFilter` using cascaded biquads. Flag for Phase 3.]**

**Controls:**
| Knob | Function |
|---|---|
| **Cutoff Frequency** | The frequency point below which audio passes, above which is cut. Low = muffled; High = full brightness. |
| **Resonance** | Boosts the band around the Cutoff. Low = gentle shaping; above ~0.7 = self-oscillation (the filter generates its own pitch). |
| **CV Attenuator** | Scales how much the incoming CV moves the Cutoff. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Audio IN | Input | AUDIO | Receives the audio signal from VCO or VCF chain. |
| Audio OUT | Output | AUDIO | Filtered audio out. Patch to VCA IN or I/O. |
| Cutoff CV IN | Input | CV — Continuous | Moves the Cutoff Frequency dynamically. Source: Envelope, LFO, or Sequencer. |

**Tone.js Node:** `Tone.Filter` (type: 'lowpass', rolloff: -24). `filter.frequency.rampTo(hz, 0.02)`. `filter.Q.rampTo(q, 0.02)`. CV input: connect envelope/LFO signal to `filter.frequency` AudioParam.

---

### 7. I/O — Input / Output Module

**Function:** The bridge between the modular world and the real world. Routes external audio (mic, guitar) into the patch system as an audio signal source, and routes the final patched signal out to speakers or a recording interface.

**Controls:**
| Knob | Function |
|---|---|
| **Input Gain** | Boosts or attenuates the incoming external audio signal before it enters the rig. |
| **Output Gain** | Master volume for the entire modular output. |

**Ports (4 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| External IN | Input | AUDIO (real-world) | Receives microphone or instrument signal via browser `getUserMedia`. |
| To-Rig OUT | Output | AUDIO | Sends the conditioned external signal into the modular patch system. |
| From-Rig IN | Input | AUDIO | Receives the final processed signal from the end of the patch chain. |
| Speakers OUT | Output | AUDIO (real-world) | Routes to `Tone.Destination` / `AudioContext.destination`. |

**Tone.js Node:** `Tone.UserMedia` (for External IN → To-Rig OUT). `Tone.Volume` (Output Gain master node). `Tone.Destination` (Speakers OUT). The I/O module should be the only module that writes to `Tone.Destination` — all other modules patch into From-Rig IN.

---

## Default Signal Chain (No Patch Cables)

When the page first loads, this hardwired default lets sound happen immediately before the user builds any patches:

```
VCO 1 (Sawtooth) → VCF → VCA → I/O (Speakers OUT)
                              ↑
Envelope (Gate triggered by Sequencer Gate OUT)
                              ↑
Sequencer (internal clock, 8 steps, C major scale)
```

This gives the user an immediately playable arpeggio on load, showcasing the instrument before they understand patching.

---

## Tone.js Implementation Notes

| Rule | Detail |
|---|---|
| **Single writer per node** | Matches VoxDAW convention. Each AudioParam has exactly one writer. If both the Cutoff knob and an LFO drive the VCF cutoff, they must sum through an intermediary gain node — not both write to `filter.frequency` directly. |
| **No hardwiring** | In Phase 3, nodes are initialized disconnected. `connect(src, dest)` / `disconnect(src, dest)` methods in `useMoogAudio.js` manage the graph dynamically, enabling patch cable simulation. |
| **Ramp all params** | `.rampTo(value, 0.02)` on all audio parameters. Never `.value =` except for type switches (waveform, filter type). |
| **Tone.start() gate** | `useMoogAudio.js` must not call `Tone.start()` — it must be called on the first user gesture (same convention as VoxTool's `useAudioEngine`). |
| **Own AudioContext?** | The Moog engine should use Tone.js's shared context (not its own `new AudioContext()`), unlike the Vocoder. This avoids the 3-AudioContext browser limit and allows future integration with the Workstation transport clock. |

---

## Implementation Roadmap (Cross-Reference with MOOG_PLAN.md)

| Phase | Deliverable | Modules Covered |
|---|---|---|
| Moog Phase 1 ✅ | Visual shell, routing | All (scaffold only) |
| Moog Phase 2 | `MoogKnob.jsx` — drag-to-rotate | All knobs |
| Moog Phase 3 | `useMoogAudio.js` — node init, default chain | VCO, VCF, VCA, Envelope, I/O |
| Moog Phase 4 | VCO panel wired | VCO |
| Moog Phase 5 | VCF panel wired | VCF |
| Moog Phase 6 | Envelope + VCA wired + keyboard trigger | VCA, Envelope |
| Moog Phase 7 | Patch cable simulation (SVG bezier) | All |
| Moog Phase 8 | LFO module | LFO |
| Moog Phase 9 | Sequencer module | Sequencer |
| Moog Phase 10 | I/O module + mic input | I/O |
| Moog Phase 11 | Visual polish, LEDs, aging effects | All |
