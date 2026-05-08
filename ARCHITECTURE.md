# VoxDaw - Technical Architecture & Implementation Blueprint

## Overview
VoxDaw is a live gesture instrument — a React browser app that maps real-time hand tracking data to a polyphonic synthesizer, arpeggiator, and effects chain with zero UI re-renders in the audio hot path.

---

## 1. Technical Stack

| Layer | Library / Tool |
|-------|---------------|
| Frontend | React 18 (Create React App) |
| Language | JavaScript (ES2022) |
| Styling | CSS Modules, Option A palette (`#0e0e10` bg / `#5DCAA5` accent) |
| Gesture tracking | `@mediapipe/tasks-vision` 0.10.35 — `HandLandmarker` |
| Audio DSP | `Tone.js` 15.1.22 (Web Audio API wrapper) |
| Vocoder DSP | Native Web Audio API (`AudioContext`, `BiquadFilterNode`, `WaveShaperNode`, `AnalyserNode`) — independent of Tone.js |
| MIDI output | Native `WebSocket` → local Node.js WS server at `ws://localhost:8080` |

---

## 2. Data Flow (per animation frame)

```
getUserMedia → <video> → HandLandmarker.detectForVideo()
  → result.landmarks[]   (21 × {x,y,z} normalized 0–1, Y-down)
  → result.handednesses[]
  → updateParams(landmarks, handednesses)   ← called inside rAF tick
      ├─ Right hand (MediaPipe "Left") → pitch / chord / velocity / arp
      └─ Left hand  (MediaPipe "Right") → reverb wet / vibrato depth / arp vol
```

**MediaPipe handedness inversion:** The display canvas is CSS-mirrored (`scaleX(-1)`), but MediaPipe reads the raw un-mirrored frame. The user's physical right hand appears on the left side of the raw frame, so MediaPipe labels it `"Left"`. In `updateParams`, `label === 'Left'` is the pitch/chord/arp hand.

---

## 3. Zero-Re-render Rule

`updateParams` runs inside a `requestAnimationFrame` loop. **No React state is ever written inside this function.** All live parameter updates go to:

- **Tone.js audio node params** via `.rampTo(value, 0.05)` — 50ms ramp prevents zipper noise
- **DOM elements** via `.textContent` using refs collected in the `hudRefs` object
- **Imperative component handles** — e.g., `pianoRollRef.current.setNotes()` and `.flashNote()`

---

## 4. Audio Graph

```
[analogVoices × 6]  ─┐
[stringsVoices × 6] ─┤→ Filter → Vibrato → Reverb → Volume → Destination
[arpVoice × 1]      ─┘
  arpVoice → arpVol → arpDelay → arpBypassGain → Destination  (default path)
                               → arpFxGain     → Filter       (fx path, toggled by setArpFx)
```

All chord voice sets connect to the same `filter` node input; Tone.js sums them. The active instrument set is tracked by `activeVoicesRef`; the inactive set is muted to `VOICE_MUTE = −80 dB`. The arp voice has a dedicated `Tone.Volume` (`arpVolRef`) before `arpDelay` so its gain is independent of the pinch-velocity volume on the main chain. `Tone.FeedbackDelay` (`arpDelayRef`) sits between `arpVol` and the bypass/fx split; `wet=0` at init so it is transparent until raised via ArpTerminal.

### Key refs in `useAudioEngine`

| Ref | Purpose |
|-----|---------|
| `analogVoicesRef` | 6× `Tone.Synth` — [root, 3rd, 5th, 7th, oct, oct+3rd] |
| `stringsVoicesRef` | 6× `Tone.FMSynth` — [root, 3rd, 5th, 7th, oct, oct+3rd] |
| `activeVoicesRef` | Points to whichever voice set is currently audible |
| `arpPatternRef` | `Tone.Pattern` — always created in `startAudio`, muted when arp off |
| `currentRootRef` | Last computed root frequency in Hz — consumed by the arp |
| `scaleRef` | `Float32Array` of sorted Hz values for `snapToNearest()` binary search |
| `globalOctaveRef` | Integer −2 to +2; applied via `.transpose(n * 12)` to raw pitch |
| `arpOctaveShiftRef` | Boolean; adds 12 semitones to `effectiveArpRoot` |
| `filterRef / vibratoRef / reverbRef / volumeRef / arpVolRef` | Shared effects chain nodes |
| `arpInstrumentNameRef` | String — persists arp instrument selection across engage/disengage (`'analog'`/`'fm'`/`'am'`/`'pluck'`) |
| `arpDecayRef` | Float — persists decay value (0.1–2.0); maps to `envelope.decay` or PluckSynth `resonance` |
| `arpDelayRef` | `Tone.FeedbackDelay` — on arp path between `arpVol` and bypass/fx split |
| `arpSpeedSnapRef` | Boolean — when `true`, rate snaps to 3 discrete bands; when `false`, fluid lerp mode |
| `smoothedFluidIntervalRef` | Float (seconds) — lerp accumulator for fluid speed; written by rAF, read by Pattern callback |
| `sendMidiRef` | Shadow ref of `sendMidi` from `useMidi` — safe to call inside rAF |
| `chordMidiRef` | `Set<number>` — MIDI notes active last frame, used for diff-based noteon/noteoff |
| `arpMidiTimers` | `number[]` — pending `setTimeout` IDs for arp noteoff scheduling |

