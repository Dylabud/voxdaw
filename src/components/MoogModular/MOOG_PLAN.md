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

### Moog Phase 2 — Tactile Knob Component
- Build `MoogKnob.jsx` + `MoogKnob.module.css` inside `src/components/MoogModular/`
- Interaction: vertical mouse-drag → CSS rotation (−135° to +135° travel)
- Props: `value` (0–1), `onChange`, `label`, `size`, optional `defaultValue`
- Internal state only — no React state in rAF loop (will be pure controlled component)
- Replace all `<KnobPlaceholder />` uses in `MoogShell.jsx` with `<MoogKnob />`
- Hold Shift for fine mode (4× slower rotation per pixel)
- Double-click to reset to `defaultValue`

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

### Moog Phase 8 — LFO Module
- New `LfoModule` component in `MoogShell.jsx`
- `Tone.LFO` node in `useMoogAudio.js`
- Rate and depth knobs
- Patch to VCF cutoff, VCO frequency, or VCA gain

### Moog Phase 9 — Visual Polish
- Animated indicator LEDs (env activity, VCO trigger)
- Knob tooltip labels on hover
- Module-level bypass switches
- Cabinet aging effects (subtle vignette, worn edges)
- Mobile / narrow viewport fallback

---

## Completed Phases Log

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
