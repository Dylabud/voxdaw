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

### Moog Phase 8b — Noise Generator Audio Wiring
- Three `Tone.Noise` pairs (noiseW/P, noise2W/P, noise3W/P) each through a `Tone.Gain` in `useMoogAudio.js`
- Wire LEVEL knob → gain node per instance
- Separate output refs for WHITE and PINK jacks for patch cable routing

### Moog Phase 12 — Visual Polish
- Knob tooltip labels on hover
- Module-level bypass switches
- Mobile / narrow viewport fallback

---

## Completed Phases Log

### [2026-07-04] Bug Fix — Black-Flashing Modules (GPU layer thrash from Phase 53's `will-change`)

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`

**Symptom (Dylan):** modules flashed black for ~a second on ENV gate-button presses and when switching back to the tab.

**Root cause:** Phase 53 put a static `will-change: transform` on `.cabinet`, permanently promoting the entire rack (~2900×1750 px of turbulence textures, layered shadows, and a blend-mode overlay) to a single giant composited GPU layer (~80 MB at DPR 2). Any small invalidation inside it (the gate button's `:active` transform — the handler itself touches no React state) forced tile re-rasterization of the giant layer, and slow tiles paint **black** until ready. Tab switch-away evicts the layer's GPU memory → tab return re-rasters everything → same flash.

**Fix — transient promotion:** removed the static `will-change`; the camera now sets `el.style.willChange = 'transform'` imperatively on wheel/pan/reset activity and releases it 500 ms after the camera settles (`touchWillChange()` + debounced timer). At rest the rack paints as normal screen-space tiles (nothing to evict, small cheap repaints); during zoom it's composited and smooth. Side benefit: releasing the layer re-rasters the rack at the current zoom scale, so a zoomed-in view snaps crisp instead of staying blurry-scaled.

**Verified (Playwright):** willChange `(empty)` at rest → `transform` immediately after wheel → `(empty)` 800 ms later; gate press causes no promotion churn; Esc reset exact; zero console errors; build compiles.

### [2026-07-04] Rack Densification — Maximize On-Screen Component Size (Phase 54, Dylan-driven)

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`, `MoogKnob.jsx`, `MoogKnob.module.css`, `Led.module.css`, `KeyboardModule.jsx`, `KeyboardModule.module.css`

Dylan: "everything is too small — maximize the modules." Under fit(), uniform px inflation is a no-op (Phase 53 lesson), so the win came from **non-uniform** changes: cutting vertical slack (raises the fit scale) + growing components into under-filled space. Measured-first with a Playwright geometry script (per-tier heights, per-module slack).

**Result: controls ~28% bigger on screen.** natH 1858→1744, fit scale 0.506→0.539, on top of components ~+20% natural size. No overlaps (verified full-rack screenshot + zoom drive).

- **Row 4 de-stack (the big one):** the two 960s were stacked in `.seqStack`, making tier 4 **616px — ⅓ of the rack** — and forcing CHORD/QNT/I/O to stretch double-height. Now side-by-side: `tierRow4` = 5 cols `1.5fr 1.5fr 1fr 0.9fr 1.1fr`. Tier 4: 616→409px. (`.seqStack` CSS left as dead class.)
- **I/O slimming (it was the next row-4 driver):** power switch + lamp folded into the MASTER knob row; 4 channel strips converted from stacked rows to a 4-across `.ioChGrid` with the legacy `io-in` jack as a 5th column (`.ioChColSpacer` baseline-aligns it).
- **Component bump ~+20%:** knobs xl 54/94→64/104, lg 42/76→50/86, md 32/58→38/66, sm 25/46→30/52, xs 18/22→22/26 (BODY_PX/WRAP_PX + `.knob_*` classes must stay in sync). Jacks 24→29 (socket 16→20, hole 8→10). LED bezel 14→17 / glass 9→11; seq/kick/power/ffb/voc/qnt LEDs all bumped. Toggles 11×22→13×26. Gate button 22→26.
- **Typography:** plateTitle 20→22, plateSub 10→11, knobLabel 11→13, jackLabel 11→13, selectorValue 15→17, toggle/selector/gate labels 10→11, ledLabel 5→7, tickNum 7→8, qntDisplay 8→10.
- **Slack trims:** plate padding 11→10 (+gap 6→5), cabinet padding 18/22→14/18, kbdBarrier 20→14.
- **Coupled geometry updated:** `.seqCtrl` min-width 86→96 (lg wrap); `.seqProbSlider` 84px/−42px → 96px/−48px (step height).
- **Keyboard widened to fill its strip:** WW 20→30, BW 12→18; `SEMI_BLACK` now **derived** from the documented formula (`nextWhiteIdx × WW − BW/2`) instead of hardcoded. **Gotcha found:** white keys are flex children sized by CSS (`.whiteKey width`) while black keys use inline `WW`-derived lefts — the CSS width must equal `WW` or black keys detach (comment added).

