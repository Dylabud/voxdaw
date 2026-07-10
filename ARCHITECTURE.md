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
- `page` state — `'home' | 'voxtool' | 'workstation' | 'moogmodular'`
- `isDarkMode` state — persists across page navigation
- `pendingProject` state — `{ requestId, projectId, data }` open-a-project requests for the Workstation

It applies `data-theme={isDarkMode ? undefined : 'light'}` on a top-level wrapper div (descendants inherit the theme tokens). Pages mount on first visit (a `visited` Set) and stay mounted with `display: none` for audio-engine continuity. **No `react-router-dom` dependency** — simple state is cheaper and avoids unmount/remount cascades on the VoxTool hooks (camera permission, MediaPipe model, AudioContext, WebSocket all stay warm only as long as the relevant page is mounted).

```
index.js → <Root>
  page='home'         → <HomePage onNavigate={…} onOpenProject={…} isDarkMode={…} onThemeToggle={…} active={…} />
  page='voxtool'      → <App              onNavigateHome={…} isDarkMode={…} onThemeToggle={…} />
  page='workstation'  → <WorkstationShell onNavigateHome={…} isDarkMode={…} onThemeToggle={…} getMoogBusNode={…} pendingProject={…} />
  page='moogmodular'  → <MoogModular      onNavigateHome={…} onBusReady={…} />
```

The old `Workstation.jsx` "under construction" 2-view wrapper was removed — Root renders `WorkstationShell` directly, so the shell mounts on the first workstation navigation.

**Open-a-project mechanism (`pendingProject`):** because the shell stays mounted across navigations, a mount-time prop can't deliver later opens. `Root.openProject({ projectId, data })` (where `data` is `deserializeProject` output, or `null` for a blank New Project) bumps a monotonic `requestId` ref, sets `pendingProject`, and navigates. The shell's apply-effect is guarded by `lastAppliedReqRef` — idempotent under StrictMode double-invocation, while a fresh requestId always applies (re-opening the same project is an intentional reload). If the workstation was already visited, `openProject` first asks `window.confirm` before clobbering the live session.

### HomePage dashboard (`src/components/HomePage/`)
Soundtrap-style project dashboard: header (wordmark + nav buttons for VoxTool / Workstation / Moog Modular + `◑/○` theme toggle), a `PROJECTS` grid, and a footer alpha/privacy note. The grid's first cell is a dashed `+ NEW PROJECT` card (`onOpenProject({ projectId: null, data: null })`); each saved project renders a `ProjectCard.jsx` (name, `{trackCount} tracks · {bpm} bpm`, short updated-at) with a hover kebab menu: rename (inline input → `renameProject`), duplicate, download `.voxdaw` (`downloadJSON(record.data)`), delete (confirm). Card click → `getProject` → `deserializeProject` → `onOpenProject`. An `[ import .voxdaw ]` button validates via `deserializeProject`, stores a new record, then opens it. **Grid refresh:** HomePage stays mounted, so Root passes `active={page === 'home'}` and a `useEffect` re-lists on return (plus after every mutating action). IndexedDB-open failure renders an inline "storage unavailable" note instead of crashing.

### Browser project store (`src/utils/projectStore.js`)
Native IndexedDB (db `voxdaw` v1, store `projects`, keyPath `id`) behind a small promise wrapper — no dependency. Record: `{ id: crypto.randomUUID(), name, createdAt, updatedAt, bpm, trackCount, data }` where `data` is the full `serializeProject()` output (source of truth; bpm/trackCount are denormalized for card display). API: `listProjects()` (metadata only, newest first), `getProject`, `saveProject` (upsert; stamps `updatedAt`, preserves existing `createdAt` so callers never read-before-write), `deleteProject`, `renameProject` (patches both the record name and `data.name` so downloads stay correctly named). A failed `openDB()` clears the cached promise so the next call can retry.

The Workstation's `[ save ]` writes here (upsert under `currentProjectId` state; first save mints the id) — producing a `.voxdaw` file moved to the export menu (`.voxdaw` item alongside mp3/wav, filename from the project name). `[ load ]` (file input) still opens raw files; it resets `currentProjectId` to `null` so the first save after a file open creates a new store record. The project `name` travels inside the `.voxdaw` file as an **additive field** (`SCHEMA_VERSION` intentionally not bumped) and is editable via a click-to-edit `NAME` block in the transport bar (the BPM-editor pattern).

---

## 15. Workstation Architecture

### Component tree
```
Workstation.jsx                 — view container: warning ↔ shell
└── WorkstationShell.jsx        — top transport bar, tracks/regions/ruler, editor host, bottom transport bar
    ├── RegionEditor/           — bottom-docked panel (mounted when editingRegion ≠ null)
    │   ├── RegionEditor.jsx    — inspector + piano roll shell
    │   └── RegionEditor.module.css
    └── ContextMenu/            — right-click menu for regions + notes (always rendered, returns null when closed)
        ├── ContextMenu.jsx
        └── ContextMenu.module.css
```

### Region/Note context menu (`ContextMenu/`)
Custom right-click menu (`position: fixed; z-index: 500`, styled after `.exportMenu`). A single `contextMenu` state (`null | { x, y, targetType: 'region'|'note', targetId }`) lives in `WorkstationShell` — the home of `notes`/`regions` state and every edit handler — so menu state and **all** command execution are centralized there. Regions wire `onContextMenu` inline; notes (in child `RegionEditor`) forward right-clicks up via the `onNoteContextMenu(x, y, id)` prop.