### Arp pattern delta-check

Four refs (`appliedArpModeRef`, `appliedArpRateRef`, `appliedArpRootRef`, `appliedArpThirdRef`) track the last values written to `arpPatternRef`. The pattern `values` and `pattern` fields are only rebuilt when mode/root/third change. `interval` is handled separately: in snap mode the rAF delta-check applies it on band transitions; in fluid mode the rAF loop only lerps `smoothedFluidIntervalRef` (never touches the scheduler), and the `Tone.Pattern` callback sets `arpPattern.interval = smoothedFluidIntervalRef.current` at note-fire time — safe inside the Tone.js scheduling context. All delta refs reset to `null`/`0.5` in `stopAudio`.

---

## 5. `dsp.js` Utility Reference

| Function | Notes |
|----------|-------|
| `calculateDistance2D(p1, p2)` | XY Euclidean on normalized landmarks |
| `calculateDistance(p1, p2)` | XYZ Euclidean |
| `mapRange(v, inMin, inMax, outMin, outMax)` | Clamped linear map |
| `isFingerExtended(hand, tipIdx, pipIdx)` | Y-comparison — reliable on non-rotated hands |
| `snapToNearest(hz, sortedFloat32Array)` | O(log n) binary search for scale quantization |
| `normalizeNote(note)` | Tone.js flat names → sharp names (for PianoRoll key lookup) |
| `getArpFingerStates(hand)` | Rotation-robust wrist-to-tip / wrist-to-PIP ratio, 1.1× threshold |
| `getWristTiltDeg(hand)` | atan2 of wrist→midMCP vector; absolute deviation for bidirectional tilt |
| `getArpSpreadDb(hand, states)` | Outermost extended-tip distance → −12 to +3 dB |

---

## 6. Component Architecture

### PianoRoll
`forwardRef` component exposing two imperative methods (no React state):
- `ref.current.setNotes(noteNames[])` — diff-based class toggling via an internal `Set`; frames with no chord change produce zero DOM writes.
- `ref.current.flashNote(noteName, durationMs)` — adds a `.flash` CSS animation (gold inset `box-shadow`) for `durationMs` ms. `flashTimersRef` (Map) allows rapid re-fires on the same key to cancel the previous timer and restart the animation via forced reflow (`void el.offsetWidth`). Called directly from the `Tone.Pattern` callback — safe because Pattern callbacks run on the main thread.

### TelemetryHUD
Eight metrics (PITCH, ARP, ARP VOL, CHORD, FILTER, REVERB, VIBRATO, VELOCITY) updated via DOM refs in the rAF loop. `position: absolute; right: 24px; top: 50%; transform: translateY(-50%)` — floats over the layout, vertically centered. Collapses via `transform: translateX(120%) translateY(-50%); opacity: 0` with 0.3s ease transition. Height: `clamp(180px, calc(65vw * (9/16)), 450px)` to track camera feed height.

### Controls sidebar
`position: absolute; left: 0; top: 0; height: 100vh; width: 200px; z-index: 10`. Header contains the `◑`/`○` light/dark theme toggle button and the "·· voxdaw" title in a flex row. A `.collapseTab` button (`position: absolute; left: 100%`) protrudes from the sidebar's right edge — it follows `translateX` so it remains reachable at the left viewport edge when collapsed. Four labeled sections: **Master Engine** (tempo, octave, scale), **Synth Voice** (instrument, oscillator), **Arpeggiator** (arp +1 oct, arp thru fx, arp controls), **Output** (MIDI toggle, Vocoder toggle, conditional record). Collapses via `transform: translateX(-100%); opacity: 0` with 0.3s ease. Controlled by `showControls` state in `App.js`.

