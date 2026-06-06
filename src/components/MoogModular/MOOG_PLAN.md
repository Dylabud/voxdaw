# MOOG_PLAN.md — Moog Modular Synthesizer (VoxDAW)

## How to Use This File

**This is the single source of truth for the Moog Modular sub-project.**
- Do NOT edit root `PLAN.md`, `CLAUDE.md`, or `ARCHITECTURE.md` for Moog work.
- When a Moog phase is completed, move it from **Future Phases** to **Completed Phases Log** with the date and a brief technical summary.
- Prefix all phases with `Moog Phase N` so they are unambiguous from Workstation/VoxTool phases.
- Add new future phases under the appropriate section header below.
- For Claude: update this file at the end of each session — do not leave it stale.

---

## Project Vision

A massive, photorealistic 1960s-style Moog Modular Synthesizer embedded as a dedicated page within VoxDAW. The synth will eventually support:
- Interactive knobs (drag-to-rotate physics)
- Real Tone.js audio: VCO → VCF → VCA → Envelope signal chain
- Patch cable simulation (dynamic connect/disconnect between modules)
- CV routing (LFO, sequencer, envelope modulation)

**Strict directory rule:** 99% of work stays inside `src/components/MoogModular/`. The only exception is `src/Root.js` routing (done once in Moog Phase 1).

---

## Future Phases

### Moog Phase 7 (audio wiring) — Wire Patch Cables to `useMoogAudio.js`
- Prerequisite: Phase 3 (audio architecture) must be complete first
- In `MoogPatchContext.completeDrag` / `removeCable`: call `useMoogAudio.connect(fromJackId, toJackId)` / `disconnect(cableId)`
- Jack IDs already match the architecture signal-type system — the visual graph already models the correct connection data, just needs an audio back-end

### Moog Phase 5 — VCF Panel Wiring ✅ (see Completed Phases Log)

### Moog Phase 6 — Envelope + VCA Wiring ✅ (see Completed Phases Log)

### Moog Phase 11 — Oscilloscope Visualization ✅ (see Completed Phases Log)

### Moog Phase 10 — Master I/O & True Modular Routing ✅ (see Completed Phases Log)

### Moog Phase 7 — Patch Cable Simulation
- Visual patch cables as SVG bezier curves between jacks
- Drag from one jack to another to create a connection
- Store connections as `[{ srcModuleId, srcJack, destModuleId, destJack }]`
- Color-coded cables (random per patch)
- Dynamic `connect()` / `disconnect()` to `useMoogAudio.js`

### Moog Phase 8 — LFO Module (Audio Wiring) ✅ (see Completed Phases Log)

### Moog Phase 8a — CP3 Mixer Audio Wiring
- Prerequisite: Phase 3 (audio architecture) complete
- Four `Tone.Gain` channel nodes + summing master `Tone.Gain` bus in `useMoogAudio.js`
- Wire CH1–CH4 gain knobs + MASTER knob → node params via `.rampTo()`
- Optional soft-clipping `WaveShaperNode` on the summing bus output for drive character

### Moog Phase 8b — Noise Generator Audio Wiring
- Two `Tone.Noise` instances (white + pink) each through a `Tone.Gain` in `useMoogAudio.js`
- Wire LEVEL knob → gain node
- Separate output refs for WHITE and PINK jacks for patch cable routing

### Moog Phase 12 — Visual Polish
- Animated indicator LEDs (env activity, VCO trigger)
- Knob tooltip labels on hover
- Module-level bypass switches
- Cabinet aging effects (subtle vignette, worn edges)
- Mobile / narrow viewport fallback

---

## Completed Phases Log

### [2026-06-06] Moog Phase 18 — Transcription Engine: Audio-to-Editable-Notes

**Files created:**
- `src/components/Workstation/transcribeAudio.js` — Monophonic pitch detection using `pitchfinder.YIN` (already in the project via `useAutotune.js`). Two-pass algorithm: (1) per-hop-frame (2048-sample window, 512-sample hop) — run YIN with RMS gate (0.01) to skip silence, convert Hz → note name via standard MIDI formula `69 + 12*log2(hz/440)`; (2) merge consecutive same-pitch frames into note events with `startBeat` (relative to region start), `durationBeats`, `velocity` (from peak RMS). Notes shorter than 80 ms are discarded as transients. Pure function, no Tone.js dependency.

**Files modified:**
- `src/components/Workstation/WorkstationShell.jsx` — Imports `transcribeAudio`. In `handleMoogRecord` stop branch: after the audio is decoded to a native `AudioBuffer`, calls `transcribeAudio(nativeBuf, Tone.Transport.bpm.value)`. Transcribed notes replace existing notes for that region via `setNotes(prev => [...prev.filter(n => n.regionId !== regionId), ...newNotes])` — re-recording overwrites the previous transcription. Note objects match the existing Workstation schema: `{ id, regionId, trackId, note, startBeat, durationBeats, velocity }`. Toast message reports detected count with hint to open piano roll.

**What Gemini thought needed building but already existed:**
- NoteEditor component → `RegionEditor.jsx` already provides a full piano roll with note drag/resize
- Data model update → `notes` state `[{ id, regionId, note, startBeat, durationBeats }]` already exists
- MIDI playback → `useWorkstationAudio` already plays notes through the track's synth via `Tone.Part`
- Dual-mode playback → both `Tone.Player` (audio) and `Tone.Part` (notes) run simultaneously on `Tone.Transport`

**"MIDI via Moog engine" mode rejected** — would require tight cross-page audio coupling between the Workstation and Moog. The track's own synth (set in the track instrument selector) plays the transcribed notes, which is the correct Workstation architecture.

**Transcription accuracy notes:** Works best with single-note sequencer patterns (monophonic). Chords, heavy reverb, or multi-VCO detuning produce approximate results. The piano roll allows manual correction.

---

### [2026-06-06] Moog Phase 17 — VoxDAW Workstation Recording Integration

**Scope implemented:** simultaneous page mounting + live Moog→Workstation audio bus + Workstation recorder button. Timeline clip integration is Phase 18+.

**Files modified:**
- `src/Root.js` — Full rewrite. Replaced single-page conditional render with a **visited-based lazy mount** strategy: pages mount on first visit and stay alive in the React tree (audio engines persist). CSS `display: none` hides inactive pages. Uses `useCallback` for stable `navigate` and `getMoogBusNode` references. `moogBusGetterRef` (ref, not state) stores the Moog's bus-node getter without causing Root re-renders.

- `src/components/MoogModular/useMoogAudio.js` — Two additions:
  1. **`n.moogBus = new Tone.Gain(1)`** in node creation block; hardwired `n.seqMasterGate.connect(n.moogBus)` as a dead-end side tap. Not connected to Destination — solely for the Workstation's `Tone.Recorder`.
  2. **`getMoogBusNode()`** (`useCallback`, `[]` deps) — returns `nodesRef.current?.moogBus ?? null`. Available immediately after MoogShell mounts (the node exists from creation, not from `powerOn`).

- `src/components/MoogModular/MoogShell.jsx` — Accepts `onBusReady(getter)` prop. A `useEffect([onBusReady, audio.getMoogBusNode])` registers `() => audio.getMoogBusNode()` with Root.js once on mount.