- **Selection-preserving:** right-click only resets selection when the target isn't already part of the active multi-selection, so group operations survive the click.
- **Group execution:** `handleContextCommand(action, type, id, payload)` resolves an effective id set (`selectedRegionIdsRef` / `noteSelectionRef` — the whole selection if the clicked item is in it, else just it) and applies Delete / Mute / Pitch across all of them.
- **Functional:** Delete, Mute Region (group-toggle anchored on the clicked region), and **Pitch** via a nested `Pitch ▸` submenu (+12…−12 excluding 0, scrollable `max-height: 60vh`, hover-open with 180ms close-delay, flips to `right: 100%` near the screen edge). **Stubs:** Copy / Paste / Split (`console.log`).
- **Transpose direction:** `KEYS` is ordered high→low (`buildKeys` runs `hiOct→loOct`), so shifting *up* by `s` semitones is `KEYS[ki − s]` (helper `shiftNoteName`).
- Close lifecycle is capture-phase (outside mousedown/contextmenu, Escape, scroll, wheel, blur, post-command); position clamps to the viewport. **Right-click button guard:** `startRegionDrag` early-returns on `e.button !== 0` so a right-click never starts a region drag.

### Region mute (`region.isMuted`)
Boolean on the region shape (default false). **Audio:** `buildRegionEvents` early-returns `[]` when muted, so the region schedules no Part events — covering both the live engine and `audioBounce` (which reuses the same pure function); `isMuted` is part of `computePartKey` so a toggle rebuilds. **Visual:** a single `.regionMuted` class (`opacity: 0.5; filter: grayscale(0.85)`) applies when `r.isMuted || t.isMuted`, covering both region mute and **cascading track mute** (a muted track grays every region in its lane). Persisted additively in `projectIO.js`. Track master-mute audio is still the existing `trackMuteGain` writer; `isMuted` only adds the per-region gate + the unified visual.

### Effects rack — per-track insert effects (state + UI + DSP)
Each track carries an `effects` array (default `[]`), each entry `{ id, type, bypass, params }`
where **array order = signal-chain order** (no separate `order` field — array position is the
source of truth, matching notes/regions). Types, labels, and **param metadata**
(`{ default, min, max, step, label, unit?, scale?, kind? }` — ranges are load-bearing: delay time
≤ 1.0s matches `maxDelay: 1`, feedback ≤ 0.9 / roomSize ≤ 0.95 prevent self-oscillation;
`kind: 'toggle'` marks boolean params) live in one registry,
**`src/components/Workstation/effectDefs.js`** (`EFFECT_DEFS` = `filter`/`delay`/`reverb`/
`doubler`/`autofilter`/`autowah`, `EFFECT_TYPES`, `effectLabel()`, `defaultParamsFor()`).

- **DSP factory (`src/components/Workstation/fxChain.js`,** peer to `synthFactory.js`**):**
  `makeFxGraph(type, params)` → uniform `{ in, out, apply(params, rampSec), dispose }` per type
  (unknown type → `null` passthrough). Six types: `filter` (`Tone.Filter` lowpass), `delay`
  (composite, below), `reverb` (`Tone.Freeverb`), `doubler` (`Tone.Chorus` freq 1.5 / delayTime
  3.5ms / spread 180, `.start()`), `autofilter` (`Tone.AutoFilter` LFO sweep, base 200 Hz,
  `.start()`), `autowah` (`Tone.AutoWah` envelope follower, base 100 Hz, no start). Per-type
  `KEY_MAPS` route state keys → Tone params (`q→Q`, `rate→frequency`, `depth→octaves` on the
  wahs); the generic applier ramps Signal/Param targets and **direct-assigns plain-setter
  props** (`Chorus.depth`, `octaves`). **Delay composite** (enables `dryThru`): FeedbackDelay
  held at `wet: 1` with explicit parallel `dryLvl`/`wetLvl` gains into a summing out —
  `wetLvl = wet`, `dryLvl = dryThru ? 1 : 1−wet` (linear complement — correct for correlated
  dry/wet). The dry-thru toggle is a pure ramped gain move, zero topology change, click-free.
  `makeFx(type, params, bypass)` → live wrapper `{ input, output, setBypass, updateParams,
  dispose }`: input fans to `graph → onGain → output` and `offGain → output`; **bypass is a
  complementary 0.05s gain crossfade** (the `setArpFx` pattern) so the graph stays static and
  toggling never pops. Gains are *initialized* to the bypass state (loaded bypassed effects
  start silent-correct, no ramp). Tone effects keep their **built-in `wet`** as a user param —
  the wrapper adds bypass only, no second dry/wet stage.
