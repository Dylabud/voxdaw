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
| `arpBaseVolRef` | `Tone.Volume` — static base-level node owned exclusively by the vol slider; sits between `arpVolRef` (gesture) and `arpDelayRef` so the two writers never conflict |
| `arpDelayRef` | `Tone.FeedbackDelay` — on arp path between `arpBaseVol` and bypass/fx split |
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
`position: absolute; bottom: 12px; right: 56px; z-index: 50` inside `.viewport`. Draggable via same ref-based architecture as `VocoderTerminal`. No canvas visualizer. Width: 228px. Contains an instrument `<select>` dropdown (analog / fm / am / pluck) and four vertical DAW faders: `dly` (5-stop: 0/'1/4'/'1/8'/'1/16'/'1/32' — controls `arpDelayRef.delayTime`), `wet` (FeedbackDelay mix 0–1 via `wet.rampTo`), `dcay` (0.1–2.0s — maps to `envelope.decay`+`release` for Synth/FMSynth/AMSynth, or `resonance` for PluckSynth), and `vol` (−36 to +6 dB — controls `arpBaseVolRef`, the static base gain node separate from the gesture-driven `arpVolRef`). `[ speed snap ]` toggle at bottom controls `arpSpeedSnapRef` in the audio engine. Mounted/unmounted via `[ arp controls ]` toggle in the Controls Arpeggiator section; fader/dropdown state resets to defaults on remount while audio node params persist independently.

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
`◑` / `○` button. Both the Controls sidebar header (VoxTool) and the Workstation transport bar render the toggle. `isDarkMode` state lives in `src/Root.js`; passed as `isDarkMode` + `onThemeToggle` props down to `App`, `Workstation`, and through to `Controls` / `WorkstationShell`. State survives navigation between pages.

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

---

## 14. Page Routing (`src/Root.js`)

The app shell is a thin state-router, not React Router. `Root.js` owns:
- `page` state — `'home' | 'voxtool' | 'workstation'`
- `isDarkMode` state — persists across page navigation

It applies `data-theme={isDarkMode ? undefined : 'light'}` on a top-level wrapper div (descendants inherit the theme tokens) and renders one of three pages based on `page`. Each page receives `onNavigateHome` plus the theme props. **No `react-router-dom` dependency** — for a 3-page app where two are visually distinct workstations, simple state is cheaper and avoids unmount/remount cascades on the VoxTool hooks (camera permission, MediaPipe model, AudioContext, WebSocket all stay warm only as long as the relevant page is mounted).

```
index.js → <Root>
  page='home'        → <HomePage onNavigate={setPage} />
  page='voxtool'     → <App        onNavigateHome={…} isDarkMode={…} onThemeToggle={…} />
  page='workstation' → <Workstation onNavigateHome={…} isDarkMode={…} onThemeToggle={…} />
```

`HomePage` is the single entry gate (the old `WelcomeModal` was folded into it and removed). `Workstation` is itself a 2-view container: a "under construction" warning page with `[ ← back ]` and `[ continue → ]`, gating entry into `<WorkstationShell />`.

---

## 15. Workstation Architecture

### Component tree
```
Workstation.jsx                 — view container: warning ↔ shell
└── WorkstationShell.jsx        — top transport bar, tracks/regions/ruler, editor host, bottom transport bar
    └── RegionEditor/           — bottom-docked panel (mounted when editingRegion ≠ null)
        ├── RegionEditor.jsx    — inspector + piano roll shell
        └── RegionEditor.module.css
```

### Layout (flex column, `100vw × 100vh`)
```
┌─ .transport (56px) ─────────────────────────────────┐  ← BPM, zoom, home, theme toggle
├─ .arrangement (flex: 1) ────────────────────────────┤  ← shrinks when editor panel is open
│   ├─ .colResizer                                     │
│   ├─ left: track headers + instrument selector       │
│   └─ right: timeline, ruler, regions                 │
├─ .divider (6px, row-resize) ────────────────────────┤  ← only when editor open
├─ .editorWrap (height controlled by inline style) ───┤  ← only when editor open
│   └─ <RegionEditor>                                  │
└─ .bottomTransport (48px) ───────────────────────────┘  ← play/pause, stop, record buttons
```

