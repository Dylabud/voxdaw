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
      ├─ Right hand (MediaPipe "Left") → pitch / chord / velocity / arp
      └─ Left hand  (MediaPipe "Right") → arp vol / wrist tilt / finger combos
```

Continuous signal routing (filter cutoff, reverb wet, vibrato depth, volume, arp volume) is fully user-configurable via `mappingsRef` — see `src/utils/gestureMappings.js`. Discrete gesture triggers (chord type, arp mode, arp rate) are routed via `triggerMappingsRef`. Both refs are synced inline in `App.js` each render so the rAF loop always reads current values without touching React state.

**MediaPipe handedness inversion:** The display canvas is CSS-mirrored (`scaleX(-1)`), but MediaPipe reads the raw un-mirrored frame. The user's physical right hand appears on the left side of the raw frame, so MediaPipe labels it `"Left"`. In `updateParams`, `label === 'Left'` is the pitch/chord/arp hand.

### Zero-Re-render Rule
`updateParams` runs inside a `requestAnimationFrame` loop. **No React state is ever written inside this function.** All live parameter updates go directly to:
- Tone.js audio node params via `.rampTo()` (50ms ramp prevents zipper noise)
- DOM elements via `.textContent` using refs collected in the `hudRefs` object
- Imperative component handles (e.g., `pianoRollRef.current.setNotes()`)

The same rule applies to `useVocoder` and `useAutotune` rAF loops — their detection/visualizer loops also write only to canvas APIs and DOM refs.

### Audio Graph
```
[analogVoices × 6]  ─┐
[stringsVoices × 6] ─┤→ Filter → Vibrato → Reverb → Volume → Destination
                      │  (lowpass −24 dB/oct)
[arpVoice × 1] → arpVol → arpBaseVol → arpDelay → arpReverb ─┬─ arpBypassGain → Destination
                                                               └─ arpFxGain    → Filter (above)

[Tone.UserMedia mic] → AnalyserNode (tap) → Tone.PitchShift → Destination  ← useAutotune (independent path)

