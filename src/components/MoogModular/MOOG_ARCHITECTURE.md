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
| SYNC IN | Input | Clock | Patch **any** clock/CV here to lock the LFO to the sequencer tempo (Transport). Empty = free-running (Moog Phase 65). |
| Sine OUT | Output | CV — Continuous | Smooth, gentle sweep. Good for vibrato. |
| Triangle OUT | Output | CV — Continuous | Symmetric ramp. Subtle tremolo. |
| Square OUT | Output | CV — Continuous | Hard on/off switching. Tremolo chops or octave-jump effects. |
| Sawtooth OUT | Output | CV — Continuous | Rising ramp that resets. Rhythmic filter sweeps. |

**Tone.js Node:** `Tone.LFO` (type selectable). `lfo.frequency.rampTo(hz, 0.05)` in FREE mode. Output routes through `${id}Out` (a Gain the jacks + meter + wave analyser tap) so the free/sync sources can crossfade behind a stable output node.

**Tempo-sync (Moog Phase 65):** patching a clock into **SYNC** flips the module to a Transport-locked mode. In sync mode the **RATE** knob quantizes to a musical **division** (`LFO_SYNC_DIVS`: 4 BAR / 2 BAR / 1 BAR / 1/2 / 1/4 / 1/8) shown as a SYNC chip, and the **MOD** knob becomes **OFFSET** (start phase — which point of the cycle lands on the downbeat, e.g. which vowel begins the bar). DEPTH is unchanged (output scale / modulation spread).
- **Why not `Tone.LFO.sync()`:** measured — it does **not** phase-lock repeatably in v15.1.22 (0.28 mean phase error at equal Transport position across runs). Instead the value is computed deterministically from `Transport.seconds` in the **`lfoSyncTick` rAF** (the `vocShiftTick`/`vowelTick` pattern): `phase = frac(t/periodSec + offset)`, `v = lfoWaveValue(type, phase) · depth`, written to a `${id}SyncSig` `Tone.Signal` (delta-gated; sole writer). Measured phase-lock error: **0.001** (LFO) / **~2 Hz** on a driven vowel formant across loops — i.e. the vowels line up with the beat every cycle.
- **Topology:** `osc → ${id}OscGain → ${id}Out` and `${id}SyncSig → ${id}SyncGain → ${id}Out`. `applyLfoMode(id, synced)` crossfades the two gains (50 ms, click-free) — free mode keeps the smooth audio-rate oscillator (the rAF can't represent fast free rates); sync mode mutes the oscillator and the rAF owns the audible signal (sync divisions are ≤ 1/8, well within rAF fidelity). Engagement is **cable-driven**: `connect()`/`disconnect()` key off the `isLfoSync` jack flag (multi-cable-safe), independent of the knob param path. UI `synced` derives from `useMoogPatch().cables` (matched on `toJackId`/`fromJackId`).

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

### 7. CP3 Mixer — Signal Combiner [REMOVED — Rack Expansion session 2026-06-10]

> **Removed from the rack.** The component, its 5 `Tone.Gain` nodes, and its 5 jacks were deleted; the 4-channel I/O mixer (Phase 23, `io-in1..4`) covers multi-source summing. Spec retained below for historical reference.

**Function:** A transistor-based summing amplifier. Takes up to 4 audio signals (typically VCO outputs) and combines them into a single output with individual channel level controls and a master output gain. At high gain settings, the transistor summing bus produces characteristic warm saturation — a primary contributor to the classic Moog "fat" sound. This is not simple clipping; it is asymmetric transistor-level compression.

**Controls:**
| Knob | Function |
|---|---|
| **CH 1–4 Gain** | Individual input level for each channel. |
| **Master** | Overall output level. High settings drive the transistor bus into warm saturation/clipping. |

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| IN 1 | Input | AUDIO | Channel 1 input (typically VCO 1 SAW or SQR output). |
| IN 2 | Input | AUDIO | Channel 2 input (typically VCO 2 output). |
| IN 3 | Input | AUDIO | Channel 3 input (typically VCO 3 output). |
| IN 4 | Input | AUDIO | Channel 4 input (auxiliary — noise, external, or LFO audio). |
| OUT | Output | AUDIO | Summed output. Patch to VCF Audio IN. |

**Tone.js Node:** Four `Tone.Gain` channel nodes summing into a single `Tone.Gain` master bus. For clipping character: a `WaveShaperNode` on the output with a soft-knee transfer curve. Phase 3 will initialize the nodes disconnected; Phase 8a will wire knobs.

---

### 8. Noise Generator [Implemented: Moog Phase 8b, 2026-07-11]

**Function:** Generates random electrical signals across all frequencies simultaneously. White noise has equal energy per frequency (Hz). Pink noise rolls off at −3 dB/octave, giving equal energy per octave — it sounds perceptually "flatter" and more natural. Used as a sound source (wind, ocean, percussion transients), as a random CV source for organic pitch drift, or as a test signal.

**Controls:**
| Knob | Function |
|---|---|
| **Level** | Output amplitude of the noise signal before the output jacks. |

**Ports (2 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| WHITE OUT | Output | AUDIO / CV | Flat spectrum — full-range randomness. Harsh, bright. |
| PINK OUT | Output | AUDIO / CV | −3 dB/oct rolloff — perceptually even energy distribution. Warmer. |

**Tone.js Node:** `Tone.Noise` (type: `'white'` or `'pink'`). Two separate noise instances per module, each through a `Tone.Gain` level stage (`${id}WGain`/`${id}PGain`) that the WHT/PNK jacks tap. One LEVEL knob drives both gains via id-keyed `updateNoiseParams(id, { level })` — knob 0–1 → gain 0–1.43× with **unity at the 0.7 default** (pre-8b patches, which had no gain stage, sound identical until the knob moves). Applies to the 3 static modules and every dynamic instance.

---

### 9. Multiples — Passive Signal Router [REMOVED — Phases 27–29, 2026-06-08]

> **Removed from the rack** (component, 8 jacks, and CSS). Jack ids are globally unique and cables cross rows freely, so fan-out is achieved by patching multiple cables from any output jack. Spec retained below for historical reference.

**Function:** A purely passive (no electronics, no power) signal distribution utility. Within each bank, all 4 jacks are hardwired together. Plugging a signal into any jack of a bank routes that signal to all other jacks in the same bank simultaneously. Used to distribute a single CV or audio source to multiple destinations (e.g., one LFO simultaneously modulating both VCF cutoff and VCO 2 frequency).

**Controls:** None.

**Ports (8 Total — 2 banks of 4):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| A1–A4 | Bidirectional | Any | Bank A: all 4 jacks electrically tied. Signal in → signal on all other A jacks. |
| B1–B4 | Bidirectional | Any | Bank B: same as Bank A, electrically isolated from Bank A. |

**Tone.js Implementation:** No dedicated audio node. Implemented in Phase 7 (patch cable simulator) as a fan-out: when a cable connects to a Multiples jack, `useMoogAudio.connect(src, dest)` is called for every other currently-occupied jack in that bank. Bank isolation is enforced in the connection manager.

---

### 10. I/O — Input / Output Module

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

### 11. Vocoder — 16-Band Spectral Vocoder [Implemented: Moog Phase 42]

**Function:** Imposes the spectral envelope of a **modulator** signal (voice, drum machine, sequence) onto a harmonically rich **carrier** signal (VCOs). Each of 16 frequency bands measures the modulator's energy and uses it to gate the matching band of the carrier — the classic "transfer of characteristics" / talking-synth effect.

**Bands:** 16 log-spaced bandpass bands, 100 Hz → 8 kHz (geometric ratio ≈ 1.339), Q = 4. Exported as `VOC_BANDS` from `useMoogAudio.js` (mirrors the `FFB_BANDS` pattern), shared between the audio engine and the UI meter.

**Controls:**
| Knob | Function |
|---|---|
| **MIX** | Dry/wet crossfade. **Dry = raw carrier passthrough**, wet = vocoded output. At 1.0 (default) you hear pure vocoded signal; at 0.0 the unprocessed carrier. |
| **VOLUME** | Master output level (`vocVolume`, the `voc-out` jack node). Knob 0–1 → 0–2× (0.5 = nominal). `vocOut` carries a fixed 3× internal makeup (the band bank is intrinsically quiet), so VOLUME combines to up to 6× total and also scales the CLARITY blend (which sums at `vocVolume`). |
| **PWIDTH** | Internal carrier pulse width (PWM duty). Knob 0–1 → width −0.95..0.95 (0.5 = square). The internal carrier runs at a fixed pitch (130 Hz, set at construction). |
| **CARR MIX** | Crossfade between the external carrier (`voc-carr-in`) and the internal pulse osc. 0 = external only (default), 1 = internal only. Lets the vocoder run standalone (mic + internal carrier, no patched VCOs). |
| **SHIFT** | Spectral/formant shift — scales all 16 carrier bandpass center freqs by a ratio. Knob 0–1 → ±1 octave (0.5 = no shift). Up = chipmunk/feminine formants, down = deeper. |
| **RES** | Q of the 16 carrier bandpass filters. Knob 0–1 → Q 1–7 (0.5 ≈ the base Q of 4). Higher = sharper, more resonant/vocal formants. |
| **SH RATE** | Rate of the LFO that modulates SHIFT. Knob 0–1 → 0.05–10 Hz. |
| **SH AMP** | Depth of the SHIFT LFO. Knob 0–1 → 0–1 octave of swing. Creates sweeping/phaser-like formant motion. Default 0. |
| **DECAY** | Envelope-follower smoothing (the 16 env LP cutoffs). Knob 0–1 → ~56 Hz (snappy) … ~7 Hz (smeary/sustained), 0.5 ≈ 20 Hz. Lower = longer vowel tails. |
| **PRESENCE** | Peaking-EQ boost (~2.7 kHz, Q 1) on the vocoded output so the robot voice cuts through a mix. Knob 0–1 → 0..+12 dB (boost only, default 0). |
| **CLARITY** | Blends the high-passed (~1.5 kHz) **real voice** (modulator consonants/sibilance) straight into the output, bypassing the band bank. Knob 0–1 → 0–0.9×. The headline word-intelligibility control — keeps vocoded vowels while letting actual consonants cut through. Default 0. |
| **HISS** | Level of high-passed (~3.5 kHz) white noise injected into the carrier bank so unvoiced consonants (s, sh, t, f) surface through the high bands. Default 0. Synthetic sibilance — compare with CLARITY (real voice). |
| **BUZZ** | Level of low-passed (~250 Hz) pink noise injected into the carrier bank for low-end body/thump, thickening vowels. Default 0. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| MOD (`voc-mod-in`) | Input | AUDIO | Modulator source — its spectral envelope is analysed. Patch from a voice/drum/sequence audio out. |
| CARR (`voc-carr-in`) | Input | AUDIO | Carrier source — gets shaped by the modulator. Patch from VCO/mixer audio out (saws ideal). |
| OUT (`voc-out`) | Output | AUDIO | Vocoded (+ optional dry) output. Patch to the mixer / I/O From-Rig. |

**DSP graph (native-on-shared-Tone-context, single writer per node):**
```
voc-mod-in → vocModRaw → HP(150) → Compressor → vocModIn
vocModIn ─→ 16× [ modBPF → rectifier(WaveShaper |x|·DRIVE) → envLP(DECAY) ]
                                                                  │ (audio-rate AudioParam)
                                                                  ▼
voc-carr-in → vocCarrExtGain ─┐                                   │
internal PulseOsc → vocCarrOscGain ┴→ vocCarrSum ─→ vocCarrBank ─→ 16× [ carrBPF(SHIFT/RES) → carrVCA.gain ◄── envLP ] → vocSum → vocWet ─┐
                                  │   ▲  ▲                                                                                                  │
                                  │   │  └── BUZZ: noise(pink) → LP(250) → vocBuzzGain ──┐                                                  │
                                  │   └───── HISS: noise(white) → HP(3.5k) → vocHissGain ┴→ vocCarrBank                                     │
                                  └──────────────────── carrier passthrough (no HISS/BUZZ) ───────── vocDry ────────────────────────────────┤
                                                                                            wet+dry → vocOut(×3 makeup) → vocPresence(EQ) ───┤
vocModIn ─→ HP(1.5k) → vocClarityGain (CLARITY: real voice) ───────────────────────────────────────────────────────────────────────────────┴─→ vocVolume(VOLUME ×0–2) → voc-out
vocModIn ─→ vocAnalyser (FFT 512)   ← drives the 16-segment LED spectrum meter
```
Each modulator band rectifies + smooths to an envelope follower, whose output connects directly to the matching carrier band's `Tone.Gain.gain` AudioParam (audio-rate, zero polling). `VOC_ENV_DRIVE` (≈8) scales the rectifier; **DECAY** sets the env-LP cutoff. The carrier is the external `voc-carr-in` and an internal `Tone.PulseOscillator` blended by **CARR MIX** into `vocCarrSum`, which feeds both the bank and `vocDry` — so HISS/BUZZ (bank-only) never leak into dry. The **spectral-shift rAF loop** (sole writer of `vocCarrBPF*.frequency`) applies SHIFT + its LFO; **RES** writes `vocCarrBPF*.Q`. Output: `wet+dry → vocOut` (fixed ×3 makeup) `→ vocPresence` (PRESENCE peaking EQ) `→ vocVolume` (VOLUME ×0–2, the jack); CLARITY sums at `vocVolume`, bypassing makeup + EQ. `getVocAnalyserData()` feeds the 16-LED meter via the same per-band-peak rAF loop as `FFBModule`.

**Tone.js Nodes:** modulator pre-chain (`vocModRaw`, `vocModHP`, `vocModComp`) + buses (`vocModIn/vocCarrIn/vocCarrExtGain/vocCarrOscGain/vocCarrSum/vocCarrBank/vocSum/vocWet/vocDry/vocOut/vocPresence/vocVolume`) + internal carrier (`vocCarrOsc` PulseOscillator + `vocCarrOscGain`) + `Tone.Analyser('fft', 512)` + HISS/BUZZ chain (`Tone.Noise`×2, HP+LP `Tone.Filter`, `Tone.Gain`×2) + CLARITY (`vocClarityHP` + `vocClarityGain`) + per band: `Tone.Filter(bandpass)` ×2 (mod + carr), `Tone.WaveShaper` (rectifier), `Tone.Filter(lowpass)` (env follower), `Tone.Gain(0)` (carrier VCA) — ~80 always-on band nodes. The PulseOscillator + HISS/BUZZ noise are started/stopped in `powerOn`/`powerOff`.

**Built-in mic (modulator):** the vocoder has an integrated mic (ENABLE MIC button + MIC IN level knob + SIG LED, top of the faceplate). It opens a `Tone.UserMedia` stream (`enableMic()`) → `extMicGain` → `vocModRaw` (the modulator pre-chain front), so enabling the mic + a carrier vocodes instantly with **no patching**. The `MOD` jack still accepts external modulator sources (drum machine, sequence), which sum with the mic. There is no separate EXT IN module — it was merged into the vocoder (Phase 48). Use headphones to avoid carrier→mic feedback.

**Modulator pre-processing (always on, voice-optimized):** both the mic and the `voc-mod-in` jack land on `vocModRaw → vocModHP (highpass 150 Hz) → vocModComp (Tone.Compressor −28 dB / 4:1) → vocModIn`. The highpass removes rumble/plosives (safe — voice intelligibility lives in formants >300 Hz); the compressor evens the drive into the envelope followers for consistent vocoding. Tuned for voice; a low-frequency modulator (e.g. a kick) loses content below 150 Hz.

The bank runs continuously even when unpatched; gating it to "carrier + modulator present" is a possible future CPU optimization.

---

### 12. EXT IN — merged into the Vocoder (§11) [Phase 48]

The external-mic input was originally a standalone module (Phase 43) but was **merged into the Vocoder** (Phase 48) since its only real use was as the vocoder modulator. The mic controls (ENABLE MIC, MIC IN, SIG LED) now live on the vocoder faceplate and feed `vocModRaw` directly — see §11 "Built-in mic". `Tone.UserMedia` lifecycle (`enableMic`/`disableMic`/`updateExtMicParams`, `extMicRef`, `extMicGain`, `extMicMeter`) is unchanged; only the routing (now → `vocModRaw` instead of a separate `ext-out` jack) and the UI host changed.

**Note on AEC:** uses `Tone.UserMedia` defaults (browser echo-cancellation/AGC may be on). Use **headphones** so the carrier doesn't bleed into the mic. If raw-signal quality becomes an issue, switch to native `getUserMedia` with `echoCancellation:false, noiseSuppression:false, autoGainControl:false` (as `useVocoder.js` does) wrapped via `createMediaStreamSource`.

---

### 13. VOWEL — Formant Filter Bank [Implemented: Moog Phase 64]

**Function:** A 3-formant resonant filter bank that sculpts a raw signal (saws ideal) into human vowel sounds. **Dynamic-only** (no static instance) — added from the library.

**Signal:** `${id}In → fan → 3× [bandpass Filter Fk (Q ~11/13/15) → gain Gk (1.0/0.55/0.28)] → ${id}Mix (×7 makeup) → ${id}Out (hard-knee limiter)` (parallel formants summed). `${id}Analyser` (FFT 256) taps Out for the display; `${id}CvIn → ${id}CvAnalyser` reads the FORMANT-CV input.

**Output level (makeup + limiter):** the parallel bandpass bank is intrinsically quiet (~7× down vs. the raw source), so `${id}Mix` applies a ×7 makeup. But the vowels are hugely unequal in level — open **A**/**O** (low F1 in a strong region of the source) peak ~4× the closed **I**/**U** — so a fixed makeup alone clips A. `${id}Out` is therefore a `Tone.Compressor` used as a **hard-knee limiter** (`threshold −1 dB, ratio 20, knee 0`) — *not* `Tone.Limiter` (whose default 30 dB soft knee barely compresses). Net: closed vowels stay at full makeup (RMS ~0.43, matching a raw VCO) while A/O are brick-walled just above unity. The jack `-out` and the FFT display both tap post-limiter `${id}Out`.

**Controls / jacks:** VOWEL knob (morph A→E→I→O→U), SHAPE knob (0.7–1.3 vocal-tract scale on all formants), jacks `-in` / `-cv-in` (FORMANT CV) / `-out`.

**Formant frequencies:** `VOWEL_FORMANTS` (module const in `useMoogAudio.js`) — classic male-voice table; `vowelFreqsAt(pos 0..4)` linearly interpolates adjacent columns. A/E/I/O/U = [730,1090,2440] / [530,1840,2480] / [270,2290,3010] / [570,840,2410] / [300,870,2240] Hz.

**Single-writer rAF (`vowelTick`):** the SOLE writer of the 3 filter frequencies — combines the morph ref (VOWEL knob), shape ref (SHAPE), and the sampled CV level (`cv*4` = full A↔U sweep) into the final formants, with a per-instance delta gate (idle module = 0 writes). `updateDynModuleParams` case `'vowel'` writes the refs only (never the filters), preserving single-writer-per-node. This is why FORMANT CV works at all — a preset morph is a nonlinear map to 3 freqs, not a direct AudioParam connection.

---

## Default Signal Chain (No Patch Cables)

**True modular routing since Moog Phase 10 — there is NO hardwired audio path.** Powering on starts the sources (VCOs, noise, LFOs, internal carriers) and the sequencer clocks, but no sound reaches the speakers until the user patches a source into the I/O module (`io-in` or a mixer channel `io-in1..4`). The minimal audible patch:

```
vco1-saw → vcf-in → (vcf-out) → vca-in → (vca-out) → io-in
seq-gate-out → env1-gate,  env1-out → vca-cv          ← gated sequencer arpeggio
```

(The only survivors of the old training-wheel wiring are module-internal fixed edges — e.g. glideBus → vco.frequency, FFB fan-out — documented per module above. Persisted racks restore the user's own cables on load, Phase 60f.)

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
| Moog Phase 1.5 ✅ | 4-tier visual expansion — 4 new module panels, thicker cabinet, metal texture | VCO+Noise (Row 1), CP3+VCF+LFO (Row 2), VCA+ENV×2+Multiples (Row 3), Sequencer blanks (Row 4) |
| Moog Phase 1.6 ✅ | Photorealistic UI overhaul — multi-cabinet tiers, cream typography, improved jacks | All |
| Moog Phase 2 ✅ | `MoogKnob.jsx` — drag-to-rotate with shift fine-mode, double-click reset | All knobs |
| Moog Phase 3 ✅ | `useMoogAudio.js` — 15 Tone.js nodes, jackMap, patch bridge via `MoogPatchContext` callbacks, Power/I/O module | VCO, VCF, VCA, Envelope, CP3, Noise, LFO, I/O |
| Moog Phase 7 ✅ | SVG patch cable simulation — zero-re-render drag, bezier droop, click-to-remove | All jacks |
| Moog Phase 4 ✅ | VCO panel knob wiring (freq, fine, wave, range) | VCO |
| Moog Phase 5 ✅ | VCF panel knob wiring (cutoff, resonance) | VCF |
| Moog Phase 6 ✅ | Envelope + VCA wiring + manual GATE button | VCA, Envelope |
| Moog Phase 8 ✅ | LFO audio wiring (rate, depth, wave) | LFO |
| Moog Phase 10 ✅ | Master I/O + true modular routing (vca→io-in hardwire removed) | I/O |
| Moog Phase 11 ✅ | Retro oscilloscope visualizer on I/O module | I/O |
| Moog Phase 9 ✅ | 960 Sequential Controller — 8-step sequencer, Tone.Loop, pitch CV out, gate routing | Sequencer |
| Bug Fix ✅ | `setTargetAtTime` for VCO/VCF frequency params — eliminates exponential-ramp-from-zero crashes | VCO, VCF |
| CV Scaling ✅ | FM + VCF CV input `Tone.Gain` scalers (×500 FM, ×5000 VCF cv, ×1000 VCF env) — LFO now audible | VCO FM, VCF |
| Moog Phase 13 ✅ | 953 Keyboard Controller — 3-oct piano (C3–B5), pitch CV + gate out, computer keyboard (A–K) | Keyboard |
| Moog Phase 8a ✖ | CP3 Mixer knob wiring — obsolete: CP3 removed (Rack Expansion 2026-06-10) | CP3 |
| Moog Phase 8b ✅ | Noise Generator LEVEL wiring — per-instance W/P gain pairs, unity at default | Noise |
| Moog Phase 42 ✅ | 16-band spectral vocoder — patchable MOD/CARR/OUT, envelope-follower bank, MIX/HISS/BUZZ, 16-seg meter | Vocoder |
| Moog Phase 43 ✅ | EXT IN — live mic via Tone.UserMedia (later merged into the Vocoder, Phase 48) | EXT IN |
| Moog Phase 48 ✅ | Merged EXT IN into the Vocoder — built-in mic feeds the modulator directly | Vocoder |
| Moog Phase 51 ✅ | Photorealistic material overhaul — black skirted knobs (+cream 960 dials), matte feTurbulence plates, cable plugs, LED bezels, dark walnut | All (visual) |
| Moog Phase 52 ✅ | Period-correct System 55 pass — spun-aluminum knob caps, worn lettering, jack thread, rubber cables, jewel-lamp facets | All (visual) |
| Moog Phase 53 ✅ | Viewport camera — wheel/pinch zoom 1–8× toward cursor, drag-pan, Esc reset; zero-re-render imperative transforms | Shell (interaction) |
| Moog Phase 54 ✅ | Rack densification — 960s de-stacked, I/O channel grid, components +20%, keyboard widened; controls ~28% bigger on screen | Shell (layout) |
| GPU Fix ✅ | Black-flashing modules — replaced static cabinet `will-change` with transient promotion during camera moves | Shell (compositing) |
| Moog Phases 55–59 ✅ | Typography pass, Reverb Aura displays, QNT knob-stepper + modulation modes, case system + module library | All |
| Moog Phase 60 series ✅ | **Dynamic Rack** — see the AS-BUILT section below | All |
| Moog Phase 12 ✅ | Knob hover tooltips shipped; module bypass rejected as superseded (MIX-at-zero / QNT BYPASS / library removal); mobile fallback deferred (touch camera subproject, desktop-first product) | All |
| Moog Phase 61 ✅ | Powered-rack frame rate — camera-driven `content-visibility` module culling + LED/meter write dedupe (see §Rendering Performance) | Shell (rendering) |

**Roadmap complete (2026-07-11)** — every phase shipped or resolved with a logged decision (full logs in MOOG_PLAN.md).

---

## Dynamic Rack — User-Customizable Modules (Phase 60 series) — AS BUILT

**Status: ✅ COMPLETE (2026-07-11).** All 14 removable module types are instantiable from the library with duplicates; the whole custom rack — instances AND patch cables — persists across reloads; expansion modules drag-to-reorder. The original decisions held: full customizability incl. duplicates; space policy = **fit-width floor + vertical scroll**. Deviations from the original proposal are noted inline below; per-phase logs live in MOOG_PLAN.md.

### Goals / Non-Goals

- **Goals:** add/remove any module from a bank; multiple instances of the same type; layout persists across sessions; patch cables work across all instances; no per-module shrink below the fit-width floor.
- **Non-goals (this series):** ~~drag-to-reorder, cable persistence~~ (both later SHIPPED — 60f), mobile layout, Workstation integration changes (`moogBus` tap unchanged).

### State Model (as built)

```js
// localStorage 'moog-rack-v2' — one record for the whole custom rack.
// Written ONLY from user event handlers / user-driven provider callbacks
// (the Phase 60c StrictMode wipe lesson); v1 (types only) migrates on read.
{
  modules:  [ { id: 'vco6', type: 'vco', num: 6 }, … ],   // array order = expansion-row order
  cables:   [ { from: 'seq-gate-out', to: 'kick2-gate-in', color: '#e84040' }, … ],
  settings: { vco1: { freqBase: 0.7, fineTune: 0.5, rangeOctave: 0, syncOn: false },
              vcf:  { cutoff: 0.4, res: 0.6, … }, seq2: { steps: [...], tempo: 128 }, … },
}
```

### Per-module settings persistence (Phase 63)

`settings` (added Phase 63) captures every module's knob/switch positions, keyed by canonical instance id (the jack prefix — same key space as `modules`/cables). This is what makes a reload / `.moog` load restore the *exact patch*, not just which modules and cables exist (60f). Two hooks in MoogShell.jsx, next to `readRackStore`:
- **`useSavedSettings(id)`** — lazy `useState(() => readModuleSettings(id))`, read ONCE at mount; each module seeds its `useState` as `saved.field ?? default`. Never-touched module → `{}` → all defaults.
- **`useModulePersist(id, values)`** — debounced 200 ms (coalesces a knob drag into one write), and writes the module's full snapshot ONLY when it differs from what's stored. That diff-guard is load-bearing: mount-time seeding and StrictMode's double-effect produce no write, honoring the "user events only" rule; and the write is merge-only (`{...settings, [id]: values}`) so it can never wipe `modules`/`cables` (the 60c hazard). The dep is `JSON.stringify(values)` so nested arrays (seq/chord `steps`, FFB `bands`) trigger correctly.

All 15 module types wired uniformly (id computed before `useState`; Vocoder `micStatus` excluded as runtime, not a setting). **SAVE/LOAD/RESET reuse the mount-time restore path**: the store is the whole setup, so SAVE serializes it to a `.moog` download, LOAD writes it + `window.location.reload()`, RESET clears it + reload. A reload lands on Root's home page, so reset/load set a one-shot `sessionStorage['voxdaw-return-page']='moogmodular'` that `Root.js` honors (minimal routing exception). Toolbar `[RESET] [SAVE SETUP] [LOAD SETUP]` in the top bar.

- **Instance id = jack prefix** (`vco6` → jacks `vco6-cv`, `vco6-saw`…). Static ids (`vco1…vco5`, `noise`, `vcf`, `qnt`…) are grandfathered as the default rack; new instances mint `type<n>` from `nextInstNumRef` (monotonic, minted eagerly in handlers). **Restore honors persisted nums** (`addModule(type, desiredNum)`, collision → fall back to minting) so cables stay valid across reloads.
- **Deviation from the proposal:** no `cases` array — added instances render in a wrapping **expansion row** inside the Voice Case at fixed per-type widths, growing the rack into the 60a floor+scroll. Simpler, and the case picker became unnecessary.

### Engine Instance Registry (as built — no separate `moduleFactories.js`)

**Deviation:** factories live inline as branches of `addModule(type)` in `useMoogAudio.js` (the co-location rule), not in a registry file. Each branch mirrors its static recipe exactly and registers nodes into `nodesRef.current` **under composed names** (`vco6GlideBus`, `ffb2Filter3`, `voc2CarrVCA7`…) so every existing name-composed lookup — param updaters, `getMeterValue`, `connect()`'s glideBus path, LED getters — works on dynamics with zero changes. Per-instance bookkeeping: `dynInstancesRef` (id → `{ type, num, nodeNames, sourceNames, jackIds }`); `sourceNames` makes powerOn/powerOff generic.

- **Per-type state went id-keyed maps** rather than one generic params bag: seq/chord loops (`buildSeqLoop(seqId)` / `buildChordSeqLoop(csId)` — one body serves statics + dynamics), kick tune/decay/trig-cb, vocoder shift refs, quantizer params/callbacks. Dispatch: `updateDynModuleParams(id, params)` for knob objects + dedicated `*ById` APIs where the callback shape differs (steps, LED callbacks, divisions, glide, sync).
- **Worklet types use a synchronous registry + deferred wiring:** `n.hardSyncNodes` / `n.qntNodes` objects are assigned at node-creation; the async worklet load defines an idempotent `wire(id)` that sweeps existing instances and parks in a ref (`wireHardSyncRef` / `wireQntRef`) for instances added later. Cleanup nulls the refs so a StrictMode remount can never wire against disposed nodes.
- **Shell bindings:** `bindingsFor(id)` caches per-instance closures (meter/params/LED/etc.) in a ref map so `Led` rAF loops and module effects never restart on unrelated renders.
- `removeModule` order (load-bearing): LibraryModal strips cables by `${id}-` prefix (fires audio disconnects) → native worklet nodes disconnected (no dispose) and the vocoder's shared-mic input edge severed **before** the `nodeNames` dispose sweep → per-type map cleanup → registry delete.
- **Cable restore (60f):** `MoogPatchProvider.restoreCables()` validates endpoints against the live jack registry, draws + fires the audio bridge; a `CableRestorer` (the provider's LAST child — sibling effect order guarantees jacks registered first) re-fires `connect()` on an idempotent retry schedule (0.8 s / 2.5 s) covering worklet-deferred jacks and the StrictMode engine rebuild.

### Per-Type Notes (duplicate cost & special handling)

| Type | Per-instance extras | Suggested cap |
|---|---|---|
| VCO | glideBus + hard-sync `AudioWorkletNode` + vibrato-tick registration (`VCO_IDS` const → registry query) | 10 |
| LFO / Noise / VCA / ENV / REV / BBD / Kick | plain node groups — cheap | 8 |
| 914 FFB | 14 filters+gains each | 4 |
| Vocoder | **16 bands × (BPF+rect+env+VCA) ≈ 70 nodes** + mic singleton (mic stays shared; MIC button on any instance grabs the one `Tone.UserMedia`) | 2 |
| QNT | own `AudioWorkletNode`; knob-stepper refs (`quantizerParamsRef`, baseHz, callbacks) become per-instance maps keyed by id | 4 |
| 960 SEQ / CHORD SEQ | own `Tone.Loop`; Transport is shared (tempo knobs all write `Transport.bpm` — last writer wins, as today with 2×960) | 4 |
| VOWEL (§13) | 3 bandpass+gain pairs + 2 analysers; own entry in `vowelTick` rAF (delta-gated); **dynamic-only → num starts at 1** (Phase 64) | 4 |
| I/O, 953 Keyboard | **fixed singletons** — not in the bank | 1 |

### Layout & Camera

- **(As built)** added instances land in the wrapping expansion row (`.tierDyn`) at fixed per-type px widths measured against their static siblings at `FLOOR_LAYOUT_W` — flex-wrap is safe there because below the floor the layout width is pinned, so wrapping cannot oscillate with fit(). Reordering = drag the grip tab (60f-2; order persists, cable overlay repositions via a resize nudge).
- **Camera change (small, standalone):** `fit()` scale becomes `clamp(availH/natH, availW/natW, 1)` — floored at fit-width. When floored, `clampPan` already permits vertical panning; add wheel-scroll (no ctrl) → vertical pan at z=1 so the tall rack is reachable without zooming.
- Blank-panel filler: a case's unused width renders as blank panels (authentic, keeps the wood frame visually full).

### Invariants preserved

Single Writer per node (per instance now); Zero-Re-render (all per-frame work stays in rAF/canvas/DOM refs; add/remove is event-driven React state like Phase 59); no static `will-change` on the cabinet; fit-stability probe must pass after every layout-affecting phase.

### Phasing (each lands green on its own)

| Phase | Scope |
|---|---|
| 60a ✅ 07-08 | Camera fit-width floor + vertical scroll (no engine changes — ships alone) |
| 60b ✅ 07-09 | Engine instance registry + factory contract; **pilot: VCO + Noise** migrated; static graph coexists for everything else |
| 60c ✅ 07-09 | Migrate LFO/VCA/ENV/REV/BBD/VCF + persistence-lite (type list in localStorage); Kick/914 slipped to 60d |
| 60d ✅ 07-10 | Kick + 914 (id-keyed refs, gate actions carry `kickId`) + **per-instance hard sync** (`hardSyncNodes` id-keyed, `wireHardSyncRef` for late adds) |
| 60e | **✅ COMPLETE 07-11 (4 parts):** 960s (id-keyed seq maps + `buildSeqLoop`, Tone.Loop lifecycle, restored-instance jackMap wipe fix) · CHORD (`buildChordSeqLoop`, per-instance snap/override) · VOCODER (~70-node factory, per-instance shift rAF, shared-mic fan-out) · QNT (per-instance worklets in `n.qntNodes`, knob-stepper machinery parameterized by owning instance, chord override as qid→csId map). Library v2's case picker was overtaken by the expansion-row design. |
| 60f | **✅ COMPLETE 07-11:** cable persistence — v2 rack store `{modules, cables}` with STABLE instance ids (`addModule(type, desiredNum)` + collision repair), `restoreCables` with jack-registry validation, idempotent connect-retry schedule for worklet-deferred jacks + StrictMode engine rebuild — **and drag-to-reorder** (grip tab per expansion slot, order persists, cable-overlay reposition nudge) |

### Risks

1. **Disposal leaks / crashes** — Tone `.dispose()` while a cable's audio connection exists; mitigated by cable-strip-first ordering + try/catch disconnects (existing pattern).
2. **Worklet-load races** — jack entries whose `dest` is a not-yet-loaded worklet node (existing `qnt-cv-in` null-until-loaded pattern generalizes: factories may return `dest: null` and patch the registry on load).
3. **GPU budget** — more modules = larger raster area; the transient `will-change` model already handles size, but 60e should re-run the black-flash regression check at 8+ cases.
4. **Registry/UI drift** — the registry must be the single source for what exists; MoogShell renders purely from state (no hardcoded rows after 60d).

---

## Rendering Performance — Powered-Rack Frame Rate (Phase 61) — AS BUILT

Large custom racks exposed a compositor bottleneck: **every visual invalidation re-runs Blink layerization (`PaintArtifactCompositor::Update`) at a cost proportional to the rack's total paint complexity** (~31 ms/pass at 31 added instances). The per-frame writers (Led opacity, FFB/vocoder segment meters, Aura/scope canvases) each pull that trigger every frame → ~30 fps while powered, even idle. JS is not the cost — the writers are triggers. (Full evidence chain: MOOG_PLAN.md, 2026-07-11/12 entries.)

**Mechanisms (all in `MoogShell.jsx` unless noted):**
- **Camera-driven module culling:** a visibility-manager effect stamps exact `contain-intrinsic-size` per `.module` (measured layout boxes — skipping can never shift layout, the Phase 55 fit() trap) and toggles `content-visibility` `'visible'`↔`'auto'` from the camera's `apply()` (`cameraViewRef` → `moduleVisRef`). Bands are **activity-adaptive**: 0.5-viewport promote lead / 1.0 demote hysteresis while the camera moves; a deep 0.05-viewport sweep after 1.2 s of stillness (at the fit-width floor one viewport ≈ 1800 layout px — fixed generous margins would exceed the whole rack and skip nothing). Promotions time-sliced ≤2/frame. Far state is always `'auto'`, never `'hidden'` — a banding miss costs perf, not pixels (a skipped module still paints its faceplate).
- **Power gate:** unpowered racks have no per-frame writers → the manager is dormant and clears its styles; unpowered scroll renders everything (pre-61 behavior).
- **Write dedupe:** `Led` / FFB / vocoder meter loops quantize opacity to 1/64 and skip identical writes — unchanged style strings never invalidate paint, so silent/steady LEDs stop re-triggering layerization. Aura + Oscilloscope canvas loops skip drawing when `checkVisibility({ contentVisibilityAuto: true })` reports their module skipped. **The QNT TRANSPOSE CV loop stays ungated** (drives the worklet root while hidden).
- **Cable-overlay resilience (`PatchCableOverlay.jsx`):** zero-size jack rects → null from `getSvgCoords`; a per-cable last-good endpoint cache keeps cables drawn through transient mid-promotion redraws.
- **Size gate (Phase 61b) — the shipped scroll fix:** toggling `content-visibility` invalidates the layer tree → one `Layerize` per toggle; during a scroll the band moves every frame, so the manager churns and saturates the main thread (which also delays the non-passive wheel handler → choppy scroll). On small/modest racks this is pure cost — they idle fine (~8 ms) without culling and scroll perfectly smooth fully rendered (this is why "lights out is smooth"). So the manager engages **only when `cabinet.offsetHeight > 2500` layout px** (`CULL_MIN_NATH`; between the default rack's 1799 and a large rack's 3415, zoom/viewport-independent). Below it, all `content-visibility` is cleared and the manager stays dormant. Default-rack powered scroll: p95 83 → 9.3 ms. **Rejected alternatives (do not retry):** a gesture writer-pause (LED/meter/canvas skip while the camera moves) — reverted, the writers were never the scroll cost, the toggling was; and removing knob `will-change: transform` — made scroll *worse* (p95 58→117 ms), since it correctly keeps knobs on GPU layers so a pan is a texture move, not a repaint.

- **Module-level layer promotion (Phase 61d) — the Retina SCROLL fix:** the culling above is about idle layerization; a separate cost dominates *scrolling* on a **2× (Retina) display** — the GPU re-composites the whole photoreal rack every frame during a pan, and the dominant term was the **~130 per-knob compositor layers** (each `.knob` had a permanent `will-change: transform`). Fix: promote layers at the **`.module`** level instead — `will-change: transform` on `.module`, removed from `.knob`. A pan then translates ~30 cached module textures (knobs paint into them) rather than blending 130 knob layers, dropping a real pan from ~1000 ms to ~370 ms GPU-thread busy (below lights-out) with **every component visible, full-res and animating — nothing hidden or frozen**. `MoogKnob.jsx` transiently re-promotes only the dragged knob (`will-change` on mousedown → cleared on mouseup) so rotation stays crisp without re-rastering its module. Sweet spot rationale: knob layers = too many composites; no layers = whole-cabinet raster-on-pan (catastrophic, measured 3781 ms); one cabinet layer = over-rasterized; ~30 module layers = few composites + bounded raster-on-pan. **Testing gotcha:** the default rack fits a normal viewport, so wheel hits the zoom path and doesn't pan — measure scrolling with a SHORT viewport (≤ ~650 px) at DPR 2 so it actually overflows/pans. *Rejected en route (do not retry): motion-mode knob-hiding (worked but Dylan rejected the vanishing visuals); an animation-freeze during pan (`viewportActivity.js`, deleted — only ~25 % off a real pan since knob composites, not animation, dominate); removing knob will-change (raster-on-pan, worse).*

**Invariants:** cabinet natural height is byte-identical with the manager on/off (no fit() feedback); jack rects inside skipped modules remain valid (Blink retains last layout — probe-verified); single writer holds (the manager is the only writer of `contentVisibility`/`containIntrinsicSize` on modules); Zero-Re-render holds (closure state + direct style writes only); module `will-change: transform` (61d) is a static CSS property — fewer/bounded layers than the knobs it replaced, so GPU-memory and black-flash risk are not increased. Measured on the 31-instance rack: powered idle ~33–42 ms/frame → ~22–24 ms; wins scale with rack height (test rack was only 1.9 viewports tall — skip ceiling ~50%). Browsers without `content-visibility` degrade gracefully to pre-61 behavior (unknown style values are no-ops).