**Verified:** geometry re-measured (tiers 360/344/329/409); zoom camera re-driven post-layout (knob drag doesn't pan, Esc restores base scale 0.539); zero console errors; production build compiles.

### [2026-07-04] Viewport Camera — Wheel Zoom + Drag Pan (Phase 53, from a Gemini blueprint — largely rejected)

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`, `MoogKnob.module.css`

Gemini's "High-Readability" phase. The legibility complaint was real; the prescription was mostly wrong — the one sound idea (a zoom/pan viewport) was implemented, the rest rejected.

**Implemented — viewport camera (`MoogShell.jsx` fit effect, rewritten):**
- `transform: translate(tx,ty) scale(s0·z)` on the cabinet, origin `0 0`; `s0` = fit scale (the zoomed-out home state, unchanged math), `z` = user zoom 1–8×. Cabinet gains `align-self: flex-start` so its layout origin is the shell's content corner — translate math needs no centering compensation (horizontal centering at rest comes from fit's width compensation making scaled width == availW exactly).
- **Wheel/pinch zooms toward the cursor** (`t' = p − ((p−t)/S)·S'`; ctrlKey = trackpad pinch, larger factor). **Drag empty faceplate pans** when zoomed. **Esc / double-click empty plate** animates back (0.35s transition, cleared after).
- **Interactivity detection with zero per-component markup:** `cursor` is an inherited CSS property and every control in the rack resolves to `pointer`/`ns-resize` (knobs, jacks, keys, selectors, cables) while bare faceplate resolves to `auto` — one `getComputedStyle(target).cursor` check (+ `closest('button, input, select, [data-jack-id]')`) gates pan/dblclick-reset. Knob drags, cable drags, and piano keys all work while zoomed.
- All view state in the effect closure; direct style writes only (Zero-Re-render Rule). Pan clamped so the rack never detaches from the viewport. `will-change: transform` on the cabinet. Cables need no changes: the overlay lives inside the cabinet (transforms with it) and `getSvgCoords` derives scale from bounding-rect ratios (new drags while zoomed land correctly — verified).
- Label contrast bump (~+0.08–0.10 alpha on knob/jack/plate-sub/toggle/selector/gate labels) keeping the Phase 52 worn warm tone. Cap polish: brushing-ring contrast halved + specular tamed so caps read clean at 8×.

**Rejected from Gemini's blueprint (with reasons):**
- **"+25% components / +30% fonts" — a mathematical no-op under fit():** `scale = availH/natH`; inflating components inflates natH, fit() scales down by the same factor → identical on-screen size. Only a camera can change perceived size in this architecture.
- **"Scrolling rack" (`overflow-y: auto`)** — the exact documented fit()-breaking proposal from Phases 27–29 (feedback memory item #6); also sacrifices the whole-instrument view. Zoom subsumes it (a zoomed view pans vertically).
- **"High-contrast crisp sans-serif"** — reverses Gemini's own Phase 52 "worn heat-stamped, NOT crisp modern print" directive (third self-reversal in three phases). Kept the period lettering; slight alpha bump only.
- **Module glow/borders** — real System 55 modules don't glow; contradicts Phases 51–52 photorealism.
- **Phase number 46** — already taken (vocoder Daft-Punk chain).

**Verified (Playwright-driven):** wheel zoom to 8× clamp toward cursor; knob drag while zoomed does not pan the view; pan works and clamps; cable drawn while zoomed lands dead-center on jacks; Esc restores the exact base transform (`translate(0,0) scale(0.50592)`); zero console errors; production build compiles.

### [2026-07-04] Period-Correct System 55 Component Pass (Phase 52, from a Gemini blueprint — partially rejected)

**Files modified:** `MoogKnob.module.css`, `MoogShell.module.css`, `Led.module.css`, `PatchCableOverlay.jsx`

Refinement pass on Phase 51 toward the exact vintage System 55 components. All static paint; no JSX changes except the cable layer removal. (Gemini labeled this "Phase 45"; renumbered — 45 was Vocoder Synth Expansion.)

- **Spun-aluminum knob caps:** new `.knob::before` (inset 22%) — brushed-metal disc via concentric `repeating-radial-gradient` brushing rings blended over a radial falloff, seated with an inset ring shadow. Pseudo-element ⇒ no JSX change; it rotates with the knob (physically correct) and concentric rings are rotationally symmetric so rotation never shimmers. `.knobCream::before { content: none }` — cream 960 dials stay solid bakelite.
- **Two-segment pointer line:** `.knobCap` now runs rim→center (top 6%, height 44%) with a single gradient: white-filled tick on the skirt (0–35%) → dark engraved line across the aluminum cap (37–100%); breakpoint = cap edge at (22−6)/44 ≈ 36%. Gemini's "black line to the skirt edge" was rejected as physically incoherent (invisible on a black skirt); the real 900-series fills the skirt segment.
- **Deeper cast shadows:** `.knobShading` outer pair bumped to `-7px 10px 16px` + `-3px 4px 6px` (long-soft + short-hard sells skirt height). Still screen-fixed via the counter-rotation identity.
- **Worn heat-stamped lettering:** all label classes (`plateTitle/plateSub/jackLabel/toggleLabel/selectorLabel/gateBtnLabel/knobLabel`) moved from pure white to warm off-white `rgba(234,229,217,…)` + faint ink-bleed `text-shadow`.
- **Abrasive plate finish:** grain turbulence bumped (baseFrequency 0.85→0.95, 3 octaves, alpha 0.16→0.22).
- **Jack thread:** concentric micro-rings on `.jack::before` — open-frame Switchcraft mounting-thread read inside the recess.
- **Cables → smooth rubber:** braid dash layer removed (Gemini reversed its own Phase 51 braid directive; rubber is the period-correct jacket anyway); sheen dulled and broadened (0.25/1.6px → 0.12/2.6px).
- **Jewel-lamp facets:** `.led::after` cut-glass facet overlay (repeating-conic wedges + warm hotspot). Lives on the glass so it fades with the rAF opacity — facets show only when lit.
- **Wood:** grain streak alpha raised (0.55→0.68) for more visible walnut figure.

**Rejected from Gemini's blueprint (with reasons):**
- **"Maintain upper-left lighting"** — nothing to maintain; lamp has always been upper-right and Dylan settled this in Phase 51. Kept upper-right.
- **Grey/black-only cables** — the 6-color palette is load-bearing UX for tracing patches on a dense rack; texture changed, palette kept.
- **"Sync-Lock / Cycle-Peak / Prob. Flicker LEDs"** — still-hallucinated feature names; facet treatment applied to the real `Led` component.
- **Phase number 45** — already taken.

**Verified:** production build compiles (warnings pre-existing); Playwright full-rack + close-up screenshots, zero console errors.

### [2026-07-04] Photorealistic Material Overhaul (Phase 51, from a Gemini blueprint — partially rejected)

**Files modified:** `MoogKnob.jsx`, `MoogKnob.module.css`, `MoogShell.jsx`, `MoogShell.module.css`, `Led.jsx`, `Led.module.css`, `PatchCableOverlay.jsx`

Full material/lighting pass — all static CSS/SVG paint, zero runtime cost, Zero-Re-render Rule untouched. (Gemini labeled this "Phase 44"; renumbered — 44 was Vocoder Loudness.)

- **Knobs (flagship):** silver knobs → **black skirted vintage bakelite** with white pointer line; **cream/ivory variant** on the 960 step dials (photo-accurate two-tone). New `variant` prop on `MoogKnob` (`'black'` default | `'cream'`). Fluted skirt = `repeating-conic-gradient` on the rotating `.knob` (physical — flutes spin with the value); dome cap = opaque-center radial layer above it. **Shadow physics:** `.knobShading` counter-rotates (−θ inside +θ ⇒ net screen transform is identity), so both its speculars AND the new directional outer drop shadow (`-5px 7px`, lamp upper-right → shadow lower-left) render screen-fixed at every knob position; only rotationally-symmetric ring shadows stay on `.knob`.
- **Faceplate:** glossy piano-black → matte crinkle-black with micro-grain via inline SVG `feTurbulence` data-URI (rasterized once, tiles as background-image); specular toned down.
- **Screws:** 7→8px, lamp-aligned highlight (68% 22%), cast shadow lower-left, per-corner slot rotation (18/−11/−27/7°).
- **Jacks:** hex mounting-nut facets — `repeating-conic-gradient` 60°-period seam lines over the chrome ring; directional cast shadow.
- **Cables (`PatchCableOverlay`):** each committed cable is now a 5-layer group — blurred cast-shadow path (`translate(-3,6)`, `feGaussianBlur`), base stroke (6px, sole interactive layer), braid dash overlay, cylindrical sheen line, and **plug hardware at both ends** (nickel collar + cable-colored strain-relief boot; endpoint tangents are exactly vertical because the bezier control points sit directly below the jacks, so plugs are axis-aligned rects). Active drag path unchanged (imperative).
- **LEDs:** new `.ledBezel` wrapper (chrome conic ring + recessed seat) around the lamp glass — separate element because the rAF fades `opacity` on the glass only; the housing must not fade. **Lights-out:** bezel background/box-shadow killed via `:global([data-lights-out])` (an unlit bezel reflects nothing in a dark room — without this, grey dots float in the darkness).
- **Toggles:** bat-handle chrome levers + mounting collar. **Power lamp:** chrome jewel bezel (persists when dark — class-swap, not opacity).
- **Wood:** deepened to reference walnut (`#522410`–`#904c24`), organic grain via horizontally-stretched `feTurbulence` (baseFrequency `0.009 0.11`); kbdBarrier matched.
- **Lamp:** `.lightOverlay` warmed + brightened (`rgba(255,253,246,0.13)` peak).

**Rejected from Gemini's blueprint (with reasons):**
- **Light from upper-left** — the entire existing system (lamp overlay, plate speculars, jack conics, knob shading) is built around the upper-right lamp at `78% 18%`; mirroring everything = pure churn for zero realism gain. Kept upper-right, deepened instead (Dylan approved).
- **"Sync-Lock / Cycle-Peak / Prob. Flicker LEDs we added"** — hallucinated feature names; the `Led` component already rendered jewel lamps. Only the bezel was missing.
- **"Flexible cable physics"** — cables already droop via gravity bezier (Phase 7); "physics" scoped to draped cast shadows + plug hardware.
- **Phase number 44** — already taken.

**Verified:** production build compiles (all warnings pre-existing); Playwright screenshots of full rack, module close-ups, patched cables, and lights-out mode.

### [2026-07-02] Chord Seq glide + bigger chord buttons, Keyboard glide staircase fix (Phase 50)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MoogShell.module.css`

Two independent items.

**Chord Sequencer — GLIDE knob + larger chord display buttons (`ChordSeqModule`):**
- Added a `GLIDE` knob (in the selector row beside CLOCK DIV / ROOT OCT) that portamentos the **root/3rd/5th** voice CV outs. Knob maps 0–1 → 0–1.5 s (same convention as the 960 seq + 953 keyboard). New `onGlideChange` prop → `audio.setChordSeqGlide` → new `chordSeqGlideRef`.
- Glide is applied **at each connected VCO's `glideBus`**, not on the `chordSeqRootOut/ThirdOut/FifthOut` signals themselves — those still jump instantly (`setValueAtTime`) because they also feed the analyser/quantizer paths; ramping them would smear the CV other modules sample. This mirrors the established `seq-pitch-out` convention (instant signal, ramp at the bus), so portamento lands *after* any quantizer and never staircases. In the chord `Tone.Loop`, the per-VCO glideBus write is now `chordGlide < 0.001 ? setValueAtTime : rampTo(vhz, chordGlide, time)`. At glide 0 the behavior is byte-for-byte identical to before.
- Enlarged the chord display buttons: `.chordSeqRoot` 26→38px / 14→20px font; `.chordSeqType` 18→26px / 10→13px font.

**Keyboard glide — staircase → pure smooth glide (`vibratoTick` rAF):**
- The kbd glide+vibrato rAF (sole writer of kbd-connected VCO glideBuses) delivered each per-frame Hz with `_param.setValueAtTime(hz, now)` — a **zero-order hold**, so a portamento sweep rendered as ~60 discrete pitch steps (the audible staircase). The JS glide trajectory (`kbdCurrentHzRef` exponential lerp) was already smooth; only the AudioParam delivery was stepped.
- Fix: when glide is active (`glide ≥ 0.001`) use `_param.linearRampToValueAtTime(hz, now + rampAhead)` (rampAhead = `max(dt*2, 1/30)`, ~2 frames of lookahead so the param is always mid-ramp and never holds flat) — audio-rate linear interpolation between frame targets = continuous glide (and smoother vibrato on held notes). Glide-off keeps the instant `setValueAtTime` so note attacks stay snappy (no 32 ms slur on every keypress). Stays in the native `_param` lane (matching the existing deliberate avoidance of Tone's Param event queue); sole-writer means the successive ramps chain cleanly.

### [2026-06-26 → 06-28] Vocoder Condense, Row 3 placement + faceplate rework (Phase 49)

**Files modified:** `MoogKnob.jsx`, `MoogKnob.module.css`, `MoogShell.jsx`, `MoogShell.module.css`

Visual-only (no audio/behavior changes). Moved the vocoder into **Row 3** (8th column; `tierRow3` extended to 8 cols). Added a new ultra-compact **`xs`** knob size (18px body, **no tick ring**, 7px label, tight group gap) — globally available but used only by the vocoder grid. Shortened grid labels (VOL/C.MIX/PWID/S.RT/S.AMP/PRES/CLAR); meter LEDs 5→4px.

Final faceplate (`.vocLayout`, two columns hugging each other, `gap: 2px`):
- **Left** (`.vocLeft`): **MIX + MIC** knobs side by side (same `md` size, MIX left of MIC), with the **ENABLE MIC** button over the **SIG** LED to their right (`.vocMicTop`/`.vocMicCtrls`); the **MOD/CARR/OUT** jacks in a **horizontal** row beneath (`.vocLeftJacks`).
- **Right** (`.vocRight`, `flex: 0 0 auto` so it shrinks to content and sits flush against the left): the remaining **12 knobs** in a spread-out **4×3 `sm` grid** (`.vocKnobGrid`, `gap: 10px 8px`).
- **Spectrum meter** (`.vocMeter`): full-width row of 16 LEDs along the **module bottom**, below both columns.
- **Module width:** the Row 3 vocoder track is `max-content`, so the module hugs its content (no empty faceplate); the other 7 modules share the remaining rack width via `fr`.

### [2026-06-26] Merge EXT IN into the Vocoder (Phase 48)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MoogShell.module.css`, `MOOG_ARCHITECTURE.md`

The standalone EXT IN module existed only to feed the vocoder modulator, so it was merged into the Vocoder as a single module.

- **Audio:** added a permanent `extMicGain → vocModRaw` connection (the modulator pre-chain front). Enabling the mic + a carrier now vocodes instantly with **no patching**; the `MOD` jack still accepts external sources (they sum at `vocModRaw`). Removed the `ext-out` jack from `buildJackMap`. `enableMic`/`disableMic`/`updateExtMicParams`/`extMicGain`/`extMicMeter` unchanged — only the routing + UI host moved.
- **UI:** deleted `ExtInModule`; added a mic row to `VocoderModule` (ENABLE MIC button, SIG LED, MIC IN knob) via new props `onMicEnable`/`onMicDisable`/`onMicGainChange`/`getMicLevel` (wired to the same hook fns + `getExtMicLevel`). New `.vocMicRow` CSS. Row 4 drops back to seq stack / chordseq / qnt / I/O.

### [2026-06-26] Vocoder Knob Cleanup — single VOLUME (Phase 47)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MOOG_ARCHITECTURE.md`

Consolidated the two level knobs (OUT makeup + VOL) into one **VOLUME**. `vocOut` now carries a fixed ×3 internal makeup (the band bank is intrinsically quiet); the single VOLUME knob drives `vocVolume` (the jack node) at 0–2× — so it scales the **whole module** including the CLARITY blend, and combines with the fixed makeup to the same ≤6× ceiling as before. Defaults preserve the prior loudness (VOLUME 0.5 → ×1 → ×3 net). `updateVocoderParams` drops `out`, renames `vol` → `volume`. Grid: 14 → 13 knobs.

### [2026-06-25] Vocoder "Daft Punk" Pre/Post Chain (Phase 46, from a Gemini blueprint — partially rejected)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MOOG_ARCHITECTURE.md`

Implemented the genuinely useful parts of Gemini's Phase 43 plan; rejected the rest with reasons.

**Implemented:**
- **Modulator pre-processing (always on):** `voc-mod-in` now lands on `vocModRaw → vocModHP (highpass 150 Hz) → vocModComp (Tone.Compressor −28/4:1, atk 3 ms, rel 120 ms) → vocModIn`. Removes rumble/plosives + evens drive into the envelope followers. Voice-optimized (a sub-150 Hz modulator loses lows). Filters/compressor need no power start/stop.
- **PRESENCE knob:** peaking EQ (~2.7 kHz, Q 1) on the vocoded output, `vocOut → vocPresence → vocVolume`, knob 0–1 → 0..+12 dB. CLARITY still bypasses it (sums at vocVolume).

**Rejected (with reasons — per the "be critical of Gemini" directive):**
- **Autotune/PitchShifter on the modulator** — fundamental vocoder misunderstanding: output pitch comes from the **carrier**, not the modulator. Retuning the voice barely affects the vocoded output. Gemini conflated a vocoder (play the carrier melody) with autotune (T-Pain). The Daft-Punk robot pitch already comes from the carrier (keyboard→VCO or internal osc).
- **"Hiss" knob** — already exists (Phase 42 HISS = high-passed noise excitation into high bands).
- **"Dry/Wet" knob** — already exists as MIX (Phase 42).
- **Auto-patch "dual sawtooth" carrier** — already solved differently via the internal carrier osc + CARR MIX (Phase 45); programmatic fake patch cables would fight the manual-patch architecture. (Offered: optionally enrich the internal carrier to a detuned dual-saw.)

### [2026-06-25] Vocoder Synth Expansion — 9 new controls (Phase 45)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MoogShell.module.css`, `MOOG_ARCHITECTURE.md`

Added fully-functional controls (no skeletons): PWIDTH, CARR MIX, SHIFT, RES, SH RATE, SH AMP, DECAY, VOL. (A FREQ knob for the internal carrier was added then removed at the user's request — the internal osc now runs at a fixed 130 Hz; PWIDTH/CARR MIX still apply.)

- **Internal carrier oscillator:** `vocCarrOsc` (`Tone.PulseOscillator`) → `vocCarrOscGain`; external `voc-carr-in` → `vocCarrExtGain`; both sum into new `vocCarrSum`, which feeds the band bank **and** `vocDry`. **CARR MIX** crossfades ext↔internal (`vocCarrExtGain`/`vocCarrOscGain`). **PWIDTH** → osc `width` (−0.95..0.95, 0.5=square); osc pitch fixed at 130 Hz (construction). Osc added to all 3 power start/stop arrays. Lets the vocoder run standalone (mic + internal carrier, no patched VCOs).
- **Spectral shift (SHIFT/SH RATE/SH AMP):** new rAF loop (`vocShiftTick`, peer of `vibratoTick`) scales the 16 carrier BPF center freqs by `ratio = base · 2^(ampOct·sin(2π·rate·t))`. SHIFT (ref `vocShiftBaseRef`, ±1 oct), SH RATE (`vocShiftLfoRateRef`, 0.05–10 Hz), SH AMP (`vocShiftLfoAmpRef`, 0–1 oct). **Sole writer** of `vocCarrBPF*.frequency`; delta-gated (`vocShiftLastRatioRef`) so a static shift settles to zero writes. Can't be done with a connected `Tone.LFO` — it's a per-band *multiplicative* ratio across 16 different base freqs.
- **RES:** carrier band Q (1–7, 0.5≈base 4) via `updateVocoderParams` (writes `vocCarrBPF*.Q` — disjoint from the rAF's frequency writes). **DECAY:** the 16 env-follower LP cutoffs (~56 Hz snappy … ~7 Hz smeary, 0.5≈20 Hz) via `vocModEnv*.frequency`.
- **VOL:** new final `vocVolume` node (the `voc-out` jack now taps it); CLARITY routed to `vocVolume` (bypassing the OUT makeup gain) so chain is `wet+dry → vocOut(OUT) → vocVolume(VOL) ← clarity`.
- `updateVocoderParams` now takes `{ mix, out, vol, carrierMix, freq, pwidth, shift, res, shiftRate, shiftAmp, decay, clarity, hiss, buzz }`. All audio-param writes remain single-writer; SHIFT trio are ref-only (consumed by the rAF). UI: 14-knob 4-col grid (`.vocKnobGrid`).

### [2026-06-25] Vocoder Loudness + Intelligibility (Phase 44)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MOOG_ARCHITECTURE.md`

Two user-driven improvements: the vocoder was too quiet when mixed with other instruments, and the words were hard to make out.

- **OUT (makeup gain):** `vocOut` was a fixed `Gain(1)` with no writer; now `updateVocoderParams({ out })` owns it, knob 0–1 → 0–6× (default 0.5 = 3×). Addresses the "intrinsically quiet" nature of a band-gated vocoder (speech only excites a few of the 16 bands at once, so the sum is far below the raw carrier — turning VCOs down doesn't change the *relative* level).
- **CLARITY (voice intelligibility):** new `vocModIn → HP(1.5 kHz) → vocClarityGain → vocOut` path blends the **real voice's** consonants/sibilance straight into the output (bypassing the band bank), knob 0–1 → 0–0.9×. The strongest legibility lever — keeps vocoded vowels while real consonants (s/t/sh/f/k) carry word recognition. Preferred over forcing a faster (buzzier) envelope follower, which would have hurt the smooth synth tone the user also wanted.
- `updateVocoderParams` extended to `{ mix, hiss, buzz, out, clarity }`; all six gains remain single-writer (env followers still own the per-band VCA gains). UI: VocoderModule now has MIX/OUT (lg) on row 1 and CLARITY/HISS/BUZZ (sm) on row 2.
- **Why not HISS for clarity:** HISS is *synthetic* noise-sibilance through the high bands; CLARITY is the *actual* voice — far more intelligible. Both retained (different character).

### [2026-06-24] EXT IN — External Mic Input (Phase 43)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MoogShell.module.css`, `MOOG_ARCHITECTURE.md`

Added a live microphone as a patchable audio source so the user can sing through the vocoder (`ext-out → voc-mod-in`, VCOs → `voc-carr-in`, `voc-out → mixer`). Built as a dedicated **EXT IN** module rather than folding into I/O (keeps I/O uncluttered; consistent with recent dedicated-module phases).

- **Audio:** `extMicGain` (`Tone.Gain`, INPUT level + `ext-out` jack node) + `extMicMeter` (`Tone.Meter`, SIG LED via `getMeterValue('extMic')`). `extMicRef` holds a lazily-created `Tone.UserMedia`.
- **`enableMic()`** (async) — `await Tone.start()`, `new Tone.UserMedia()`, `await mic.open()`, connect into `extMicGain`; returns bool (false on permission denial). Idempotent. **`disableMic()`** + unmount cleanup `close()`+`dispose()` to release the device / clear the OS mic indicator. **`updateExtMicParams({ gain })`** sole writer of `extMicGain.gain` (knob 0–1 → 0–2×, 0.5 = unity).
- **Jack:** `ext-out` (type:out → `extMicGain`) in the I/O section of `buildJackMap`; existing `connect/disconnect` handles it with zero new logic.
- **UI:** `ExtInModule` in Row 4 before I/O — INPUT knob, SIG LED, and an ENABLE MIC button with off/connecting/on/error states (mint when live, red on DENIED). New `.micBtn`/`.micBtnOn`/`.micBtnErr` CSS.
- **Decision — Tone.UserMedia over native getUserMedia:** proven in `useAutotune`, connects cleanly to Tone nodes, lives in the shared context. Tradeoff: browser AEC/AGC defaults may be on — documented headphone recommendation + the native-constraints fallback path if raw quality is needed.

### [2026-06-24] 16-Band Vocoder (Phase 42)

**Files modified:** `useMoogAudio.js`, `MoogShell.jsx`, `MoogShell.module.css`, `MOOG_ARCHITECTURE.md`

Added a self-contained, patchable 16-band spectral vocoder built on the shared Tone.js context (NOT reusing `useVocoder.js`, which spins its own AudioContext + internal carriers — both forbidden by `MOOG_ARCHITECTURE.md`). Modeled structurally on the 914 FFB.

- **`VOC_BANDS`** — 16 log-spaced bandpass bands (100 Hz → 8 kHz, ratio ≈ 1.339, Q 4), exported like `FFB_BANDS`.
- **DSP:** `vocModIn` fans to 16 modulator bands `BPF → rectifier(Tone.WaveShaper |x|·VOC_ENV_DRIVE) → envLP(20 Hz)`; each env follower connects directly to the matching carrier band's `vocCarrVCA.gain` AudioParam (audio-rate, zero polling). `vocCarrIn → 16× carrBPF → carrVCA → vocSum → vocWet`. **MIX** crossfades `vocDry` (raw carrier passthrough) ↔ `vocWet` via `updateVocoderParams({ mix })`. `vocAnalyser` (FFT 512) taps `vocModIn`.
- **Single-writer compliance:** env followers own the VCA gains; `updateVocoderParams` owns wet/dry. Both confirmed disjoint.
- **Jacks (fully manual, no default patch):** `voc-mod-in`, `voc-carr-in`, `voc-out` — handled by existing `connect/disconnect` with zero new logic.
- **UI:** `VocoderModule` in Row 2 beside FFB — MIX/HISS/BUZZ knobs + 16-segment LED spectrum meter (reuses the FFB per-band-peak rAF pattern via `getVocAnalyserData`). New `.vocMeter`/`.vocLed` CSS.
- **HISS/BUZZ excitation:** `vocCarrBank` inserted between `vocCarrIn` and the filter bank. HISS = white noise → HP(3.5 kHz) → `vocHissGain`; BUZZ = pink noise → LP(250 Hz) → `vocBuzzGain`; both sum into `vocCarrBank` so they're vocoded by the modulator envelope but **never leak into `vocDry`** (dry taps raw `vocCarrIn`). Knob 0–1 → gain ×0.5 (hiss) / ×0.7 (buzz). Noise sources started/stopped in `powerOn`/`powerOff` + cleanup arrays. `updateVocoderParams` extended to `{ mix, hiss, buzz }`.
- **Tradeoff noted:** ~80 always-on band nodes; gating to "both inputs patched" deferred as a future CPU optimization.
- **Pre-existing bug fixed:** the `powerOff` node-stop array omitted `vco5` (stopped vco1–vco4 only), so VCO5 kept oscillating after power-off. Added `n.vco5` to the `powerOff` array (it was already in the `powerOn` and cleanup arrays); VCO5 now follows the same start/stop/start cycle as the other VCOs.

**Critique of Gemini:** his "own module" instinct was correct for a modular synth (a vocoder needs both a carrier and a modulator audio path; the keyboard, a CV/gate controller, has neither — so "build it into the keyboard" had no signal home). But he assumed a mic modulator — there is no `Tone.UserMedia` input in the Moog engine, so the modulator must be an internal source for now. Reusing `useVocoder.js` wholesale would have violated the shared-context rule. HISS/BUZZ deferred per scope.

### [2026-06-11] MIDI-to-CV Integration (Phase 34)

**Files modified:** `KeyboardModule.jsx`, `KeyboardModule.module.css`

Internalized Web MIDI API into the 953 Keyboard Controller. Physical USB MIDI keyboard drives existing PITCH OUT and GATE OUT patch jacks with no extra modules or wiring.

- **`navigator.requestMIDIAccess({ sysex: false })`** called on mount; attaches `onmidimessage` to all current inputs; `onstatechange` handles hot-plug connect/disconnect.
- **`onUpdateRef` pattern** — MIDI handler reads a ref instead of closing over `onUpdate` prop directly; MIDI `useEffect` never re-runs on prop change, so listeners are never torn down mid-performance.
- **Mono legato (`heldMidiNotesRef` stack)** — all held MIDI note numbers tracked; note-off restores the previous held note (gate stays open) rather than cutting. Enables natural legato on monophonic patches.
- **`pressedByMouseRef` guard** — `pointerup` release early-returns when `pressedByMouseRef` is false, preventing mouse events from cancelling a MIDI-held gate.
- **MIDI LED** — DOM-mutated directly via `midiLedRef`. Dim = no device; steady green = connected; 80ms flash on every note-on. `midiConnectedRef` mirrors state for stale-closure-safe timeout callback.
- Mouse, computer keyboard, and MIDI all work simultaneously; no fallback mode required — all three are always active.

**Gemini corrections:** `953KeyboardController.jsx` rename rejected (breaks imports). `onUpdate` direct closure would tear down listeners on every render — `onUpdateRef` is the correct pattern. `pressedByMouseRef` guard not mentioned by Gemini. Mono legato stack not addressed by Gemini. "Automatic fallback" is not needed since all input methods coexist.

---

### [2026-06-11] 61-Key Keyboard + Wooden Barrier

**Files modified:** `KeyboardModule.jsx`, `KeyboardModule.module.css`, `MoogShell.jsx`, `MoogShell.module.css`

- **61 keys (C2–C7):** `buildKeys()` loops 5 octaves (C2–B6) + appends top C7. `WW` 28→20px, `BW` 17→12px; `SEMI_BLACK` recalculated for new geometry (`[null,14,null,34,null,null,74,null,94,null,114,null]`). All 61 keys share the same `onPointerDown` handler.
- **Wooden barrier (`kbdBarrier`):** `<div className={styles.kbdBarrier} />` between `.rack` and `<KeyboardModule>`. Horizontal grain via `repeating-linear-gradient(90deg)`, walnut color matching cabinet (`#b46030`–`#c87038`), `border-top`/`border-bottom` for physical depth.

---

### [2026-06-11] Visual Aesthetic Overhaul

**Files modified:** `MoogShell.module.css`, `MoogKnob.jsx`, `MoogKnob.module.css`

**Glossy black faceplates:** `.plate` background replaced from warm charcoal micro-texture with piano-black `#080808` + right-to-left ambient diffuse gradient. `.plate::after` changed from centered hotspot to directional `to bottom left` specular matching lamp at `78% 18%`.

**Unified studio lamp:** `.lightOverlay` div (`position:absolute; inset:0; z-index:49; mix-blend-mode:screen`) inside `.cabinet` replaces per-module specular. Single `radial-gradient(ellipse at 78% 18%)` illuminates modules based on their physical position in the rack. `mix-blend-mode:screen` brightens knobs, jacks, and labels proportionally without obscuring them.

**Chrome jacks with conic ring:** `.jack` background replaced with `conic-gradient` + `radial-gradient` specular. `::before` adds inner socket body (16px); `::after` is the plug hole (8px). Three-layer depth: chrome ring → socket → hole. Ring brightness peaks at 52° (2 o'clock) matching the lamp.

**White knobs with fixed shading:** `.knob` base uses `radial-gradient(circle at 50% 50%)` — rotationally symmetric so it looks the same at any value. Directional specular/shadow lives entirely on `.knobShading` (new counter-rotating `<div>` inside `.knob` with `transform: rotate(${-rotateDeg}deg)`). Inset edge shadows also on `.knobShading` so they never spin. Lamp-matched shading: primary specular `72% 14%`, diffuse lit area `68% 24%`, shadow `22% 82%`, inset `inset -1px 1px` bright / `inset 1px -1px` dark.

**White text + white dials:** All module labels, jack labels, knob labels, selector values, BPM displays, chord/seq buttons, quantizer labels → `#ffffff` or `rgba(255,255,255,X)` with hierarchy preserved. Nameplate text kept dark (black on brass). Knob body → white gradient `#ffffff→#686868`. Tick marks and numbers → `rgba(255,255,255,X)`.

**Brighter wood:** Cabinet base gradient `#1c0c04–#472010` → `#7a3a14–#c06c34`. Vignette opacity `0.52→0.32` to let the brighter base show through. Ring shadow colors updated to match. Cabinet padding `8px 10px 10px` → `18px 22px 22px` (thicker frame). `border-radius` `10px→14px`.

---

### [2026-06-10] LFO Rate Modulation (Cascading LFOs)

**Files modified:** `MoogShell.jsx`, `useMoogAudio.js`

Added rate FM input and MOD DEPTH knob to both LFO modules, plus waveform-analyser-driven LEDs.

- `useMoogAudio.js`: Added `lfo1modGain`/`lfo2modGain` (`Tone.Gain(0)`) — permanent wired to `lfo.frequency`/`lfo2.frequency`; `lfoWaveAnalyser`/`lfo2WaveAnalyser` (`Tone.Analyser('waveform', 32)`) dead-end taps on each LFO; `lfo-fm`/`lfo2-fm` jacks → the mod Gain nodes; `updateLfoParams`/`updateLfo2Params` extended with `modDepth` param → `safeRamp(lfo1modGain.gain, modDepth * 10)` (0–10 Hz swing range); `getLfoInstant`/`getLfo2Instant` callbacks read `data[last]` from each waveform analyser, normalized `(v+1)/2`, guarded by `isPoweredRef` so LED stays dim when off.
- `MoogShell.jsx`: `LfoModule` gains `modDepth` state + `MOD` sm-knob; jack rows split: inputs (`SYNC`, `FM`) above outputs (`SIN`, `TRI`, `SQR`, `SAW`); `getLfoInstant`/`getLfo2Instant` stable getters added to `MoogShell` and passed as `getLedValue`.

**Gemini corrections:** `LFOModule.jsx` rejected (co-location rule). JS formula for rate calculation is impossible for audio-rate CV — the correct architecture is a `Tone.Gain` scaler node feeding `lfo.frequency` (same as `vcfenv` pattern). Smoothed `Tone.Meter` doesn't pulse at LFO rate; waveform analyser `data[last]` does. `isPoweredRef` guard prevents 50%-brightness LED when synth is off (analyser returns 0 → `(0+1)/2 = 0.5` without the guard).

**Patch: cascading LFOs:** `lfo2-sin → lfo1-fm` with MOD depth raised → LFO 1's rate wobbles at LFO 2's speed.

---

### [2026-06-10] BBD Chorus Module

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`, `useMoogAudio.js`

Added a patchable BBD Bucket Brigade Chorus effect module to Row 2.

- `useMoogAudio.js`: `n.chorus = new Tone.Chorus({ frequency:1.5, delayTime:3.5, depth:0.7, wet:0.0 })`; added to `powerOn`/`powerOff`/cleanup start+stop arrays; `chorus-in`/`chorus-out` jacks in buildJackMap; `updateChorusParams({ rate, depth, wet })` — rate uses exponential `0.1*50^rate` mapping (0.1–5 Hz), depth uses direct assignment (plain JS setter, not AudioParam — `safeRamp` would throw), wet uses `safeRamp`.
- `MoogShell.jsx`: `ChorusModule` co-located; RATE LED uses a `useCallback` getter that computes `Math.abs(sin(Date.now()*hz))` against a `rateHzRef` updated in the param `useEffect` — stable reference so Led's rAF never restarts. Knobs: RATE (md), DEPTH (md), MIX (md). Jacks: IN, OUT.
- `MoogShell.module.css`: `.tierRow2` updated to `1.1fr 1.1fr 1fr 1fr 0.75fr 0.75fr 0.8fr` (7 col).

**Gemini corrections:** `ChorusModule.jsx` rejected (co-location rule). `Tone.Chorus.depth` is a plain JS setter not an AudioParam — `safeRamp` would have thrown. `chorus.start()`/`.stop()` not mentioned by Gemini. "Processor tier" doesn't exist — placed in Row 2. Rate range narrowed to chorus-appropriate 0.1–5 Hz (not LFO's 0.1–30 Hz).

**Patch:** `vco-saw → chorus-in` → `chorus-out → vcf-in` (or I/O directly). MIX at 0 = unity gain (transparent).

---

### [2026-06-10] VCF 2 — Second Voltage Controlled Filter

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`, `useMoogAudio.js`

Added a second independent VCF module to Row 2.

- `useMoogAudio.js`: Added `vcf2: Tone.Filter(20kHz, lowpass, -24)` + `vcf2cv1/vcf2cv2/vcf2env` Gain scalers (×5000/×5000/×1000); permanent scaler→frequency connections; `vcf2-in/cv1/cv2/env/out` jacks in buildJackMap; `updateVcf2Params` callback.
- `MoogShell.jsx`: `VcfModule` gains `number = 1` prop; jack IDs derived as `vcf` (n=1) or `vcf${n}` (n>1); plate header now shows `plateNum`; second instance `<VcfModule number={2} onParamUpdate={audio.updateVcf2Params} />` added to Row 2.
- `MoogShell.module.css`: `.tierRow2` updated from `1.5fr 1fr 1fr 0.75fr 0.75fr` (5 col) to `1.1fr 1.1fr 1fr 1fr 0.75fr 0.75fr` (6 col).

**Row 2 is now:** VCF 1 + VCF 2 + LFO 1 + LFO 2 + Rev 1 + Rev 2

---

### [2026-06-10] Rack Expansion, UI Polish, Pitch Architecture Overhaul & Chord-Seq Routing

**Files modified:** `MoogShell.jsx`, `MoogShell.module.css`, `MoogKnob.module.css`, `useMoogAudio.js`

**Global font size pass (~30% bump):** All module labels, jack labels, knob labels, selector values, plate titles, nameplates, and quantizer display text bumped across `MoogShell.module.css` and `MoogKnob.module.css`. Chord seq root buttons 7→14px, chord type buttons 5→10px; button heights increased to match.

**CP3 Mixer removed:** Component, 5 `Tone.Gain` nodes (`cp3ch1–4`, `cp3bus`), 5 jacks, and 4 internal `connect()` calls all deleted. Row 2 grid updated from 4 to 3 columns.

**Chord sequencer grid:** Switched from `repeat(8, 1fr)` to `repeat(4, 1fr)` — 8 steps now display as 4×2.

**Rack expansion — new modules:**
- Row 1: VCO 4 + Noise 2 + Noise 3 (all modules parameterized with `number` prop for unique jack IDs)
- Row 2: LFO 2 (`lfo2-*` jacks, `lfo2Meter`, `updateLfo2Params`) + Reverb 2 (`reverb2-*` jacks, `updateReverb2Params`)
- Row 3: VCA 2 + VCA 3 (`vca2/3-in/cv/out` jacks, `updateVca2/3Params`) + ENV 3 (`env3-*` jacks, `env3Meter`, full gate routing)
- Row 4: Second 960 Sequencer stacked under first (`.seqStack` flex column, `flex: 1` on `.module` fills height); `seq2-*` jacks (`seq2-pitch-out`, `seq2-gate-out`, etc.), `seq2Loop`, `updateSeq2Steps`, `setSeq2StepCallback`

**Bug fix — sequencer jack ID collision:** Both `SequencerModule` instances were registering identical jack IDs (`seq-pitch-out` etc.), causing the second to overwrite the first in `MoogPatchContext.jackRefs`. `SequencerModule` now accepts `number` prop; jack prefix is `seq` or `seq2`.

**VCO CV-in override architecture:** `connect()` now zeroes `vco.frequency.value` when any source is patched to `vco*-cv`, making the source the sole pitch provider (base=0 + source = correct Hz). `updateVcoParams` suppresses the frequency write while CV is connected (via `connectionsRef` scan); `vcoKnobHzRef` stores the last knob Hz for restoration on disconnect. Fixes pitch being wrong for ALL CV paths (sequencer, quantizer, chord seq).

**Chord sequencer as inline chord quantizer (`chordseq-cv-in` → snap → `chordseq-cv-out`):**
- New `chordSeqInputAnalyser: Tone.Analyser('waveform', 256)` tap on `chordseq-cv-in`
- `snapToChordHz(inputHz, rootClass, chordType)` module-level helper: finds nearest chord tone in semitone distance across octaves −3..+4
- `chordSnapTick` rAF reads analyser Hz, snaps to current chord step's tones, writes to `chordSeqPitchOut`; chord loop skips its own pitch write while input is active (single-writer rule)
- Patch `seq-pitch-out → chordseq-cv-in → chordseq-cv-out → vco-cv` for chord-locked melody

**Chord seq → Quantizer full override (`chordseq-cv-out → qnt-transpose-in`):**
- `qntChordOverrideRef` set in `connect()` / cleared in `disconnect()` for that specific cable
- `qntOverrideTick` 60fps rAF continuously holds the quantizer's root+scale to the current chord step (delta-checked — only posts when chord changes). Bulletproof against any other writer (TRP analyser, React effects, manual knob clicks)
- Immediate apply fires in `connect()` so quantizer is correct the moment the cable is drawn
- Chord loop also pushes root+scale on each step advance as belt-and-suspenders

**Independent chord root output (`chordseq-root-out`):**
- New `chordSeqRootOut: Tone.Signal` node, always outputs root Hz of current step × octave offset
- ROOT OCT click-to-cycle selector (−3..+3) in ChordSeqModule UI; `chordSeqRootOctaveRef` + `setChordSeqRootOctave` callback
- Completely independent of the CV-in snapping path — patch to a bass VCO with FREQ at minimum

**Default chords changed:** Am · Am · F · F · C · C · E · E (rootClass `[9,9,5,5,0,0,4,4]`, chordType `[CMIN,CMIN,CMAJ,CMAJ,CMAJ,CMAJ,CMAJ,CMAJ]`) in both `ChordSeqModule` state and `chordSeqStepsRef`.

---

### [2026-06-08] Bug Fix — Oscilloscope Waveform + Viewport Overflow

**Oscilloscope waveform not reaching edge (`Oscilloscope.jsx` + `Oscilloscope.module.css`):**
The `<canvas>` element (200×64 attribute) had `display: block; width: 100%` CSS but no explicit `height`. Replaced elements maintain their intrinsic aspect ratio when only width is constrained — on a ~350px-wide I/O module the canvas rendered at ~112px tall (350 × 64/200) instead of 64px. Added `height: 64px` to `.canvas` to lock it to its intended height regardless of display width. The waveform width was also fixed by syncing `canvas.width = canvas.offsetWidth` each rAF frame so drawing always spans the full CSS display width.

**Rack rendering outside viewport (two-pass fix, `MoogShell.jsx`):**
- **Root cause 1** (oscilloscope): the oversized canvas nearly doubled the I/O module height, making total rack height ~1490px+ and forcing an extreme scale factor.
- **Root cause 2** (fit() loop instability): the `fitting` boolean + `setTimeout(0)` reset had a race condition — `setTimeout` could fire before the ResizeObserver callback on some browsers, allowing re-entrant fit() calls with stale state.
- **Root cause 3** (display:none to block): `fit()` was not re-running when the Moog page was navigated back to (Root.js sets inactive pages to `display:none`).

**Final fit() implementation:** `scheduleFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 0) }` — rapid ResizeObserver callbacks (from fit()'s own DOM writes) collapse into a single deferred call, self-terminating the loop. Width guard `if (el.style.width !== newW) el.style.width = newW` prevents unnecessary ResizeObserver triggers on stable iterations. ResizeObserver on cabinet catches `display:none → display:block` transitions. `fit()` called immediately on mount + via `document.fonts.ready.then(scheduleFit)` + `window.resize`.

---

### [2026-06-08] Phases 27–29 — UI Scaling & Readability Overhaul

**Phase 27 — Responsive Rack UI Refactor:**
- Removed `max-width: 1420px` from `.cabinet` — cabinet now fills `width: 100%` of the shell on all display sizes, eliminating blank side margins on wide monitors.
- Rack gap: 2px → 3px. Plate padding: 10px → 11px. Plate/body gaps, row gaps slightly increased.
- Typography: `plateTitle` 12px → 13px, `plateSub` 5.5px → 6px, `knobLabel` 6px → 7px, `jackLabel` 5.5px → 6.5px, `selectorValue` 9px → 10px.
- Knobs (body/wrap): xl 44/76 → 48/83, lg 34/62 → 37/67, md 26/48 → 28/52, sm 20/38 → 22/41.
- Jacks: 18px → 21px, border 2.5px → 3px, hole 7px → 8px.

**Phase 28 — Fluid Rack Scaling & Viewport Maximization:**
- fit() width compensation: when height-based scale < 1, sets `el.style.width = ceil(availW / scale)` so the visual width after `transform: scale()` equals `availW` exactly — no blank side margins from the scale shrinking the visual width.

**Phase 29 — Typography & Readability Scalability:**
- Knobs (body/wrap): xl 48/83 → 54/94, lg 37/67 → 42/76, md 28/52 → 32/58, sm 22/41 → 25/46. Indicator cap widths increased proportionally.
- `knobLabel` 7px → 9px, `plateTitle` 13px → 16px, `plateSub` 6px → 7.5px, `selectorValue` 10px → 12px, `selectorLabel/toggleLabel` 6px → 7.5px, `jackLabel` 6.5px → 8.5px, `gateBtnLabel` 6px → 7.5px.
- Jacks: 21px → 24px, hole 8px → 10px.
- `.seqCtrl min-width` updated to 86px to match new lg knob wrap.
- Row gaps: knobRow 12→14px, jackRow 8→10px, selectorRow 9→10px, switchRow 10→12px, gateBtnRow 8→10px.

**MULT module removal:** `MultiplesModule` component, `<MultiplesModule />` from Row 3, 8 mult jacks from jackMap, `.tierRow3` 4th column, and `.multiplesGrid/.multBank/.multBankLabel` CSS all removed. Row 3 now: VCA + ENV 1 + ENV 2.

---

### [2026-06-07] Moog Phase 26 — Chord Step-Editor Implementation

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js`:
  1. **SCALE_DEFS extended** with 7 chord type interval arrays: `CMAJ [0,4,7]`, `CMIN [0,3,7]`, `CDOM [0,4,7,10]`, `CMAJ7 [0,4,7,11]`, `CMIN7 [0,3,7,10]`, `CSUS4 [0,5,7]`, `CDIM [0,3,6]`. The quantizer worklet already accepts arbitrary interval arrays — no worklet changes needed.
  2. **`CHORD_BASE_HZ = 130.81`** (C3) — root Hz base. `rootClass 0-11 → C3…B3` (130–247 Hz). All values > 10 Hz so qnt-transpose-in analyser threshold correctly detects them.
  3. **`chordSeqStepsRef`** now stores `{ rootClass: 0-11, chordType: string }` per step. Default: I-IV-V-I (C, C, F, F, G, G, C, C).
  4. **`chordSeqChordCbRef`** + **`setChordSeqChordCallback`** — fires `fn(rootClass, chordType)` on each chord step advance.
  5. **Chord loop** updated: Hz from `CHORD_BASE_HZ * 2^(rootClass/12)`; fires both step LED callback and chord callback.

- `src/components/MoogModular/MoogShell.jsx`:
  1. **`CHORD_TYPES` / `CHORD_TYPE_LABELS`** — module-level constants; used in ChordSeqModule AND MoogShell's chord callback (separate data planes: UI display vs postMessage).
  2. **`ChordSeqModule` rewritten**: steps have `{ rootClass, chordType }`; 8-column `.chordSeqGrid`; each step column: LED + `.chordSeqRoot` button (cycles 12 notes on click) + `.chordSeqType` button (cycles 7 chord types on click). Clock div selector and ROOT CV jack preserved.
  3. **MoogShell** adds `chordMapRef` (useRef) and a `useEffect` registering the chord callback: calls `updateQuantizerParams({ root, scale: chordType })` AND writes chord type label to `chordMapRef.current.textContent`. Both are DOM mutations — no React re-render.
  4. **`QuantizerModule`** accepts `chordMapRef` prop; attaches it to a new `.qntExtChordType` span in the EXT row. Root note span (rAF) and chord type span (chord callback) are separate DOM elements — no write conflicts.

- `src/components/MoogModular/MoogShell.module.css`: `.chordSeqGrid`, `.chordSeqRoot`, `.chordSeqType`, `.qntExtChordType`.

**Data flow:**
```
ChordSeqModule step click → setSteps (React state) → onStepsChange → chordSeqStepsRef
Tone.Loop tick → rootClass → CHORD_BASE_HZ * 2^(rc/12) → chordSeqPitchOut (Hz, audio domain)
             → chordSeqChordCbRef → MoogShell callback:
                 → updateQuantizerParams({ root, scale: chordType }) → worklet postMessage
                 → chordMapRef.current.textContent = "maj7" (DOM mutation)
```

**Chord-aware quantization:** When chord seq advances to "G CMIN7", the quantizer's scale becomes `[0,3,7,10]` with root=7 → snaps melody to G, Bb, D, F only.

**Gemini plan corrections:**
- `ChordSeqModule.jsx` — rejected. Co-located in MoogShell.jsx.
- `{ root, type, notes }` — `notes[]` redundant (derived). Correct: `{ rootClass, chordType }`.
- "CHORD CV = Chord Program" — audio signals carry one float; chord type travels via postMessage, not CV.
- Quantizer worklet changes — not needed; SCALE_DEFS extension + existing postMessage protocol suffices.

---

### [2026-06-07] Moog Phase 25 — Intelligent Patch-Sensing Transposition

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js`:
  1. **`qntTransposeAnalyser`** — `new Tone.Analyser('waveform', 256)` in node creation. `Tone.Analyser` with waveform type calls `getFloatTimeDomainData`, which returns actual float values. A patched `chordSeqPitchOut` (ConstantSourceNode, offset = Hz) returns ~Hz in every sample; no cable returns zeros.
  2. **`'qnt-transpose-in'`** jack added to `buildJackMap` pointing to `n.qntTransposeAnalyser`.
  3. **`getQntTransposeData()`** — `useCallback`, returns `n.qntTransposeAnalyser.getValue()` (Float32Array of 256 samples).

- `src/components/MoogModular/MoogShell.jsx` — `QuantizerModule` extended:
  1. `getTransposeData` prop added.
  2. `transposeActiveRef`, `rootRef`, `lastExtNoteClassRef`, `extLedRef`, `extRootRef`, `extRowRef` refs.
  3. `useEffect([root])` keeps `rootRef` current for rAF closure reads.
  4. Param `useEffect` checks `transposeActiveRef.current`: if EXT active, skips `root` so the rAF loop owns it; otherwise sends full params including knob root.
  5. rAF `useEffect`: computes `avgHz = avg(|samples|)`; threshold 10 Hz distinguishes "cable present" (>10) from "no cable" (~0). On transition: shows/hides EXT row, lights/dims EXT LED, restores knob root on disconnect. While active: Hz → MIDI → note class (delta-checked to avoid spamming worklet), calls `onParamUpdate({ root: noteClass })`, updates `extRootRef` text.
  6. EXT status row (hidden by CSS `display: none`; shown via `extRowRef.current.style.display = 'flex'` in rAF). EXT LED + "EXT ROOT" label + current root note text — all DOM-mutated, zero React state.
  7. `qnt-transpose-in` (TRP) jack added alongside CV IN and OUT.

- `src/components/MoogModular/MoogShell.module.css`: `.qntExtRow`, `.qntExtLed`, `.qntExtLabel`, `.qntExtDisplay`.

**Why no worklet changes:** Root overrides happen at chord-change rate (~1–2 Hz at 120 BPM / 1 bar). Sending `port.postMessage` at 60 fps → delta check reduces actual messages to ≤ chord-change rate. No audio-rate accuracy needed; worklet already handles dynamic root updates.

**Gemini plan corrections:**
- `QuantizerModule.jsx` — rejected. Co-located in `MoogShell.jsx`.
- `rawCV * 12 + baseRoot` — wrong. CV is Hz (32–1046 Hz), not 0–1. Correct: `midi = 69 + 12 * log2(hz / 440)`, then `noteClass = round(midi) % 12`.
- "null check or patch-cable state tracker" — the analyser's zero-output with no input IS the cable detector. No separate tracking needed.
- "Modify quantizer AudioWorklet" — not needed. Root updates via `port.postMessage` are adequate for musical tempo.

---

### [2026-06-07] Moog Phase 24 — Chord & Note Transposition Sequencer

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js`:
  1. **`chordSeqPitchOut`** — `new Tone.Signal(SEQ_HZ_MIN)` in node creation; exposes `chordseq-cv-out` jack (same type as `seq-pitch-out`).
  2. **`chordSeqLoop`** — `new Tone.Loop` at configurable interval (default `'1m'`); advances 8 steps, sets Hz via `setValueAtTime`, fires LED callback.
  3. **`chordSeqLoopRef` / `chordSeqStepsRef` / `chordSeqCurrentStepRef` / `chordSeqStepCbRef` / `chordSeqDivisionRef`** — parallel to the 960 sequencer refs.
  4. **`powerOn` / `powerOff`** — chord loop started/stopped alongside the main seq loop; LEDs cleared on powerOff.
  5. **`updateChordSeqSteps`** / **`setChordSeqStepCallback`** / **`setChordSeqDivision`** — matching the existing sequencer export pattern. `setChordSeqDivision` writes `chordSeqLoopRef.current.interval` for immediate effect.

- `src/components/MoogModular/MoogShell.jsx`:
  - `CHORD_DIVS` / `CHORD_LABELS` module-level constants.
  - `ChordSeqModule` co-located function component: 8-step `chordSeqStep` columns (LED + sm knob), clock division selector (½ BAR / 1 BAR / 2 BAR / 4 BAR), `chordseq-cv-out` jack. LED animation via DOM `classList` — same pattern as `SequencerModule`.
  - Row 4 grid: `3.5fr 0.9fr 1fr` → `2.5fr 1fr 0.9fr 1fr` (960 Seq | Chord Seq | Quantizer | I/O).

- `src/components/MoogModular/MoogShell.module.css`:
  - `.chordSeqStep` — identical to `.seqStep` without the gate button space.
  - `.tierRow4` updated to 4 columns.

**Killer patch:** `chordseq-cv-out → qnt-cv-in` → `qnt-cv-out → vco1-cv` with `seq-pitch-out → vco1-fm`. Chord seq sets root every bar; quantizer snaps it to scale; 960 seq plays melodic variation on top via FM modulation.

**Gemini plan corrections:**
- `ChordSeqModule.jsx` — rejected. Co-located in MoogShell.jsx.
- "patches into Base Frequency or Transposition input" — no special input needed; `vco-cv` is additive by design.
- "Clock Division knob" — selector is correct for discrete musical values; a continuous knob can't map to `'2n'`/`'1m'`/`'2m'`/`'4m'` meaningfully.

---

### [2026-06-07] Moog Phase 23 — Multi-Channel Master Mixer

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Three additions:
  1. **`ioCh1`–`ioCh4`** — `new Tone.Gain(0.8)` in node creation block. Each connects to `n.master` (summing) and to a dedicated `Tone.Meter` tap (post-gain, so LEDs reflect actual contribution).
  2. **`ioCh1Meter`–`ioCh4Meter`** — `new Tone.Meter({ normalRange: true, smoothing: 0.2 })`. Dead-end side taps after each channel gain. `getMeterValue('ioCh1')` etc. already works via the existing `n[${id}Meter]` lookup convention.
  3. **`'io-in1'`–`'io-in4'` jacks** added to `buildJackMap` pointing to `n.ioCh1`–`n.ioCh4` as destinations. Legacy `'io-in'` → `n.master` preserved for patch compatibility.
  4. **`updateIoChannelVol(channelIndex, value)`** — single writer for ioCh1–ioCh4 gain params; uses `safeRamp` consistently with all other param writers.

- `src/components/MoogModular/MoogShell.jsx` — Three additions:
  1. **`ZERO_GETTER`** — module-level `() => 0` constant; used as stable fallback for `Led.getValue` to prevent rAF restarts on render if `getChLevels` is ever undefined.
  2. **`getIoCh1Level`–`getIoCh4Level`** — four stable `useCallback` getters in `MoogShell` (same pattern as `getLfoLevel`, `getEnv1Level` etc.).
  3. **`IoModule`** — extended with `getChLevels` (array of 4) and `onChannelVolChange` props. New `chVols` state (`[0.8,0.8,0.8,0.8]`); `useEffect([chVols])` fires `onChannelVolChange(i+1, v)` for each channel. Four `.ioChRow` divs replace the single jack row: each row is `[activity LED] [CH n VOL sm-knob] [IN n jack]`. Legacy `io-in` kept at bottom below a divider (labeled "IN ✦" to distinguish it from the channel inputs).

- `src/components/MoogModular/MoogShell.module.css` — Added `.ioChRow` (flex row, align-items center, gap 6px).

**Architecture notes:**
- Single-writer rule preserved: `ioCh1–4.gain` owned exclusively by `updateIoChannelVol`; `master.volume` owned by `updateIoParams`; no overlap.
- Disposal: all new Gain/Meter nodes are in the `n` object and disposed automatically by the existing `Object.values(n).forEach(node => node.dispose())` cleanup.
- Backward compat: `io-in` → `n.master` stays in jackMap and UI; existing patches using it continue to work.

**Gemini plan corrections:**
- `masterIn`/`masterOut` naming — invented, doesn't exist. Real node is `n.master` (Tone.Volume).
- `MasterMixerModule.jsx` — rejected (recurring error since Phase 3). All modules co-located in `MoogShell.jsx`.
- Meter tap location: Gemini unspecified; tapped post-gain (from ioCh output) so LEDs show channel contribution, not raw input.
- Stable `ZERO_GETTER` for `Led` fallback — inline `() => 0` would restart rAF on every render.

---

### [2026-06-07] Quantizer + AudioWorklet Bug Fixes

Multiple bugs discovered and fixed through systematic code tracing:

**1. SAC Compatibility — root cause of "no sound from quantizer":**
Tone.js uses `standardized-audio-context` (SAC) internally. `Tone.context.rawContext` is a SAC `stdAudioContext`, not a native `AudioContext`. All Tone.js nodes (including `Tone.Gain._gainNode`) are SAC-wrapped. SAC's `connect()` explicitly throws `InvalidAccessError` when connecting TO any native (non-SAC) AudioNode. Our `new AudioWorkletNode(rawCtx, name)` created native nodes, so every patch cable connection to `qnt-cv-in` silently threw inside the `try/catch` → cable drawn on screen, no audio. Fix: `Tone.context.createAudioWorkletNode(name)` creates SAC-wrapped AudioWorkletNodes accepted by the rest of the graph. Applied to both quantizer and hard sync worklets.

**2. React StrictMode race condition:**
StrictMode double-invokes `useEffect`. Cleanup sets `nodesRef.current = null`, then second mount sets `n2`. First mount's worklet `.then()` fired with `nodesRef.current = n2` (not null) — old guard `if (!nodesRef.current)` passed but `n` in closure was disposed first-mount nodes. If it fired after second mount's `.then()`, it overwrote `jackMapRef.current` with dead node references → all patches no-op. Fix: `if (nodesRef.current !== n) return` ensures only the current mount's closure proceeds.

**3. MIDI note delta check (octave changes missed):**
Worklet compared `noteClass` (0–11) for change detection. C3 → C4 (both = class 0) sent no port message → display/LEDs froze. Also broke OCT SHIFT feedback. Fix: compare full `midiOut` integer (includes octave) so any pitch change fires the update.

**4. Phase 19 hard sync routing clarification:**
`hardSyncNode.connect(n.vco2syncOut.input)` — with SAC nodes (fix #1), `n.vco2syncOut.input` is a SAC GainNode, making `sacWorkletNode.connect(sacGainNode)` fully compatible.

---

### [2026-06-07] Moog Phase 22 — Quantizer Improvements + VCO UI Cleanup

**VCO modules (`MoogShell.jsx`):** Removed `cvMode` state, `cycleCvMode`, `handleTune`, `onTune` prop, and CV MODE/TUNE selectorRow. Reverted to original minimalist design (WAVE, RANGE, HARD SYNC for VCO2, jacks only).

**Quantizer additions (`useMoogAudio.js` + `public/quantizer-worklet.js` + `MoogShell.jsx` + `.module.css`):**
- **BYPASS toggle** — when ON, worklet copies `inputCh[i]` directly to `outputCh[i]` without quantizing. Orange accent when active. Useful to confirm cable patching without quantization.
- **IN LED** — worklet detects `hasSignal` (cable connected/disconnected) and posts `{ hasSignal }` on transitions only. DOM-mutated round LED in the Quantizer panel lights when a source is connected to `qnt-cv-in`.
- **OCT SHIFT** — click-to-cycle selector (−3..+3 octaves). Applied in worklet as `bestMidi + octShift * 12` before Hz conversion. Solves additive VCO pitch alignment without touching VCO FREQ knob extensively.
- **Note display** — DOM-ref `<div>` shows `G3  196.0 Hz` (computed from `midiNote` sent in port message). Updated only on note change — zero React state.
- `quantizerParamsRef` gains `bypass` and `octShift` fields, flushed on worklet load.
- LED callback extended to `(noteClass, midiNote, hasSignal)` — `noteClass === null` → signal-state-only message, skip LED/display.

**Usage note:** VCO `cv-in` is additive (Moog standard). Set VCO FREQ to minimum + use OCT SHIFT on the Quantizer to place output in the right octave range.

---

### [2026-06-07] Moog Phase 20 — Musical CV Quantizer

**Files created:**
- `public/quantizer-worklet.js` — `QuantizerProcessor` AudioWorkletProcessor. Per-sample Hz→nearest-scale-note→Hz mapping. Algorithm: convert input Hz to fractional MIDI, iterate scale degrees, find nearest `12k + root + degree` to input MIDI, convert winner back to Hz. Delta-checked `port.postMessage({ noteClass })` fires only when the quantized note class changes — limits main-thread LED update traffic to ≤1 message per 128-sample block. Default scale: MAJ / C on construction; scale+root received via `port.onmessage`.

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Six additions:
  1. **`SCALE_DEFS`** — module-level constant (CHR/MAJ/MIN/PMAJ/PMIN arrays).
  2. **`quantizerStepCbRef`** — UI LED callback ref (same pattern as `seqStepCbRef`).
  3. **`quantizerParamsRef`** — buffers latest `{scale, root}` so config changes made before worklet loads are flushed correctly on load.
  4. **`n.quantizerOut`** — `new Tone.Gain(1)` created synchronously. Tone.Gain wrapper so downstream Tone.js nodes (`vco.frequency`) can receive the quantized Hz via `Tone.js.connect()`. Connected via `quantizerNode.connect(n.quantizerOut.input)` (native AudioNode → native GainNode — same `.input` pattern from Phase 19 fix).
  5. **`'qnt-cv-in'` / `'qnt-cv-out'` jacks** — added to `buildJackMap`. `qnt-cv-in.dest = n.quantizerNode ?? null` (deferred until worklet loads; jackMap rebuilt after). `qnt-cv-out.node = n.quantizerOut` (always live).
  6. **`updateQuantizerParams({scale, root})`** and **`setQuantizerCallback(fn)`** — matching the existing sequencer callback pattern. `updateQuantizerParams` buffers in `quantizerParamsRef` first, then posts to worklet (no-op if worklet not yet loaded).

- `src/components/MoogModular/MoogShell.jsx` — `QuantizerModule` component co-located. State: `scale` ('MAJ'), `root` (0). `selectorRow` with SCALE and ROOT click-to-cycle selectors. 12-LED chromatic note display: DOM refs array + LED callback from `onSetCallback` — active LED `background/#5DCAA5 box-shadow` set directly (no React state). Two jacks: `qnt-cv-in`, `qnt-cv-out`. Mounted in Row 4 between Sequencer and I/O.

- `src/components/MoogModular/MoogShell.module.css` — `tierRow4` updated `3.5fr 1fr → 3.5fr 0.9fr 1fr`. Added `.qntLeds`, `.qntLedGroup`, `.qntLed`, `.qntLedBlack`, `.qntLedLabel` LED display styles.

**Classic patch:**
`seq-pitch-out → qnt-cv-in` → `qnt-cv-out → vco1-cv`. Sequencer steps are forced to the scale; notes outside the scale (step voltage knobs in between) snap to nearest scale degree. Set VCO1 FREQ to minimum for pure sequencer pitch control.

**Gemini plan corrections:**
- `Tone.Signal` bridge for real-time processing — impossible; `Tone.Signal` is a constant-value source, not a processor. AudioWorklet is the correct tool.
- `Tone.Analyser` / `setInterval` for audio-rate processing — `Tone.Analyser` is read-only FFT display; `setInterval` runs on main thread at ~60fps with no audio-rate timing. AudioWorklet runs at 44100 Hz in the audio rendering thread.
- `QuantizerModule.jsx` — all modules co-located in `MoogShell.jsx`. Documented since Phase 3.
- `<MoogKnob>` for SCALE — click-to-cycle selector is correct for discrete options (same as WAVE/RANGE in VcoModule).

---

### [2026-06-06] Moog Phase 19 — True Hard Sync via AudioWorklet

**Files created:**
- `public/hard-sync-worklet.js` — `HardSyncProcessor` AudioWorkletProcessor. Phase-accumulator master tracking + slave reset on detected sawtooth discontinuities (`prev > 0 && m < prev - 0.5` threshold — robust for sawtooth and square master waveforms, immune to smooth waveforms). AudioParams: `slaveFreq` (k-rate, Hz), `slaveDetune` (k-rate, cents). Always outputs slave sawtooth; phase-resets to 0 on each master cycle boundary. Runs entirely in the audio rendering thread — zero main-thread overhead.

**Files modified:**
- `src/components/MoogModular/useMoogAudio.js` — Five additions:
  1. **`n.vco2syncOut`** — `new Tone.Gain(0)` created synchronously with other nodes. Acts as the gain-gate wrapper: gain=0 when HARD SYNC is off, ramps to 1 when on.
  2. **Async worklet load** — `rawCtx.audioWorklet.addModule('/hard-sync-worklet.js').then()` runs after node creation. On load: creates `AudioWorkletNode('hard-sync-processor')`, assigns to `n.hardSyncNode`; connects `n.vco2fm → hardSyncNode.parameters.get('slaveFreq')` (additive — FM/envelope modulation on vco2-fm now drives both VCO2.frequency AND the worklet slave, no extra cables needed); connects `hardSyncNode → n.vco2syncOut`; rebuilds jackMap. Race condition guard: `nodesRef.current = null` is set first in cleanup, so any in-flight `.then()` aborts on `if (!nodesRef.current) return`.
  3. **`vco2-sync-in` / `vco2-sync-out` jacks** — added to `buildJackMap`. `vco2-sync-in: { type:'in', dest: n.hardSyncNode ?? null }` (deferred to null before worklet loads; jackMap rebuilt after load). `vco2-sync-out: { type:'out', node: n.vco2syncOut }` (always live; outputs silence until toggle enables gain and worklet connects).
  4. **`updateVcoParams` dual-write** — when `vcoId === 'vco2'` and `n.hardSyncNode` exists, also calls `setTargetAtTime` on `slaveFreq` / `slaveDetune` AudioParams to keep the worklet's base frequency in sync with the FREQ/FINE knobs.
  5. **`setVco2SyncEnabled(enabled)`** — `safeRamp(n.vco2syncOut.gain, enabled ? 1 : 0, 0.01)`. 10ms click-free ramp. Returned from hook.

- `src/components/MoogModular/MoogShell.jsx` — Two additions:
  1. **`VcoModule`** gains `onSyncChange` prop and `syncOn` state. When provided, renders a HARD SYNC selectorGroup (click to toggle, value green when ON) and a second `jackRow` with SYNC↓ (sync-in) and SYNC↑ (sync-out) jacks.
  2. **VCO2 call site** — `onSyncChange={audio.setVco2SyncEnabled}` wired.

**Houdini patch (the "Houdini" sound):**
1. Power ON
2. VCO1: FREQ ≈ 0.3 (E2 range), WAVE = SAW
3. VCO2: FREQ ≈ 0.35, WAVE = SAW, HARD SYNC toggle ON
4. Patch `vco1-saw → vco2-sync-in` (VCO1 is master, VCO2 is slave)
5. Patch `env1-out → vco2-fm` (envelope sweeps slave pitch 0→500Hz above base)
6. Patch `vco2-sync-out → cp3-in1` (synced slave is the audio output)
7. Patch `cp3-out → vcf-in → vca-in → io-in`
8. Patch `seq-gate-out → env1-gate` (sequencer triggers envelope per step)
9. Each note: envelope attack sweeps VCO2 upward while phase-locked to VCO1 → tearing hard sync timbre.

**Gemini plan corrections:**
- `Tone.Signal` / `Tone.Waveform` for sync — architecturally incorrect. Web Audio OscillatorNode has no phase-reset input. AudioWorkletProcessor is the only correct implementation.
- `setTargetAtTime` "for sync modulation performance" — confused the concept; the correct use is the standard `setTargetAtTime` already in `updateVcoParams` for click-free parameter changes.
- Both oscillators in worklet (Gemini's implicit suggestion) — rejected. Slave-only worklet is simpler, keeps VCO2's controls and FM/CV patch infrastructure intact, and doesn't duplicate the master oscillator.
- "SYNC IN overrides internal master routing" — the jack-based system IS the routing; no internal routing needed. Patching VCO1 to SYNC IN IS enabling the sync.

---

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