- `src/components/Workstation/Workstation.jsx` — Accepts and passes `getMoogBusNode` prop through to `WorkstationShell`.

- `src/components/Workstation/WorkstationShell.jsx` — Four additions:
  1. Accepts `getMoogBusNode` prop.
  2. `moogRecording` / `moogRecordSec` state + `moogRecorderRef` / `moogBusNodeRef` / `moogTimerRef` / `moogRecordingRef` refs.
  3. **`handleMoogRecord`** (`useCallback`, `[getMoogBusNode]` dep) — toggle start/stop: calls `getMoogBusNode()`, connects a `Tone.Recorder` to the bus, starts recording + 1-second interval counter. Stop: `recorder.stop()` → Blob → triggers download as `.webm`. Uses `moogRecordingRef` (not `moogRecording` state) inside the callback to avoid stale closures. `setToastMessage` for error states.
  4. Replaces the no-op `●` button with a live `● MOOG` / `■ Ns` toggle button.

**How to use:**
1. Visit Moog Modular, set up a patch, power on. Audio flows through `seqMasterGate → moogBus`.
2. Navigate to Workstation (Moog stays alive, audio continues).
3. Click **● MOOG** in the bottom transport bar. Recording starts (button shows elapsed seconds in red).
4. Click **■ Ns** to stop. A `.webm` audio file downloads automatically.

**Gemini plan corrections:**
- `export const moogGlobalBus = new Tone.Gain(1)` at module level rejected — creates Tone.js nodes before AudioContext initialization. Used `useEffect` node creation instead.
- "Always mount all pages unconditionally" rejected — VoxTool's getUserMedia, Workstation's audio engine, and Moog's Tone.js nodes would all initialize on app load before the user visits those pages. Visited-based lazy mount is correct.
- "MoogPatchContext expose" rejected (7th time).

---