- **Live engine (`useWorkstationAudio.js`):** per-track chain is
  `fade → volume → pan → [FX wrappers] → mute → Destination`. Three effects between track-node
  creation (#1) and mute/solo sync (#2), declaration order load-bearing (chain built in the same
  commit as node creation → project-load wiring is free): **1b structural sync** — per-track key
  `effects.map(e => id+':'+type).join('|')`; on change, `pan.disconnect()` (1b is the *only*
  post-creation writer of pan's output), dispose old wrappers, rewire pan→w0…wN→mute; `'' ` key
  fallback means no-FX tracks are never rewired. **1c bypass sync** (delta map → `setBypass`) and
  **1d param sync** (**object-reference compare** — `updateEffectSettings` mints a new params
  object each call → `updateParams`, 0.02s ramps). Wrappers disposed on track removal + unmount
  sweep. *Accepted limitation:* add/remove while playing is a synchronous rewire (possible
  momentary click on that track); bypass — the frequent live action — is click-free.
- **Offline bounce (`audioBounce.js`):** mirrors the chain; non-bypassed effects instantiated
  back-to-front via `makeFxGraph` (`g.out.connect(head); head = g.in`) between pan and mute (no
  crossfade machinery offline; bypassed effects simply not built; Chorus/AutoFilter `.start()`
  runs inside the builder, valid in the Offline context). Default `tailSec` may truncate long
  delay/reverb tails past the last region.
- **CRUD** (`WorkstationShell.jsx`): `addEffect` (params from `defaultParamsFor`) / `removeEffect`
  / `toggleBypassEffect` / `updateEffectSettings` (**merges** partial params — sliders send
  single keys) — immutable nested-map `useCallback`s, so they inherit the **passive undo/redo
  recorder for free** (burst coalescing folds a slider drag into one entry). Effect IDs come from
  `nextEffectIdRef` (`e<N>`), restored on load from `deserializeProject().nextEffectId`.
- **Two synced views of `track.effects`**: compact inspector list (`RegionEditor/EffectsList.jsx`)
  and the effects-tab module grid (`RegionEditor/EffectsRack.jsx` — header `bypass / title / ×`,
  body = registry-driven param rows: sliders with log scaling for filter cutoff / autofilter
  rate (`min·(max/min)^v`) + value readouts, and **`kind: 'toggle'` metadata → pill button**
  (delay `dry thru`); `onUpdate` → `updateEffectSettings`). **Inspector overflow:** `.inspector`
  clips (`min-height: 0; overflow: hidden`); EffectsList's `.field` has `min-height: 0` and
  `.list` is `flex: 0 1 auto; overflow-y: auto` with the 4px mint scrollbar — natural height
  while it fits, shrink-and-scroll when it doesn't, header/instrument pinned above and the
  add-select pinned right below the last row.
- **Persistence** (`projectIO.js`): `effects` (incl. params) serialized/deserialized additively
  with guards (old projects → `[]`). **`SCHEMA_VERSION` is intentionally not bumped** — the
  version check is strict-equality, so a bump would reject every existing `.voxdaw` file; an
  additive defaulted field is backward-compatible.

### CPU: render-graph pruning + performance quality (Phase 141, `useWorkstationAudio.js` / `fxChain.js` / `WorkstationShell.jsx`)
Large projects (17 tracks × multi-FX racks) overloaded both audio and main threads because
mute/solo/bypass were gain-only — every synth voice and FX node (incl. always-running LFOs and
feedback loops) kept processing behind a 0-gain node. The overhaul exploits one Web Audio
property: **the render thread only processes nodes transitively connected to the destination.**

- **Mute/solo:** effect #2 (unchanged single writer of the mute node) ramps to 0 (20ms), then a
  50ms timer disconnects the mute node from Destination — the whole track subtree leaves the
  render set. Becoming audible reconnects while gain is still 0, then ramps up (click-free).
  State in `muteConnByTrackIdRef` (`{connected, timer}`); timers cleared on track removal +
  unmount. Effect #2 also maintains `audibleByTrackIdRef`, which `makePartCallback` reads at
  fire time to skip triggering notes on inaudible tracks — no Part rebuilds on mute/solo; the
  trackId is resolved live through `appliedRegionStateRef` because region drags don't rebuild
  Parts (a captured trackId would go stale). Trade-off: unmuting mid-note waits for the next
  note onset.
- **Activity pruning (lossless — always on, all quality tiers):** an *audible* track with no
  notes sounding is also pruned; without this, 17 audible tracks cost 17 tracks of FX DSP even
  in a section where only 6 play (the "solo sounds fine, full mix cuts out" failure).
  `estimateTrackTailSec(track)` — exported from `useWorkstationAudio.js` and reused by
  `audioBounce.estimateFxTailSec` — bounds a track's ring-out past its last note end (synth
  release incl. `track.envelope`, drum one-shot 6 s floor, non-bypassed delay feedback decay to
  −60 dB, Freeverb `1 + roomSize*9`; clamp [2, 30]); cached per track in `tailByTrackIdRef`.
  Every Part note fire (`noteLifecycleRef.onNoteScheduled` inside `makePartCallback`, invoked
  BEFORE the sampler load guard so an unready-sampler skip still marks the track active) and
  every audition attack/release calls `connectTrack(trackId)` and bumps
  `activeUntilByTrackIdRef` to `noteEnd + tail`. A 1 Hz sweeper (effect 2b, `setInterval` —
  wall-clock so paused/idle projects also fall to near-zero audio CPU) disconnects
  connected+audible tracks past their window, with a `synthIsRinging` guard (PolySynth
  `activeVoices`, Sampler private `_activeSources`) covering audition notes held past the
  analytic window. Reconnect is click-free: an idle-pruned track's mute gain sits at 1, frozen
  FX content is ≤ −60 dB by construction, and Part callbacks fire `lookAhead` (~0.1 s) before
  the audible moment so the reconnect always lands first. `connectTrack` is audibility-gated
  and the sweeper skips inaudible tracks — mute/solo connection state remains effect #2's
  exclusive territory (single-writer preserved).
- **FX bypass:** `makeFx.setBypass(true)` crossfades as before, then a 70ms timer disconnects
  `graph.out` from `onGain` — the effect graph (LFOs included: they feed params of unreachable
  nodes) stops rendering. Un-bypass reconnects before ramping. Wrappers created bypassed start
  pruned. *Accepted limitation:* delay/reverb buffers freeze while pruned; un-bypass can
  briefly replay a stale tail at wet level.
