# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# VoxDaw - System Instructions & Coding Standards

## Session Initialization Protocol
**CRITICAL:** At the start of every new chat session, before writing any code or proposing solutions, you MUST read the following files in their entirety to establish context:
1. `CLAUDE.md` (System instructions and boundaries)
2. `ARCHITECTURE.md` (Technical stack and data flow)
3. `PLAN.md` (Current project state and immediate next steps)

---

## Commands

```bash
npm start       # Dev server (CRA, port 3000)
npm run build   # Production build
npm test        # Jest + React Testing Library (watch mode)
```

No linter config beyond CRA defaults (`eslint-config-react-app`). Source maps suppressed via `GENERATE_SOURCEMAP=false` in `.env` to silence a known MediaPipe upstream warning.

---

## Architecture

### Data Flow (per animation frame)
```
getUserMedia → <video> → MediaPipe HandLandmarker.detectForVideo()
  → result.landmarks[]  (21 × {x,y,z} normalized 0–1, Y-down)
  → result.handednesses[]
  → updateParams(landmarks, handednesses)   ← called inside rAF tick
      ├─ Right hand (MediaPipe "Left") → pitch / chord / filter / volume / arp
      └─ Left hand  (MediaPipe "Right") → reverb wet / vibrato depth
```

**MediaPipe handedness inversion:** The display canvas is CSS-mirrored (`scaleX(-1)`), but MediaPipe reads the raw un-mirrored frame. The user's physical right hand appears on the left side of the raw frame, so MediaPipe labels it `"Left"`. In `updateParams`, `label === 'Left'` is the pitch/chord/arp hand.

### Zero-Re-render Rule
`updateParams` runs inside a `requestAnimationFrame` loop. **No React state is ever written inside this function.** All live parameter updates go directly to:
- Tone.js audio node params via `.rampTo()` (50ms ramp prevents zipper noise)
- DOM elements via `.textContent` using refs collected in the `hudRefs` object
- Imperative component handles (e.g., `pianoRollRef.current.setNotes()`)

### Audio Graph
```
[analogVoices × 4]  ─┐
[stringsVoices × 4] ─┤→ Filter → Vibrato → Reverb → Volume → Destination
[arpVoice × 1]      ─┘   (lowpass −24 dB/oct)
```
All voice sets connect to the same `filter` node input; Tone.js sums them automatically. The active instrument set is tracked by `activeVoicesRef`; the inactive set is muted to `VOICE_MUTE = −80 dB`. The arp voice has a dedicated `Tone.Volume` before the filter so its gain is independent of the pinch-velocity volume on the main chain.

### Key Refs in `useAudioEngine`
| Ref | Purpose |
|-----|---------|
| `analogVoicesRef` | 4× `Tone.Synth` — [root, 3rd, 5th, 7th] |
| `stringsVoicesRef` | 4× `Tone.FMSynth` — [root, 3rd, 5th, 7th] |
| `activeVoicesRef` | Points to whichever voice set is currently audible |
| `currentRootRef` | Last computed root frequency in Hz — consumed by the arp |
| `scaleRef` | `Float32Array` of sorted Hz values for `snapToNearest()` binary search |
| `filterRef / vibratoRef / reverbRef / volumeRef` | Shared effects chain nodes |

### `dsp.js` Utility Reference
| Function | Notes |
|----------|-------|
| `calculateDistance2D(p1, p2)` | XY Euclidean on normalized landmarks |
| `calculateDistance(p1, p2)` | XYZ Euclidean |
| `mapRange(v, inMin, inMax, outMin, outMax)` | Clamped linear map |
| `isFingerExtended(hand, tipIdx, pipIdx)` | Y-comparison — reliable only on non-rotated hands |
| `snapToNearest(hz, sortedFloat32Array)` | O(log n) binary search for scale quantization |
| `normalizeNote(note)` | Tone.js flat names → sharp names (for PianoRoll key lookup) |

### PianoRoll Component
`PianoRoll` is a `forwardRef` component exposing two imperative methods:
- `ref.current.setNotes(noteNames[])` — diff-based class toggling via an internal `Set`; frames with no chord change produce zero DOM writes.
- `ref.current.flashNote(noteName, durationMs)` — adds a `.flash` CSS animation (gold inset `box-shadow`) to a single key for `durationMs` ms. `flashTimersRef` (Map) allows rapid re-fires on the same key to cancel the previous timer and restart the animation cleanly via forced reflow (`void el.offsetWidth`). Called directly from the `Tone.Pattern` callback (not via `Tone.Draw`) — the Pattern callback runs in the main thread and DOM calls are safe there.

**Arp pattern delta-check:** Three refs — `appliedArpModeRef`, `appliedArpRateRef`, `appliedArpRootRef` — track the last values written to `arpPatternRef`. `pat.values / .pattern / .interval` are only reassigned when one of these changes, preventing Tone.Pattern from restarting its step counter every frame. All three are reset to `null` in `stopAudio` so re-engage always seeds the fresh pattern.

### Loop Station
`useLoopStation(volumeRef)` taps a `Tone.Recorder` after `volumeRef`. Records 8 s (4 bars @ 120 BPM), decodes via `rawContext.decodeAudioData`, then plays back through a `Tone.Player(loop:true)` directly to `Destination` — bypassing the effects chain. Does **not** use `Tone.Transport`.

### MediaPipe Landmark Index Quick Reference
| Index | Landmark |
|-------|----------|
| 0 | Wrist |
| 4 | Thumb Tip |
| 5, 9, 13, 17 | Index / Middle / Ring / Pinky MCP |
| 6, 10, 14, 18 | Index / Middle / Ring / Pinky PIP |
| 8, 12, 16, 20 | Index / Middle / Ring / Pinky Tip |
| 9 | Middle MCP — also used as hand-size reference point |

---

## The Team & Roles
* **User (Dylan):** Project Owner and Lead Developer. Ensure explanations are clear and educational.
* **You (Claude):** Senior Executive Software Engineer. Write production-ready, highly efficient, mathematically correct code. Prioritize performance and low latency above all else.
* **Gemini:** Technical Project Manager & Systems Architect. Defines high-level strategy, maintains the project roadmap, and drafts foundational documentation before handing precise execution blueprints to Claude.

---

## Documentation Maintenance
* Do not make sweeping architectural changes without first proposing an update to `ARCHITECTURE.md` and getting Dylan's approval.
* When a task is completed, move it from "Future Steps" to the "Completed Steps Log" in `PLAN.md` with the date and brief technical details.

---

## Core Directives & Standards

1. **Zero-Latency Tolerance:** Use `requestAnimationFrame` for visual updates and Tone.js ramp methods for audio. Never block the rAF loop.
2. **Mathematical Precision:** All DSP and gesture-mapping calculations must be mathematically sound. Avoid unoptimized loops in the render cycle.
3. **Strict Aesthetic — Option A (Deep Space & Mint):** Background `#0e0e10`, Accent `#5DCAA5`. All UI must feel like a high-end professional audio tool.
4. **Code Quality:** Small, modular components. Optimize state to prevent unnecessary re-renders. The rAF loop must touch zero React state.
5. **Communication:** Briefly explain *why* a solution is the most efficient/correct approach before providing code.