### [2026-06-05] Moog Phase 16 — Studio Reverb Module

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Three additions:
  1. **`n.reverb`** — `new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 })` in the `useEffect` node creation block. Uses `Tone.Freeverb` (not Gemini's `Tone.JCReverb`) because `Tone.Freeverb` is already proven in this codebase (VoxTool `arpReverbRef`). `wet: 0.0` on init so patching the reverb in is transparent until the user raises MIX.
  2. **`'reverb-in'` / `'reverb-out'` jacks** — added to `buildJackMap(n)` after VCA jacks. `reverb-in: { type: 'in', dest: n.reverb }`, `reverb-out: { type: 'out', node: n.reverb }`. Same dual-reference pattern as `vcf-in`/`vcf-out`.
  3. **`updateReverbParams({ roomSize, wet })`** — `useCallback`, empty deps, uses `safeRamp` on `n.reverb.roomSize` and `n.reverb.wet`. Returned from hook.

- `src/components/MoogModular/MoogShell.jsx` — Added `ReverbModule` function component co-located in MoogShell.jsx (same pattern as all other modules). State: `roomSize=0.7`, `wet=0.0`. `useEffect([roomSize, wet])` → `onParamUpdate(...)`. Two `MoogKnob` elements (ROOM md, MIX md) + `Jack` pair (`reverb-in`, `reverb-out`). Mounted in Row 2 after `LfoModule`: `<ReverbModule onParamUpdate={audio.updateReverbParams} />`.

- `src/components/MoogModular/MoogShell.module.css` — `.tierRow2` updated from `1.7fr 1.5fr 1fr` to `1.7fr 1.5fr 1fr 0.75fr` to accommodate the fourth module in Row 2.

**Patch path for reverb insert:**
`vca-out → reverb-in` → `reverb-out → io-in` (reverb replaces the direct vca→io connection)

**Gemini plan corrections:**
- `Tone.JCReverb` → `Tone.Freeverb` (proven in this codebase; same parameters, no API risk).
- `useRef(new Tone.Freeverb(...))` at hook call site rejected — moved to `useEffect` node creation block.
- "Expose via MoogPatchContext" rejected — prop-drilled from MoogShell.
- "ReverbModule.jsx" rejected — all modules co-located in MoogShell.jsx.

---

### [2026-06-05] Moog Phase 15 — Reactive LED Feedback

**Files created:**
- `src/components/MoogModular/Led.jsx` — Zero-re-render analog level LED. Props: `getValue` (fn → 0–1), `color` (`'green'`|`'yellow'`|`'red'`), `label` (optional string). `useEffect` starts a `requestAnimationFrame` loop that writes `el.style.opacity = 0.12 + val * 0.88` directly to the DOM ref — zero React state. `will-change: opacity` on the LED element keeps the animation on the GPU compositing layer (no layout/paint cost per frame). Cleanup: `cancelAnimationFrame` on unmount.
- `src/components/MoogModular/Led.module.css` — Single-element LED design. Full glow state (radial gradient + two-layer box-shadow) always in CSS; `opacity` fades between `0.12` (authentic off-state dim dot) and `1.0` (fully lit with ambient glow). Green (ENV activity), yellow (LFO rate), red (master level indicator).

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Three additions:
  1. **4 `Tone.Meter` nodes** added to the `useEffect` node creation block (`lfoMeter`, `env1Meter`, `env2Meter`, `masterMeter`). Each has `normalRange: true` (returns 0–1, not dB) and tuned `smoothing` values: LFO `0.7` (averaged oscillating signal), ENV `0.25` (fast enough to track ADSR shape), master `0.2` (responsive to transients).
  2. **Meter connections** — all dead-end side taps. `n.lfo → n.lfoMeter`; `n.env1 → n.env1Meter`; `n.env2 → n.env2Meter`; `n.vca → n.masterMeter`. Master meter taps from `n.vca` (pre-master Volume) not `n.master` — after the -14 dB master attenuation, levels are too low (~0.07) to produce visible LED activity at default settings; tapping from VCA gives useful signal-present feedback.
  3. **`getMeterValue(id)`** (`useCallback`, empty deps) — looks up `n[${id}Meter]`, calls `.getValue()`, clamps to [0,1] with `isFinite` guard.

- `src/components/MoogModular/MoogShell.jsx` — Four additions:
  1. `useCallback` added to React imports; `Led` imported.
  2. Four stable getter closures created in `MoogShell` via `useCallback(() => audio.getMeterValue(id), [audio.getMeterValue])` — pre-bound so `Led`'s `useEffect` dep array never changes, preventing unnecessary rAF restarts on module re-renders.
  3. `LfoModule`, `EnvelopeModule`, `IoModule` signatures updated to accept `getLedValue` prop. `LfoModule`: LED in knobRow (yellow, before RATE). `EnvelopeModule`: LED in gateBtnRow (green, before GATE label). `IoModule`: LED in knobRow (red, after MASTER, labeled "PEAK").
  4. Stable getters wired at call sites: `getLedValue={getLfoLevel}`, `getLedValue={getEnv1Level}`, `getLedValue={getEnv2Level}`, `getLedValue={getMasterLevel}`.

**Gemini plan corrections:**
- `useRef(new Tone.Meter(...))` at hook call site — same bug documented in phases 3, 8, 9, 11, 13. Moved to `useEffect` node creation block.
- "Open `LfoModule.jsx`" — no such file. All modules co-located in `MoogShell.jsx` (documented since phase 8).
- "Expose via MoogPatchContext" — wrong abstraction rejected every phase. Prop-drilled from MoogShell.
- "`lfo.current.connect(lfoMeter.current)`" — wrong. Nodes at `n.lfo`, not `lfo.current`.
- Master meter tap moved from `n.master` to `n.vca` — at -14 dB master attenuation, `n.master` output is too attenuated for useful LED feedback at default settings.
- Inline arrow prop `() => getMeterValue(id)` rejected — new function reference every render causes LED's `useEffect` to restart. Replaced with stable `useCallback` closures in MoogShell.

---

### [2026-06-05] Moog Phase 14 — Vintage Studio Polish Pass

**Files modified:**
- `src/components/MoogModular/MoogShell.module.css` — Four additions:
  1. **Cabinet vignette + noise grain**: Two new background layers prepended to `.cabinet`'s existing 3-layer gradient. A `radial-gradient` vignette darkens corner/edges to simulate decades of oxidation. A tight 73° `repeating-linear-gradient` noise grain breaks up the smooth digital wood texture. No SVG data URIs or pseudo-elements — gradient layers are zero-overhead and avoid z-index collisions with patch cables (z-index: 50) and `will-change: transform` knobs.
  2. **Faceplate wear overlay**: Added `position: relative` to `.plate` and a `::after` pseudo-element — a subtle `radial-gradient` centered at 50% 42% (where main knobs sit) at ~2.5% white opacity. Simulates oil from thousands of finger turns wearing down the powder coat. `pointer-events: none` keeps all interactions intact.
  3. **`@keyframes flicker`**: 7-keyframe opacity oscillation (0.85–1.0 range) over a 5.3s loop. Keyframe positions are irregular to avoid a mechanical rhythm.
  4. **`.powerLamp` / `.powerLampOn`**: 10px jewel indicator light (dark red when off; bright red radial-gradient with 3-layer red glow when on). `.powerLampOn` applies `flicker` animation. Glow uses three stacked `box-shadow` layers at 6/16/30px blur to simulate lamp light bleeding onto the surrounding faceplate.

- `src/components/MoogModular/MoogShell.jsx` — Added `<div className={styles.powerLamp} …/>` sibling to `<PowerSwitch>` inside `IoModule`'s `.switchRow`. Class list toggles `powerLampOn` based on `isPowered` prop (already available in scope).

- `src/components/MoogModular/Oscilloscope.module.css` — Three additions:
  1. `position: relative` on `.screen` — anchors the `::after` scanline overlay.
  2. Curved screen vignette via `radial-gradient` prepended to `.screen`'s background stack — sits behind the canvas but shows through cleared transparent pixels, darkening the corners to simulate CRT tube curvature.
  3. `.screen::after` — `repeating-linear-gradient` scanlines (1px dark / 2px transparent, 14% opacity, `pointer-events: none`). Paints above the canvas as a final CRT layer without affecting waveform interaction.
  4. Phosphor ambient glow added to `box-shadow` — `0 0 14px rgba(80, 180, 120, 0.30)` simulates green phosphor light bleeding onto the surrounding dark metal faceplate.

**Gemini plan corrections:**
- SVG data-URI noise texture rejected — gradient-layer approach achieves equivalent grain with zero encoding overhead and cleaner CSS.
- Pseudo-element vignette on `.cabinet` rejected — avoids z-index collisions with `PatchCableOverlay` (z:50) and `will-change: transform` stacking contexts on knobs. Background gradient is the correct containment boundary.
- Two oscilloscope pseudo-elements reduced to one — the curved-screen vignette belongs in the background stack (shows through transparent canvas), not a `::before`.

---

### [2026-06-05] Moog Phase 13 — 953 Keyboard Controller

**Files created:**
- `src/components/MoogModular/KeyboardModule.jsx` — playable 3-octave keyboard (C3–B5, 21 white + 15 black keys). Registers `kbd-pitch-out` and `kbd-gate-out` jacks via `MoogPatchContext` so patch cables connect them to the rest of the rack. Pointer events (single shared handler using `data-note-name`/`data-note-hz` attributes to avoid per-key closures) + window-level `pointerup` for reliable note-off on mouse-leave. Computer keyboard support: A W S E D F T G Y H U J K plays C4–C5. Note labels at each C key; computer shortcut hint on the key faces.
- `src/components/MoogModular/KeyboardModule.module.css` — hardware-literal CSS. Walnut control strip matching the cabinet aesthetic; ivory white keys with `border-box` layout (28px each, shared left borders, bottom rounding); ebony black keys (`position:absolute`, 17px wide, z-index 2); pressed state via `transform: translateY(2px)` and darkened gradient; `drop-shadow` filter on the key bed for depth.

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Four changes:
  1. **`kbdPitchOut`** Tone.Signal (init=SEQ_HZ_MIN) added to node creation; `kbd-pitch-out` jack added to jackMap; `kbd-gate-out` added as `{ isGate: true }` output.
  2. **`gateActionsRef` refactor** — rekeyed from `toJackId` to the full cable key (`"fromId→toId"`). Fixes a collision: if both `seq-gate-out` and `kbd-gate-out` connect to the same env jack, the second `set()` now uses a different key and neither overwrites the other. The sequencer loop now filters by `fromId === 'seq-gate-out'`; `updateKeyboard` filters by `'kbd-gate-out'`.
  3. **`connect()` / `disconnect()`** updated for the new gate key format.
  4. **`updateKeyboard(hz, isGateDown)`** — `kbdPitchOut.setValueAtTime(hz, Tone.now())` + iterate gate map (kbd-only) and `triggerAttack`/`triggerRelease`.
- `src/components/MoogModular/MoogShell.jsx` — imported `KeyboardModule`; rendered below `.rack` inside `.cabinet` (inside the `MoogPatchProvider` so jacks can register, and inside the `PatchCableOverlay` z-index so cables reach keyboard jacks).

**Gemini corrections:**
- `useRef(new Tone.Signal(0))` at hook call site — nodes must be inside `useEffect`. Same bug as Phases 3, 8, 11, and the scaler phase.
- "New `vco?-pitch-in` jacks" — unnecessary. `vco?-cv` already goes direct-to-frequency (previous CV scaling fix intentionally kept it as a bypass path for Hz-range sources). Keyboard patches there.
- "Expose via MoogPatchContext" — rejected in every prior phase. Gate routing via `gateActionsRef` + `connect()`/`disconnect()`.

---

### [2026-06-04] Moog Phase 9 — 960 Sequential Controller

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Five changes:
  1. **`Tone.Signal seqPitchOut`** added to node creation block; exposed via `seq-pitch-out` jack (type `out`). Patch to any VCO `cv-in` for pitch control — outputs Hz in the C1–C6 range (same scale as the VCO FREQ knob; set VCO FREQ to minimum for pure sequencer pitch control).
  2. **`Tone.Loop`** created at node-init time (not in `powerOn`) for correct Tone.js lifecycle. Fires every `'8n'` on `Tone.Transport`. Loop callback: advances `seqCurrentStepRef` (0–7), calls `n.seqPitchOut.setValueAtTime(hz, time)` for sample-accurate pitch, triggers/releases connected envelopes at 80% gate width, and calls `seqStepCbRef.current(idx)` for DOM-direct LED animation.
  3. **Gate routing** — `env1-gate` / `env2-gate` jacks upgraded from deferred `dest:null` to `{ isGate:true, envId }`. `seq-gate-out` is `{ type:'out', isGate:true }`. `connect()` detects the `isGate` pair and registers the env in `gateActionsRef` (Map). `disconnect()` removes from the map. Programmatic `triggerAttack/Release` — `Tone.Envelope` has no CV-driveable AudioParam for gating.
  4. **Transport lifecycle** — `powerOn` calls `Tone.Transport.start()` + `seqLoop.start(0)`, resets `seqCurrentStepRef=-1` so first tick lands on step 0. `powerOff` calls `seqLoop.stop()`, `Tone.Transport.stop()`, fires `seqStepCbRef(-1)` to clear LEDs.
  5. **New exports**: `setTempo(bpm)` (ramps `Transport.bpm`), `updateSequencerSteps(steps[])` (writes `seqStepsRef` — zero React state), `setSeqStepCallback(fn|null)` (registers LED callback).

- `src/components/MoogModular/MoogShell.jsx` — Added `SequencerModule` component (replaces `SequencerReservedPanel`). State: `steps[]` (8×`{voltage,gate}`), `tempo` (20–300 BPM). Tempo knob → `setTempoState` → `onTempoChange(bpm)` via `useEffect`. Steps → `onStepsChange(steps)` via `useEffect`. Step callback registered via `useEffect([onSetCallback])` — writes a DOM-mutation closure into `seqStepCbRef`; uses `ledRefs` array and `classList.add/remove` for zero re-render LED animation. Gate toggles are React state (click → `setSteps`) since they're discrete user actions, not audio-hot-path. Row 4 now uses `<SequencerModule>` + `<IoModule>`.

- `src/components/MoogModular/MoogShell.module.css` — Updated `tierRow4` to `3.5fr 1fr` (sequencer takes most of the row). Added `.seqLayout`, `.seqCtrl`, `.seqBpmDisplay`, `.seqSteps`, `.seqStep`, `.seqLed`, `.seqLedActive`, `.seqGateBtn`, `.seqGateOn`.

**Gemini corrections:**
- "Look up connected jacks in MoogPatchContext" — the audio hook has no context access. Gate routing uses `gateActionsRef` populated by the existing `connect()/disconnect()` pair.
- "Instantiate `Tone.Signal` at hook call site" — creates node during render, outside lifecycle. Moved to the `useEffect` node creation block alongside all other nodes.
- "`Tone.Transport.start()` inside powerOn" — correct for the Moog page (separate route, only one page mounted at a time). Confirmed safe per ARCHITECTURE.md Tone.Transport coordination note.
- Gemini proposed `useRef(new Tone.Loop(...))` at hook call site — same lifecycle issue as the Signal. Moved inside `useEffect`.

---

### [2026-06-04] Layout & Visual Fixes — Viewport Fit, Wood Removal, Screw Positioning

**Files modified:**
- `src/components/MoogModular/MoogShell.module.css` — Three rounds of layout fixes:
  1. **Wood between rows removed**: `.tier` stripped of all walnut `background`, `border-radius`, `padding`, and `box-shadow` rings — now a plain transparent grid. `.rack` gets `background: #0a0908` (dark metal) and `gap: 2px`; the 2px gap shows as a thin rack rail between rows. Walnut now visible only at the outer `.cabinet` padding edges (reduced to `8px 10px 10px`). All internal spacing condensed: `.plate` padding `10px 13px 9px → 10px`, gap `7px → 5px`; `.plateBody` gap `6px → 4px`; `.knobRow/switchRow/selectorRow/jackRow/gateBtnRow` gaps and paddings reduced 2–4px each.
  2. **Screw overlap fixed**: Screws reduced to `7px × 7px`, positioned at `top/bottom: 2px, left/right: 2px` — corner of each screw reaches 9px from edge. Plate `padding: 10px` (all sides) ensures content starts at 10px — 1px clearance. Phillips cross arms reduced to 4px width/height.
  3. **`flex-shrink: 0` on `.cabinet`**: Prevents flexbox from shrinking the cabinet before `fit()` measures it, which was causing `el.offsetHeight` to return the shell height (not the cabinet's true content height), resulting in `scale = 1` and unscaled overflow.

- `src/components/MoogModular/MoogShell.jsx` — `fit()` function overhauled:
  - Resets both `transform` and `marginBottom` before measuring so natural dimensions are always accurate.
  - Applies `marginBottom: Math.round(natH * (scale - 1))` (negative) after scaling — collapses the layout footprint left by `transform: scale()` (which is visual-only) so the flex container never exceeds `100vh`.
  - Added `ResizeObserver` on the cabinet alongside the `window.resize` listener — re-fires `fit()` if cabinet height settles after mount (font load, CSS cascade, etc.).

---

### [2026-06-04] Moog Phase 11 — Retro Oscilloscope Visualization

**Files created:**
- `src/components/MoogModular/Oscilloscope.jsx` — Zero-re-render canvas component. Receives `getData` prop (the `getOscilloscopeData` callback from `useMoogAudio`). `useEffect` starts a `requestAnimationFrame` loop that clears the canvas, calls `getData()`, then draws the waveform. Y-mapping: `(1 - sample) / 2 * H` maps +1→top, -1→bottom, 0→centre. Draws a flat centre line when `getData` returns null (pre-powerOn). Trace: `strokeStyle='#5DCAA5'` (VoxDAW accent mint), `lineWidth=1.5`, `shadowBlur=6` for phosphor glow. Shadow reset after each stroke to prevent bleed. `cancelAnimationFrame` on cleanup. Canvas fixed at 200×64 px.
- `src/components/MoogModular/Oscilloscope.module.css` — CRT screen aesthetic: dark `#060e08` background, two-layer `repeating-linear-gradient` grid (8px horizontal divisions, 20px vertical divisions in dim green `rgba(80,180,120,0.10)`). Layered `box-shadow` for bezel recess and outer dark border.

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Added `n.analyser = new Tone.Analyser('waveform', 512)` to the node creation block; connected via `n.master.connect(n.analyser)` (dead-end side tap — does not affect master→Destination path). `analyser` disposed in cleanup via the existing `Object.values(n).forEach(node => node.dispose())`. Added `getOscilloscopeData()` (`useCallback`, empty deps) that returns `n.analyser.getValue()` (Float32Array of 512 samples in [-1, 1]) or null.
- `src/components/MoogModular/MoogShell.jsx` — Imported `Oscilloscope`. Added `getOscData` prop to `IoModule`; rendered `<Oscilloscope getData={getOscData} />` at top of `.plateBody`. Wired at call site: `getOscData={audio.getOscilloscopeData}`.

**Gemini corrections:**
- `useRef(new Tone.Analyser(...))` at the hook call site creates the node during render, outside any lifecycle. Moved to the `useEffect` node creation block alongside all other nodes — correct lifecycle management.
- No `MoogPatchContext` — same correction as every previous phase. Prop-drill: `MoogShell → IoModule → Oscilloscope`.

---

### [2026-06-04] Moog Phase 10 — Master I/O & True Modular Routing

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Four changes:
  1. **CP3 internal wiring moved to `useEffect` (node creation)**: `cp3ch1-4 → cp3bus` now connects synchronously at node creation time. These are CP3's internal fixed architecture (channels always sum to bus), not "training wheels" — moved out of `powerOn` where they had a redundant `hardwiredRef` guard. `hardwiredRef` ref deleted.
  2. **VCA → Master hardwire removed from `powerOn`**: Audio no longer reaches the destination automatically. The user must patch `vca-out → io-in` (or any source → `io-in`) for sound to exit. True modular routing.
  3. **`io-in` jack added to `buildJackMap`**: `{ type: 'in', dest: n.master }` — replaces the former `io-spkr-out: { type: 'in', dest: null }`. Patching any source to `io-in` connects it to the `Tone.Volume` master node → Destination.
  4. **`updateIoParams({ volume })`** added (useCallback, empty deps): maps `volume` (0–1) linearly to -60 dB to +6 dB (`-60 + volume * 66`); uses `safeRamp` on `n.master.volume`. At default `volume=0.75`: ≈ -10.5 dB. Master `Tone.Volume` init changed from -12 → -14 dB (matches 0.7 knob default more closely).
- `src/components/MoogModular/MoogShell.jsx` — `IoModule`: added `onParamUpdate` prop; `useEffect([masterVol])` → `onParamUpdate({ volume: masterVol })`; jack renamed `io-spkr-out` → `io-in` with label "IN". Wired at call site with `onParamUpdate={audio.updateIoParams}`.

**Gemini corrections:**
- CP3 internal wires are NOT training wheels — they're the mixer's fixed internal architecture. They were correctly kept, just moved to the right location (node creation, not `powerOn`).
- VCA→Master WAS a training wheel and is correctly removed.
- No `MoogPatchContext` — same correction as every previous phase.
- `safeRamp` used for master volume — consistent with the [0, 0] RangeError fix.

---

### [2026-06-04] Bug Fix — Tone.js rampTo RangeError [0, 0] (`useMoogAudio.js`)

**Root cause:** `Param.rampTo()` calls Tone.js's `assertRange(value, param.minValue, param.maxValue)`. When the AudioContext is **suspended** (before `powerOn()`), AudioParams report `minValue = maxValue = 0`, so any call to `rampTo` throws `RangeError: Value must be within [0, 0], got: 1e-7`. All module `useEffect` hooks fire on mount before POWER is clicked, which was calling `updateVcoParams`, `updateVcfParams`, etc. into a suspended context. Secondary issue: `resonance=0.0 → Q=0`, which Tone.js substitutes as `1e-7` for exponential ramps, hitting the same validation.

**Fix (`useMoogAudio.js` only):** Added module-level `safeRamp(param, value, rampTime)` — uses `.rampTo()` when `Tone.context.state === 'running'`, direct `.value =` assignment otherwise. `.value` is always valid regardless of context state and pre-initialises the params so they are correct the moment `powerOn()` resumes the AudioContext. Replaced all 7 `.rampTo()` calls in `updateVcoParams`, `updateVcfParams`, `updateVcaParams`, and `updateLfoParams` with `safeRamp()`. Added `Math.max(0.001, resonance * 20)` floor on VCF Q — Q=0 fails exponential ramp validation even in a running context.

**Gemini plan corrections:** Jack IDs were already in sync (no audit needed). The `MoogPatchContext connect()` null guards already existed. The jack map multi-waveform routing was already correct. Only the `rampTo` crash was real.

---

### [2026-06-03] Moog Phase 8 — LFO Audio Wiring

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Added `updateLfoParams({ rate, depth, type })` (useCallback, empty deps). Maps `rate` (0–1) exponentially to 0.1–30 Hz via `0.1 * Math.pow(300, rate)` and calls `n.lfo.frequency.rampTo(hz, 0.05)`. Maps `depth` (0–1) directly to `n.lfo.amplitude.rampTo(depth, 0.05)` — the LFO amplitude scales the ±1 output swing. Sets `n.lfo.type = type` for UI-driven waveform default (cable connections still override waveform at connect-time via `from.waveform` in `connect()`). Returned from hook.
- `src/components/MoogModular/MoogShell.jsx` — Rewrote `LfoModule` in-place (same file, same pattern as all other modules). State: `rate=0.3`, `depth=0.5`, `waveType='sine'`. `useEffect` on all three calls `onParamUpdate({ rate, depth, type: waveType })`. Added click-to-cycle WAVE selector using existing `.selectorRow`/`.selectorGroup` CSS (consistent with VCO Phase 4). Renamed "LEVEL" knob → "DEPTH" (correct terminology for LFO modulation amount). SYNC toggle remains visual-only (audio SYNC is future work). Wired at call site: `<LfoModule onParamUpdate={audio.updateLfoParams} />`.

**Gemini corrections:**
- `Tone.LFO` was already instantiated in Phase 3 (`n.lfo`) and already started in `powerOn` — Gemini's "instantiate and start immediately" would have created a duplicate.
- Jack map already has 4 waveform output jacks (`lfo-sin/tri/sqr/saw`) — Gemini's proposed single `"lfo-out"` jack would be worse; the 4-jack design is authentic to the Moog hardware and cable-connects already set waveform.
- No separate `LfoModule.jsx` file — all modules are co-located in `MoogShell.jsx`, and that pattern is correct.
- No `MoogPatchContext` — same correction as all previous phases.
- Wave selector uses existing CSS (`.selectorRow`/`.selectorGroup`) from Phase 4 — zero new CSS needed.

---

### [2026-06-03] Moog Phase 6 — Envelope & VCA Wiring

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Added three new functions, all `useCallback` with `[]` deps:
  - `updateEnvParams(envId, { attack, decay, sustain, release })` — looks up `nodesRef.current[envId]` (env1/env2, both `Tone.Envelope`); maps A/D/R exponentially `0.01 * Math.pow(1000, v)` (0.01s–10s) and sustain linearly (0–1); writes directly to `env.attack/decay/sustain/release` properties (no rampTo on time params — Tone.Envelope properties are not AudioParams).
  - `triggerGate(envId, isDown)` — calls `env.triggerAttack()` or `env.triggerRelease()` on the named envelope. Works with `Tone.Envelope` (CV source) — when patched via cable `env1-out → vca-cv`, the Web Audio additive connection gates the VCA gain. The VCA GAIN knob sets the bias (initial gain); set GAIN=0 for full envelope gating.
  - `updateVcaParams({ gain })` — ramps `n.vca.gain.rampTo(gain, 0.05)` (linear 0–1); VCA is `Tone.Gain`, gain is an AudioParam.
  - Returned all five new functions alongside existing ones.
- `src/components/MoogModular/MoogShell.jsx` — `VcaModule`: added `onParamUpdate` prop, `useEffect([gain])` → `onParamUpdate({ gain })`; ENV AMT visual-only. `EnvelopeModule`: added `onParamUpdate` and `onGate` props; `useEffect([attack,decay,sustain,release])` → `onParamUpdate(envId, {...})`; added GATE pushbutton (`onMouseDown/Up/Leave` → `onGate(envId, bool)`, mouse-leave prevents stuck notes). All three wired in `MoogShell`.
- `src/components/MoogModular/MoogShell.module.css` — Added `.gateBtnRow`, `.gateBtnLabel`, `.gateBtn` — round (22px) deep-red vintage pushbutton with radial-gradient face, embossed ring shadow, press animation (`translateY(2px) scale(0.94)`), hover glow.

**Gemini corrections:**
- `Tone.Envelope` ≠ `Tone.AmplitudeEnvelope` — Gemini assumed the latter, but Phase 3 instantiated `Tone.Envelope` (CV source). `triggerAttack/Release` still works on `Tone.Envelope`; it outputs a 0–1 signal that adds to `vca.gain` when patched. VCA GAIN knob documented as "initial gain / bias" — this is authentic Moog hardware behavior (the original 902 VCA had an INITIAL GAIN control).
- ADSR time params are Envelope properties, not AudioParams — no `.rampTo()`, direct property assignment.
- No `MoogPatchContext` changes — same wrong abstraction as Phases 4 and 5. Prop-drilled from `MoogShell`.
- VCA gain kept linear 0–1 (not dB conversion) — `Tone.Gain.gain` is a linear AudioParam; direct mapping is correct and avoids unnecessary complexity.

---

### [2026-06-03] Moog Phase 5 — VCF Panel Wiring

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Added `updateVcfParams({ cutoff, resonance })` (useCallback, empty deps). Maps `cutoff` (0–1) exponentially to 20 Hz–20 kHz via `20 * Math.pow(1000, cutoff)` and calls `n.vcf.frequency.rampTo(hz, 0.05)`. Maps `resonance` (0–1) to Q 0–20 and calls `n.vcf.Q.rampTo(q, 0.05)`. Also corrected VCF init frequency from 2000 Hz → 20000 Hz to match the knob's fully-open default of `cutoffBase=1.0` — prevents UI/audio desync on first load. Returned from the hook.
- `src/components/MoogModular/MoogShell.jsx` — Added `onParamUpdate` prop to `VcfModule`. Fixed defaults: `cutoff=1.0` (fully open, matching 20 kHz init), `res=0.0`, `kbd=0.0`. Added `useEffect([cutoff, res, onParamUpdate])` that calls `onParamUpdate({ cutoff, resonance: res })`. ENV AMT and KBD knobs remain visual-only state (Phase 6 will wire them). Wired `<VcfModule onParamUpdate={audio.updateVcfParams} />` in MoogShell.

**Gemini corrections:**
- Rejected exposing `updateVcfParams` through `MoogPatchContext` — same wrong abstraction as Phase 4. Prop-drilling from `MoogShell` is correct.
- `vcf.current` in Gemini's description was wrong — node lives at `nodesRef.current.vcf`.
- No `KnobPlaceholder` replacements needed — Phase 2 had already installed `MoogKnob` on all VCF controls.
- Fixed VCF node init frequency to 20000 Hz to match the UI default — Gemini's plan left an implicit init/UI mismatch.

---

### [2026-06-03] Moog Phase 4 — VCO Panel Wiring

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Added `updateVcoParams(vcoId, { hz, detune, type })` (useCallback, empty deps). Looks up `nodesRef.current[vcoId]` (vco1/vco2/vco3); calls `vco.frequency.rampTo(hz, 0.05)`, `vco.detune.rampTo(detune, 0.05)`, and `vco.type = type` for each provided field. Returned from the hook.
- `src/components/MoogModular/MoogShell.jsx` — Rewrote `VcoModule`. Replaced the continuous `wave` knob (wrong for a discrete waveform selection) and the static `ToggleSwitch` pairs with click-to-cycle selectors. State: `freqBase` (0–1, default 0.5), `fineTune` (0–1, VCO2=0.52/VCO3=0.48 for built-in analog detuning), `waveType` (string, default 'sawtooth'), `rangeOctave` (int -2..+2, default 0). `useEffect` on all four: exponential Hz map (C1=32.703 Hz → C6=1046.502 Hz), `rangeOctave` octave multiplier, `fineTune` → ±100 cents, calls `onParamUpdate`. `VcoModule` receives `onParamUpdate` prop (prop-drilled from MoogShell, not via MoogPatchContext which owns cable state only). All three VcoModules wired: `onParamUpdate={audio.updateVcoParams}`.
- `src/components/MoogModular/MoogShell.module.css` — Added `.selectorRow`, `.selectorGroup`, `.selectorLabel`, `.selectorValue` styles: inset dark display pill, hover/active accent, hardware-literal palette. Removed duplicate Phase 3 entry from Future Phases.

**Gemini corrections:**
- Rejected exposing `updateVcoParams` through `MoogPatchContext` — that context owns cable routing, not audio control. Prop-drilling from `MoogShell` is the correct and simpler path.
- `vco.current` in Gemini's description was wrong — nodes live at `nodesRef.current[vcoId]`.
- Replaced the continuous WAVE knob with a click-to-cycle selector — a 0–1 knob cannot map meaningfully to discrete waveform types.

---

### [2026-06-02] Moog Phase 3 — Audio Architecture & Patch Bridge

**Files created:**
- `src/components/MoogModular/useMoogAudio.js` — Tone.js audio hook. 15 nodes created in `useEffect([], [])`, disposed on unmount: `vco1/2/3` (Tone.Oscillator), `noiseW/P` (Tone.Noise), `cp3ch1–ch4` (Tone.Gain 0.8), `cp3bus` (Tone.Gain 0.7), `vcf` (Tone.Filter lowpass rolloff -24), `vca` (Tone.Gain 1.0), `env1/2` (Tone.Envelope), `lfo` (Tone.LFO), `master` (Tone.Volume -12 dB → Destination). `buildJackMap(n)` maps all 52 jack IDs to `{type:'out', node, waveform?}` or `{type:'in', dest}` port descriptors; deferred jacks have `dest: null` (silently no-op on connect). `powerOn()`: `await Tone.start()`, starts VCOs/noise/LFO, hardwires cp3ch1–4→cp3bus and vca→master (once only via `hardwiredRef`). `powerOff()`: stops sources. `connect(fromId, toId)`: sets VCO/LFO waveform if `from.waveform`, calls `from.node.connect(to.dest)`. `disconnect`: tracks connections in a Map, calls `node.disconnect(dest)`.

**Files modified:**
- `src/components/MoogModular/MoogPatchContext.jsx` — Added `onCableAdded`/`onCableRemoved` callback props to `MoogPatchProvider` (stored in refs — never in useCallback deps). Added `cableSetRef` (Set of `"fromId→toId"` strings) for synchronous O(1) duplicate detection. Added `cablesRef` (mirror of cables state) for synchronous cable lookup in `removeCable`. Added `setCables` wrapper that keeps `cablesRef` in sync. Audio bridge callbacks called OUTSIDE setState updaters to avoid React purity violations.
- `src/components/MoogModular/MoogShell.jsx` — Added `import useMoogAudio`. Added `PowerSwitch` component (reuses `.toggle`/`.toggleLever` CSS, lever turns green on `isPowered`). Added `IoModule` component (plate header "I/O", POWER toggle, MASTER VOL knob, SPKR jack). `MoogShell` now calls `const audio = useMoogAudio()` and passes `onCableAdded={audio.connect}` / `onCableRemoved={audio.disconnect}` to `<MoogPatchProvider>`. Row 4 second panel replaced with `<IoModule isPowered={audio.isPowered} onPower={audio.powerOn} />`.

**How to hear audio (Phase 3 workflow):**
1. Click POWER (I/O module, Row 4) — `Tone.start()` resumes AudioContext; VCOs drone at 220 Hz
2. Draw cable `vco1-saw` → `cp3-in1` → VCO1 waveform set to sawtooth, connects to CP3 ch1
3. Draw cable `cp3-out` → `vcf-in` → CP3 bus to VCF
4. Draw cable `vcf-out` → `vca-in` → VCF to VCA (hardwired VCA→Master→Destination on powerOn)
5. Hear filtered sawtooth wave through speakers

---

### [2026-06-02] Moog Phase 7 — Visual Patch Cable Simulation

**Files created:**
- `src/components/MoogModular/MoogPatchContext.jsx` — React Context. `cables` state (`[{id,fromJackId,toJackId,color}]`); `jackRefs` mutable Map (id→HTMLElement, no re-renders on registration); `dragRef` (`{active,fromJackId,color}`). Functions: `registerJack/unregisterJack`, `startDrag` (pre-assigns cable color from 6-color vintage palette), `completeDrag` (deduplicates, advances color index), `cancelDrag`, `removeCable`. All callbacks have empty deps (only touch refs + stable `setCables`).
- `src/components/MoogModular/PatchCableOverlay.jsx` — SVG `position:absolute; inset:0; overflow:visible; z-index:50`. `getSvgCoords` divides `getBoundingClientRect` screen-space deltas by `svgRect.width / svgEl.offsetWidth` to correctly handle `transform:scale()` on the cabinet parent. `cablePath` computes cubic bezier drooping downward (`drop = max(50, min(|dy|×0.4+65, 180))`). Committed cables rendered as `<path>` with `pointerEvents="stroke"` + drop-shadow filter; click removes cable. Active drag path updated imperatively via `setAttribute('d',...)` — zero React re-renders during drag. Window `mousemove`/`mouseup` always attached (early-exit when `dragRef.current.active === false`). Drop detection: `document.elementFromPoint` → ancestor walk for `data-jack-id`. `justEndedRef` prevents accidental cable removal on drag release. `useReducer` forceUpdate on `window.resize` repositions committed cables.
- `src/components/MoogModular/PatchCableOverlay.module.css` — minimal overlay positioning.

**Files modified:**
- `src/components/MoogModular/MoogShell.jsx` — `Jack` upgraded: `useRef`+`useEffect` for DOM registration, `data-jack-id` attribute, `cursor:crosshair`, `onMouseDown` → `startDrag`. All 52 jacks given unique IDs (VCO1-3: `vco{n}-{cv/fm/sin/tri/saw/sqr}`; Noise: `noise-{wht/pnk}`; CP3: `cp3-{in1-4/out}`; VCF: `vcf-{in/cv1/cv2/env/out}`; LFO: `lfo-{sync/sin/tri/sqr/saw}`; VCA: `vca-{in/cv/out}`; ENV1/2: `env{1|2}-{gate/trig/out}`; Mult: `mult-{a|b}{1-4}`). `VcoModule` derives prefix from `number` prop; `EnvelopeModule` derives from `label` via `.toLowerCase().replace(/\s+/g,'')`. Wrapped in `<MoogPatchProvider>` + `<PatchCableOverlay />` added as first child of `.cabinet`.
- `src/components/MoogModular/MoogShell.module.css` — `position: relative` added to `.cabinet` to anchor the overlay.

**Audio wiring deferred** to "Moog Phase 7 (audio wiring)" future phase, which requires Phase 3 first.

---

### [2026-06-02] Moog Phase 1.6 — Photorealistic UI Overhaul

**Files modified:**
- `src/components/MoogModular/MoogShell.module.css` — four targeted visual improvements: **(1) Multi-cabinet layout**: `.rack` is now a gap-only spacer (`gap: 14px`, no background); each `.tier` carries its own walnut `repeating-linear-gradient` background, `border-radius: 6px`, `padding: 6px 10px 8px`, and cabinet `box-shadow` with `inset 0 2px 10px rgba(0,0,0,0.80)` to simulate modules recessed into wood. The outer `.cabinet` is intentionally darker/more muted so each tier reads as its own cabinet unit. **(2) Faceplates**: base color darkened to `#141312`, added `border-right: 1px solid #1c1a18` for clean module edge definition. **(3) Typography**: `plateTitle` bumped to `#cec5a2` (more ivory/cream, matches vintage silkscreen) and `multBankLabel` updated to match. **(4) Jacks**: size 16→18px, ring warmed to `#888078`, thicker `border: 2.5px`, added `inset 0 1px 0 rgba(168,162,150,0.32)` top-edge ring highlight. Screws: slightly brighter face highlight.
- `src/components/MoogModular/MoogShell.jsx` — removed 3 × `<TierSep />` (spacing now handled by `gap: 14px` on `.rack`).

**Gemini directives rejected:**
- Layout restructuring (Row 1–4 signal-flow order is correct; Phase 1.5 work preserved)
- 960 Sequencer 3×8 placeholder (Phase 9; building throw-away UI now is scope creep)
- "Fixed Filter Bank" placeholder (not in MOOG_ARCHITECTURE.md, no signal-flow definition)
- Complete knob redesign ("black fluted skirts" — Phase 1c silver aesthetic is correct and verified)

---

### [2026-06-02] Moog Phase 2 — Tactile Knob Component

**Files created:**
- `src/components/MoogModular/MoogKnob.jsx` — fully controlled knob component. Props: `value` (0–1), `onChange`, `label`, `size` (xl/lg/md/sm), `defaultValue`. CSS rotation maps value → −135° to +135° (270° travel). Drag: `mousedown` captures `startY` + `startValue` via closure; `mousemove` on `window` computes `startValue + (startY − currentY) / range` where range is 100px normal / 400px with Shift held (4× fine mode). `mouseup` cleans up listeners + restores cursor. `dblclick` fires `onChange(defaultValue)`. `will-change: transform` on knob body for GPU compositing.
- `src/components/MoogModular/MoogKnob.module.css` — complete knob CSS: silver radial-gradient face, dark indicator line (`.knobCap`), fixed scale tick marks (`.knobScale`/`.tickArm`/`.tickLine`/`.tickMajor`/`.tickNum`). `cursor: ns-resize`, `user-select: none`, `touch-action: none` on knob body.

**Files modified:**
- `src/components/MoogModular/MoogShell.jsx` — removed `KnobPlaceholder`, `KnobScale`, `TICK_COUNT/MIN_ANGLE/MAX_ANGLE` (all moved to `MoogKnob.jsx`). Added `import { useState }` + `import MoogKnob`. Each module component now owns local `useState` for its knob values (`VcoModule` freq/fine/wave; `Cp3MixerModule` ch1–ch4/master; `VcfModule` cutoff/res/envAmt/kbd; `LfoModule` rate/level; `VcaModule` gain/envAmt; `EnvelopeModule` attack/decay/sustain/release; `NoiseModule` level). **Phase 3 must lift this local state up to `MoogShell` and convert to refs for audio wiring.**

---

### [2026-06-02] Moog Phase 1.5 — Massive Visual Expansion (4-Tier Rack)

**Files modified:**
- `src/components/MoogModular/MoogShell.jsx` — added 5 new module components: `NoiseModule` (LEVEL knob + WHITE/PINK jacks), `Cp3MixerModule` (4× CH sm knobs + MASTER lg + 5 jacks), `LfoModule` (RATE/LEVEL knobs + SYNC toggle + 5 output jacks), `MultiplesModule` (2× bank-of-4 vertical jack columns, no knobs), `SequencerReservedPanel` (blank + 960 SEQUENCER label). Reorganized from 3-tier to 4-tier rack: Row 1 (VCO×3 + Noise), Row 2 (CP3 + VCF + LFO), Row 3 (VCA + ENV×2 + Multiples), Row 4 (two Sequencer reserved blanks).
- `src/components/MoogModular/MoogShell.module.css` — thickened walnut cabinet (padding 12→16px vertical, 20→28px horizontal; triple-ring box-shadow 3/6/8px vs old 2/4px); added diagonal micro-texture to `.plate` via two `repeating-linear-gradient` overlays at 118° and 208° (simulates stamped metal); strengthened directional knob drop shadow (6px/18px + 10px/28px ambient vs old 5px/14px); strengthened jack drop shadow (3px/8px); replaced `.tierVco/.tierFilt/.tierEnv` with `.tierRow1–4` grid classes; added `.multiplesGrid`/`.multBank`/`.multBankLabel` for Multiples layout; added `.blankSub` for SequencerReservedPanel.
- `src/components/MoogModular/MOOG_ARCHITECTURE.md` — added §7 CP3 Mixer, §8 Noise Generator, §9 Multiples specs. Former §7 I/O renumbered to §10. Updated implementation roadmap to include Phase 1.5 ✅ and Phases 8a/8b.
- `src/components/MoogModular/MOOG_PLAN.md` — this log entry; updated Phase 8 note to reflect visual is done; added Phase 8a (CP3 wiring) and Phase 8b (Noise wiring).

---

### [2026-05-28] Moog Phase 1c — Knob Silver Redesign + Scale Marks

**Files modified:**
- `src/components/MoogModular/MoogShell.jsx` — added `KnobScale` component (11 tick marks, 270° arc, −135° to +135°). `KnobPlaceholder` now wraps knob in `.knobWrap` alongside `<KnobScale>`. Numbers (0 / 5 / 10) shown on `xl` + `lg` sizes only; counter-rotated inline so they stay upright at all arc positions.
- `src/components/MoogModular/MoogShell.module.css` — complete knob and jack visual overhaul.

**Knob changes:**
- Top face: three-layer radial gradient — sharp specular highlight ellipse (top-left, simulating studio lamp) + warm secondary bounce + `#d8d5ce → #464640` silver-to-pewter base. Indicator line inverted to dark `#1a1a18` for contrast against silver.
- Skirt ring: `box-shadow` layers `0 0 0 2px #141414 / 0 0 0 4px #888880 / 0 0 0 5px #1a1a18` — dark gap → brushed silver ring → outer edge.
- `.knobWrap` sizing: 76/62/48/38px for xl/lg/md/sm — contains both the knob and the scale ring.

**Scale marks:**
- 11 `tickArm` divs rotating around `transform-origin: 50% 100%` (circle center).
- Minor ticks: 4px, `rgba(180,168,138,0.52)`.
- Major ticks (i=0,5,10): 7px, `rgba(210,198,162,0.82)`.
- `tickNum` labels sit at `top: -7px` (just outside the arc), counter-rotated per-tick via inline `rotate()`.

**Jack changes:**
- Ring color changed from brass `#c09850` → silver `#909088` to match knob skirt language.
- Added outer `0 0 0 1px rgba(200,196,186,0.25)` glow to simulate polished ring catching light.

---

### [2026-05-28] Moog Phase 1b — Layout Compaction + Wood-Border Fix

**Files modified:**
- `src/components/MoogModular/MoogShell.jsx` — removed all space-wasting elements: `tierLabel` (×3), `tierRail` (×2), `cabinetFloor`, `footerStamp`. Replaced `tierRail` with slim `<TierSep />` (4px machined-metal strip).
- `src/components/MoogModular/MoogShell.module.css` — full layout compaction.

**Layout changes:**
- `.shell`: `height: 100vh; justify-content: center; padding: 18px 16px` — whole cabinet fits in one viewport, no scrolling required.
- `.rack`: `background: #0e0c0a` covers entire interior — wood shows ONLY at cabinet padding edges (12/20/14px). No wood between tiers.
- `.tier`: `padding: 0; gap: 2px` — modules are flush; 2px inter-module gap is the rack's dark metal, not wood.
- `.module`: removed `min-height: 280px` hard constraint — content determines height naturally.
- All internal spacing (plate padding, gap, font sizes) reduced for compact fit.

---

### [2026-05-27] Moog Phase 1 — Visual Shell + Routing

**Files created:**
- `src/components/MoogModular/MoogShell.jsx` — main container with 3-tier rack: VCO bank (×3), VCF + VCA, Envelope (×2) + blank panel. Sub-components: `Screw`, `KnobPlaceholder`, `Jack`, `ToggleSwitch`, `VcoModule`, `VcfModule`, `VcaModule`, `EnvelopeModule`, `BlankPanel`. No audio, no state — pure visual scaffold.
- `src/components/MoogModular/MoogShell.module.css` — CSS-only 1960s hardware aesthetic: walnut wood cabinet (multi-layer `repeating-linear-gradient`), matte charcoal module faceplates, cream/ivory labels, Bakelite knob radial gradients, brass jack sockets, metallic corner screws.
- `src/components/MoogModular/MOOG_PLAN.md` — this file; project roadmap and phase log.
- `src/components/MoogModular/MOOG_ARCHITECTURE.md` — module signal-flow spec and Tone.js implementation blueprint.

**Files modified (one-time routing exception):**
- `src/Root.js` — added `moogmodular` page branch, imported `MoogShell`
- `src/components/HomePage/HomePage.jsx` — added third nav button `[ Moog Modular ]`
- `src/components/HomePage/HomePage.module.css` — added `.moogBtn` with walnut/brass border color scheme

**Design decisions:**
- Walnut grain via three layered `repeating-linear-gradient`s (no images, pure CSS)
- Screw heads use `radial-gradient` + `::before/::after` Phillips cross, `position: absolute` in module corners
- CSS Grid for tier layouts: `repeat(3,1fr)` / `2.1fr 1fr` / `1fr 1fr 1.2fr`
- Home button `position: fixed` so it's always reachable