### ArpTerminal
`position: absolute; bottom: 12px; right: 56px; z-index: 50` inside `.viewport`. Draggable via same ref-based architecture as `VocoderTerminal`. No canvas visualizer. Width: 190px. Contains an instrument `<select>` dropdown (analog / fm / am / pluck) and three vertical DAW faders: `dly` (5-stop: 0/'1/4'/'1/8'/'1/16'/'1/32' — controls `arpDelayRef.delayTime`), `wet` (FeedbackDelay mix 0–1 via `wet.rampTo`), and `dcay` (0.1–2.0s — maps to `envelope.decay`+`release` for Synth/FMSynth/AMSynth, or `resonance` for PluckSynth). `[ speed snap ]` toggle at bottom controls `arpSpeedSnapRef` in the audio engine. Mounted/unmounted via `[ arp controls ]` toggle in the Controls Arpeggiator section; fader/dropdown state resets to defaults on remount while audio node params persist independently.

### WelcomeModal
`position: fixed; inset: 0; z-index: 300` — renders on every page load/reload, blocking all DAW interaction until dismissed. Controlled by `showWelcome` state in `App.js` (`useState(true)`; no localStorage). No backdrop-click dismissal — user must explicitly click `[ ENTER STUDIO ]`. Adapts to light/dark theme via CSS vars (`--bg-panel`, `--text-primary`, `--overlay-bg`, `--accent-color`). Always dark is not enforced here because it is not a camera overlay.

### Toggle buttons
One `position: absolute; z-index: 50` button in `App.js` (`.rightToggleBtn` at `top: 16px; right: 16px`) collapses the TelemetryHUD. The Controls sidebar collapses via its own `.collapseTab` (see Controls sidebar above).

### Viewport
`width: 65vw; max-width: 1000px; aspect-ratio: 16/9`. Hosts the mirrored `<video>` feed, the MediaPipe skeleton `<canvas>` overlay, the PianoRoll overlay, the LoopProgress bar, the `VocoderTerminal` overlay, and the `ArpTerminal` overlay. Both video and canvas use `transform: scaleX(-1)` to mirror for natural interaction.

---

## 7. Layout Architecture

```
.app  (position: relative; display: flex; justify-content: center; align-items: center)
  │     data-theme="light" attribute set here when light mode active
  ├── Controls         (position: absolute; left: 0)    ← floats left, out of flow
  │     └── .collapseTab (position: absolute; left: 100%) ← protrudes from right edge
  ├── .stage           (flex column; z-index: 1)        ← permanently centered by flex
  │     ├── Viewport
  │     └── Engage/Disengage button
  ├── TelemetryHUD     (position: absolute; right: 24px) ← floats right, out of flow
  └── .rightToggleBtn  (position: absolute; z-index: 50)
```

Because both panels are out of normal flow, toggling them does not cause the central `.stage` to shift — it stays centered by flexbox at all times.

---

## 8. Loop Station

`useLoopStation(volumeRef)` taps a `Tone.Recorder` after `volumeRef`. Records 8 s (4 bars @ 120 BPM), decodes via `rawContext.decodeAudioData`, then plays back through a `Tone.Player(loop:true)` directly to `Destination` — bypassing the effects chain. Does not use `Tone.Transport`.

---

## 9. MIDI Output

`useMidi` hook owns the WebSocket lifecycle. `sendMidi(type, note, velocity)` is a stable `useCallback` over refs — safe to call inside rAF/Tone callbacks. Chord MIDI uses a per-frame `Set<number>` diff to send only changed noteon/noteoff events. Arp MIDI schedules noteoff via `setTimeout(holdMs)` where `holdMs = Tone.Transport.toSeconds(HOLD_MAP[rate]) * 1000`. `panicAllNotes()` bypasses the enabled-check and fires noteoff for all active notes — called first in `handleDisengage`.

### Connection Error Fallback (MidiModal)
`useMidi` accepts an optional `onConnectionError` callback. If the WebSocket `onerror` fires (i.e., the bridge server is not running), the callback is invoked before `ws.close()` cascades state back to disabled. `App.js` passes `() => setShowMidiModal(true)` as this callback, which renders `<MidiModal>` — a `position: fixed; z-index: 100` overlay with a blurred backdrop.

`MidiModal` is a 4-view state-routed setup guide controlled by internal `view` state (`'menu'` | `'returning'` | `'windows'` | `'mac'`). The menu view routes users to reconnect instructions or OS-specific first-time setup. Windows and Mac views include Node.js and (Windows only) loopMIDI installation steps, each with a `<a href="/VoxDaw-MIDI-Bridge.zip" download>` primary button. The bridge ZIP is served from `public/VoxDaw-MIDI-Bridge.zip`.