Play/pause and stop buttons live in `.bottomTransport` (border-top panel, `justify-content: center`). The top transport bar retains BPM, zoom, home, and theme controls only.

### State in `WorkstationShell`
| State / Ref | Purpose |
|-------------|---------|
| `isPlaying` (state) | drives play-button active class; gates the rAF loop |
| `bpm` (state) | current tempo (default 120); replaces former `BPM` constant — drives `pxPerSec` and `Tone.Transport` |
| `editingBpm` / `tempBpm` (state) | in-place BPM editor toggle + draft string value |
| `tracks` (state) | `[{ id, name, instrument, color, isMuted, isSolo }]` — `color` is a hex string from `TRACK_COLORS` |
| `regions` (state) | `[{ id, trackId, startMeasure, durationMeasures, clipOffset, fadeIn, fadeOut }]` — `clipOffset` is in measures, can be negative (left padding). `fadeIn`/`fadeOut` are measure-valued visual envelopes (Phase 98), `fadeIn + fadeOut ≤ durationMeasures` enforced by push logic |
| `notes` (state) | `[{ id, trackId, note, startBeat, durationBeats, regionId }]` — `startBeat` is **bottle-local** (offset from the region's bottle origin = `startMeasure − clipOffset` measures), filtered by `trackId` for the active editor |
| `editingTrackId` (state) | non-null = bottom editor panel visible |
| `selectedRegionId` (state) | ID of the currently selected region (set on mousedown; cleared on completed drag or lane click — **persists after a pure click** so Delete/Backspace has a target); drives `.regionSelected` CSS class (`filter: brightness(0.8)`) |
| `editorHeight` (state) | resizable bottom panel height in px (default 320, clamped `[150, vh-200]`) |
| `nextIdRef` / `nextRegionIdRef` | monotonic counters → stable names across hypothetical delete/add |
| `playheadRef` / `timeRef` | DOM nodes written every frame by the rAF loop |
| `timelineRef` | scroll container — needed for `getBoundingClientRect()` + `scrollLeft` |
| `rulerRef` | drag (scrub) is only initiated when `mousedown.target ∈ ruler` |
| `ghostRefs` (map) | `{ trackId → ghost DOM element }` — direct DOM mutation during hover |
| `hoverRef` | `{ trackId, measure }` — read by click handler to commit a region |
| `dragRef` | active region drag: `{ regionId, trackId, origTrackIndex, pendingTrackId, pendingTrackIndex, mode, startX, startY, initStart, initDuration, initClipOffset, el, pendingStart, pendingDuration, pendingClipOffset, dragStarted, companions }` — `dragStarted` gates `is-dragging` + cursor + inline filter to the first `mousemove` that crosses a 4px 2D threshold (`Math.hypot(dx, dy) < 4`), preventing spurious drag activation on clicks. `initClipOffset`/`pendingClipOffset` track the bottle/window invariant during resize-left (clipOffset = initClipOffset + (newStart − initStart), allowed to go negative for left-padding) |
| `isDraggingRef` | ruler drag-scrub flag (suppresses ghost during scrub) |
| `editorWrapRef` | direct DOM mutation during editor-panel resize |
| `regionsRef` | inline-synced mirror of `regions` state — lets drag `useEffect` closures read current regions without stale-closure bugs |
| `tracksRef` | inline-synced mirror of `tracks` state — lets drag `useEffect` closures resolve candidate track IDs during cross-track moves |
| `selectedRegionIdRef` | inline-synced mirror of `selectedRegionId` state — read by the Delete/Backspace `useEffect` (dep: `[]`) so it never re-registers on selection changes |
| `lastPianoScrollTopRef` | persists piano roll vertical scroll position across track switches and editor close/reopen; `null` = no user scroll yet → C4 default |
| `pianoScrollRef` | RegionEditor scroll container — also used by `handlePianoRollScroll` for scroll sync and `lastPianoScrollTopRef` save |

### Key constants
| Constant | Value | Meaning |
|----------|-------|---------|
| `PIXELS_PER_BEAT` | `25` | 100px per 4/4 bar — matches CSS bar-line gradient |
| `MEASURES` | `24` | number of ruler labels (1..24) |
| `TRACK_H` | `72` | matches `.trackLane` height in CSS — used for cross-track Y snapping |
| `RULER_HEIGHT` | `24` | matches `.ruler` height in CSS — offset applied before flooring `clientY` to track index |
| `TRACK_COLORS` | 7-color array | mid-saturation hex colors for per-track differentiation; cycles via `(n-1) % len` |
| `pxPerSec` (derived) | `PIXELS_PER_BEAT * (bpm / 60) * zoomLevel` | pixels per second; recalculates on BPM or zoom change; drives playhead and seek math |

### BPM Editing
The transport bar BPM display is click-to-edit: clicking the value renders an `<input type="number">` in-place (same CSS as the static span — transparent bg, no spinners). `handleBpmCommit` validates, clamps (20–300), and applies the change. **Playhead anchoring on BPM change:** `Tone.Transport.seconds` is scaled by `bpm / newBpm` before applying `Tone.Transport.bpm.value = newBpm` — this preserves the musical bar:beat position so the playhead does not jump. Uses `.value =` (instant) rather than `.rampTo()` because this is a discrete user action and a ramp would create ordering ambiguity with the simultaneous `seconds` adjustment. The `setBpm(n)` re-render then recalculates `pxPerSec`, triggering the `useEffect [pxPerSec, updatePlayhead]` which repositions the playhead DOM element — net result: no visual jump.

### Tone.Transport coordination
`Tone.Transport` is a global singleton shared with `useAudioEngine`. Workstation and VoxTool both call `.start()` / `.pause()` / `.stop()` independently. Acceptable for now because the user is on one page at a time. **Open work:** a `useTransport` hook owning Transport state + position events will be the coordination layer when global timeline math comes online.

### Interaction model
| Surface | Single click | Double-click | Drag |
|---------|--------------|--------------|------|
| Ruler | seek to position | n/a | scrub (window-level mousemove) |
| Empty lane | commit ghost-region | open editor | n/a |
| Lane (with regions) | nothing (ghost suppressed) | create region at hover measure (if unoccupied) + open editor | n/a |
| Region body | n/a (stopPropagation) | open editor | move — X: 1-measure snap; Y: cross-track snap by `TRACK_H` |
| Region left edge | n/a | n/a | resize-left (start clamps ≥ 0, ≤ right-edge − 1) |
| Region top-left corner (half-disc) | n/a | n/a | `fade-left` — drag fade-in width; pushes `fadeOut` if collides |
| Region top-right corner (half-disc) | n/a | n/a | `fade-right` — drag fade-out width; pushes `fadeIn` if collides |
| Merged fade joint (handles meet) | center 40%: `fade-both` (joint slides, sum preserved); edges 30%/30%: split back to `fade-left`/`fade-right` | n/a | as above |
| Region right edge | n/a | n/a | resize-right (duration ≥ 1) |
| Region `[ edit ]` btn | open editor panel | n/a | n/a |
| Track header | n/a | toggle editor panel | n/a |
| Editor divider | n/a | n/a | resize panel height `[150, vh-200]` |
| **Spacebar** | toggle play/pause (input-focus-guarded) | n/a | n/a |
| **Delete / Backspace** | delete selected region + all its notes (input-focus-guarded) | n/a | n/a |

All drag operations write directly to `element.style` during the drag; React state commits exactly once on `mouseup`. Matches the established Zero-Re-render Rule pattern (playhead, ghost, etc).

**Drag body class:** `document.body.classList.add('is-dragging')` is deferred to the first `onMove` event that crosses the 4px threshold (`dragStarted = true`), **not** on `mousedown`. This prevents the `pointer-events: none` CSS rule from applying to regions during a plain click, which was causing `dblclick` events to mis-target the lane and create spurious regions. CSS rule `:global(body.is-dragging) .region { pointer-events: none }` suppresses all region hover effects and edit-button reveals during a drag. The `handleLaneMouseMove` ghost-preview handler also early-returns when `dragRef.current` is truthy — preventing ghost animation from interfering with active drags.

**Cross-track move collision:** `noOverlap(candTrackId, candStart, candDur)` is evaluated against the candidate track on every `mousemove`. The region snaps `translateY` to `(pendingTrackIndex - origTrackIndex) * TRACK_H` and floats at `zIndex: 10`. On `mouseup`, transform and zIndex are cleared synchronously before `setRegions` commits the new `trackId` — preventing a flash of the region in its original lane.

**Live color during cross-track drag:** When the candidate track changes (`candTrackId !== prevTrackId`), `d.el.style.setProperty('--track-color', color)` immediately overrides the inherited CSS variable on the dragged DOM element, providing live color feedback. The override is removed via `d.el.style.removeProperty('--track-color')` in `onUp` before `setRegions` commits, so the element re-inherits the correct lane color.

**Region selection:** `setSelectedRegionId(region.id)` is called at the start of `startRegionDrag`. `setSelectedRegionId(null)` is called inside the `if (d.dragStarted)` block in `onUp` (clears after a completed drag) and in `handleLaneClick` (clears on empty lane click). **Pure clicks (no drag movement) leave selection intact** — this is intentional so the user can click a region and then press Delete/Backspace to remove it. Three-tier brightness: `.region:active` → `brightness(0.6)` (mousedown held); `.regionSelected` → `brightness(0.8)` (selected, mouse released); base → `1.0` (not selected). An inline `d.el.style.filter = 'brightness(0.6)'` is applied at drag threshold crossing to persist the active-dark state after the browser drops `:active` mid-drag; cleared alongside `transform`/`zIndex` in `onUp`.

### Region clip rendering
Regions render absolutely inside their lane. Both `trackRow` (left header column) and `trackLane` (right timeline column) receive `style={{ '--track-color': t.color }}` — the two divs are in separate DOM subtrees so the variable must be set on both:
- `top: 4px; bottom: 4px` insets give breathing room
- `background: color-mix(in srgb, var(--track-color, var(--accent-color)) 25%, transparent)`
- `border: 1px solid var(--track-color, var(--accent-color))`
- Resize handles on left/right edges (6px wide, `cursor: ew-resize`) at `z-index: 3`
- Edit button at top-right (`z-index: 4`) revealed via pure-CSS `.region:hover .editBtn` — no React hover state
- Selected region receives `.regionSelected` class → `filter: brightness(0.8)`; active/dragging → `brightness(0.6)`; works with any dynamic color without hex math

### Track color system
`TRACK_COLORS` is a 7-color module-level array of mid-saturation hex values chosen for visibility on `#0e0e10`. Color assigned in `handleAddTrack` via `TRACK_COLORS[(n - 1) % TRACK_COLORS.length]` using the stable `nextIdRef` counter. Stored as `track.color` (hex string). Applied via the `--track-color` CSS custom property which cascades to `.trackName`, `.trackRowActive`, `.region`, `.noteBlock`, `.regionHighlight`. A 7px color dot (`<span className={styles.trackColorDot}>`) sits inside a `.trackNameRow` flex wrapper next to the track name in the header.

### Note shape (Bottle/Window model)
```
{ id, trackId, note, startBeat, durationBeats, regionId }
```
`regionId` links each note to its parent region (foreign key). Notes are stored in **bottle-local beats**: `startBeat` is offset from the region's bottle origin, which sits at the absolute timeline measure `region.startMeasure − region.clipOffset`. A region's visible window covers bottle beats `[clipOffset * 4, (clipOffset + durationMeasures) * 4)`; notes outside the window are hidden but never destroyed (they reappear when the window grows back). Render math: `globalLeftBeat = (region.startMeasure − region.clipOffset) * 4 + note.startBeat`. `handleNoteAdd` converts incoming global `startBeat` to bottle-local before storage. `handleNoteAdd` also auto-creates a region with `clipOffset: 0` when a note lands in an empty measure. **Move semantics**: sliding a region's window does NOT shift its notes' `startBeat` — only `region.startMeasure` changes; notes stay locked to the bottle.

### Destructive edit (`applyDestructiveEdit`)
Trim/split overlapping regions on the same track. Four cases preserve the bottle except in total eclipse:
- **A (total eclipse)**: incoming fully covers old → old region destroyed, its notes deleted.
- **B (right trim)**: only `durationMeasures` shrinks. Bottle preserved; right-side notes hidden by the window.
- **C (left trim)**: `startMeasure` advances, `durationMeasures` shrinks, `clipOffset` increases by the same shift so the bottle origin stays fixed. Bottle preserved; left-side notes hidden.
- **D (middle split)**: left piece keeps the original region+notes (`durationMeasures` trimmed); right piece is a fresh region with a new `id` and deep-cloned notes (new note IDs, same bottle contents), `clipOffset` advanced to align with the cut. Each half independently holds the full bottle and can be expanded outward to reveal hidden notes.

### Cluster resize (multi-region drag)
When multiple regions are selected and resized together, `onUp` resolves internal cluster collisions before resolving against background regions. The cluster is sorted with **`(trackIndex ascending, initStart × secondaryAsc)`** where `secondaryAsc = -1` for `resize-right`, `+1` for `resize-left`/`move`. Using **`initStart` (pre-drag startMeasure)** as the secondary key — kept in a sidecar `initStartById` Map — preserves the intrusion-direction signal through wall-clamping: if multiple members get pinned to `pendingStart=0`, `pendingStart` ties but `initStart` still disambiguates so the originally-rightmost member sorts last (resize-left) or originally-leftmost sorts last (resize-right), letting that member's expansion win via Case A eclipse instead of being clipped by Case C from a wall-mate. The cluster loop's "last incoming wins" semantic combined with this sort yields the expected DAW behavior in all clamp scenarios.

### Region overlap telemetry + DOM sync (post-commit microtask)
After `setRegions/setNotes` in `onUp`, a `queueMicrotask` performs two passes against `regionsRef.current`:
1. **Overlap assertion**: groups by `trackId`, sorts each by `startMeasure`, and `console.warn`s `[region-overlap]` on any adjacent pair where `prev.startMeasure + prev.durationMeasures > cur.startMeasure`. Catches any state-level bug introduced by future changes to `applyDestructiveEdit` or the cluster loop.
2. **DOM/state resync (silent)**: walks each region's DOM node via `[data-region-id]` and writes `style.left`/`style.width` to match state if they differ. This is an intentional workaround for React's reconciler bailing on `style` props whose value matches the previous render's memo even though the DOM was direct-mutated during drag (e.g., a companion trimmed back to its original duration by Case C — React sees same-value and skips the DOM write, leaving the drag-time stretched DOM stale).

### Void-click deselection
Clicking the empty area below all track lanes clears region selection. Implemented in the marquee `useEffect`'s `onUp` `else` branch (when `d.active` is false — mousedown armed marquee but no drag past 4px). Lane clicks bypass via `stopPropagation` on `.trackLane`; ruler clicks route through `isDraggingRef` and never set `marqueeDragRef`.

### Beat-to-region containment
A region at `(startMeasure, durationMeasures)` occupies global beats `[startMeasure * 4, (startMeasure + durationMeasures) * 4)`. A note `n` is *in* its region iff its bottle-local `startBeat` ∈ `[clipOffset * 4, (clipOffset + durationMeasures) * 4)`.

### Piano roll shell (`RegionEditor`)

**Tab navigation:** The 48px `editorBar` strip above the piano roll body contains three tabs: **notes** | **instrument** | **effects**. Local `activeTab` state (no prop threading). The inspector column and column resizer are always rendered regardless of the active tab — they are unconditional siblings of the `.pianoRoll` scroll container. The `.pianoRoll` scroll container itself is always mounted (preserving `scrollTop` natively), and always contains the piano keys column. Only the right-hand content area inside `.pianoRoll` is conditional: a ternary renders the `.grid` div on the notes tab, or a centered `.placeholder` span on instrument/effects tabs. This ensures the keys column scrolls in sync with the grid whenever the piano roll is visible, and scroll position is never lost across tab switches.

Generated via `buildKeys(loOct, hiOct)`:
- `buildKeys(-2, 8)` → 132 chromatic keys (C-2 to B8), 18px each = 2376px tall column
- C4 is at key index 59 (inner loop runs B→C per octave); default `scrollTop = 59 * 18 - clientHeight + 18` shows C4 at the bottom of the viewport on first open
- Scroll position persists via `scrollMemoryRef` prop (a `useRef` from WorkstationShell); null = use C4 default; tab switches never re-trigger the C4 useEffect (dep: `track?.id`)
- White / black row backgrounds via `--piano-key-white` / `--piano-key-black` (directionally correct in both themes)
- Labels only at every C; `.keyOctave` class adds a stronger top border for visual octave markers
- Note blocks and region highlights use `var(--track-color, var(--accent-color))` — injected on the editor root div via `style={{ '--track-color': track?.color }}`
- Grid click (`handleGridClick`): `x = (clientX - rect.left) + scrollLeft - keysW`, `y = (clientY - rect.top) + scrollTop` — both axes compensate for scroll position

**`computeGridBg(ppm, zoomLevel)`** (exported from `WorkstationShell.jsx`, shared with `RegionEditor`): Builds the CSS `background-image` string for arrangement and piano roll grids. At macro zoom-out, `ppm` can drop to 1–2px, collapsing all gradients into a solid block. Fix: `labelStep = Math.max(1, Math.ceil(50 / ppm))` (identical to the ruler's label-skip formula) scales the effective measure period to `effectivePpm = ppm * labelStep`. Beat and sub-beat layers are suppressed when `labelStep > 1` (they would be sub-pixel at those zoom levels). Grid lines are thus guaranteed to align with visible ruler labels at all zoom levels.

Grid backgrounds (six layered `repeating-linear-gradient`s on `.grid`, top → bottom):
1. Bar lines — `var(--border-mid)` every 200px (1 bar = 4 beats × 50px)
2. Sub-beat lines — `var(--border-faint)` every 50px
3. Octave lines — `var(--border-mid)` every 216px (12 × 18px)
4. Semitone rows — `var(--border-subtle)` every 18px
5. **Accidental-row shading** — `var(--pr-shade-accidental)` (5 black-key rows per octave)
6. **Natural-row shading** — `var(--pr-shade-natural)` (7 white-key rows per octave)

Theme-aware shading inverts direction per theme:
- **Dark theme:** `--pr-shade-natural = rgba(255,255,255,0.04)` (brighten naturals), `--pr-shade-accidental = transparent`
- **Light theme:** `--pr-shade-natural = transparent`, `--pr-shade-accidental = rgba(0,0,0,0.06)` (darken accidentals)

Both achieve the same visual semantic ("accidentals look darker than naturals") via opposite mechanics fitted to each theme's contrast budget.

**Grid alignment gotcha:** explicit `minHeight: KEYS.length * KEY_H` (= 1296px) is set on both keys column and grid via inline style. `align-items: stretch` inside an `overflow: auto` flex container is bounded by the visible cross-size, not the line's natural maximum — so flex stretch alone leaves the grid background blank below the viewport on scroll. The explicit pixel min-height is the reliable fix.