[mic getUserMedia] → 16-band vocoder → Destination  ← useVocoder (own AudioContext)
```

- Active chord instrument tracked by `activeVoicesRef`; inactive set muted to `VOICE_MUTE = −80 dB`.
- Arp bypass/fx split toggled via `setArpFx(bool)` — cross-fades between paths so the switch is click-free.
- Autotune and vocoder are **independent of each other and of Tone.js** in terms of AudioContext: autotune runs in Tone.js's context; vocoder creates its own `new AudioContext()`.

### Key Refs in `useAudioEngine`
| Ref | Purpose |
|-----|---------|
| `analogVoicesRef` | 6× `Tone.Synth` — [root, 3rd, 5th, 7th, oct, oct+3rd] |
| `stringsVoicesRef` | 6× `Tone.FMSynth` — same intervals |
| `activeVoicesRef` | Points to whichever voice set is currently audible |
| `currentRootRef` | Last computed root frequency in Hz — consumed by the arp |
| `scaleRef` | `Float32Array` of sorted Hz values for `snapToNearest()` binary search |
| `globalOctaveRef` | Integer −2 to +2; applied via `.transpose(n * 12)` to raw pitch |
| `arpVolRef` | `Tone.Volume` — gesture-driven arp gain (written by `updateParams`) |
| `arpBaseVolRef` | `Tone.Volume` — static base-level node written only by the vol slider; sits between `arpVolRef` and `arpDelayRef` so the two writers never conflict |
| `arpDelayRef` | `Tone.FeedbackDelay` — on arp path between `arpBaseVol` and bypass/fx split |
| `arpReverbRef` | `Tone.Freeverb` — on arp path between `arpDelayRef` and bypass/fx split |
| `arpBypassGainRef / arpFxGainRef` | Parallel output routing for arp |
| `filterRef / vibratoRef / reverbRef / volumeRef` | Shared chord effects chain nodes |
| `appliedArpModeRef / appliedArpRateRef / appliedArpRootRef / appliedArpThirdRef` | Delta-check refs — pattern is only rebuilt when one of these changes; all reset to `null`/`0.5` in `stopAudio` |

### `dsp.js` Utility Reference
| Function | Notes |
|----------|-------|
| `calculateDistance2D(p1, p2)` | XY Euclidean on normalized landmarks |
| `calculateDistance(p1, p2)` | XYZ Euclidean |
| `mapRange(v, inMin, inMax, outMin, outMax)` | Clamped linear map |
| `isFingerExtended(hand, tipIdx, pipIdx)` | Y-comparison — reliable only on non-rotated hands |
| `snapToNearest(hz, sortedFloat32Array)` | O(log n) binary search for scale quantization |
| `normalizeNote(note)` | Tone.js flat names → sharp names (for PianoRoll key lookup) |
| `getArpFingerStates(hand)` | Rotation-robust wrist-to-tip / wrist-to-PIP ratio, 1.1× threshold |
| `getWristTiltDeg(hand)` | atan2 of wrist→midMCP vector; absolute deviation for bidirectional tilt |
| `getArpSpreadDb(hand, states, handSize)` | Outermost extended-tip distance → −12 to +3 dB |

### Gesture Routing System (`src/utils/gestureMappings.js`)
Two independent routing layers, both user-configurable via the GestureSettings modal:

- **Signals** (continuous): 6 gesture sources → 5 audio destinations. Each mapping row: `{ id, source, destination, invert }`. Stored in `mappings` React state; `mappingsRef` (inline-synced) passes the live value into the rAF loop.
- **Gates** (discrete triggers): 17 trigger sources (strict 8-state finger-combo enumerations for each hand + 3 wrist-tilt bands) → 27 action destinations (chord types, arp modes, arp rates). Stored in `triggerMappings` state; `triggerMappingsRef` inline-synced.

`updateParams` runs in three phases: **(1) Gather** signals + active triggers from each hand block; **(2) Resolve** trigger IDs to `targetChord / targetArpMode / targetArpRate`; **(3) Execute** chord and arp logic.

### Vocoder Hook (`src/hooks/useVocoder.js`)
Standalone 16-band phase vocoder built entirely on native Web Audio API — **completely independent of Tone.js** (creates its own `new AudioContext()`). Carrier: 5 sawtooth oscillators (4 chord voices + 1 arp voice) updated via `updateNotes(freqs[])` every rAF frame using `setTargetAtTime(τ=10ms)` — zero node churn. Exposed API: `startVocoder / stopVocoder / updateNotes / updateVocoderParams / getAnalyserData / isVocoderActive`.

### Autotune Hook (`src/hooks/useAutotune.js`)
Hard-tune pitch correction using `pitchfinder.YIN` on a 2048-sample native `AnalyserNode` tapping the raw mic signal **before** `Tone.PitchShift`. Runs in Tone.js's AudioContext (not a separate one). Detection loop gated to ~30 fps (every 2nd rAF frame) to cap YIN's O(n²) cost. Semitone shift: `12 * Math.log2(targetHz / detectedHz)` assigned directly to `pitchShift.pitch` (no ramp = hard snap). Scale is updated externally via `setAutotuneScale(key)` — App.js calls this alongside `setScale` whenever the scale dropdown changes. Exposed API: `startAutotune / stopAutotune / isAutotuneActive / setAutotuneScale / setAutotuneWet / detectedNoteRef / correctedNoteRef`.

### PianoRoll Component
`PianoRoll` is a `forwardRef` component exposing two imperative methods:
- `ref.current.setNotes(noteNames[])` — diff-based class toggling via an internal `Set`; frames with no chord change produce zero DOM writes.
- `ref.current.flashNote(noteName, durationMs)` — adds a `.flash` CSS animation (gold inset `box-shadow`) to a single key for `durationMs` ms. `flashTimersRef` (Map) allows rapid re-fires on the same key to cancel the previous timer and restart the animation cleanly via forced reflow (`void el.offsetWidth`). Called directly from the `Tone.Pattern` callback — safe because Pattern callbacks run on the main thread.

### Loop Station
`useLoopStation(volumeRef)` taps a `Tone.Recorder` after `volumeRef`. Records 8 s (4 bars @ 120 BPM), decodes via `rawContext.decodeAudioData`, then plays back through a `Tone.Player(loop:true)` directly to `Destination` — bypassing the effects chain. Does **not** use `Tone.Transport`.

### Page Routing (`src/Root.js`)
The app shell is a thin state-router — **no `react-router-dom`**. `Root.js` owns `page` (`'home' | 'voxtool' | 'workstation'`) and `isDarkMode` state, applies `data-theme="light"` on a top-level wrapper, and threads `onNavigateHome` + theme props to each page. Theme persistence survives navigation because state lives at the Root level. `App.js` is the VoxTool page; `Workstation.jsx` is a 2-view container that gates the WIP DAW shell behind a continue button. Adding a new page = adding a branch in `Root.js`, not a routing library.

### Workstation (`src/components/Workstation/`)
DAW-style page composed of `Workstation.jsx` (warning ↔ shell container) → `WorkstationShell.jsx` (transport bar / tracks / regions / ruler / playhead) → `RegionEditor/` (bottom-docked editor with inspector + piano roll shell). State for tracks (`{ id, name, instrument, color, isMuted, isSolo, volume, pan, effects }`) and regions (`{ id, trackId, startMeasure, durationMeasures, clipOffset, fadeIn, fadeOut }`) lives in `WorkstationShell`. Regions have 6 drag modes: `move`, `resize-left`, `resize-right`, `fade-left`, `fade-right`, `fade-both` (merged-joint slide). **Tone.Transport is the singleton clock** — `handlePlayPause` toggles based on `Tone.Transport.state` (start ↔ pause preserves position); `handleStop` resets to zero. Playhead transform + time text update through a single rAF loop reading `Tone.Transport.seconds`. **All hover/drag interactions are ref-based** (ghost region, region move, region resize, editor-panel divider): direct DOM mutation during the drag, one `setState` on `mouseup` — matches the Zero-Re-render Rule. Region clicks `stopPropagation` so only the ruler does seek/scrub.

### Workstation per-track insert effects (`effectDefs.js` / `fxChain.js`)
`track.effects` = `[{ id, type, bypass, params }]`, **array order = signal order**. Registry `effectDefs.js` (`EFFECT_DEFS`: filter/delay/reverb/doubler/autofilter/autowah, param metadata incl. `kind: 'toggle'`); DSP factory `fxChain.js` (`makeFxGraph` → uniform `{ in, out, apply, dispose }` per type; `makeFx` wraps with **click-free bypass** via complementary 0.05s gain crossfade — the `setArpFx` pattern). Live chain sits at `pan → [FX] → mute` in `useWorkstationAudio.js` (effects 1b structural / 1c bypass / 1d params — 1b is the **only** post-creation writer of pan's output; params delta-check by object reference). Mirrored offline in `audioBounce.js` (non-bypassed only, back-to-front via `makeFxGraph`). Delay is a composite (FeedbackDelay `wet:1` + parallel `dryLvl`/`wetLvl` gains) so `dryThru` pins dry at unity with zero topology change. **Ranges are load-bearing:** delay time ≤ 1.0s (`maxDelay: 1` — rampTo above throws), feedback ≤ 0.9, roomSize ≤ 0.95. Chorus/AutoFilter need `.start()`; `Chorus.depth`/`octaves` are plain setters (not rampable) — the applier handles both kinds.

### Theme-aware piano roll row shading
`--pr-shade-natural` and `--pr-shade-accidental` in `index.css` invert which row type gets shaded per theme — dark mode brightens naturals via `rgba(255,255,255,0.04)`, light mode darkens accidentals via `rgba(0,0,0,0.06)`. The grid uses six layered `repeating-linear-gradient`s (bar lines, sub-beats, octave lines, semitone rows, accidental shading, natural shading) — exactly one shading layer is non-transparent per theme. **Watch out:** `--bg-panel` is *darker* than `--bg-base` in light mode (the opposite of dark mode) — use the dedicated `--piano-key-white` / `--piano-key-black` vars for any "white-key brighter than black-key" mapping that must hold in both themes.

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
* **Gemini:** Technical Project Manager & Systems Architect. Defines high-level strategy, maintains the project roadmap, and drafts foundational documentation before handing precise execution blueprints to Claude. **Be critical of Gemini's plans** — verify signal flow correctness, check for existing utilities before proposing new ones, and reject approaches that violate the Zero-Re-render Rule or the established hook modularity pattern.

---

## Documentation Maintenance
* Do not make sweeping architectural changes without first proposing an update to `ARCHITECTURE.md` and getting Dylan's approval.
* When a task is completed, move it from "Future Steps" to the "Completed Steps Log" in `PLAN.md` with the date and brief technical details.

---

## Core Directives & Standards

1. **Zero-Latency Tolerance:** Use `requestAnimationFrame` for visual updates and Tone.js ramp methods for audio. Never block the rAF loop.
2. **Mathematical Precision:** All DSP and gesture-mapping calculations must be mathematically sound. Avoid unoptimized loops in the render cycle.
3. **Strict Aesthetic — Option A (Deep Space & Mint):** Background `#0e0e10`, Accent `#5DCAA5`. All UI must feel like a high-end professional audio tool. Overlay terminals (VocoderTerminal, AutotuneTerminal, ArpTerminal) are **always dark** regardless of light/dark theme — they sit on the live camera feed and require constant high contrast.
4. **Hook Modularity:** Each major audio subsystem lives in its own hook (`useAudioEngine`, `useVocoder`, `useAutotune`, `useLoopStation`, `useMidi`). Do not add new audio subsystems to `useAudioEngine` — create a peer hook and wire it through `App.js`.
5. **Single Writer Per Node:** Every audio node ref has exactly one writer. Never write to a ref that is already owned by the rAF loop (e.g., `arpVolRef` is owned by `updateParams` — the ArpTerminal vol slider uses the separate `arpBaseVolRef`).
6. **Code Quality:** Small, modular components. Optimize state to prevent unnecessary re-renders. The rAF loop must touch zero React state.
7. **Communication:** Briefly explain *why* a solution is the most efficient/correct approach before providing code.