---

## 10. Vocoder Engine

### `useVocoder` hook (`src/hooks/useVocoder.js`)
A standalone 16-band phase-vocoder built entirely on the native Web Audio API, independent of Tone.js.

**Signal graph:**
```
micSource ──┬──→ modPreGain (×10) ──→ [16 × modBPF → rectifier → envLP → gainNode.gain]
            │                                                            ↓
            │                          carrierBus ──→ [16 × carrBPF → gainNode] ──→ outputGain ──→ wetGain ──┐
            └──→ dryGain (raw mic) ─────────────────────────────────────────────────────────────────────────────┴──→ AnalyserNode → destination
```

**Filter bank:** 16 log-spaced bands from 100 Hz to 8000 Hz. Each band: modulator `BiquadFilter` (bandpass, Q=2.5) → full-wave `WaveShaper` rectifier → 20 Hz LP envelope follower. The LP output is connected to the corresponding carrier `GainNode.gain` AudioParam — audio-rate envelope control with zero polling.

**Carrier:** 4 sawtooth `OscillatorNode`s (one per chord voice). Frequencies and per-osc gains are updated every rAF frame via `updateNotes(freqs[])` using `setTargetAtTime(τ=10ms)` — zero node churn.

**Dry/Wet:** `wetGain` and `dryGain` both connect to a shared `AnalyserNode` (fftSize 512) before `ctx.destination`. `mix` param (0–1) cross-fades linearly: `wetGain.gain = mix`, `dryGain.gain = 1 - mix`.

**Exposed API:** `startVocoder()`, `stopVocoder()`, `updateNotes(freqs[])`, `updateVocoderParams({ q, envHz, modGain, outGain, mix })`, `getAnalyserData(Uint8Array)`, `isVocoderActive`.

