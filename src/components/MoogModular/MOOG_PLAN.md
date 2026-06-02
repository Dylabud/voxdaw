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

### Moog Phase 3 — Audio Architecture (`useMoogAudio.js`)
- Create `src/components/MoogModular/useMoogAudio.js` (peer hook, never added to `useAudioEngine`)
- Initialize nodes: 3× `Tone.Oscillator`, 1× `Tone.Filter` (ladder type), 2× `Tone.AmplitudeEnvelope`, 1× `Tone.Volume`, CP3 summing bus (`Tone.Gain` × 5), 2× `Tone.Noise`
- Architecture: do NOT hardwire permanently — expose `connect(srcRef, destRef)` / `disconnect(srcRef, destRef)` for future patch cable simulation
- Default wiring for immediate sound: VCO1 → CP3 → VCF → VCA → Destination
- Expose `startMoog()` / `stopMoog()` lifecycle (requires user gesture before `Tone.start()`)
- **State migration:** lift the local `useState` values currently in each module component up to `MoogShell`, convert to refs, and wire knob `onChange` callbacks → audio node params via `.rampTo(value, 0.02)`
- Single writer per node rule applies here too

### Moog Phase 3 — Audio Architecture (`useMoogAudio.js`)
- Create `src/components/MoogModular/useMoogAudio.js` (peer hook, never added to `useAudioEngine`)
- Initialize nodes: 3× `Tone.Oscillator`, 1× `Tone.Filter` (ladder type), 2× `Tone.AmplitudeEnvelope`, 1× `Tone.Volume`
- Architecture: do NOT hardwire permanently — expose `connect(srcRef, destRef)` / `disconnect(srcRef, destRef)` for future patch cable simulation
- Default wiring for immediate sound: VCO1 → VCF → VCA → Destination
- Expose `startMoog()` / `stopMoog()` lifecycle (requires user gesture before `Tone.start()`)
- Wire knob `onChange` callbacks → audio node params via `.rampTo(value, 0.02)`
- Single writer per node rule applies here too

### Moog Phase 4 — VCO Panel Wiring
- Connect VCO 1/2/3 frequency knobs → `oscillator.frequency.rampTo()`
- Fine tune knob → frequency offset in semitones
- Waveform selector knob → `oscillator.type` (sine/triangle/sawtooth/square)
- Range toggle → octave multiplier
- Detune VCO 2/3 slightly from VCO 1 for classic analog thickness

### Moog Phase 5 — VCF Panel Wiring
- Cutoff knob → `filter.frequency.rampTo()`
- Resonance knob → `filter.Q.rampTo()`
- Envelope Amount knob → envelope-to-cutoff routing amount
- Keyboard tracking knob → pitch-proportional cutoff offset

### Moog Phase 6 — Envelope + VCA Wiring
- ADSR knobs → `envelope.attack/decay/sustain/release`
- VCA Gain knob → `volume.volume.rampTo()`
- Add keyboard (MIDI-style) trigger: on-screen keys or computer keyboard (A-K = notes)

### Moog Phase 7 — Patch Cable Simulation
- Visual patch cables as SVG bezier curves between jacks
- Drag from one jack to another to create a connection
- Store connections as `[{ srcModuleId, srcJack, destModuleId, destJack }]`
- Color-coded cables (random per patch)
- Dynamic `connect()` / `disconnect()` to `useMoogAudio.js`

### Moog Phase 8 — LFO Module (Audio Wiring)
- Visual scaffold already complete (Phase 1.5) — Rate, Level knobs + SYNC toggle + 5 output jacks exist
- Wire `Tone.LFO` node in `useMoogAudio.js`
- Rate knob → `lfo.frequency.rampTo()`, Level knob → LFO amplitude
- Patch cable simulator (Phase 7) handles routing to VCF cutoff / VCO frequency / VCA gain

### Moog Phase 8a — CP3 Mixer Audio Wiring
- Prerequisite: Phase 3 (audio architecture) complete
- Four `Tone.Gain` channel nodes + summing master `Tone.Gain` bus in `useMoogAudio.js`
- Wire CH1–CH4 gain knobs + MASTER knob → node params via `.rampTo()`
- Optional soft-clipping `WaveShaperNode` on the summing bus output for drive character

### Moog Phase 8b — Noise Generator Audio Wiring
- Two `Tone.Noise` instances (white + pink) each through a `Tone.Gain` in `useMoogAudio.js`
- Wire LEVEL knob → gain node
- Separate output refs for WHITE and PINK jacks for patch cable routing

### Moog Phase 9 — Visual Polish
- Animated indicator LEDs (env activity, VCO trigger)
- Knob tooltip labels on hover
- Module-level bypass switches
- Cabinet aging effects (subtle vignette, worn edges)
- Mobile / narrow viewport fallback

---

## Completed Phases Log

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
