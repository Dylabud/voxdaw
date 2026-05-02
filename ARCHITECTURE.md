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
[analogVoices × 4]  ─┐
[stringsVoices × 4] ─┤→ ArpVol → Filter → Vibrato → Reverb → Volume → Destination
[arpVoice × 1]      ─┘   (arp has dedicated Tone.Volume before the filter)
```

All voice sets connect to the same `filter` node input; Tone.js sums them. The active instrument set is tracked by `activeVoicesRef`; the inactive set is muted to `VOICE_MUTE = −80 dB`. The arp voice has a dedicated `Tone.Volume` (`arpVolRef`) before the filter so its gain is independent of the pinch-velocity volume on the main chain.

### Key refs in `useAudioEngine`

| Ref | Purpose |
|-----|---------|
| `analogVoicesRef` | 4× `Tone.Synth` — [root, 3rd, 5th, 7th] |
| `stringsVoicesRef` | 4× `Tone.FMSynth` — [root, 3rd, 5th, 7th] |
| `activeVoicesRef` | Points to whichever voice set is currently audible |
| `arpPatternRef` | `Tone.Pattern` — always created in `startAudio`, muted when arp off |
| `currentRootRef` | Last computed root frequency in Hz — consumed by the arp |
| `scaleRef` | `Float32Array` of sorted Hz values for `snapToNearest()` binary search |
| `globalOctaveRef` | Integer −2 to +2; applied via `.transpose(n * 12)` to raw pitch |
| `arpOctaveShiftRef` | Boolean; adds 12 semitones to `effectiveArpRoot` |
| `filterRef / vibratoRef / reverbRef / volumeRef / arpVolRef` | Shared effects chain nodes |
| `sendMidiRef` | Shadow ref of `sendMidi` from `useMidi` — safe to call inside rAF |
| `chordMidiRef` | `Set<number>` — MIDI notes active last frame, used for diff-based noteon/noteoff |
| `arpMidiTimers` | `number[]` — pending `setTimeout` IDs for arp noteoff scheduling |

### Arp pattern delta-check

Four refs (`appliedArpModeRef`, `appliedArpRateRef`, `appliedArpRootRef`, `appliedArpThirdRef`) track the last values written to `arpPatternRef`. The pattern is only rebuilt when one of these changes, preventing `Tone.Pattern` from restarting its step counter every frame. All four reset to `null` in `stopAudio`.

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
`position: absolute; left: 0; top: 0; height: 100vh; width: 200px; z-index: 10`. Four labeled sections: **Master Engine** (tempo, octave, scale), **Synth Voice** (instrument, oscillator), **Arpeggiator** (arp +1 oct toggle), **Output** (MIDI toggle, conditional record). Collapses via `transform: translateX(-100%); opacity: 0` with 0.3s ease. Controlled by `showControls` state in `App.js`.

### Toggle buttons
Two `position: absolute; z-index: 50` buttons in `App.js` (`.leftToggleBtn` at `top: 16px; left: 16px`, `.rightToggleBtn` at `top: 16px; right: 16px`). Placed outside the panels so they are never affected by the panels' `opacity: 0` collapse state.

### Viewport
`width: 65vw; max-width: 1000px; aspect-ratio: 16/9`. Hosts the mirrored `<video>` feed, the MediaPipe skeleton `<canvas>` overlay, the PianoRoll overlay, and the LoopProgress bar. Both video and canvas use `transform: scaleX(-1)` to mirror for natural interaction.

---

## 7. Layout Architecture

```
.app  (position: relative; display: flex; justify-content: center; align-items: center)
  ├── Controls         (position: absolute; left: 0)    ← floats left, out of flow
  ├── .stage           (flex column; z-index: 1)        ← permanently centered by flex
  │     ├── Viewport
  │     └── Engage/Disengage button
  ├── TelemetryHUD     (position: absolute; right: 24px) ← floats right, out of flow
  ├── .leftToggleBtn   (position: absolute; z-index: 50)
  └── .rightToggleBtn  (position: absolute; z-index: 50)
```

Because both panels are out of normal flow, toggling them does not cause the central `.stage` to shift — it stays centered by flexbox at all times.

---

## 8. Loop Station

`useLoopStation(volumeRef)` taps a `Tone.Recorder` after `volumeRef`. Records 8 s (4 bars @ 120 BPM), decodes via `rawContext.decodeAudioData`, then plays back through a `Tone.Player(loop:true)` directly to `Destination` — bypassing the effects chain. Does not use `Tone.Transport`.

---

## 9. MIDI Output

`useMidi` hook owns the WebSocket lifecycle. `sendMidi(type, note, velocity)` is a stable `useCallback` over refs — safe to call inside rAF/Tone callbacks. Chord MIDI uses a per-frame `Set<number>` diff to send only changed noteon/noteoff events. Arp MIDI schedules noteoff via `setTimeout(holdMs)` where `holdMs = Tone.Transport.toSeconds(HOLD_MAP[rate]) * 1000`. `panicAllNotes()` bypasses the enabled-check and fires noteoff for all active notes — called first in `handleDisengage`.

---

## 10. MediaPipe Landmark Index Quick Reference

| Index | Landmark |
|-------|----------|
| 0 | Wrist |
| 4 | Thumb Tip |
| 5, 9, 13, 17 | Index / Middle / Ring / Pinky MCP |
| 6, 10, 14, 18 | Index / Middle / Ring / Pinky PIP |
| 8, 12, 16, 20 | Index / Middle / Ring / Pinky Tip |
| 9 | Middle MCP — also used as hand-size reference point |