**`getUserMedia` constraints:** `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `channelCount: 1` — raw mono signal prevents Chrome's AEC/AGC from triggering Windows driver feedback-loop protection.

### `VocoderTerminal` component (`src/components/VocoderTerminal/`)
A `position: absolute; bottom: 12px; left: 56px; z-index: 50` overlay inside `.viewport` (which is `position: relative`). Zero impact on DOM flow or camera layout.

- **Canvas visualizer (250×60):** rAF loop calls `getAnalyserData`, groups 256 FFT bins into 40 bars by peak, alpha-scales bar color by amplitude. Writes only to `canvas.getContext('2d')` — never touches React state.
- **5 range sliders:** Wet/Dry, Filter Q, Env Speed, Mic Gain, Output Gain. A single `handleSlider` callback updates local display state and calls `updateVocoderParams` directly. Audio params change immediately via the hook's node refs.
- Rendered conditionally inside `Viewport` when `isVocoderActive` is true. Three props threaded through `App.js → Viewport → VocoderTerminal`: `isVocoderActive`, `getAnalyserData`, `updateVocoderParams`.

---

## 11. Gesture Routing System (`src/utils/gestureMappings.js`)

All gesture routing constants and defaults live in a single module. Two independent routing layers:

### Signals (continuous modulation matrix)
6 gesture sources (`right_hand_size`, `right_pinch_norm`, `left_pinch_dist`, `left_wrist_y`, `left_wrist_tilt`, `left_arp_spread`) → 5 audio destinations (`filter_cutoff`, `reverb_wet`, `vibrato_depth`, `volume`, `arp_volume`). Each mapping row: `{ id, source, destination, invert }`. The `invert` flag flips the 0–1 range. Mappings are stored in `mappings` React state in `App.js`; a `mappingsRef` (inline-synced) passes the live value into the rAF loop without re-renders. `updateParams` extracts all signals into a plain `signals{}` object inside each hand block, then iterates `mappingsRef.current` and calls `.rampTo` on the appropriate audio node.

### Gates (trigger routing)
17 discrete trigger sources in three groups:
- **Right hand** (7): `right_no_fingers`, `right_middle`, `right_middle_ring`, `right_pinky`, `right_ring_pinky`, `right_middle_pinky`, `right_middle_ring_pinky` — strict 8-state enumeration of middle/ring/pinky `isFingerExtended` combos each frame.
- **Left hand** (7): `left_no_fingers`, `left_pinky`, `left_ring_pinky`, `left_middle`, `left_middle_ring`, `left_middle_ring_pinky`, `left_middle_pinky` — strict 8-state enumeration of `getArpFingerStates` middle/ring/pinky combos each frame.
- **Tilt bands** (3): `left_tilt_low` (< 20°), `left_tilt_mid` (20–60°), `left_tilt_high` (> 60°) — selected from `getWristTiltDeg` each frame.

27 action destinations in four groups: 7 chord types (`chord_root` → `chord_major_7` + `chord_root_maj7`), 11 complex chords (sus4, dim, maj/min +oct, maj/min sub-bass, root −2 oct, poly maj/min, maj9, min9), 6 arp modes, 3 arp rates.

**Hot path:** `updateParams` runs in three phases: **(1) Gather** — each hand block independently produces `activeTriggers[]` and `signals{}`; **(2) Resolve** — iterate `triggerMappingsRef.current`, use `dest in CHORD_DEST_LABELS` / `ARP_DEST_TO_MODE` / `ARP_DEST_TO_RATE` membership to bucket into `targetChord`/`targetArpMode`/`targetArpRate` (cross-hand routing is possible); **(3) Execute** — chord logic calls `resolveChord(targetChord)` returning `{ intervals: number[], thirdST }` — a `for (let i = 0; i < 6; i++)` loop activates voices up to `intervals.length` and mutes the rest.

`DEFAULT_TRIGGER_MAPPINGS` (17 rows) replicates all prior hardcoded behavior exactly.

### GestureSettings modal (`src/components/GestureSettings/`)
`position: fixed; z-index: 200` overlay matching viewport dimensions (`width: 65vw; max-width: 1000px; aspect-ratio: 16/9`). Two tabs: **signals** (source → destination → invert toggle, `.row` grid) and **gates** (`<optgroup>`-grouped dropdowns, `.rowNarrow` grid, no invert column). Both tabs have scrollable `.rowList` (`flex: 1; min-height: 0; overflow-y: auto`) and a footer with Add and Restore Defaults actions. **Collision detection:** frequency maps computed per-render for all four select types; selects with count > 1 receive a `.warningSelect` class (amber border + glow, uses `var(--warning-color)` for light-mode legibility). Opened via `[ configure routing ]` button in Controls.

---

## 12. Light / Dark Mode Theming

### Mechanism
`data-theme="light"` attribute is set on the root `.app` div in `App.js` (controlled by `isDarkMode` React state, default `true`). When absent, all components use `:root` variable values — identical to the previous hardcoded dark palette. No localStorage persistence; theme resets to dark on each page load.

### CSS Variable Layers (`src/index.css`)
| Category | Variables |
|----------|-----------|
| Backgrounds | `--bg-base`, `--bg-panel`, `--bg-elevated`, `--bg-surface`, `--bg-frosted` |
| Borders | `--border-subtle`, `--border-faint`, `--border-mid`, `--border-strong` |
| Text | `--text-primary`, `--text-muted`, `--text-dimmer`, `--text-dimmest` |
| Overlays | `--overlay-bg`, `--input-bg`, `--row-bg`, `--row-border` |
| Accent/form | `--accent-color`, `--form-text`, `--form-text-mid`, `--form-text-dim`, `--warning-color` |
| Viewport/piano | `--bg-camera`, `--piano-key-white`, `--piano-key-white-bdr`, `--piano-key-black`, `--piano-key-black-bdr` |

### What adapts vs stays dark
- **Adapts:** Controls sidebar, TelemetryHUD, GestureSettings modal, MidiModal, Viewport camera bg + idle label, PianoRoll key colors.
- **Always dark (camera overlays):** ArpTerminal, VocoderTerminal, LoopProgress — they sit on top of the live camera feed and require constant high contrast.
- **Always accent-colored (unchanged):** `#5DCAA5` borders on focused elements, mint fill on active/engage buttons, recording red, arp flash gold.

### Toggle button
`◑` / `○` button in the Controls sidebar header (flex row alongside "·· voxdaw" title). `isDarkMode` state lives in `App.js`; passed as `isDarkMode` + `onThemeToggle` props to Controls.

---

## 13. MediaPipe Landmark Index Quick Reference

| Index | Landmark |
|-------|----------|
| 0 | Wrist |
| 4 | Thumb Tip |
| 5, 9, 13, 17 | Index / Middle / Ring / Pinky MCP |
| 6, 10, 14, 18 | Index / Middle / Ring / Pinky PIP |
| 8, 12, 16, 20 | Index / Middle / Ring / Pinky Tip |
| 9 | Middle MCP — also used as hand-size reference point |