- **Performance quality:** `performanceQuality` (`'high'`|`'medium'`|`'low'`, default high) in
  `WorkstationShell`, rendered as a `QUALITY` select in the transport meta group, persisted to
  localStorage `voxdaw.performanceQuality` (machine capability — never serialized to `.voxdaw`
  or undo history). *medium* = PolySynth `maxPolyphony` 32→12 (quality-sync effect 3d applies
  live; `perfQualityRef` applies at synth build; Samplers have no voice pool) + context
  `lookAhead` 0.1→0.2s for scheduling headroom (lookAhead is context-global — VoxTool gains
  latency while reduced). *low* = medium + force-bypass of `HEAVY_EFFECT_TYPES` (`effectDefs.js`:
  reverb, pitchshift, doubler, autofilter, autowah, phaser, tremolo, vibrato, autopanner —
  everything whose DSP runs continuously with silent input; cheap native-node effects stay on).
  Effective bypass = `e.bypass || (low && heavy)`, computed in effects 1b (creation/seed) and 1c
  (deps `[tracks, performanceQuality]`); `track.effects` is never mutated, so returning to high
  restores the user's own bypass states. EffectsRack mirrors the block: module body grayed/inert
  (`.bodyBlocked`) with an "increase sound quality to enable [effect]" notice; the header row
  (bypass pill, remove ×) stays interactive.
- **Hidden-page visual rAF loops** (Moog FFB + vocoder LED meters, VocoderTerminal spectrum
  canvas) early-return on `offsetParent === null` (Root keeps pages mounted `display:none`).
  The Moog TRANSPOSE CV loop is deliberately NOT gated — it drives the worklet root and must
  keep running while the Moog plays hidden. Offline bounce is untouched (it already skipped
  inaudible tracks and bypassed FX).

### Undo/redo history (Phase 139, `WorkstationShell.jsx`)
Tracks **arrangement data only** (`tracks`/`regions`/`notes` — mute/solo/volume/pan/instrument live on those objects); UI state (zoom/scroll/playhead/selection) is not tracked. A **passive recorder** `useEffect([tracks, regions, notes])` records history *after* React commits, so React 18 batching coalesces a multi-setter action (e.g. split = `setRegions`+`setNotes`) into one entry — **zero changes to the ~46 mutation sites**. **Leading-edge burst coalescing** (push the pre-change snapshot on the first change of a burst, suppress further pushes for ~200ms) folds a drag's mid-flight commits + continuous volume/pan slider commits into one entry. Snapshots store array **references** (state is updated immutably). `undo`/`redo` swap snapshots between `past`/`future`/`latestRef` under a `timeTravelingRef` guard, then `silenceAll()` + `recomputeFades()` (no forced pause); capped at `MAX_HISTORY = 100`. Toolbar ↶/↷ (disabled via `canUndo`/`canRedo`) + Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y, input-guarded. **Gotcha (fixed):** the `setFuture`/`setPast` updater closures must capture the present (`const current = latestRef.current`) *before* `latestRef` is reassigned — reading it inside the updater (which runs later) grabbed the post-mutation value, making the first redo a no-op.

### Sampler load guard (Phase 140, `useWorkstationAudio.js`)
`makePartCallback` guards `if (!synth || synth.disposed || synth.loaded === false) return;` before `triggerAttackRelease` — a `Tone.Sampler` throws "buffer is either not set or not loaded" if triggered before its buffers load (instrument hot-swap / paste while the Transport runs). Strict `=== false` is load-bearing: PolySynths have no `loaded` prop (`undefined`), so they always play. Same guard on the editor's preview-audition (`previewAttack`).

### Pause hard-cut + ghost-note silencing (`useWorkstationAudio.js` + `WorkstationShell.jsx`)
`silenceAll()` calls `.releaseAll()` on every region synth **and** ramps each region's fade gain to 0 over `HARD_CUT_SEC = 0.02` to kill release tails for an instant cut. Single-writer preserved: pause writes 0, `recomputeFades()` restores on resume (temporally exclusive). It is wired into pause/stop/auto-pause/scrub-clutch **and** into `seekToClientX` and the `handlePlayPause` resume branch — so a voice ringing from a prior position can never bleed across a seek or into resume (the "ghost note"). No Part rebuild is needed: Tone.Part's one-shot `transport.schedule` events natively re-fire at/after the playhead on a backward seek and skip forward, so only voice silencing was missing.

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
| `tracks` (state) | `[{ id, name, instrument, color, isMuted, isSolo, volume, pan, effects, envelope }]` — `color` is a hex string from `TRACK_COLORS`; `effects` is the per-track insert-effect rack (see *Effects rack* below); `envelope` is the optional per-track ADSR override (see §16 *Per-track ADSR override*) |
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
### BPM Editing
The transport bar BPM display is click-to-edit: clicking the value renders an `<input type="number">` in-place (same CSS as the static span — transparent bg, no spinners). `handleBpmCommit` validates, clamps (20–300), and calls `setBpm(n)` ONLY — **no direct `Transport.bpm` write**: the hook's tempo-sync effect fires on the commit and `recomputeTempo` (the bpm signal's single writer, see *Global tempo automation*) re-anchors the curve. Tone's source of truth is ticks, so a bpm change preserves musical position automatically (the playhead rAF loop is tick-driven). `pxPerSec` no longer exists — seek and paste-advance set `Transport.ticks` directly (`x / pixelsPerMeasure → measures → ticks`), exact at any tempo.

### Global tempo automation (Phase 144, `tempoMath.js` / `WorkstationShell.jsx` / `useWorkstationAudio.js` / `audioBounce.js`)
A permanent "global" strip (24px, chevron-expandable to a 72px lane) sits above the track rows in BOTH the sticky header column and the timeline; the lane is a normal `AutomationLane` with `TEMPO_META` (40–240 bpm). State: shell `globalAutomations = [{ id:'a<n>', target:{kind:'tempo'}, points }]` — PROJECT DATA (undo snapshots + additive `.voxdaw` field sharing the `a<n>` namespace); lane visibility is UI-only. Pure `tempoMath.js` owns the math: `buildTempoMap(baseBpm, points)` → `{ anchors, bpmAtMeasure, secondsAtMeasure, measureAtSeconds }`. Anchor spacing uses the exact trapezoid TickSignal integrates for linear bpm ramps (**Δt = 240·Δm / avgBpm** — PPQ cancels), so Transport ticks and the map agree exactly at every anchor; mid-ramp bpm follows `b² = b0² + (b1²−b0²)·(m−m0)/Δm` (ramps are linear-in-seconds; the lane's straight line is a hair idealized between anchors). Empty points → constant-bpm identity map, so consumers never branch on null. Unit-tested (`tempoMath.test.js`).

**Single-writer:** `recomputeTempo` in the hook is the ONLY writer of `Transport.bpm` (the old shell writers in handlePlayPause/handleBpmCommit/applyProjectData are gone). It rebuilds `tempoMapRef` and re-schedules the curve from the current tick position, and runs FIRST inside `recomputeFades` — so fades and `recomputeAutomation` (which consume the map) and all 7 existing re-anchor call sites cover tempo for free; a delta-keyed tempo-sync effect (1f) covers lane/bpm edits. **Everything that converts measures↔seconds goes through the map:** fade envelope durations resolve at FIRE time inside the `Transport.schedule` callback (this killed the old "BPM change mid-region desyncs fades" caveat; `computeFadeKey` has no bpm component), track-automation ramp anchors, note durations in live+offline Part callbacks (event `"<ticks>i"` spans → map seconds), bounce duration/capSec/firstOnsetSec, and both 30 Hz stepped drivers read `transport.ticks/(PPQ·4)`. Offline bounce schedules the same anchor ramps on the offline transport (starts at 0 ⇒ map seconds = context seconds). **Unmount hazard handled:** `Transport.cancel(0)` does NOT clear bpm-signal automation and the Transport is shared with VoxTool's transport-clocked arp — cleanup cancels the bpm schedule and restores the flat base value. Live readout: when the lane has points, the rAF loop writes `∿<bpm>` to a span beside the base BPM (zero re-render).

### Track groups (Phase 145, `GroupModal.jsx` / `GroupFxPanel.jsx` / `WorkstationShell.jsx` / `useWorkstationAudio.js` / `audioBounce.js` / `automationMath.js` / `projectIO.js`)
Flat groups (no nesting): shell `groups = [{ id:'g<n>', name, color, isMuted, isSolo, volume, pan, effects, automations }]` + `track.groupId`; members are **contiguous** in the tracks array (createGroup splices at the first member's position; deserialize normalizes) — the render emits ONE header row per run. Collapse state is a UI-only Set. Creation via track right-click → `GroupModal` (initiator pre-checked but un-lockable; already-grouped tracks grayed; "select more tracks" until ≥2). Group header row (GROUP_H = 48px, both sides — inert strip on the timeline): chevron, click-to-edit name, PanKnob, volume, mutually-exclusive M/S, heartbeat (group automation lanes reuse `openAutomationTrackIds` — disjoint id namespaces), `fx` (bottom-docked `GroupFxPanel` hosting the channel-agnostic `EffectsRack` in the RegionEditor's slot — mutually exclusive with it), context menu (Rename / Color / Ungroup / Delete Group + Tracks, confirm + undoable).

**Geometry:** `computeLaneTops(tracks, openSet, topOffset, groupView)` emits GROUP_H (+ the group's open automation area) before each run's first member; collapsed members contribute **zero height** → naturally unreachable by `yToTrackIndex`; region drags guard clamp/companion arithmetic against hidden tracks; marquee row height comes from the cumulative table (`min(TRACK_H, tops[i+1]−tops[i])`).

**Audio:** per-group chain `memberMutes → groupIn(Gain) → groupVolume → groupPan → [group FX] → groupMute → Destination`. Effect #0g (before #1) reconciles bus nodes; effect #1a re-parents CONNECTED track mutes on membership change (disconnected ones pick the target up from `connectTrack`'s `outputForTrack`); FX effects 1b/1c/1d run a `syncFamily` pass per channel family (`e<n>` ids span both, so per-effect delta maps need no re-keying); automation resolution/release-restore/live-preview UNION the track+group node maps (`t<n>`/`g<n>` disjoint); effect #3e syncs group volume/pan under the automation-takes-over contract. **Audibility rule (group mute + solo):** `anySoloed` spans tracks AND groups; track audible = `!t.isMuted && !group.isMuted && (!anySoloed || t.isSolo || group.isSolo)`; group bus audible = `!g.isMuted && (!anySoloed || g.isSolo || any member soloed)` — `audibleByTrackIdRef` stores the EFFECTIVE value, so the fire-time note skip and `connectTrack` gate are group-blind. **Pruning:** buses get the same ramp→delayed-disconnect as tracks, and the 1 Hz sweeper prunes a bus once no member is connected past max(member windows) + `estimateGroupTailSec` (FX-only bound; shared `fxTailSec` extraction); `connectTrack` revives the bus before its own early-return. **Bounce:** offline group chains mirror live behind one shared `computeAudibility`; `estimateFxTailSec` SUMS member tail + bus tail (serial rings add); per-track stem export neutralizes group mute/solo (a muted parent must not silence the stem; the stem still prints through the group FX). **Persistence:** additive `groups` + `track.groupId`, dangling-id/empty-group repair, `nextGroupId`, e<n>/a<n> scans include group arrays; groups are inside undo snapshots (Delete Group is undoable). `deleteTrack` GCs a group whose last member dies.

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

### Loop phase (`loopPhase`) — boundary-aware three-piece split
Looped regions carry `loopPhase` (measures into the home cycle at the region's left edge, default `0`). Note occurrences unroll at `regionStart + ((homeLocalMeasures − loopPhase) mod li) + j·li`. At phase `0` this reduces to the original `i·baseLoop` unroll, so all pre-existing regions are unchanged. The math lives in **`src/components/Workstation/loopMath.js`** (`firstLoopOffsetMeasures`, `loopBoundaries`) — the single source of truth shared by the audio unroll (`buildRegionEvents`), the arrangement loop visuals (segments/dividers/tint/mini-notes), and the piano-roll note ghosts. Persisted in `projectIO`; in `computePartKey`.

**Split Region** (`splitRegionAtMeasure`) on a looped region produces a **boundary-aware three-piece split** (Phase 135) — the right side is split at *both* the playhead and the next loop boundary so no second-class phased region is ever minted:
- **L** (reuses `r.id`, keeps the originals) — original truncated at the playhead; keeps looping with a partial tail.
- **M** (new id, cloned notes) — the **non-looping** severed remainder of the in-progress cycle, from the playhead to the next boundary (`clipOffset = co + homeLocalRel` windows the bottle onto home-local `[homeLocalRel, li)`).
- **R** (new id, cloned notes) — a fresh, **clean phase-0 loop** starting at the next boundary (`clipOffset = co`, full home block, working `loop-resize-base` handle).

Edge cases collapse cleanly: split **on** a boundary → 2-piece L + R (clean); split in the **last partial iteration** (no full cycle after) → 2-piece L + M; non-looped region → existing Case-D 2-piece (bottle slides forward). Because R is always phase `0`, **new splits never create `loopPhase !== 0`** — the phase machinery is retained only so old `.voxdaw` projects containing phased regions (minted by the pre-Phase-135 model) still load and play correctly. **Limitation:** the `loop-resize-base` drag handle is still hidden on any pre-existing phased region (`loopPhase !== 0`).

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

**Vertical grid lines — `drawGrid(canvas, {...})`** (Phases 137-138-141, exported from `WorkstationShell.jsx`, shared with `RegionEditor`): the arrangement and piano-roll **vertical** lines (down-beat / quarter-beat / off-beat-eighth tiers) are drawn on a `<canvas>` pinned to each scroll viewport via a zero-size `position: sticky` holder, redrawn on scroll/zoom/resize/theme. `pixelsPerMeasure` stays a continuous float (smooth zoom, regions never jump) and **each line is snapped to a whole pixel** at draw time (`Math.round(leftInset + idx·floatPpm − scrollLeft)`), so lines stay crisp at any zoom without drifting off the float-positioned regions — the one thing a uniform `repeating-linear-gradient` can't do (it forced the earlier `computeGridBg` to round the shared unit, which caused a zoom-jump). DPR-scaled for retina; colours read from CSS vars at draw time (theme-aware); `getMeasureInterval(ppm)` drives the macro-zoom tier/label step. Piano-roll uses `leftInset = 56` (sticky keys column).

**Zoom anchor** (Phase 141): the Ctrl/pinch wheel handlers compute the zoom-to-cursor scroll target chained through refs (`liveZoomRef` for zoom, `pendingScrollRef ?? el.scrollLeft` for the base scroll) so the anchor is independent of React's commit timing — fixes the fast-zoom "jump" that grew with distance + render load. The `useLayoutEffect([zoomLevel])` applies the (correctly-chained) `pendingScrollRef` after the width commits.

Horizontal rows + shading stay CSS on the piano-roll `.grid` / `.gridShading` overlay:
- Octave lines — `var(--border-mid)` every 216px (12 × 18px)
- Semitone rows — `var(--border-subtle)` every 18px
- **Accidental-row shading** — `var(--pr-shade-accidental)` (5 black-key rows per octave)
- **Natural-row shading** — `var(--pr-shade-natural)` (7 white-key rows per octave)

Theme-aware shading inverts direction per theme:
- **Dark theme:** `--pr-shade-natural = rgba(255,255,255,0.04)` (brighten naturals), `--pr-shade-accidental = transparent`
- **Light theme:** `--pr-shade-natural = transparent`, `--pr-shade-accidental = rgba(0,0,0,0.06)` (darken accidentals)

Both achieve the same visual semantic ("accidentals look darker than naturals") via opposite mechanics fitted to each theme's contrast budget.

**Grid alignment gotcha:** explicit `minHeight: KEYS.length * KEY_H` (= 1296px) is set on both keys column and grid via inline style. `align-items: stretch` inside an `overflow: auto` flex container is bounded by the visible cross-size, not the line's natural maximum — so flex stretch alone leaves the grid background blank below the viewport on scroll. The explicit pixel min-height is the reliable fix.

---

## 16. Workstation Instrument Library

The Workstation supports two instrument families, both routed through `makeSynth(name, opts)` in `src/components/Workstation/synthFactory.js`:

### Synth voices (`SYNTH_INSTRUMENTS`)
9 oscillator-based `Tone.PolySynth` configs: `fm pluck`, `analog`, `strings`, `am`, `pluck`, `sine`, `square`, `sawtooth`, `triangle`. Construction is synchronous, zero load cost.

### Sampled voices (`SAMPLED_INSTRUMENT_NAMES`)
20 `Tone.Sampler`-backed instruments from the [nbrosowsky/tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) library: `bass-electric`, `bassoon`, `cello`, `clarinet`, `contrabass`, `flute`, `french-horn`, `guitar-acoustic`, `guitar-electric`, `guitar-nylon`, `harmonium`, `harp`, `organ`, `piano`, `saxophone`, `trombone`, `trumpet`, `tuba`, `violin`, `xylophone`.

- **Sample files** are vendored at `public/samples/<instrument>/<pitch>.mp3` (~82MB total, mp3-only — `.ogg`/`.wav` from the upstream repo are not vendored).
- **URL maps** live in `src/components/Workstation/sampleInstruments.js` as pure data (`{ baseUrl, urls, release }` per instrument) — no Tone.js imports, safe to import anywhere.
- **`makeSynth(name, { onLoad })`** creates `new Tone.Sampler({ urls, baseUrl, release, onload })`. The optional `onLoad` callback fires once buffers are decoded.

### Loading lifecycle
Per-region synths are created lazily in `useWorkstationAudio.js`. For sampled instruments:
1. `loadingRegionsRef` (Map<regionId, trackId>) marks the region as pending on construction.
2. The sampler's `onload` callback removes the region from the map and recomputes `loadingTrackIds` React state.
3. The shell reads `loadingTrackIds` to render a ` …` suffix on the affected track's instrument label.

**Buffer cache amortization:** Tone's internal `ToneAudioBuffer` cache is keyed by URL and shared across all `Sampler` instances in the same `AudioContext`. The first region using `piano` downloads the .mp3 set; every subsequent `Sampler` constructed with the same URL map resolves `onload` essentially instantly. No app-level sampler cache is needed — sharing samplers across regions would break the per-region `fadeGain` envelope architecture.

### Piano-roll previews (`RegionEditor.jsx`)
All piano-roll preview sounds (side-key click/glissando, grid note placement, note grab) go through the hook's **audition API** (`auditionAttack/auditionReleaseAll` from `useWorkstationAudio`) — the same per-track synth the Instrument tab uses, connected at the track's `volume` node so previews ride `volume → pan → FX → mute` and carry the per-track envelope override. Drum choke, one-shot skip-release, and the unloaded-sampler guard all live inside the API, so RegionEditor's helpers are one-liners. A priming effect (`auditionPrime(track.id)` on `[track?.id, track?.instrument]`) starts sampled-instrument buffer downloads on editor open so the first click doesn't dead-click (replaces the old module-level Destination-routed `previewSynthCache`, which is removed). **Live drag pitch preview:** during a note drag (`mode === 'move'` only), when the anchor note's computed pitch crosses a key row, `onMove` releases the previous pitch and attacks the new one — the pitch-change comparison (`dD.lastAuditionedNote`, seeded at mousedown) is the throttle, firing once per row crossing rather than per mousemove.

### Offline render (`audioBounce.js`)
`Tone.Offline` creates a separate `AudioContext`, so realtime-context buffers cannot be reused. The bounce callback is `async` and `await Tone.loaded()` before `transport.start()` — this awaits all `Tone.Sampler` decoders created inside the callback, including the offline context's own buffer set. Without this await, sampled instruments could render silent on the first export of a session.

### RegionEditor dropdown UX
The instrument `<select>` uses `<optgroup label="synth">` / `<optgroup label="sampled">` to keep the 29-item list scannable.

### Per-track ADSR override (`track.envelope`)
Each track carries an optional `envelope` (`{ attack, decay, sustain, release }`); absent = the instrument default. `synthFactory.js` is the single source of truth: a `SYNTH_ENVELOPES` lookup feeds both `makeSynth` and `defaultEnvelopeFor(instrument)` (drum kits → `null`; sampled melodic → `{ attack, release }` only, since `Tone.Sampler` exposes no decay/sustain). `applyEnvelope(synth, env)` handles both node kinds (`Tone.PolySynth.set({ envelope })` vs. `Tone.Sampler.attack`/`.release`), and `makeSynth(instrument, { envelope })` applies it at build.

The override is applied at **every synth build** — region synths and the audition synth in `useWorkstationAudio.js`, plus the offline render in `audioBounce.js` — and kept live by **envelope-sync effect 3c** (`appliedEnvByTrackIdRef`, object-reference compare mirroring the FX-param sync): when `track.envelope` changes it `applyEnvelope`s the audition synth *and* every region synth on that track with no synth rebuild. `WorkstationShell.handleEnvelopeChange` merges partial knob edits (seeded from `defaultEnvelopeFor` on first touch, so a drag folds into one undo entry via the burst-coalescer); `handleInstrumentChange` clears the override so the chassis knobs snap to the new instrument's defaults. Persistence is additive in `projectIO.js` (`deserializeEnvelope`) — **`SCHEMA_VERSION` is intentionally not bumped**, so pre-existing `.voxdaw` files still load.

---

## 17. Moog Modular Synthesizer (`src/components/MoogModular/`)

### Component tree
```
MoogShell.jsx          — cabinet, rack tiers, all module components, lights-out toggle
├── useMoogAudio.js    — all audio DSP: nodes, jack map, loops, callbacks
├── MoogKnob.jsx       — silver hardware knob (drag vertical, shift=fine, dblclick=reset)
├── Led.jsx            — zero-re-render rAF opacity LED (green/yellow/red/blue)
├── KeyboardModule.jsx — 61-key CV keyboard + MIDI + glide + vibrato controls
├── Oscilloscope.jsx   — CRT phosphor waveform display
├── PatchCableOverlay  — SVG cable layer (z-index:50, position:absolute inset:0)
└── MoogPatchContext   — jack registry + drag state for cable patching
```

### GlideBus Architecture (per-VCO pitch routing)
Each VCO has `vcoNGlideBus: Tone.Signal(185)` as the **sole pitch writer** to `vco.frequency`. `vco.frequency` is initialized to 0; the glideBus + FM gain nodes add additively. This architecture lets glide and vibrato coexist without scheduling conflicts:

```
glideBus → vco.frequency   (always connected, sole pitch source)
vcoNfm   → vco.frequency   (additive FM modulation, unchanged)
```

**MANAGED vs pass-through sources:** CV sources (seq, kbd, qnt, chord seq outputs) are MANAGED — no audio cable to glideBus; instead the Tone.Loop/rAF/onmessage callbacks write `glideBus._param.setValueAtTime(hz, time)` directly. Pass-through sources audio-connect to the glideBus (transparent at offset=0).

`vcoActiveCvRef` (`{ vco1..vco5: sourceJackId|null }`) tracks which source is driving each VCO cv-in. Written by `connect()`/`disconnect()`, read by all loop callbacks and the keyboard rAF.

### Keyboard Pitch + Glide + Vibrato (rAF-based)
A single `vibratoTick` rAF loop handles all three simultaneously for kbd-connected VCOs — no Tone.js `rampTo` scheduling (which `setValueAtTime` would cancel):

```
kbdBaseHzRef   — target Hz from last key press (updateKeyboard sets this)
kbdCurrentHzRef — smoothly-lerped Hz: += (1 - exp(-dt/glide)) * (target - current)
kbdLastOutputHzRef — actual last-written Hz including swing; seeds kbdCurrentHz on note-on
kbdNoteOnsetRef — AudioContext time of last note-on (null = none yet)
kbdVibratoResetRef — flag consumed by rAF with its own `now` (ensures elapsed=0 exactly)
```

Output: `hz = max(1, kbdCurrentHz + effectiveDepth * sin(2π * rate * now))`

Vibrato delay: `effectiveDepth = depth * min(1, max(0, elapsed / delayTime))` — ramps from 0 to full depth over delayTime seconds after note-on. Seeding `kbdCurrentHzRef` from `kbdLastOutputHzRef` on note-on eliminates discontinuities (glide starts from the true current pitch including any active vibrato swing).

### Per-VCO Bus + Hard Sync
```
vco.oscillator → vcoNnormalGain(1) ─┐
                                      ├─ vcoNbus → vcoNMeter, jacks
AudioWorkletNode(slave) → vcoNsyncOut(0) ─┘
```
`setVcoNSyncEnabled(bool)` crossfades normalGain ↔ syncOut over 10ms. Hard sync: 5 `AudioWorkletNode` instances (`hard-sync-processor`) created from one `addModule` call — each wired `vcoNsyncIn → worklet → vcoNsyncOut`. `vcoNfm` drives `worklet.parameters.get('slaveFreq')` for FM-through-sync.

### Sequencer Gate Logic
Gate-off steps write `0` to `glideBus._param` and `seqGateNode.gain._param` (native AudioParam, bypasses Tone scheduling) for VCOs connected to that sequencer's pitch output only. `seqMasterGate` is never written from loops — it was the source of cross-sequencer interference. Each sequencer is fully independent via `vcoActiveCvRef`.

Stochastic probability: `fires = step.gate && Math.random() < step.prob`. Probability sliders use `transform:rotate(-90deg)` on `<input type="range">` (cross-browser reliable, unlike `writing-mode`).

### Chord Sequencer Polyphonic Outputs
`chordseq-root-out`, `chordseq-3rd-out`, `chordseq-5th-out` output the 1st/3rd/5th chord tones per step using `CHORD_VOICE_INTERVALS` (padded to 4 tones, shared across chord types). All are MANAGED sources — loop drives connected glideBuses directly with instant `setValueAtTime`.

### 914 Fixed Filter Bank (FFBModule)
14 bands in parallel: LP (100 Hz) + 12 bandpass at √2 intervals (125–5600 Hz) + HP (8 kHz). Architecture: `ffbIn` fans to 14 `{Tone.Filter → Tone.Gain}` pairs, all summing into `ffbSum → ffbMaster`. Band gain knobs (0–1 → amplitude), MSTR knob (0→1.5×). Activity LEDs driven by `ffbAnalyser` (FFT 512) rAF: half-octave bin range per band, dB → opacity. `FFB_BANDS` exported constant shared between `useMoogAudio.js` and `MoogShell.jsx`.

### Kick Drum (KickModule)
`Tone.MembraneSynth` (TUNE/P.ENV/DECAY) + `Tone.NoiseSynth → highpass 2kHz → clickGain` (CLICK) in parallel into `kickOut`. `kick-gate-in` jack: `{ isGate: true, isKick: true }` — both sequencer loops detect `action.isKick` and call `kickSynth.triggerAttackRelease(tune, decay, time)` sample-accurately. `kickTrigCbRef` registered by KickModule so the LED flashes in sync with the audio callback. `kick-click-in` CV jack modulates `kickClickGain.gain` for accent.

### Lights-Out Mode
`data-lights-out="true"` on `.cabinet`. CSS attribute selectors (`cabinet[data-lights-out="true"] .class`) hide faceplates, knobs, text, jacks, cables (`PatchCableOverlay opacity:0`), keyboard (`opacity:0`). Visible: LEDs (Led.jsx rAF-driven opacity), power lamp (`.powerLampOn`), sequencer step LEDs (`.seqLedActive`), gate-on buttons (`.seqGateOn`), oscilloscope, hard sync blue LEDs (in `.vcoSyncLed`, sibling of `.selectorRow` so lights-out `selectorRow { opacity:0 }` can't cascade to it).

