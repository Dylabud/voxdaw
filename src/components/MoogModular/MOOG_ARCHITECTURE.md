# MOOG_ARCHITECTURE.md
## 1960s Moog Modular Synthesizer — Module Specifications & Implementation Blueprint

> **How to use this file:**
> This is the canonical signal-flow and module-design reference for the Moog Modular sub-project.
> - All implementation decisions (audio graph wiring, Tone.js node choices, port types) must be consistent with this document.
> - When a module is implemented in a phase, annotate it with `[Implemented: Moog Phase N]`.
> - Do not modify this file without flagging changes to Dylan first.
> - Do NOT conflate this document with the root `ARCHITECTURE.md` (VoxTool/Workstation signal flow).

---

## Signal Type System

All connections carry one of two signal classes. The patch cable simulator must enforce type compatibility at connect time:

| Signal Class | Sub-type | Description |
|---|---|---|
| **AUDIO** | — | Audible waveforms (~20 Hz – 20 kHz). Flows through VCO → VCF → VCA → I/O. |
| **CV** | Continuous | Smoothly sweeping voltage (−5V to +5V or 0–10V). Used for pitch, cutoff, modulation. |
| **CV** | Gate | Max voltage held HIGH for note duration, snaps to 0 on release. Sustains envelopes. |
| **CV** | Trigger | Microsecond voltage spike. Fires one-shot attacks, resets sequences/LFOs. |
| **CV** | Clock | Steady rhythmic trigger stream. Synchronizes tempo between modules. |

**1 Volt per Octave (1V/Oct):** The universal CV pitch standard. Every 1V increase doubles the oscillator frequency (one octave up). All CV pitch outputs (Sequencer, keyboard) and all VCO CV inputs use this standard.

---

## Module Specifications

---

### 1. VCO — Voltage Controlled Oscillator

**Function:** The raw sound source. Generates a continuous waveform at a pitch determined by its Frequency knob and any incoming CV. It drones indefinitely — a VCA must gate it. Pitch tracks at 1V/Oct on the CV input.

**Controls:**
| Knob | Function |
|---|---|
| **Frequency** | Sets the base pitch (coarse, wide range — multiple octaves). **[Correction: Gemini omitted this — it's the primary control, not optional.]** |
| **Fine Tune** | Small pitch offset (±1 semitone range) for detuning against other VCOs. |
| **Range Switch** | Coarse octave selector (LO / 32' / 16' / 8' / 4' / 2'). Shifts the Frequency knob's range. |
| **Waveform Switch** | Selects which output waveform the primary output jack carries (Sine / Tri / Saw / Square). |

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| CV IN | Input | CV — Continuous (1V/Oct) | Pitch control. Add volts → pitch rises. Typically from Sequencer or keyboard. |
| Sine OUT | Output | AUDIO | Smooth, pure, round tone. Fundamental only. |
| Triangle OUT | Output | AUDIO | Slightly brighter. Odd harmonics at lower amplitudes. |
| Sawtooth OUT | Output | AUDIO | Brightest, richest. All harmonics. Classic Moog bass/lead. |
| Square OUT | Output | AUDIO | Hollow, woody. Odd harmonics only. |

**Engine (Moog Phase 68b — worklet CORE):** the VCO is no longer a `Tone.Oscillator`. Its core is the `hard-sync-worklet.js` AudioWorklet: **one phase accumulator emits all four waveforms simultaneously** on a 4-channel output (0=sine 1=triangle 2=sawtooth 3=pulse), so all four output jacks are live at once. Signal path: worklet → `${id}coreGate` (power gate, 0 while unpowered) → `${id}bus` (sequencer per-step gate) → a `ChannelSplitter(4)` → four tap gains (`Sin/Tri/Saw/Pulse`) → the jacks. Per-VCO `Tone.Signal`s sum into the worklet's a-rate params: `GlideBus` + `fm`(×500) → `slaveFreq` (Hz), `DetuneSig` → `slaveDetune` (cents), `WidthSig` + `pw` → `pulseWidth`. **SHAPE** knob phase-warps all four waveforms (pulse duty for the SQR out). **HARD SYNC** = the worklet's `syncEnabled` param: a master patched to SYNC IN resets the shared phase, syncing all four outs; SYNC OUT taps the SAW (sharp reset edge). **Known limitation:** the core is naive (non-band-limited) so high notes alias — PolyBLEP is a logged follow-up (MOOG_PLAN Future Phases).

---

### 2. LFO — Low Frequency Oscillator

**Function:** Mechanically identical to the VCO but tuned to sub-audio rates (0.01 Hz – ~20 Hz). It is **never heard directly** — its output is always CV, used to automatically modulate other modules (vibrato, filter wobble, tremolo, etc.).

**Controls (as built — Moog Phase 70):**
| Knob | Function |
|---|---|
| **RATE** | Free-run rate, exponential **0.01 Hz – 100 Hz** (`LFO_RATE_MIN_HZ · LFO_RATE_SPAN^knob`, span 10000 = a **decade per quarter-turn**: 0.01/0.1/1/10/100). The low end is a 100-second sweep; the top crosses into audio rate for FM. In SYNC mode this same knob selects a musical division instead (`LFO_SYNC_DIVS`) — it stores the raw 0..1 in `lfoRateRefs` and never touches Hz. |
| **DEPTH** | Amplitude of the outgoing CV (modulation depth). |
| **MOD** | Rate-modulation depth in free mode; doubles as the sync **OFFSET** (start phase). |
| ~~WAVE selector~~ | **Removed** Phase 70 — waveform is chosen by **which output jack you patch** (the real module has four simultaneous shape outs and no shape switch). `connect()` sets the oscillator type AND keeps `lfoWaveRefs` in step, so free and sync both follow the cable; cable restore re-fires `connect()`, so shape survives a reload without being persisted. An LFO with no output cable sits at its constructor default (sine). |

**Panel readouts are READ-ONLY (Phase 70).** Knob labels are fixed silkscreen — they no longer relabel themselves to DIV/OFFSET when synced. The old FREE/SYNC `ToggleSwitch` drew a full lever with **no click handler** (mode is cable-driven), so it is now a `ModeIndicator`: two printed words, the live one burning red, the other dark. The division is a permanent `.lfoDivScreen` — dead glass until a clock is patched, then lit. Both are exempt from the lights-out fade via `.selectorRowEmissive` **on the row**, because `opacity` on a parent creates a stacking context a child cannot opt out of.

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| SYNC IN | Input | Clock | Patch **any** clock/CV here to lock the LFO to the sequencer tempo (Transport). Empty = free-running (Moog Phase 65). |
| Sine OUT | Output | CV — Continuous | Smooth, gentle sweep. Good for vibrato. |
| Triangle OUT | Output | CV — Continuous | Symmetric ramp. Subtle tremolo. |
| Square OUT | Output | CV — Continuous | Hard on/off switching. Tremolo chops or octave-jump effects. |
| Sawtooth OUT | Output | CV — Continuous | Rising ramp that resets. Rhythmic filter sweeps. |

**Tone.js Node:** `Tone.LFO` (type selectable). `lfo.frequency.rampTo(hz, 0.05)` in FREE mode. Output routes through `${id}Out` (a Gain the jacks + meter + wave analyser tap) so the free/sync sources can crossfade behind a stable output node.

**Tempo-sync (Moog Phase 65):** patching a clock into **SYNC** flips the module to a Transport-locked mode. In sync mode the **RATE** knob quantizes to a musical **division** (`LFO_SYNC_DIVS`: 4 BAR / 2 BAR / 1 BAR / 1/2 / 1/4 / 1/8) shown as a SYNC chip, and the **MOD** knob becomes **OFFSET** (start phase — which point of the cycle lands on the downbeat, e.g. which vowel begins the bar). DEPTH is unchanged (output scale / modulation spread).
- **Why not `Tone.LFO.sync()`:** measured — it does **not** phase-lock repeatably in v15.1.22 (0.28 mean phase error at equal Transport position across runs). Instead the value is computed deterministically from `Transport.seconds` in the **`lfoSyncTick` rAF** (the `vocShiftTick`/`vowelTick` pattern): `phase = frac(t/periodSec + offset)`, `v = lfoWaveValue(type, phase) · depth`, written to a `${id}SyncSig` `Tone.Signal` (delta-gated; sole writer). Measured phase-lock error: **0.001** (LFO) / **~2 Hz** on a driven vowel formant across loops — i.e. the vowels line up with the beat every cycle.
- **Topology:** `osc → ${id}OscGain → ${id}Out` and `${id}SyncSig → ${id}SyncGain → ${id}Out`. `applyLfoMode(id, synced)` crossfades the two gains (50 ms, click-free) — free mode keeps the smooth audio-rate oscillator (the rAF can't represent fast free rates); sync mode mutes the oscillator and the rAF owns the audible signal (sync divisions are ≤ 1/8, well within rAF fidelity). Engagement is **cable-driven**: `connect()`/`disconnect()` key off the `isLfoSync` jack flag (multi-cable-safe), independent of the knob param path. UI `synced` derives from `useMoogPatch().cables` (matched on `toJackId`/`fromJackId`).

---

### 3. Sequencer

**Function:** The conductor. Stores a loop of 8 programmable steps and steps through them in time with an incoming clock (or its own internal clock). Outputs a pitch CV and a Gate signal for each step.

**Step Count:** **16 steps** as built (Phases 14–18 doubled the classic Moog 960's 8), of which the **cycle length is the number of non-SKIPPED steps**. The step body scans `steps.length`, never a literal — a rack saved with an 8-entry array would otherwise index `undefined` and throw inside the audio callback.

**SKIP vs REST — the distinction is time, and it is what makes odd meters possible (Phase 89).** A REST holds the gate low but still consumes its slice of the bar. A **SKIP is removed from the cycle**: `advanceSeq` walks forward to the next non-skipped index, so a skipped step never becomes current and never costs a tick. Skip 13–16 and the 960 is a 12-step sequencer. The intended workflow for a time signature is **CLOCK = the denominator, playing steps = the numerator** — 3/4 is CLOCK `1/4` with 3 steps, 7/8 is CLOCK `1/8` with 7.
- **`step.skip` is additive** — a step saved before Phase 89 has no such key and `undefined` is falsy, so every existing rack loads as a full 16-step cycle. `SCHEMA_VERSION` is not involved (the rack store is unversioned per-module settings blobs).
- **The scan is bounded by `steps.length`**, so an all-skipped sequencer cannot spin inside the audio callback. It returns early having consumed the tick, writing no pitch and firing no gate, and clears the position LED (`-1`; the callback self-diffs, so repeat `-1`s cost nothing).
- **CLK↑ still pulses once per *played* step**, since one Loop tick resolves to exactly one non-skipped step — a chained 960 advances in lockstep, not in the master's un-skipped time.
- **The cycle floats free of the Transport bar line, by design.** 12 steps at `1/8` is 1.5 bars of 4/4, so it phases against a chord sequencer running at `1m` and against the Workstation timeline. That is a modular sequencer behaving correctly (its cycle is its own length), not a drift bug.
- Verified across wrap-around, mid-pattern gaps, a single playable step, all-skipped, an 8-entry legacy array, and the pre-Phase-89 step shape with no `skip` key.

**Controls (as built — Moog Phase 87):**
| Control | Function |
|---|---|
| **Step Mode Switches (×16)** | Three states, cycled by clicking: **PLAY** (green lamp — gate + pitch) → **REST** (unlit — gate stays LOW, step still occupies its slice of the bar) → **SKIP** (red lamp — removed from the cycle entirely, see below). Two lit colours on one control, both built on the same lamp recipe; the column is never dimmed. |
| **Step Voltage Dials (×16)** | Sets the specific pitch voltage for each step. Cream rotary knobs; 0–1 maps exponentially over `SEQ_HZ_MIN`…`SEQ_HZ_MAX` (C1–C6). |
| **Step Probability (×16)** | Per-step chance the ON step actually fires (`step.gate && Math.random() < step.prob`). 100% = always. |
| **GLIDE** | 0–1.5 s portamento applied at each connected VCO's `glideBus` on the step boundary. |
| **CLOCK** | **This** sequencer's step rate off the rack master clock: 1 BAR · 1/2 · 1/4 · 1/4T · 1/8 · 1/8T · 1/16. Sits beside GLIDE and uses the **VCO RANGE gesture** — hold and drag vertically, `CLOCK_DRAG_PX` 16 px per step. `SEQ_DIVS` is ordered slowest→fastest so up = "more", matching RANGE's up = higher pitch. Reads `EXT` and goes inert when a cable is patched to CLK↓. |

**There is no TEMPO knob on the 960 — the I/O panel owns the master clock (Phase 87b).** Every 960 used to carry one, and every one of them wrote the same global `Tone.Transport.bpm`: with two sequencers the knobs fought, each panel showed its own stale number, and whichever mounted last silently won — a Single Writer violation hiding as a feature. There is exactly one clock in the rack, so there is exactly one knob for it, sitting with the other rack-wide controls (POWER, MASTER volume) on I/O: `IoModule` holds `tempo` state, persists it in the `io` settings blob, and is the sole caller of `audio.setTempo`. `readSavedTempo()` migrates racks stored under the two earlier layouts (`settings.tempo.bpm`, then `settings.seq.tempo`).

**The I/O BPM chip is click-to-type (Phase 87c).** Enter/blur commits clamped to `BPM_MIN`…`BPM_MAX` (20–300), Escape reverts through `escapeRef`, empty/non-numeric keeps the old tempo. Knob and field write the same `tempo` state, so they can never disagree.

**`.bpmInput` inherits ONLY `font-family` (Phase 87e).** A form control doesn't inherit the family by default, but it *does* take `font-size` / `font-weight` / `letter-spacing` from the `.selectorValue` class it also carries — and because `.bpmInput` is declared later at equal specificity, an `inherit` on any of those **wins** and silently drops the field to the body's ~13 px while every neighbouring chip stays at 21. That is what made the BPM readout render visibly smaller than the chips around it. Width is `3.2em`, which resolves against the element's own 21 px so the box tracks the chip type scale.

**It is an `<input>` in BOTH states — never a `<span>` swapped for an input (Phase 87d).** The cabinet auto-scales to its own natural size (`fit()` + a `ResizeObserver`), so a read-state element and an edit-state element whose boxes differ by even a pixel grow the tier and visibly rescale **the entire rack** on click, then again on commit — the same failure mode as the wrapped VCF knob row that `tierRow2`'s extra width exists to prevent. One element, one box, nothing to differ: "editing" is just `:focus`, and the mint cue is a CSS rule. **That rule must be scoped `.selectorGroup .bpmInput:focus` and placed after `.selectorGroup:hover .selectorValue`** — a bare `.bpmInput:focus` is (0,2,0) against the hover rule's (0,3,0) and loses, so the border snapped back to the hover colour whenever the cursor rested on the field being edited.

**Click-away commit needs a capture-phase window listener, not blur.** Most rack controls (jacks, `MoogKnob`, the RANGE/CLOCK selectors) `preventDefault()` on mousedown to own their drag, and that suppresses the browser's focus change — so clicking one left the field focused and mid-edit. The listener runs in **capture** so a target that `stopPropagation`s cannot hide the click, and `commitBpm` is idempotent (`editingBpmRef` guard) because the click-away path also calls `blur()`, which re-fires it. `editingBpmRef`/`bpmDraftRef` are set **eagerly in the handlers**, not left to the render-time inline sync, so a focus+blur pair landing before the next render can't make the commit early-return and drop the edit.

**Two things protect a click-to-type field from the rack camera, and they are not interchangeable.** The camera's pan listener is native, on `.cabinet`; React dispatches from `#root`, an *ancestor*, so a React `stopPropagation` runs **after** the pan handler and cannot stop it — only the camera's own `isInteractive(e.target)` guard can, via `closest('input')` for the field and the **`text` cursor** (added to its cursor allow-list in 87c) for the readout. `stopPropagation` *does* work for keydown, because the QWERTY-note and Escape-reset-view listeners are on `window`, which is *below* `#root` in the bubble order — React's synthetic `stopPropagation` calls the native one, so they never fire. The same asymmetry applies to the VCO's RANGE selector, whose `ns-resize` cursor (not its `stopPropagation`) is what keeps a range drag from panning the rack.

**Per-sequencer speed is CLOCK DIV**, which retimes only that instance's `Tone.Loop` via `setSeqDivisionById` → `loop.interval` — the same shape as the chord sequencer's division control. Gate length is 80% of a step **at that instance's own division** (it was computing `Tone.Time('8n')` regardless until Phase 87, so any other division held envelopes for the wrong slice).

**Ports (4 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Clock IN (`-clk-in`) | Input | Gate — Clock | External clock pulse forces the sequencer forward one step, and **stops its internal clock entirely** while patched. Any gate-domain source works: another 960's CLK↑ or GATE↑, or the keyboard's GATE↑ (one step per keypress). |
| Clock OUT (`-clk-out`) | Output | Gate — Clock | Pulses once per step for daisy-chaining. Unlike GATE↑ it fires on **every** step — a clock is a metronome, so the step switch and the probability roll do not apply to it. |
| Pitch CV OUT (`-pitch-out`) | Output | CV — Continuous (1V/Oct) | Outputs the current step's dial voltage as Hz. Patch to VCO CV IN. |
| Gate OUT (`-gate-out`) | Output | CV — Gate | Goes HIGH when an active step fires, LOW at the step boundary. Patch to Envelope Gate IN. |

**CLK↓ / CLK↑ are gate-domain ports, and were DEAD from Phase 9 to Phase 87.** Both were registered `{ dest: null }` / `{ node: null }` with no `isGate` flag, so `connect()` hit its no-op branches — the jacks rendered, accepted cables, drew the cable and did nothing at all. Exactly the 911 TRIG failure fixed in Phase 78, and the same silent signature. They now register like every other gate port and route through `gateActionsRef`:
- `connect()`'s gate branch has an `isSeqClock` case (ahead of the kick case) that stores `{ isSeqClock, seqId, fromId }`.
- `applySeqClockSource(seqId)` arbitrates internal vs external by **counting live `isSeqClock` connections** for that instance, not a boolean — two cables into one CLK↓ (cables fan in) must not have the first removal re-arm the internal clock. `powerOn` skips ext-clocked loops; starting one would run the sequencer at two rates simultaneously.
- **Recursion guard is load-bearing.** seq1 CLK↑ → seq2 CLK↓ → seq2 CLK↑ → seq1 CLK↓ is a legal patch and an infinite loop; `seqClockDepthRef` + `SEQ_CLOCK_MAX_DEPTH` (4) truncates a cycle instead of overflowing the stack inside the audio callback.
- Under an external clock the incoming pulse rate is unknown, so the instance's own CLOCK DIV stands in as gate width.

**A pulled cable must never leave a VCO muted (Phase 87).** The rest-step mute below writes `${vcoId}bus`, and the step loop is that gain's single writer. Pull the cable while the sequencer is sitting **on a rest** and nothing ever writes it again — the VCO stays silent until the next power cycle. Through a quantizer or chord seq it is worse: pulling the cable that feeds *that* module leaves the VCO's own cable intact, so the mute is unreachable and permanent. `reopenUngatedVcoBuses()` runs after **every** disconnect (the `isVcoCv` branch *and* the generic tail — the tail is what covers the transitive case) and on `removeModule('seq')`. It re-opens only VCOs whose resolved CV origin is no longer a live sequencer, so it never fights the loop for a VCO the loop still owns.

**Rest-step muting is TRANSITIVE (Phase 76).** A 960 mutes the VCOs it drives on rest steps by writing each `${vcoId}bus` gain, and it identifies "the VCOs it drives" by jack identity — `vcoActiveCvRef[vcoId] === '${seqId}-pitch-out'`. That matches on a direct patch but **not** once a quantizer or chord sequencer sits in between, because the VCO's active CV becomes `qnt-cv-out` / `chordseq-cv-out`. Off-steps then silently stopped muting and the note droned through every rest. The gate loop now resolves the source through `resolveCvOrigin(src, connections)`, which walks `cvPassthroughInput` links (`qnt*-cv-out ← qnt*-cv-in`, `chordseq*-cv-out ← chordseq*-cv-in`) back to the originating jack.

**Only `cv-out` is a pass-through — NOT ROOT / 3RD / 5TH (Phase 90).** Phase 76 listed all four chord-seq outputs, which was wrong: the voice outs are generated from that module's **own** step program (`CHORD_BASE_HZ · 2^(rootClass/12)` plus the chord intervals, fired every chord step *"regardless of cv-in state"*), so they carry the chord sequencer's note, not the incoming 960's. Including them made a 960's rest step mute VCOs playing the chord voices — notes that step has nothing to do with. **A rest may only silence the note it is a rest for**; anything wider is a rest reaching outside its own voice. This is the natural failure mode of a transitive walk, so any future addition to `cvPassthroughInput` must answer one question: *is the value at this output literally the value that arrived at that input?* For `cv-out` yes (snapped, but the same note travelling onward); for ROOT/3RD/5TH no.
- **Only the GATE loop resolves transitively — the glide/pitch write above it must keep using the IMMEDIATE source**, because whoever sits directly upstream owns the pitch. Resolving both would give a VCO two writers on its GlideBus (the seq and the quantizer callback).
- Terminates at a non-pass-through jack, at an unpatched pass-through input (that module is then the origin — e.g. a chord seq running its own program, which correctly does NOT gate to an unrelated 960), or at a 4-hop guard that also makes a cable cycle harmless.
- Resolved per step rather than cached on cable changes: the origin depends on cables that never touch the VCO (patching `seq→qnt-cv-in` changes it for a VCO already fed by `qnt-cv-out`), so a cache would need invalidating from every connect/disconnect site. A `=== pitchSrc` short-circuit means direct patches never pay for the walk.
- `powerOff` now reopens every `${vcoId}bus`: powering down on a rest step used to leave that VCO muted until the sequencer next reached a gated step.

### 3b. Chord Sequencer — parity with the 960 (Phase 92)

Everything below mirrors the 960 deliberately: same three step states, same gate/clock contract, same helpers. Where the two modules differ it is because the chord seq emits **pitch CV for a chord**, not a single note.

| Control / Port | Behaviour |
|---|---|
| **Step mode ×8** | **PLAY** (green lamp — chord + GATE↑) → **REST** (unlit — chord advances, no gate, so a progression can move under a sustained note without re-articulating) → **SKIP** (red lamp — removed from the cycle). Skip is what makes a **3- or 7-chord progression** possible. |
| **CLOCK DIV** | Own division off the rack master clock; reads `EXT` and goes inert while CLK↓ is patched. |
| **GATE↑** (`-gate-out`) | Fires on every PLAY chord, width 80 % of this instance's division. Chord stabs no longer have to borrow a 960's gate, which fires on *its* rhythm. |
| **CLK↓ / CLK↑** (`-clk-in` / `-clk-out`) | Same contract as the 960's: CLK↓ stops the internal Loop and the pulse advances one chord; CLK↑ pulses once per executed step. |

**CLOCK DIV is one chip with two meanings (Phase 93b)** — the LFO's RATE-in-sync-mode pattern (Phase 65). Unpatched it is a musical division off the master clock (`½ BAR … 4 BAR`); with a cable on CLK↓ the internal Loop is stopped and the same chip divides the **incoming** pulses instead (`÷1 ÷2 ÷3 ÷4 ÷6 ÷8`), so under a 960's CYCLE↑ it reads as *bars per chord*. Each mode holds its own state, so patching and unpatching never loses the other setting. **The label does not change** (Phase 70: *"a real faceplate is silkscreened — it never relabels itself"*); the VALUE reports the mode, and the `÷` prefix is unmistakable. Briefly shipped as a second `CLK ÷` chip — Dylan, correctly: *"it essentially does the same thing the clock div does."*

**Choosing which 960 a progression follows (Phase 93).** With two or more 960s in the rack, "follow that one, in its meter" is a **cable**, not a setting: patch the chosen 960's **CYCLE↑** into the chord seq's **CLK↓**.

`${seqId}-cycle-out` pulses **once per completed cycle** rather than once per step. Detection is derived, not counted — the step scan only moves forward and wraps, so landing on the **first playing step** means the cycle just came round (`idx === firstPlaying`). That matters because it makes CYCLE↑ track the 960's *real* length as skips are edited mid-run: skip down to 3 steps and the chords change every 3, with nothing else to adjust. A counted "every N pulses" would need the user to keep N in step by hand — which is the problem this solves.
- **CYCLE↑ is a pulse, not a gate:** on any step that is not the top of the cycle it emits *nothing* — it does not release, the way an unfired GATE↑ does.
- **Divider phase is "advance on the FIRST pulse, then every Nth."** Counting the other way round swallows the downbeat, leaving the opening bar with no chord while the counter warms up. Re-phased by `powerOn`, `resetSequencers` (so a Workstation take starts at chord 1), and any CLK ÷ change.
- Verified across 4/4, 3/4, 5/4, 7/8 at ÷1, 3/4 at ÷2, a skipped first step (cycle top correctly becomes step 2), and a single-playing-step 960 (every tick is a cycle).

- **`gate` / `skip` are additive** — a chord step saved before Phase 92 has neither key; the loop reads `gate !== false` and falsy `skip`, so old racks load as a full 8-chord cycle with every step gating.
- **`dispatchStepActions` is shared** by `advanceSeq` and `advanceChordSeq`. Extracted rather than duplicated because the recursion guard **must be one counter across both module types** — a mixed cycle (960 CLK↑ → chord CLK↓ → chord CLK↑ → 960 CLK↓) is otherwise unbounded. Verified: capped at `SEQ_CLOCK_MAX_DEPTH`, no stack overflow.
- Skip scan, all-skipped early return, `applyChordSeqClockSource`, and the `powerOn` ext-clock skip are the 960's, instance-for-instance.

**All value chips share one gesture (Phase 92).** `beginDragSelect` — **drag vertically to scrub, click to step one** — backs VCO RANGE, 960 CLOCK, chord CLOCK DIV / ROOT OCT / per-step root + quality, and QNT SCALE / ROOT / OCT. Nine call sites; the drag maths was not worth transcribing nine times. `wrap: true` for genuinely circular lists (pitch class, chord quality — clamping made B→C a 12-step crawl); ordered ranges clamp so their ends are felt. **The `ns-resize` cursor is load-bearing**, not decoration: it is what tells the cabinet's `isInteractive` check this is a control, since the pan listener is native on `.cabinet` while React dispatches from `#root` (see the BPM-field note below). (QNT BYPASS was the one plain-click binary chip; it was removed in Phase 95, so every value chip is now a drag chip.)

**A chip is a FIXED box — it never resizes to its own text (`ChipValue`, Phase 101).** Content-sized chips re-flowed their row: QNT's LEARN going `OFF` → `PLAY…` was enough to wrap the line and make neighbouring controls jump to a second row and back. `ChipValue` renders **every reading the chip can take** into one CSS grid cell and hides all but the current, so the box measures the longest option in the real font — exact, and self-maintaining when a label is reworded (the older `.selectorValueRange` does the same job with a hand-tuned `em` width). **`visibility: hidden`, never `display: none`** — the hidden copies must stay in layout or they add no width and the mechanism silently does nothing. Reading lists are **derived** from the label tables, never retyped. Rows carrying these chips should be `nowrap`: with fixed chips the row width is constant, so there is nothing left to wrap, and wrapping only ever reintroduces the jumping.

**A chip whose jack is patched glows (`.chipOverridden`, Phase 95).** Same mint 1.6 s pulse as `MoogKnob`'s `.knobGlow`, and deliberately the same meaning — *this control is being driven from somewhere else, so its number is not what the module is using*. Currently QNT ROOT while TRP is patched, which until Phase 95 showed and scrubbed a stale value with no indication at all. Animate `box-shadow`, not `filter`: the chip's `.selectorValue` carries an inset shadow that a `filter` drop-shadow would smear.

**Chord voice → VCO: the chord owns the note, the FREQ knob owns the octave (Phase 94).** Patching ROOT / 3RD / 5TH / 7TH into a VCO's `cv-in` left that VCO's FREQ knob doing nothing — the only register control was the chord seq's ROOT OCT, which moves every voice at once. `snapVoiceToKnobOctave(voiceHz, knobHz)` snaps the voice to whichever octave **of itself** lands nearest the knob: a quantizer whose grid is the octaves of one pitch class rather than a scale, i.e. the 902's knob-stepper idea (Phase 57) at coarser resolution. `Math.round` in log2 space puts each switch-over a **tritone** above the octave, giving the widest possible dead zone either side.
- **`CHORD_VOICE_KINDS` is the single source for all three chord-output lookups** (`CHORD_VOICE_OUT_RE`, `CHORD_OUT_RE`, `CHORD_OUT_SUFFIX`). They were three hand-written literals until Phase 94b, and adding the 7TH in Phase 91 updated only two — `connect()`'s kept `(cv|root|3rd|5th)`, so a 7TH → VCO cable failed the managed-source test and took the **audio pass-through** branch. That left the GlideBus with two writers (the loop's snapped `setValueAtTime` plus the raw Signal summing in through the cable), so the 7th played sharp and ignored the FREQ knob. Derived now, so a future 9th cannot half-land the same way.
- Applied at **three** sites, or the knob feels broken: the chord loop's voice write, `updateVcoParams` (re-snaps off `chordVoiceLastHzRef` so the knob responds *while a chord is held*, not at the next chord), and `connect()`'s seed (otherwise patching parks on the chord's own octave until the next step).
- The VCO's FREQ knob takes the **same mint glow** as quantizer knob-stepper mode — `knobQuantizedVcoIds` returns chord-voice VCOs too. One meaning for one indicator: *this knob is stepping, so its position is not literally the pitch.*
- **ROOT OCT is mathematically absorbed for a knob-controlled VCO** — octave-shifting a note cannot change the set of its own octaves, so the knob always wins. Verified. It still governs voices patched anywhere other than a VCO `cv-in`. This is the intended trade: per-voice registers were the whole request.
- Because each voice's octave is independent, **inversions and open voicings are now hand-buildable** (the 5th naturally lands below the root at some knob positions) — a manual subset of the auto voice-leading discussed as future work.

**A managed pitch source is written, never polled — the chord-seq path (Phase 88).** A chord sequencer's `cv-in` is an **analyser**, and the snapper rAF polls it, snaps the reading to the current chord, and writes the result. That is the only thing that can work for a genuine audio source (an LFO, a VCO), but it is a *poll*: an analyser buffer plus up to a frame of latency, on wall-clock time. A 960's pitch out is not a signal to be measured — it is a value the step loop already knows, at an audio time it already knows. Polling it made the pitch land tens of ms after the gate that the **same step** scheduled sample-accurately, so a note attacked on the *previous* step's pitch and then jerked to the right one: two notes per step, loudest after a rest (the wrong pitch gets a fresh gate opening instead of blending into a still-ringing note).

`managedPitchSourceFor(csId, connections)` returns the 960 feeding a chord seq's `cv-in`, or null. It splits ownership by **source kind** — the same managed/pass-through split `connect()` already applies at a VCO's `cv-in`:
- **`advanceSeq` writes** the chord seq's `PitchOut` and every downstream VCO `glideBus`, snapped, at the step's `time`. Glide comes from the **seq**, matching what `glideForPitchSource` resolves for this path.
- **The snapper rAF stands down** for that instance (flags `chordSeqInputActive` true by definition rather than inferring it from the analyser, and clears its delta gate so a cable pull resumes cleanly).
- **`buildChordSeqLoop` re-snaps on chord change**, reading `seqLastHzRef` — otherwise a bar-line chord change leaves the held pitch on the *previous* chord until that 960's next step, since the 60 fps rAF that used to cover it has stood down.

**Order-independence is load-bearing and tested.** At a bar line both Loops fire at the same `time`; a same-time `setValueAtTime` replaces the earlier one, so whichever Tone runs second wins — and by then both refs it reads (`seqLastHzRef`, `chordSeqCurrentStepRefs`) are current. Verified: seq-first and chord-first converge to the identical Hz, so no Loop-ordering assumption is needed. *Out of scope:* `kbd-pitch-out → chordseq-cv-in` still polls. The same race exists there but is far milder — the keyboard writes at `Tone.now()` with no lookAhead — and it would need its own write site in `updateKeyboard`.

**Tone.js Node:** one `Tone.Loop` per instance (`buildSeqLoop`), interval = that instance's CLOCK DIV. The loop body is a thin wrapper around **`advanceSeq(seqId, time)`**, which was extracted from it in Phase 87 precisely so an external clock pulse can call the same step body; `time` is the scheduled audio time from the Loop, or `undefined` → `Tone.now()` from a keyboard-driven pulse.

---

### 4. VCA — Voltage Controlled Amplifier [Implemented: Moog Phase 6 · ENV AMT / LOG-LIN / OUT lamp + seq-gate removal: Phase 71]

**Function:** The volume gate. The VCO is always on — the VCA is the dam that lets sound through only when CV tells it to. Without a VCA, every note drones forever.

Static ×3 (`vca`, `vca2`, `vca3`) plus library instances (`vca4`+). All instances are built by the same helper and behave identically.

**Controls (as built — Moog Phase 71):**
| Knob | Function |
|---|---|
| **GAIN** | INITIAL GAIN / bias, linear 0–1, written straight to the `Tone.Gain`'s own `gain` param. This is the level that passes with **no** CV patched. CV sums on top of it, so GAIN = 0 gives full envelope gating and GAIN = 1 passes at full level regardless of CV. Sole writer of the intrinsic value; the cable owns the connected input (the standard Moog knob+CV split). |
| **CV 1** / **CV 2** | Independent attenuators (`${id}Cv` / `${id}Cv2`) on the two control inputs. 0 = that input has no effect, 1 = full range. CV 1 was visual-only until Phase 71 (labelled ENV AMT); CV 2 added Phase 77. |
| **LOG / LIN** | Response curve of that CV (`${id}CvShape`), the 902's LIN/EXP switch. Clickable; defaults to **LIN** (the pre-Phase-71 behaviour). |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Audio IN (`-in`) | Input | AUDIO | Receives the raw (forever-on) audio signal from VCO or VCF. |
| Volume CV 1 (`-cv`) | Input | CV — Gate / Continuous | Tells the VCA when and how much to open. Usually from an Envelope OUT. Lands on its attenuator, **never on `gain` directly**. Jack id is `-cv`, not `-cv1` — kept so cables saved before CV 2 existed still resolve. |
| Volume CV 2 (`-cv2`) | Input | CV — Gate / Continuous | Second control input with its own attenuator (Phase 77). |
| Audio OUT (`-out`) | Output | AUDIO | The gated, shaped audio signal. Taps the `Tone.Gain` itself on every instance. |

**Signal (per instance, `buildVcaCv(n, id)`):**
```
-in  ─────────────────────────────► ${id} (Tone.Gain) ──┬──► -out
-cv  ► ${id}Cv  ─┐                                       └──► ${id}Meter (OUT lamp)
     (CV 1 att)  ├─► ${id}CvShape ─► ${id}.gain
-cv2 ► ${id}Cv2 ─┘    (LOG/LIN)
     (CV 2 att)
```

**The two CVs sum BEFORE the response curve, not after (Phase 77).** That is how a real VCA behaves — several control voltages meet at one control port and the amplifier's linear or exponential response acts on their SUM — and it is why there is ONE shaper rather than two. Shaping each input separately and adding the results would make two half-open CVs read as two small gains instead of one large one: measured in LOG, two CVs at 0.5 give **1.000** summed-first (fully open, correct) versus **0.061** shaped-separately (near-silent). Web Audio sums multiple connections into a node's input, so no summing node is required.

**Why two inputs.** With one shared attenuator an envelope and an LFO could be patched together (cables fan in) but only scaled together, so softening the envelope also killed the tremolo. Verified: at a target of "envelope peaking 0.3, tremolo ±0.5", one shared attenuator caps the tremolo at ±0.30; two independent ones deliver ±0.50 with the envelope still at 0.30. An unpatched CV 2 contributes exactly 0, so a rack using only CV 1 is bit-identical to pre-Phase-77.

**LOG vs LIN — both curves pass through the origin, and that is load-bearing.** `${id}CvShape` is a `Tone.WaveShaper`; LIN is the identity, LOG is dB-linear across `VCA_LOG_RANGE_DB` (60 dB): `y = (10^((x−1)·60/20) − 10^(−3)) / (1 − 10^(−3))`, normalised so **f(0) = 0 and f(1) = 1**. A WaveShaper fed silence still emits `curve(0)`, so a curve that missed the origin would park a permanent DC offset on every VCA's gain with nothing patched. `VCA_CURVE_POINTS` is **odd** (1025) so x = 0 lands exactly on a sample rather than being interpolated. Negative CV clamps to 0 in LOG (no negative dB-domain gain); LIN passes it, so a bipolar LFO can still subtract from the GAIN bias as it always could. Musically: a linear envelope ramp through LIN stays loud then drops away sharply at the very end; through LOG it fades perfectly evenly, because hearing is logarithmic — that is the "natural instrument decay" setting. Curve writes are **delta-checked against `vcaLinRefs`**, not against the node's `.curve` getter (Web Audio copies the array on set, so read-back is not a reliable identity check).

**No hardwired seq gate (Phase 71).** `vca-out` used to tap `seqGateNode`, a gain node written per step by sequencer 1's `Tone.Loop`, so VCA 1's output was chopped to seq 1's rhythm **with no cable patched** — a hardwired audio path, which this document has forbidden since Phase 10. A twin `vca-out2` on `seq2GateNode` existed in the jack map but was never rendered, so it was unreachable. Both nodes are gone; `buildSeqLoop`'s `n[`${seqId}GateNode`]?.gain` write is optional-chained and is now a no-op for statics exactly as it always was for dynamic sequencers, whose musical gate paths (env/kick gate cables + per-VCO bus gating) are unaffected.

**Tone.js Nodes:** `Tone.Gain` (the amp) + `Tone.Gain` (CV attenuator) + `Tone.WaveShaper` (response) + `Tone.Meter` (OUT lamp).

---

### 5. Envelope Generator — ADSR

**Function:** The shaper. When triggered, it outputs a single, non-repeating voltage curve that mimics the physical dynamics of an acoustic instrument. Most often used to control the VCA (volume shape) and VCF (timbre shape) simultaneously.

**[Correction vs Gemini spec]:** Gemini merged Trigger and Gate into one port. The real Moog 911 has **separate Trigger and Gate inputs** because they behave differently:
- **Trigger IN:** A microsecond spike — fires the Attack phase even if gate never opens (percussive hits, ping mode).
- **Gate IN:** A held HIGH signal — sustains the envelope until it drops LOW, then fires Release.
For MVP a single combined port is acceptable, but the distinction must be understood.

**Controls:**
| Knob | Function |
|---|---|
| **Attack** | Time for voltage to rise from 0 to peak after a trigger (0.001s – ~10s). |
| **Decay** | Time to fall from peak down to the Sustain level. |
| **Sustain** | The level held while the gate stays HIGH (0 = fully off, max = stays at peak). |
| **Release** | Time to fade from Sustain level back to 0 after gate closes. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Trigger IN (`-trig`) | Input | CV — Trigger | Fires a ONE-SHOT: attack → decay → release, length taken from the envelope's own A+D knobs, so the source's gate length is irrelevant. A rest step simply doesn't fire (a trigger has no "off"). **Dead from Phase 1 until Phase 78** — the jack was `dest: null` with no `isGate`, so `connect()` hit its `if (to.dest === null) return` no-op and the cable did nothing at all. |
| Gate IN (`-gate`) | Input | CV — Gate | Holds Sustain open while HIGH; closing fires Release, so the note's length is the incoming gate's length. |
| Envelope CV OUT | Output | CV — Continuous | The ADSR voltage shape. Patch to VCA CV IN and/or VCF Cutoff CV IN. |

**GATE vs TRIG is the whole point of two ports.** GATE length comes from the source; TRIG length comes from the knobs. Both register in `gateActionsRef` via `connect()`'s gate branch (the jack carries `isGate: true` plus `isTrig` for the trigger), and both firing sites — the 960 step loop and `updateKeyboard` — branch on `action.isTrig` through the shared `triggerEnvOneShot(env, time)` helper. Its duration is `attack + decay`, floored at 2 ms so an all-zero envelope still clicks rather than doing nothing.

**`powerOff` releases every envelope** (statics + dynamics). An envelope is not a source, so holding the manual GATE button or a patched gate while powering down parked the `Tone.Envelope` at its sustain level with nothing to bring it back — the next power-up then started with that VCA wide open and droned until something released it.

**Tone.js Node:** `Tone.AmplitudeEnvelope` for VCA control. For VCF control: use `Tone.Envelope` whose output signal is scaled and added to the filter frequency AudioParam.

---

### 6. VCF — Voltage Controlled Filter

**Function:** The tone sculptor. Takes a harmonically rich waveform (Sawtooth is ideal) and removes frequencies above (or below) the Cutoff point. Resonance boosts the frequencies at the cutoff for the iconic Moog squelch. This is subtractive synthesis.

**Filter Type:** **24 dB/octave Moog Ladder Filter** — a 4-pole lowpass design with distinctive resonance character. **[Note: Tone.js's built-in `Tone.Filter` uses a `BiquadFilterNode` which maxes at 12 dB/oct. For true Moog ladder sound, consider `Tone.Filter` at 24 dB or a custom `MoogLadderFilter` using cascaded biquads. Flag for Phase 3.]**

**Controls (as built — Moog Phase 70):**
| Knob | Function |
|---|---|
| **Cutoff Frequency** | Exponential 20 Hz–20 kHz (`20 · 1000^knob`). Writes `filter.frequency` — the knob is its sole writer. |
| **Resonance** | `Q = knob · 20` (floored 0.001 — Q=0 breaks the exponential ramp). |
| **ENV AMT** | Attenuator on the ENV jack's cutoff depth. Sole writer of `vcfenv.gain`. At max, a peaking envelope lifts a fully-closed cutoff across the WHOLE knob range (`VCF_ENV_CENTS` ≈ 11959 cents ≈ 9.97 oct, derived from the cutoff span itself). |
| ~~CV Attenuator~~ | **Not built** — declined Phase 70. CV 1/CV 2 carry a fixed `VCF_CV_CENTS` (≈5980, i.e. ±5 oct, half of ENV because CV is bipolar); depth belongs to the source's own level knob. Genuinely missing for fan-out and for level-less sources (ENV, seq/kbd pitch out, VCO outs) — revisit if those bite. |
| ~~KBD tracking~~ | **Removed** Phase 70 — it was never wired, and keyboard tracking is a *Minimoog* feature, not a 904A one. |

**Ports (5 Total, as built):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| Audio IN (`-in`) | Input | AUDIO | From VCO, mixer, or another filter. |
| CV 1 / CV 2 (`-cv1`/`-cv2`) | Input | CV — Continuous | Cutoff modulation, fixed depth. |
| ENV (`-env`) | Input | CV — Continuous | Cutoff modulation, depth set by ENV AMT. |
| Audio OUT (`-out`) | Output | AUDIO | Filtered audio. |

**Tone.js Node:** `Tone.Filter` (type `lowpass`, rolloff −24 = **two cascaded biquads**). Cutoff uses `setTargetAtTime` — frequency-type params dispatch `rampTo` → exponential, which is unsafe near 0.

**CV summing is EXPONENTIAL, on `detune` (Moog Phase 70).** All three CV inputs are **cents scalers** feeding `filter.detune`, never `frequency`. Native BiquadFilter computes `frequency · 2^(detune/1200)`, so a given depth moves the cutoff by the same musical interval wherever the CUTOFF knob sits; linear-Hz summing made one envelope a 3.5-octave slam at a low cutoff and an inaudible nudge at a high one. Cents also sum correctly across the three inputs (= multiply in Hz), which is how 1V/oct CV behaves. `Tone.Filter` fans its `detune` Signal to both cascaded biquads. Single-writer holds: the knob owns `frequency.value`, the cables own the connected `detune` input.

**Not a true ladder — deliberate.** The faceplate says "24 dB/OCT LADDER" but the core is cascaded biquads, which cannot self-oscillate, do not thin the passband as resonance rises, have no drive, and (because Tone fans `Q` into *both* biquads) produce an effectively squared, spiky resonance. A real Huovilainen ladder worklet was built in Phase 70 and **reverted — Dylan preferred the biquad's smoother character.** If it is ever revisited, ship it as a separate library module rather than swapping this core (see MOOG_PLAN Phase 70).

---

### 7. CP3 Mixer — Signal Combiner [REMOVED — Rack Expansion session 2026-06-10]

> **Removed from the rack.** The component, its 5 `Tone.Gain` nodes, and its 5 jacks were deleted; the 4-channel I/O mixer (Phase 23, `io-in1..4`) covers multi-source summing. Spec retained below for historical reference.

**Function:** A transistor-based summing amplifier. Takes up to 4 audio signals (typically VCO outputs) and combines them into a single output with individual channel level controls and a master output gain. At high gain settings, the transistor summing bus produces characteristic warm saturation — a primary contributor to the classic Moog "fat" sound. This is not simple clipping; it is asymmetric transistor-level compression.

**Controls:**
| Knob | Function |
|---|---|
| **CH 1–4 Gain** | Individual input level for each channel. |
| **Master** | Overall output level. High settings drive the transistor bus into warm saturation/clipping. |

**Ports (5 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| IN 1 | Input | AUDIO | Channel 1 input (typically VCO 1 SAW or SQR output). |
| IN 2 | Input | AUDIO | Channel 2 input (typically VCO 2 output). |
| IN 3 | Input | AUDIO | Channel 3 input (typically VCO 3 output). |
| IN 4 | Input | AUDIO | Channel 4 input (auxiliary — noise, external, or LFO audio). |
| OUT | Output | AUDIO | Summed output. Patch to VCF Audio IN. |

**Tone.js Node:** Four `Tone.Gain` channel nodes summing into a single `Tone.Gain` master bus. For clipping character: a `WaveShaperNode` on the output with a soft-knee transfer curve. Phase 3 will initialize the nodes disconnected; Phase 8a will wire knobs.

---

### 8. Noise Generator [Implemented: Moog Phase 8b, 2026-07-11 · six colours + scope + LEVEL CV: Phase 69, 2026-07-29]

**Function:** Generates random electrical signals — a sound source (wind, ocean, percussion transients), a random CV source, or a test signal. **Six colours** are available simultaneously, each on its own output jack (spectral tilt in parentheses): WHITE (flat), PINK (−3 dB/oct), RED (−6 dB/oct, deep — aka brown noise), BLUE (+3 dB/oct, bright), VIOLET (+6 dB/oct, brightest/thinnest), GREY (perceptually even). A shared LEVEL knob + a LEVEL-CV jack scale all six.

**Controls:**
| Knob | Function |
|---|---|
| **Level** | Output amplitude of all six colours before the jacks (knob 0–1 → gain 0–1.43×, unity at 0.7). |

**Ports (7 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| WHITE / PINK / RED / BLUE / VIOLET / GREY OUT | Output | AUDIO / CV | The six colours, each tapping its own LEVEL gain. |
| LEVEL CV IN | Input | CV — Continuous | LFO/CV that modulates the LEVEL of all six colours (jack `-lvl-cv`, right of the LEVEL knob). |

**Tone.js graph (per instance, `buildNoiseColors(n, id)`):** three real sources — `Tone.Noise('white'|'pink'|'brown')`. Each colour has its own `Tone.Gain` LEVEL stage the jack taps. Derived colours filter off the shared sources (fewer running sources): **RED** = brown → gain; **BLUE** = pink → native `IIRFilter([1,-1],[1])` differentiator (−3 + 6 = +3 dB/oct); **VIOLET** = white → same differentiator (+6 dB/oct); **GREY** = white → lowshelf(+) → peaking(−9 @3.5 kHz) → highshelf(+) (inverse equal-loudness). A biquad shelf cannot make a constant broadband slope — hence the IIR differentiators. `updateNoiseParams(id, { level })` is the single writer of all six gains, each scaled by a per-colour makeup (`NOISE_LEVEL_GAINS`) so the colours sit at comparable loudness. **LEVEL CV** fans through per-colour makeup scalers into each gain's AudioParam (knob owns intrinsic value, CV sums — makeup-balanced like the knob). Jack ids: `-wht/-pnk/-brn/-blu/-vio/-gry` + `-lvl-cv` (kept `-brn` internally though the label reads RED). Applies to the 3 static modules and every dynamic instance.

**Visualizer:** a retro CRT scope (`NoiseScope`) draws a procedural noise trace tinted to whichever colour is currently patched (`useMoogPatch().cables`, most-recent wins); trace roughness varies per colour, amplitude tracks LEVEL. Zero-Re-render (canvas-in-rAF, Phase-61 visibility-gated); stays emissive-bright in lights-out with the I/O-oscilloscope bezel treatment.

---

### 9. Multiples — Passive Signal Router [REMOVED — Phases 27–29, 2026-06-08]

> **Removed from the rack** (component, 8 jacks, and CSS). Jack ids are globally unique and cables cross rows freely, so fan-out is achieved by patching multiple cables from any output jack. Spec retained below for historical reference.

**Function:** A purely passive (no electronics, no power) signal distribution utility. Within each bank, all 4 jacks are hardwired together. Plugging a signal into any jack of a bank routes that signal to all other jacks in the same bank simultaneously. Used to distribute a single CV or audio source to multiple destinations (e.g., one LFO simultaneously modulating both VCF cutoff and VCO 2 frequency).

**Controls:** None.

**Ports (8 Total — 2 banks of 4):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| A1–A4 | Bidirectional | Any | Bank A: all 4 jacks electrically tied. Signal in → signal on all other A jacks. |
| B1–B4 | Bidirectional | Any | Bank B: same as Bank A, electrically isolated from Bank A. |

**Tone.js Implementation:** No dedicated audio node. Implemented in Phase 7 (patch cable simulator) as a fan-out: when a cable connects to a Multiples jack, `useMoogAudio.connect(src, dest)` is called for every other currently-occupied jack in that bank. Bank isolation is enforced in the connection manager.

---

### 9b. KICK — Membrane Drum Synthesizer [Implemented: Moog Phase 60d · trigger hygiene Phase 79 · CLICK TONE + TUNE CV Phase 80]

**Function:** A `Tone.MembraneSynth` body plus a filtered-noise beater transient. Static `kick` plus library instances (`kick2`+).

**Signal:** `Synth → Out` and `ClickSynth → ClickFilter → ClickGain → Out`. Jacks `-gate-in` (isGate/isKick) / `-click-in` (ACCT) / `-tune-cv` / `-out`.

**Controls:** TUNE (40–200 Hz) · P.ENV (0–5 oct drop) · DECAY (0.05–2 s, also the note length) · CLICK (transient level) · **TONE** (beater highpass, 333 Hz–12 kHz; knob centre is exactly the 2000 Hz it was hardcoded at before Phase 80).

**Trigger times are clamped strictly forward (`nextKickTime`, Phase 79) — load-bearing.** Tone's monophonic voices are Sources, and `Source.start()` asserts *"Start time must be strictly greater than previous start time"*. The sequencer schedules `lookAhead` (~0.1 s) into the future while the manual TRIG button fires at `Tone.now()`, so **clicking TRIG while a step is pending is in the past relative to it** — a guaranteed throw inside the step loop, not a load-dependent race. `KICK_MIN_GAP_S` is 1 ms, far below audibility on a drum, and the clamp is applied per instance to **both** voices (body and click are both Sources).

**TUNE CV is Hz-DOMAIN.** Despite this document's 1V/oct header, every pitch out on the rack (`seq-pitch-out`, `qnt-cv-out`, `chordseq-*-out`, `kbd-pitch-out`) emits the frequency itself — that is what the VCOs' glideBus consumes. So the patched signal's **value becomes the drum's fundamental**, which is what makes sequenced tom fills and melodic drums work; a ±1-style CV would have been incompatible with every pitch source here. With a cable present the **TUNE knob becomes a transpose** around the incoming pitch (centre = unity, span ±13.9 semitones), so neither control goes dead. Engagement is **cable-driven** (a patched-but-idle source reads 0, indistinguishable from no cable — the `isLfoSync` pattern) and resolved at trigger time by scanning `connectionsRef`, not cached. Sampled from a per-instance `Tone.Analyser` because "read the pitch at the moment the drum fires" is a lookup, not an AudioParam connection. Clamped 20–2000 Hz.

**Rhythmic LEDs go through `drawAt` (Phase 79).** Firing them straight from the Loop callback lit them `lookAhead` early — ~40% of an eighth note at 120 BPM. `drawAt` wraps `getDraw().schedule` with a fallback to an immediate call. Applies to the kick lamp (both paths) and the 960 step LED.

---

### 10. I/O — Input / Output Module

**Function:** The bridge between the modular world and the real world. Routes external audio (mic, guitar) into the patch system as an audio signal source, and routes the final patched signal out to speakers or a recording interface.

**Controls:**
| Knob | Function |
|---|---|
| **Input Gain** | Boosts or attenuates the incoming external audio signal before it enters the rig. |
| **Output Gain** | Master volume for the entire modular output. The **PEAK lamp** taps `n.master` (post-knob, i.e. what actually leaves the rack). Until Phase 71 it tapped `seqGateNode` — VCA 1's seq-gated output — so it was blind to the MASTER knob and to every patch that didn't happen to run through VCA 1. |

**Ports (4 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| External IN | Input | AUDIO (real-world) | Receives microphone or instrument signal via browser `getUserMedia`. |
| To-Rig OUT | Output | AUDIO | Sends the conditioned external signal into the modular patch system. |
| From-Rig IN | Input | AUDIO | Receives the final processed signal from the end of the patch chain. |
| Speakers OUT | Output | AUDIO (real-world) | Routes to `Tone.Destination` / `AudioContext.destination`. |

**Tone.js Node:** `Tone.UserMedia` (for External IN → To-Rig OUT). `Tone.Volume` (Output Gain master node). `Tone.Destination` (Speakers OUT). The I/O module should be the only module that writes to `Tone.Destination` — all other modules patch into From-Rig IN.

> **The Controls / Ports tables above are the ORIGINAL 2026-06 spec and no longer describe the module.** External IN / To-Rig OUT and the Input Gain knob moved to the Vocoder in Phase 48; the master clock arrived in Phase 87b. Retained for history — the as-built description is below.

**As built:** eight input channels → per-channel `ioCh1…8` `Tone.Gain` (the faders, `updateIoChannelVol` is their single writer) → `master` (`Tone.Volume`, the MASTER knob, `updateIoParams` its single writer) → **`masterLimit`** → `seqMasterGate` (`Tone.Gain`, `.toDestination()`) → speakers, with `moogBus` tapped off the gate for the Workstation recorder. **`io-in` is CHANNEL 5 and its jack id must never change (Phase 104).** It was the unmixed legacy "IN ✦" landing straight on `master`; it now runs through `ioCh5` with its own fader and meter like every other channel. The id stays `io-in` rather than becoming `io-in5` because **saved racks persist cables as `{ from: jackId, to: jackId }`** — renaming it would orphan every cable ever patched to it. Only the panel label reads "IN 5". `IO_JACK_IDS` (MoogShell) is the ordered list, with the historical id sitting in position 5.

**Channel controls are `MoogFader`, not knobs — and that is a layout mechanism (Phase 104).** A `sm` `MoogKnob` reserves 52 px for its tick ring; `MoogFader` reserves 26 px, so the column is sized by the **jack** (29 px) instead of the level control. That is what let 4 channels become 8 with the plate unchanged: 8 fader columns measure 253 px against the old 5 knob columns' 276 px. `cursor: ns-resize` on the fader is **load-bearing** — it is what the cabinet's `isInteractive` check reads to know this is a control and not faceplate to pan the rack with.

`chVols` **pads on load**: pre-104 racks store four entries, and a bare `?? [...]` would leave channels 5–8 `undefined`. The seed builds a full-length array, preserving existing positions and defaulting the rest.

**Lights-out rule for any new control: hide the WHOLE thing, not just its printed label.** `MoogKnob` hides `.knobGroup`, `MoogFader` hides `.faderGroup`. A control is a physical object — with the room dark there is no light for it to catch, so it has nothing to be seen by. Only emissive things stay lit (LEDs, the QNT screen, the scope, lamp states like `.seqGateOn`). `MoogFader` shipped hiding only its label and the faders stayed plainly visible in the dark — the reasoning was "it's a real object so it persists", which is precisely backwards. Channel LEDs tap each `ioChN` **post-fader**; the **PEAK** lamp taps `master` **post-knob** (Phase 71 — it used to tap VCA 1's gated output and was blind to both). The scope taps `master` too. Panel also carries **POWER**, the rack-wide **TEMPO** knob + click-to-type **BPM** field (Phase 87b–e).

**`seqMasterGate` is the rack's power gate (Phase 102).** `powerOff` ramps it to 0 and `powerOn` ramps it back to 1 **before** starting any source. It previously re-*opened* on power-down, which made POWER OFF depend on every source stopping — and plenty do not: the **mic** is a `Tone.UserMedia` with its own lifecycle, and **anything with a feedback loop or a tail keeps feeding the output on its own** (CHRONOS delay — confirmed by a long-standing "hum after power off" that this fix silenced — plus reverb tails and the BBD chorus). **Gate the one gateway; never try to enumerate the sources.** That list is open-ended, and every new looping or self-oscillating module would silently rejoin it. Ramped both ways: a hard gain jump on a live signal clicks. Known and accepted: buffers are muted, not cleared, so power-on can replay a moment of an old delay tail.

**`masterLimit` is the output brick wall (Phase 103)** — `threshold −1, ratio 20, knee 0`, the same recipe VOWEL and the vocoder use and explicitly **not** `Tone.Limiter` (30 dB soft knee, barely compresses — Phase 64a). **PEAK and the scope deliberately tap `master` PRE-limiter**: they must show what you are *feeding* the output. Tapping post-limiter would mean the lamp could never light, because the limiter has already fixed it — the rack would compress silently with no indication why it sounded squashed.

**PEAK is a true peak/clip lamp (Phase 103).** `getMasterPeak()` takes max |sample| over the scope's analyser buffer and returns it **UNCAPPED** — `> 1` is clipping. It replaced `getMeterValue('master')`, which was smoothed RMS *clamped to 1*: the clamp made full scale and 3× over read identically, and the smoothing averaged away the short transients that actually clip (measured: a 1-sample 1.4 spike reads peak 1.40, rms 0.080). `Led`'s optional `clipAt` latches the lamp hot-red for 900 ms — **the latch is required, not cosmetic**: a 1-sample clip is visible in ~0.1% of frames otherwise. Class writes are diffed, per the Phase-61 paint rule.

**MASTER at zero is true silence (Phase 103)** — `volume ≤ 0.005 → -Infinity` dB, which `Tone.Volume` converts to a gain of exactly 0. The old floor was −60 dB (0.1% amplitude), audible on a loud patch; a threshold rather than `=== 0` keeps the end of the knob travel from being a dead zone. Everything above it is unchanged.

**A restored tempo is validated, not trusted (Phase 102).** `readSavedTempo` migrates two older storage layouts and can also be fed a hand-edited `.moog`, so it coerces with `Number()`, rejects non-finite, and clamps to `BPM_MIN…BPM_MAX`. Its old `?? 120` only caught `null`/`undefined`; every other route to the tempo was already bounded.

---

### 11. Vocoder — 16-Band Spectral Vocoder [Implemented: Moog Phase 42 · PROGRAM presets + mic noise gate: Phase 72]

**Function:** Imposes the spectral envelope of a **modulator** signal (voice, drum machine, sequence) onto a harmonically rich **carrier** signal (VCOs). Each of 16 frequency bands measures the modulator's energy and uses it to gate the matching band of the carrier — the classic "transfer of characteristics" / talking-synth effect.

**Bands:** 16 log-spaced bandpass bands, 100 Hz → 8 kHz (geometric ratio ≈ 1.339), Q = 4. Exported as `VOC_BANDS` from `useMoogAudio.js` (mirrors the `FFB_BANDS` pattern), shared between the audio engine and the UI meter.

**Controls:**
| Knob | Function |
|---|---|
| **MIX** | Dry/wet crossfade. **Dry = raw carrier passthrough**, wet = vocoded output. At 1.0 (default) you hear pure vocoded signal; at 0.0 the unprocessed carrier. |
| **VOLUME** | Master output level (`vocVolume`, the `voc-out` jack node). Knob 0–1 → 0–2× (0.5 = nominal). `vocOut` carries a fixed 3× internal makeup (the band bank is intrinsically quiet), so VOLUME combines to up to 6× total and also scales the CLARITY blend (which sums at `vocVolume`). |
| **PWIDTH** | Internal carrier pulse width (PWM duty). Knob 0–1 → width −0.95..0.95 (0.5 = square). The internal carrier runs at a fixed pitch (130 Hz, set at construction). |
| **CARR MIX** | Crossfade between the external carrier (`voc-carr-in`) and the internal pulse osc. 0 = external only (default), 1 = internal only. Lets the vocoder run standalone (mic + internal carrier, no patched VCOs). |
| **SHIFT** | Spectral/formant shift — scales all 16 carrier bandpass center freqs by a ratio. Knob 0–1 → ±1 octave (0.5 = no shift). Up = chipmunk/feminine formants, down = deeper. |
| **RES** | Q of the 16 carrier bandpass filters, **exponential `20^res` (Q 1–20)**. *The control that decides whether this sounds like a synth or a voice.* VOWEL's formants (§13) run at Q 11/13/15; before Phase 83 this topped out at 7, so the bands were 3–4× too broad to cut formant-shaped peaks. **Sparse and resonant beats flat and continuous** — contiguous band coverage passes the carrier through largely intact, which is the "loose synth" failure mode; VOWEL sounds vocal precisely because everything between its three formants is discarded. Output makeup tracks Q (`×√(Q/4)`) because a bandpass's bandwidth shrinks as 1/Q, so without it raising RES just goes quiet. |
| **SH RATE** | Rate of the LFO that modulates SHIFT. Knob 0–1 → 0.05–10 Hz. |
| **SH AMP** | Depth of the SHIFT LFO. Knob 0–1 → 0–1 octave of swing. Creates sweeping/phaser-like formant motion. Default 0. |
| **DECAY** | Envelope-follower **RELEASE**, 6 ms … 120 ms (centre ≈ 27 ms). Attack is pinned fast at 1.5 ms — see the asymmetric-follower note below. Falls back to writing the 16 symmetric LP cutoffs when the worklet is unavailable. |
| **PRESENCE** | Peaking-EQ boost (~2.7 kHz, Q 1) on the vocoded output so the robot voice cuts through a mix. Knob 0–1 → 0..+12 dB (boost only, default 0). |
| **CLARITY** | Blends the high-passed (~1.5 kHz) **real voice** (modulator consonants/sibilance) straight into the output, bypassing the band bank. Knob 0–1 → 0–0.9×. The headline word-intelligibility control — keeps vocoded vowels while letting actual consonants cut through. Default 0. |
| **HISS** | Level of high-passed (~3.5 kHz) white noise injected into the carrier bank so unvoiced consonants (s, sh, t, f) surface through the high bands. Default 0. Synthetic sibilance — compare with CLARITY (real voice). |
| **BUZZ** | Level of low-passed (~250 Hz) pink noise injected into the carrier bank for low-end body/thump, thickening vowels. Default 0. |
| **PROGRAM** (header) | One-click voicing recall — **NUVO** (crisp, fast tracking, both intelligibility aids up) / **TALKBOX** (resonant mid honk, low-end body, consonants deliberately poor like the real thing) / **ALIEN** (formants shifted up + slow drift). Presets **write the knobs** (`VOC_PROGRAMS` in `MoogShell.jsx`) rather than applying a hidden offset, so the knobs stay the single source of truth and persist normally. They touch **voice character only** — SHIFT/RES/DECAY/PRES/CLAR/HISS/BUZZ/S.RT/S.AMP — never MIX, VOL, MIC, C.MIX or GATE (your level, routing and room). The readout is the last program *pressed*; it is **not re-applied on mount**, or every reload would stomp knobs tuned afterwards (the Phase 60c "user events only" rule). |
| **GATE** (header) | Modulator noise-gate threshold, 4 positions OFF / LOW / MID / HIGH → normalized 0 / 0.5 / 0.75 / 1.0. Default **OFF** = the pre-Phase-72 signal path. Discrete because a gate is a set-once-per-room control and the faceplate has no spare width; the engine mapping is continuous, so it could become a knob with no engine change. |

**Ports (3 Total):**
| Port | Direction | Signal | Description |
|---|---|---|---|
| MOD (`voc-mod-in`) | Input | AUDIO | Modulator source — its spectral envelope is analysed. Patch from a voice/drum/sequence audio out. |
| CARR (`voc-carr-in`) | Input | AUDIO | Carrier source — gets shaped by the modulator. Patch from VCO/mixer audio out (saws ideal). |
| OUT (`voc-out`) | Output | AUDIO | Vocoded (+ optional dry) output. Patch to the mixer / I/O From-Rig. |

**DSP graph (native-on-shared-Tone-context, single writer per node):**
```
voc-mod-in → vocModRaw → HP(150) → Compressor → vocModIn
vocModIn ─→ 16× [ modBPF → rectifier(WaveShaper |x|·DRIVE) → envLP(DECAY) ]
                                                                  │ (audio-rate AudioParam)
                                                                  ▼
voc-carr-in → vocCarrExtGain ─┐                                   │
internal PulseOsc → vocCarrOscGain ┴→ vocCarrSum ─→ vocCarrBank ─→ 16× [ carrBPF(SHIFT/RES) → carrVCA.gain ◄── envLP ] → vocSum → vocWet ─┐
                                  │   ▲  ▲                                                                                                  │
                                  │   │  └── BUZZ: noise(pink) → LP(250) → vocBuzzGain ──┐                                                  │
                                  │   └───── HISS: noise(white) → HP(3.5k) → vocHissGain ┴→ vocCarrBank                                     │
                                  └──────────────────── carrier passthrough (no HISS/BUZZ) ───────── vocDry ────────────────────────────────┤
                                                                                            wet+dry → vocOut(×3 makeup) → vocPresence(EQ) ───┤
vocModIn ─→ HP(1.5k) → vocClarityGain (CLARITY: real voice) ───────────────────────────────────────────────────────────────────────────────┴─→ vocVolume(VOLUME ×0–2) → voc-out
vocModIn ─→ vocAnalyser (FFT 512)   ← drives the 16-segment LED spectrum meter
```
Each modulator band rectifies + smooths to an envelope follower, whose output connects directly to the matching carrier band's `Tone.Gain.gain` AudioParam (audio-rate, zero polling). Per band the chain is `ModBPF → ModDrive → ModRect → ModEnv`; `VOC_ENV_DRIVE` (8) × the pre-emphasis tilt sets the drive gain.

**Asymmetric envelope followers (Phase 84, `public/env-follower-worklet.js`) — the one place in this rack where a worklet is genuinely required.** A biquad/one-pole lowpass, which is what the 16 `ModEnv` filters were, is inherently **symmetric**: one time constant serves both directions, forcing a losing trade — fast enough for consonant onsets lets the rectification ripple through and roughens vowels; slow enough for smooth vowels smears consonants into the vowel that follows. No native node smooths asymmetrically (a WaveShaper holds no state; a DelayNode feedback loop is quantised to a 128-sample block and needs a nonlinear element inside the cycle), and per-sample state is exactly what an AudioWorklet is for. Measured on a 120 Hz band carrying a consonant burst then a vowel:

| follower | consonant peak by 30 ms | vowel ripple |
|---|---|---|
| symmetric 8 ms (the old centre) | 0.410 | 0.031 |
| symmetric 3 ms (the old fast end) | 0.518 | 0.082 |
| **asymmetric 1.5 ms / 27 ms** | **0.829** | **0.020** |

It wins on **both** axes at once — twice the consonant definition of the old centre *and* the lowest ripple of the three — because a slow release holds the envelope near the ripple's PEAK between cycles rather than averaging through it.

**Topology:** `16× ModRect → ChannelMerger(16) → env-follower-processor (16 ch) → ChannelSplitter(16) → 16× ModEnv → CarrVCA.gain`. The worklet's output re-enters through the **existing** `ModEnv` filters rather than 16 new adapter nodes — which also avoids connecting a raw splitter straight to a Tone param — and those filters become the **per-band de-ripple stage** described next. **Load-failure safety is the shape of the whole block:** `ModRect → ModEnv → CarrVCA.gain` is wired at construction and only unhooked once the worklet actually exists, so a 404 or a refused module degrades to exactly the pre-Phase-84 symmetric behaviour instead of silence. `Tone.context.createAudioWorkletNode` (never `new AudioWorkletNode`) for the SAC reason noted in the quantizer; `channelInterpretation: 'discrete'` so the 16 bands are never up/down-mixed.

**Analysis rectifier — three rules, all load-bearing (Phase 73):**
1. **`VOC_RECT_POINTS` must be ODD (2049).** `Tone.WaveShaper.setMap` samples at `x = (i/(len−1))·2 − 1`; at the default even length 1024, x = 0 falls *between* samples 511 and 512, and with a `|x|·8` mapping both neighbours are 0.0078. Web Audio interpolates, so the curve returned **0.0078 for a silent input** — a permanent gain on all 16 carrier VCAs, i.e. raw carrier at ≈ **−8.5 dB, always**, loudest wherever the carrier has most energy (a saw's fundamental). This was a real, shipped bug: the "constant low buzz". An odd count puts x = 0 exactly on a sample. *Same class as the VCA LOG/LIN curve (§4) and the mic gate above — any WaveShaper feeding an AudioParam must pass exactly through the origin, because a shaper fed silence still emits `curve(0)`.*
2. **The ceiling is a soft knee, not `Math.min(1, …)`.** A hard clip pinned every band at or above 1/8 scale to exactly 1.0, so the loudest bands became indistinguishable — and vowel identity *is* the relative height of the formant peaks, so flattening the tops smears vowels together. Now linear below `VOC_RECT_KNEE` (0.6) and asymptotic to 1 above it: contrast preserved where it matters, nothing pins, nothing exceeds unity.
3. **The drive lives in a Gain node, not in the curve.** The shaper then sees an already-amplified signal spanning the full [−1, 1] domain, so every band gets the table's full resolution. With the drive inside the curve, a band driven ×32 would use ~1/32 of the table and quantise its envelope into a few dozen steps.

**Analysis pre-emphasis (`vocBandTilt`, Phase 73).** Speech energy falls ~6–9 dB/octave above ~500 Hz, so a flat analysis bank leaves the low bands wide open on the voice fundamental while the consonant bands (2–8 kHz) barely crack — a muffled robot with a droning bottom. Each band's drive gain is scaled by `(f/500)^0.6` (≈3.6 dB/oct), clamped to [0.35, 4.0] → **−8.4 dB at 100 Hz … +12 dB at 6–8 kHz**. Applied **before** the rectifier on purpose: tilting the *detector* makes low bands less sensitive and high bands more sensitive while every carrier VCA stays bounded at unity; tilting after the envelope would instead push high carrier bands past unity and make output level depend on the tilt. The correction is deliberately partial — full compensation measures "more correct" and sounds hissy.

**Per-band envelope de-ripple (Phase 86) — the fix for "a static sound".** The Phase 84 attack of 1.5 ms is fast enough to track individual **glottal pulses**, so the follower re-imposes the speaker's PITCH on the carrier as amplitude modulation. Measured at the flat 300 Hz post-filter it originally shipped with: **18.9 % ripple** on a voiced band — heard as buzzy static on every voiced sound. (The pre-84 symmetric follower measured 28.7 %, so Phase 84 helped and simply did not go far enough — which is exactly why DECAY "didn't make much difference": release was never the culprit.)

A **flat** cutoff cannot win, because pitch ripple (~120 Hz) and consonant onsets (~30 Hz bandwidth) are barely a decade apart:

| post-LP | pitch ripple | consonant 90 % rise |
|---|---|---|
| 300 Hz (as shipped in 84) | 18.9 % | 8.4 ms |
| 60 Hz flat (best single value) | 7.4 % | 15.1 ms |
| **per-band, 20 → 121 Hz** | **6.0 %** | **12.5 ms** |

Scaling with band frequency breaks the trade because the two problems live in different bands: pitch ripple is a **voiced** phenomenon concentrated low and mid, while consonants are **high** and mostly unvoiced noise with no pitch ripple to reject at all. `vocEnvPostHzFor(f) = 20 · (f/100)^0.41` — 20 Hz at the 100 Hz band rising to 121 Hz at 8 kHz — beats the best flat value on **both** counts.

**The ANALYSIS bank tracks RES too (Phase 85) — sharpening only the carrier was half the job.** Phase 83 raised the carrier Q but left the modulator bank at `VOC_BANDS`' Q of 4, and at that width **one vocal formant opens five analysis bands**: a 730 Hz formant reads 22 / 47 / 92 / 33 / 18 % across the 430 / 580 / 770 / 1035 / 1385 Hz bands. So every formant was reproduced as a smeared cloud of five carrier peaks — *sharp* peaks after 83, but still five. VOWEL renders the same formant as exactly **one** peak, which is the difference that kept being audible. At analysis Q ≈ 12 the leakage collapses to a single band.

`vocAnalysisQFor` = `clamp(carrierQ × 0.8, 4, 14)`, so one knob sharpens analysis and synthesis together; floored at the historical 4 so **RES at or below centre is byte-identical to before**, and TALKBOX (analysis Q 12.6) reaches the one-band point.

**Accepted trade-off:** a constant-Q bank rings for ≈ `Q/(π·f)`, so narrow LOW bands ring longest — 40 ms at 100 Hz, 17 ms at 240 Hz, but only 5.5 ms at 730 Hz and 1.6 ms at 2.5 kHz. It matters least exactly where it is worst: the 150 Hz highpass and the pre-emphasis tilt (−8.4 dB at 100 Hz) already suppress that region, and Phase 84's fast attack tracks an onset before the ring settles.

**Carrier density becomes load-bearing at high RES.** A Q-20 carrier band at 1 kHz is only ~50 Hz wide, so a single low saw may have no harmonic inside it at a given moment and that band drops out. Fixes, in order: a denser carrier (several detuned VCOs, or a chord), or a little **HISS**/**BUZZ**, which exist precisely to fill spectral gaps in the carrier bank.

**Band Q and coverage.** Bands sit a fixed ratio 1.339 apart (0.421 octave). A bandpass's −3 dB width is `fc/Q`, so adjacent skirts exactly MEET at **Q = (1+r)/(2(r−1)) ≈ 3.45**; above that there are holes in the spectrum between bands and the voice sounds hollow/phasey. The base `VOC_BANDS` Q of 4 is therefore slightly gappy, and **RES** (Q = 1 + knob·6) is the control — knob **0.408** is the contiguous-coverage point, which is what the NUVO program sets. Higher Q is a legitimate voicing choice (more resonant/robotic), not an error — it is simply not "clean".

The carrier is the external `voc-carr-in` and an internal `Tone.PulseOscillator` blended by **CARR MIX** into `vocCarrSum`, which feeds both the bank and `vocDry` — so HISS/BUZZ (bank-only) never leak into dry. The **spectral-shift rAF loop** (sole writer of `vocCarrBPF*.frequency`) applies SHIFT + its LFO; **RES** writes `vocCarrBPF*.Q`. Output: `wet+dry → vocOut` (Q-tracking makeup, ×3 at the base Q) `→ vocPresence` (PRESENCE peaking EQ) `→ vocLimit` (hard-knee brick wall, `−1 dB / 20:1 / knee 0`, copied from VOWEL's output stage — **not** `Tone.Limiter`, whose 30 dB soft knee barely compresses) `→ vocVolume` (VOLUME ×0–2, the jack); CLARITY sums at `vocVolume`, so the real voice bypasses makeup, EQ **and** the limiter, exactly as in VOWEL. `getVocAnalyserData()` feeds the 16-LED meter via the same per-band-peak rAF loop as `FFBModule`.

**Tone.js Nodes:** modulator pre-chain (`vocModRaw`, `vocModHP`, `vocModComp`) + buses (`vocModIn/vocCarrIn/vocCarrExtGain/vocCarrOscGain/vocCarrSum/vocCarrBank/vocSum/vocWet/vocDry/vocOut/vocPresence/vocVolume`) + internal carrier (`vocCarrOsc` PulseOscillator + `vocCarrOscGain`) + `Tone.Analyser('fft', 512)` + HISS/BUZZ chain (`Tone.Noise`×2, HP+LP `Tone.Filter`, `Tone.Gain`×2) + CLARITY (`vocClarityHP` + `vocClarityGain`) + per band: `Tone.Filter(bandpass)` ×2 (mod + carr), `Tone.WaveShaper` (rectifier), `Tone.Filter(lowpass)` (env follower), `Tone.Gain(0)` (carrier VCA) — ~80 always-on band nodes. The PulseOscillator + HISS/BUZZ noise are started/stopped in `powerOn`/`powerOff`.

**The mic is a SINGLETON; its LEVEL and STATUS are not (Phase 81).** One `Tone.UserMedia` → `extMicGain` is shared by every vocoder instance, but the MIC knob and the ENABLE button are drawn per instance, and both were wired straight to the shared thing:
- **MIC knob** — both instances wrote the one `extMicGain.gain`, so turning voc2's MIC silently moved voc1's and the two knob positions disagreed with reality. A single-writer violation. Each instance now owns a `${id}MicGain` (`extMicGain → ${id}MicGain → ${id}ModRaw`), written by `updateVocMicGain(vid, …)`. `extMicGain` stays at unity and is purely the shared tap for the mic and its SIG meter.
- **Mic STATUS** — was per-instance `useState`, so one instance could read "● LIVE" while the other read "○ MIC" for the same live mic. Lifted to `MoogShell`, which owns `enableMic`/`disableMic` and passes `micStatus` down to every instance.
- **Known limitation:** removing/hiding every vocoder leaves the mic open with no button to close it (the OS indicator stays lit until page unload, which does `close()` + `dispose()`). The engine has no visibility into which modules are rendered, so this is not fixed here.

**Built-in mic (modulator):** the vocoder has an integrated mic (ENABLE MIC button + MIC IN level knob + SIG LED, top of the faceplate). It opens a `Tone.UserMedia` stream (`enableMic()`) → `extMicGain` → `vocModRaw` (the modulator pre-chain front), so enabling the mic + a carrier vocodes instantly with **no patching**. The `MOD` jack still accepts external modulator sources (drum machine, sequence), which sum with the mic. There is no separate EXT IN module — it was merged into the vocoder (Phase 48). Use headphones to avoid carrier→mic feedback.

**Modulator pre-processing (always on, voice-optimized):** both the mic and the `voc-mod-in` jack land on `vocModRaw → vocModHP (highpass 150 Hz) → [noise gate] → vocModComp (Tone.Compressor −28 dB / 4:1) → vocModIn`.

**Noise gate (Phase 72, `buildVocGate(n, id)` — shared by the static and the factory):**
```
${id}ModHP ─┬─────────────────────────────────────────► ${id}GateGain ─► ${id}ModComp
            └─► GateFollow ─► GateScale ─► GateCurve ──┘ (drives .gain)
                (envelope)    (1/thresh)   (soft knee)
```
The compressor is what makes vocoding consistent, but at a −28 dB threshold it also pulls **room noise up between words**. The gate sits **before** it — after it, the compressor has already flattened the difference between speech and noise and no threshold works.

**Not `Tone.Gate`, though it exists and looks like an exact fit.** Tone.Gate is Follower → `GreaterThan` → gain, and GreaterThan emits a hard **0/1 step**: the gain snaps open the instant the threshold is crossed (clicks on every word, chatters on breaths), and its `smoothing` smooths *detection* only, not the gain. The comparator is therefore replaced by a soft-knee `WaveShaper` — same three-stage shape, but the gain eases open across the 6 dB below the threshold.

**Threshold is applied by scaling the detector into a FIXED curve**, never by rebuilding the curve: `x = followerAmp / thresholdAmp`, so the control writes one plain gain param (rampable, single-writer) and the curve table is never rewritten (the reverb-DAMP rebuild-storm lesson). WaveShaper **clamps input to [-1, 1]**, which is exactly the wanted behaviour at the top — any level at or above the threshold gives `x ≥ 1` → fully open. `curve(0) = 0` is **load-bearing**: a WaveShaper fed silence still emits `curve(0)`, so a curve missing the origin would park a DC offset on the gate gain (the Phase-71 VCA LOG/LIN lesson). `VOC_GATE_SMOOTH` (40 ms) is **fixed at construction and never written** — `Tone.Follower` wraps a `OnePoleFilter`, whose `frequency` setter disposes and rebuilds its IIRFilter (§17 hazard 2). Range `VOC_GATE_MIN_DB` −80 (transparent for anything above −80 dBFS) … `VOC_GATE_MAX_DB` −30. The highpass removes rumble/plosives (safe — voice intelligibility lives in formants >300 Hz); the compressor evens the drive into the envelope followers for consistent vocoding. Tuned for voice; a low-frequency modulator (e.g. a kick) loses content below 150 Hz.

The bank runs continuously even when unpatched; gating it to "carrier + modulator present" is a possible future CPU optimization.

---

### 12. EXT IN — merged into the Vocoder (§11) [Phase 48]

The external-mic input was originally a standalone module (Phase 43) but was **merged into the Vocoder** (Phase 48) since its only real use was as the vocoder modulator. The mic controls (ENABLE MIC, MIC IN, SIG LED) now live on the vocoder faceplate and feed `vocModRaw` directly — see §11 "Built-in mic". `Tone.UserMedia` lifecycle (`enableMic`/`disableMic`, `extMicRef`, `extMicGain`, `extMicMeter`) is unchanged; only the routing (now → `vocModRaw` instead of a separate `ext-out` jack) and the UI host changed. **Mic LEVEL is per-instance since Phase 81** — see §11.

**Note on AEC:** uses `Tone.UserMedia` defaults (browser echo-cancellation/AGC may be on). Use **headphones** so the carrier doesn't bleed into the mic. If raw-signal quality becomes an issue, switch to native `getUserMedia` with `echoCancellation:false, noiseSuppression:false, autoGainControl:false` (as `useVocoder.js` does) wrapped via `createMediaStreamSource`.

---

### 13. VOWEL — Formant Filter Bank [Implemented: Moog Phase 64]

**Function:** A 3-formant resonant filter bank that sculpts a raw signal (saws ideal) into human vowel sounds. **Dynamic-only** (no static instance) — added from the library.

**Signal:** `${id}In → fan → 3× [bandpass Filter Fk (Q ~11/13/15) → gain Gk (1.0/0.55/0.28)] → ${id}Mix (×7 makeup) → ${id}Out (hard-knee limiter)` (parallel formants summed). `${id}Analyser` (FFT 256) taps Out for the display; `${id}CvIn → ${id}CvAnalyser` reads the FORMANT-CV input.

**Output level (makeup + limiter):** the parallel bandpass bank is intrinsically quiet (~7× down vs. the raw source), so `${id}Mix` applies a ×7 makeup. But the vowels are hugely unequal in level — open **A**/**O** (low F1 in a strong region of the source) peak ~4× the closed **I**/**U** — so a fixed makeup alone clips A. `${id}Out` is therefore a `Tone.Compressor` used as a **hard-knee limiter** (`threshold −1 dB, ratio 20, knee 0`) — *not* `Tone.Limiter` (whose default 30 dB soft knee barely compresses). Net: closed vowels stay at full makeup (RMS ~0.43, matching a raw VCO) while A/O are brick-walled just above unity. The jack `-out` and the FFT display both tap post-limiter `${id}Out`.

**Controls / jacks:** VOWEL knob (morph position), SHAPE knob (0.7–1.3 vocal-tract scale on all formants), **MODE** (CHAIN / DIRECT) + **FROM** / **TO** selectors, jacks `-in` / `-cv-in` (FORMANT CV) / `-out`.

**MODE — CHAIN vs DIRECT (Phase 75).** `vowelFreqsAt` treats the five vowels as an ordered **road** (A→E→I→O→U), so a sweep from U to A necessarily drives back through O, I and E — halfway through it is literally sounding the vowel **I** (270/2290/3010). That is right for a continuous morph and wrong for "start at U, land on A".
- **CHAIN** (default, and the pre-Phase-75 behaviour bit-for-bit) — the knob + CV walk the whole road.
- **DIRECT** — `vowelFreqsBetween(from, to, t)` blends the two chosen endpoints' formant triples straight, so the sweep only ever contains shades of those two vowels and touches no third. U→A at 50% is 515/980/2340, which lies between them and is not any other vowel.

Both modes read the **same** morph knob + FORMANT-CV sum, so a CV patched into `-cv-in` drives either identically — only the path through vowel space differs. In DIRECT the knob is the manual position along the FROM→TO line and the CV rides on top, so a full-scale envelope with the knob at 0 travels exactly FROM → TO (verified: endpoints land on the exact table values).

**There is deliberately no gate input or internal sweep timer.** The envelope shape comes from the rack's existing ENV modules — `kbd-gate-out → env1-gate`, `env1-out → vowel-cv-in` — which gives full ADSR control of the vowel travel (ATTACK = how fast it reaches TO, SUSTAIN = the vowel held while the key is down, RELEASE = the drift back to FROM) without a second envelope generator. Chosen over a built-in GATE + TIME knob for exactly that reason.

FROM/TO render **dimmed but present** in CHAIN (`.selectorGroupIdle`) rather than hidden — hiding them would change the module's height between modes, and "real hardware, currently dark" is already the rack's language for this (the LFO division screen, §2).

**Formant frequencies:** `VOWEL_FORMANTS` (module const in `useMoogAudio.js`) — classic male-voice table; `vowelFreqsAt(pos 0..4)` linearly interpolates adjacent columns. A/E/I/O/U = [730,1090,2440] / [530,1840,2480] / [270,2290,3010] / [570,840,2410] / [300,870,2240] Hz.

**Single-writer rAF (`vowelTick`):** the SOLE writer of the 3 filter frequencies — combines the morph ref (VOWEL knob), shape ref (SHAPE), and the sampled CV level (`cv*4` = full A↔U sweep) into the final formants, with a per-instance delta gate (idle module = 0 writes). `updateDynModuleParams` case `'vowel'` writes the refs only (never the filters), preserving single-writer-per-node. This is why FORMANT CV works at all — a preset morph is a nonlinear map to 3 freqs, not a direct AudioParam connection.

---

### 14. PANNER — Voltage-Controlled Stereo Panner [Implemented: Moog Phase 67]

**Function:** Places a (typically mono) source in the stereo field. **Dynamic-only.** `${id}In → Tone.Panner(0) → ${id}Out` — `Tone.Panner` wraps the native `StereoPannerNode`, already **equal-power**, so one node gives the pan law (no dual-VCA matrix). The whole rack downstream of `io-in` is 2-channel, so it pans to both the speakers and the Workstation record tap.

**Controls / jacks:** PAN knob (writes `pan.pan` intrinsic value), CV DEPTH knob (attenuator). Jacks `-in` / `-cv-in` (a CV summed onto `pan.pan` via `${id}CvDepth`, clamped [−1,1]) / `-out`. `getPanMeterData(id)` computes per-channel level (input peak × equal-power gain at the effective pan) for the two L/R meter LEDs.

---

### 15. CHRONOS — Multi-Zone Stereo Delay [Implemented: Moog Phase 68]

**Function:** MONO in → STEREO out. **Dynamic-only.** A **hand-built** stereo feedback loop around two native `Tone.Delay` lines (not a `Tone.FeedbackDelay` black box) so COLOR (loop lowpass), HALO (allpass diffusion + L↔R cross-feedback smear) and a `tanh` soft-clip all live INSIDE the feedback path. Modulating `delayTime` (TIME knob / TIME CV) varispeed-warps pitch with no dropouts (native interpolation) = tape-stop/skid. Stereo width is synthesized (L/R times drift apart + cross-feed); wet L/R hard-pan to their own buses, dry sums to both (centre), all → one stereo OUT jack.

**As built:** per channel `Sum → Delay(maxDelay 4 s) → HP → LP → Ap1 → Ap2 → Wet(→ its OutBus)`, with `Ap2 → Sat(tanh) → Fb(self) + Xfb(cross)` back into the sum. Zones `CHRONOS_RANGES = { micro:[0.003,0.03], mini:[0.03,0.28], macro:[0.28,3.0] }`; TIME is log-mapped within the zone. `updateDynModuleParams` case `'chronos'` takes the full `{zone,time,repeats,halo,color,mix}` and derives all node values (feedback + cross share headroom, `|self|+|cross| ≤ ~0.9`, tanh guards the rest). NB Web Audio clamps any delay inside a feedback cycle to ≥1 render quantum (~2.9 ms), so Micro floors there. Jacks `-in` / `-time-cv` / `-rep-cv` / `-out`; `getChronosDisplay(id)` drives an echo-ring visualizer (energy = post-diffusion peak, ring gap = live delay time).

---

### 16. WAVEFOLDER — West-Coast Sine Folder [Implemented: Moog Phase 68c]

**Function:** Drives a signal into a fixed multi-fold sine transfer curve — more drive = more folds = more added harmonics. **Dynamic-only.** Output-domain waveshaping, so it works on ANY audio in (VCO, chord, external) — which is why it's its own module rather than a VCO knob (the VCO's SHAPE is phase-domain).

**As built:** `In → Drive(FOLD pre-gain 0.2..1.0) → BiasSum → Shaper → Out`, where `Shaper = Tone.WaveShaper(x ⇒ sin(x·π·4))` (4 folds across ±1 at max drive) and `Bias` (a `Tone.Signal`, SYMMETRY −0.5..0.5) adds a DC offset before the fold for asymmetric/even-harmonic folding. FOLD-CV (`${id}FoldCv`) sums onto `Drive.gain`. Jacks `-in` / `-fold-cv` / `-out`; `getFolderScope(id)` draws the folded output waveform.

---

### 17. REV — Studio Reverb [Implemented: Moog Phase 3 · DAMP + MIX CV + ROOM clamp: Phase 70]

**Function:** Freeverb-based room/hall reverb. Static ×2 (`reverb`, `reverb2`) plus library instances (`reverb3`+).

**Controls / jacks:** **ROOM** (size), **DAMP** (tail brightness), **MIX** (dry/wet). Jacks `-in` / `-mix-cv` / `-out`.

**ROOM is CLAMPED to `REV_MAX_ROOM` (0.95) — load-bearing.** `Tone.Freeverb` wires `roomSize` straight to the feedback gain of its eight comb filters (`roomSize.connect(lowpassCombFilter.resonance)`); at 1.0 the feedback reaches unity, the tail never decays, and the combs sum into a runaway build-up. Same value the Workstation's `effectDefs` uses.

**DAMP → Freeverb `dampening`, with two hazards (both hit in Phase 70):**
1. **Stability ceiling.** It reaches `OnePoleFilter`, whose lowpass coefficients are `a0 = 2π·f/sr`, `b1 = a0 − 1`, fed to `createIIRFilter([a0,0],[1,b1])`. A one-pole IIR is stable only while `|b1| < 1`, i.e. **f < sr/π** (≈14 kHz @44.1 kHz). Beyond it the filter diverges, NaN floods the comb feedback loop, and the **whole AudioContext dies** (rack-wide silence, reload required). The range is therefore derived from the live sample rate and capped at 70% of that limit, with the midpoint pinned to exactly 3000 Hz (the value dampening was hardcoded to before the knob existed).
2. **Every write rebuilds nodes.** `OnePoleFilter.frequency`'s setter calls `_createFilter()`, disposing and re-creating its IIRFilter and re-wiring the graph — ×8 combs per write. Writing per knob-frame is a teardown storm that sounds like loud scratching. All writes therefore go through **`scheduleRevDamp`**: delta-checked (an identical target is a no-op — this is what stops ROOM/MIX moves touching it, since the param effect re-sends the whole object) and **debounced 120 ms**, so a continuous drag produces zero writes and one lands when the knob settles. Timers are cleared on instance removal and unmount.

**MIX CV** sums onto Freeverb's `wet` (a CrossFade fade Signal — connectable, self-clamping 0..1). Unity gain; depth belongs to the source. **Display:** the Aura sphere taps the reverb's OUTPUT (Phase 56 rule) so it keeps moving through the tail.

---

### 18. BBD — Bucket Brigade Chorus / Flanger [Implemented: Moog Phase 3 · composite + FBK/DELAY/TONE + RATE CV: Phase 70]

**Function:** Chorus through flanger. Static `chorus` plus library instances (`chorus2`+).

**As built — a COMPOSITE, not a bare `Tone.Chorus`:**
```
${id}In ─┬──────────────────────────────► ${id}Dry ──┐
         └─► ${id} (Chorus, wet 1) ─► ${id}Tone ─► ${id}Wet ─┴─► ${id}Out
                    ▲                        │
                    └─ ${id}FbDly ◄─ ${id}Fb ◄─ ${id}Sat(tanh) ◄─ ${id}FbHp(120 Hz) ◄┘
```
The Chorus runs 100% wet and MIX crossfades the two external gains, because the **BBD colour filter must sit on the WET path only** — Tone's own dry/wet is internal, so a filter after it would darken the dry signal too. Same shape as the Workstation delay's dry-through.

**Controls / jacks:** RATE (0.1–5 Hz), DEPTH, MIX, **FBK**, **DELAY** (2–20 ms), **TONE** (700 Hz–14 kHz lowpass). Jacks `-in` / `-rate-cv` / `-out`.

**FEEDBACK is hand-built; Tone's internal `feedback` stays 0.** Tone's loop is a bare gain — nothing damps the resonance as it recirculates and nothing stops low frequencies accumulating, so at high settings the comb peak (which tracks `delayTime`, ≈190–560 Hz at DELAY 3.5 ms / DEPTH 0.5) sings as a low bee-like hum, one per channel offset by the 180° stereo spread. The return path puts **TONE inside the loop**, adds a 120 Hz highpass to kill the mud, and a `tanh` to bound runaway. Clamped to `BBD_MAX_FEEDBACK` (0.9). Same reasoning as CHRONOS's hand-built loop (§15).

**`BBD_FB_DELAY_S` (5 ms) in the return path is LOAD-BEARING.** Web Audio **mutes any cycle that contains no DelayNode**, and `Tone.Chorus` has an internal DRY branch (input → CrossFade → output) with no delay in it — so feeding back into the chorus input creates a delay-free cycle and Chrome silences the entire loop. Symptom: the wet path goes dead, MIX only makes things quieter, and every wet-side knob does nothing. **Cycle detection is topological**, so running the chorus at `wet: 1` does NOT help. 5 ms clears one render quantum at every sample rate.

**DEPTH and DELAY are plain setters** (both recompute the two LFOs' min/max), re-sent on every unrelated knob move, so both are delta-checked. The **rate LED is synthetic** (`Date.now()`-driven, not meter-fed), so unlike every other LED on the rack it must be **explicitly gated on power** or it keeps pulsing on a dead rack.

---

### 19. 914 — Fixed Filter Bank [Implemented: Moog Phase 60d · meter fixes + FLAT/MSTR CV/SWEEP CV: Phase 70]

**Function:** 14 parallel fixed-frequency bands (`FFB_BANDS`: lowpass 100 Hz, twelve bandpasses 125 Hz–5.6 kHz at Q 2.8, highpass 8 kHz), each with its own level knob. Frequencies and Q are **fixed** — that is what "fixed filter bank" means; do not add tuning controls.

**Signal:** `${id}In` → fan to 14 × [`Filter` → **`Sweep`** → `Gain`] → `${id}Sum` → `${id}Master` → out. **The Sweep stage exists so single-writer holds**: the `ffbSweepTick` rAF owns `Sweep`, the band knobs own `Gain`; without the split both would write the same node.

**Controls / jacks:** 14 band knobs, **MSTR**, **FLAT** (resets all bands to unity). Jacks `-in` / `-master-cv` / `-sweep-cv` / `-out`.

**SWEEP CV** moves a resonant gain hump across the bank (a filter-bank formant sweep) — a nonlinear map from one voltage to 14 correlated gains, which is why it is an rAF and not an AudioParam connection (the `vowelTick` reason). Engagement is **cable-driven** (`recomputeFfbSweep`, the `isLfoSync` pattern): a patched-but-silent CV reads 0 V, indistinguishable from no cable, so without the flag an unpatched bank would sit permanently humped at its centre band. `FFB_SWEEP_FLOOR` 0.10, `FFB_SWEEP_SIGMA` 2.2 bands.

**Meter (fixed Phase 70 — it had never been correct):** the analyser taps **`${id}Master`, post-bank** (the Phase 56 rule), so pulling a band knob down visibly darkens its LED; it previously tapped the INPUT and was blind to both the band knobs and the master. Bin width comes from **`fftBinHz(bins)`** — `Tone.Analyser('fft', N)` sets `fftSize = N*2` and returns N bins, so a bin spans `sampleRate/(N*2)`, **not** `sampleRate/N`. The old `44100 / 512` was double the true width *and* ignored the device rate, putting every band roughly an octave low. The vocoder's 16-LED meter shared the identical bug and the same helper now backs both.

---

### 20. QNT — Musical CV Quantizer [Implemented: Moog Phase 20 · BYPASS/IN-LED/OCT/display: Phase 22 · knob-stepper: Phase 57 · modulation mode: Phase 58 · quantized FM: Phase 70 · audit + BYPASS removal: Phase 95]

**Function:** Snaps a continuous pitch CV to the nearest note of a scale. Runs **per-sample in an AudioWorklet** (`public/quantizer-worklet.js`, `quantizer-processor`), so a swept CV comes out as a true staircase rather than a glide.

**Controls / jacks:** two fixed chip rows — **SCALE** (13 presets) · **ROOT** (0–11, `wrap: true`) · **OCT** (−3…+3) · **GLIDE** knob (0–1.5 s), then **SNAP** · **LEARN**. All five chips are fixed-width `ChipValue` boxes and both rows are `nowrap` (Phase 101). Jacks `-cv-in` / `-cv-out` / `-transpose-in` (TRP) / `-trig-out` (TRIG↑). A clickable one-octave **keyboard** (Phase 97) + a `note + Hz` readout. Dynamic to 4 instances (`qnt`, `qnt2`…).

**The keyboard IS the scale, not just a display (Phase 96; made a real keyboard in Phase 97).** Clicking a key toggles that note and flips SCALE to `CUSTOM`; a preset pick reseeds it. The mask is stored as **offsets from ROOT**, so dragging ROOT transposes the pattern rather than scrambling it (hence the root key's mint dot — it is what makes a shifted pattern legible). The last lit note cannot be switched off — an empty scale makes both snap implementations fall through to "nearest chromatic", which reads as broken (one note left is legitimate: everything snaps to octaves of it).

- **Geometry mirrors the 953** (`KeyboardModule.jsx`): one octave, `WW 48 / BW 28 / WH 64 / BH 40`, black-key lefts **derived** as `nextWhiteIdx × WW − BW/2` from the shared `BLACK_NEXT_WHITE` table — never hand-placed. Ratios land within 0.02 of the 953's so the two read as one instrument at two sizes. `z-index: 2` on black keys does double duty: the visual overlap **and** click priority in the shared hit area.
- **It is a SCREEN, not a set of keys (Phase 98).** `.qntScreen` is assembled from the rack's two existing displays — phosphor bed / graticule / tube vignette / the exact 1px-per-3px scanline recipe from the **I/O oscilloscope**, plus the `#767066` chrome ring, recessed inner darkening and upper-right studio-lamp sheen from the **Aura OLED** — in mint rather than the scope's green. Keys are lit segments: dim phosphor outline when out of scale, filled + glowing when in, full brightness with bloom when sounding. **Sheen (`::before`, z 5) and scanlines (`::after`, z 6) paint OVER the keys** so they read as drawn *on* the glass; both are `pointer-events: none`. Lights-out keeps it lit (emissive, like its two ancestors) but swaps chrome for the dark ring + brighter halo, and its note names stay lit because they are on the glass, not the faceplate.
- **`dimActiveLed` must clear EXACTLY the properties `litKeyStyle` sets** (`background`, `borderColor`, `boxShadow`). It clears rather than repaints because the resting look has four cases (white/black × in/out) that only React knows — a hardcoded repaint would turn every released key into an out-of-scale white one, and a missed property leaves a released key permanently lit. `qnt-verify98.mjs` asserts the two property lists are identical.
- **Hand-picked notes get NAMED, not shrugged at (Phase 99).** `identifyScale(mask, root, lockRoot)` (pure, module-level) replaces the old always-`CUSTOM`. A note set is genuinely several scales at once — the white keys are C major *and* D dorian *and* A minor; **G lydian is the identical seven notes as D major** — so **the user's current ROOT is tried first** and is what disambiguates. Only if nothing fits there does the search widen to the other eleven roots, and then the ROOT chip moves with it. `SCALE_ID_ORDER` (naming preference, MAJ/MIN first) is deliberately **not** `SCALE_KEYS` (the chip's brightest→darkest drag order).
  - **Moving the root is a relabelling, not a retune:** `rebaseMask` re-expresses the same absolute notes (`newMask[o] = mask[o + (new − old)]`), and the worklet allows `(root + interval) mod 12`, so the audible set is unchanged. Tested exhaustively over 12×12 root pairs.
  - **Identification runs in the click handler, never in an effect on `mask`** — it can move ROOT, which rewrites the mask, which would re-fire such an effect: a loop.
  - **`lockRoot` when TRP is patched** — that cable owns the root, so identification may not move it; the set is either nameable where it stands or CUSTOM. `CUST` survives for genuinely unnameable sets.
- `SCALE_INTERVALS` (panel) duplicates `SCALE_DEFS` (engine) because the panel must seed the keys; **the engine stays the audio authority and sanitises whatever arrives** (`scale` may be a preset key *or* a raw interval array). `qnt-verify96.mjs` / `99` assert the two tables stay identical — that duplication is the standing drift risk here.

**`TRIG↑` (Phase 96)** pulses on every *new* quantized note — patch it into an ENV to re-articulate per step. Gate outs in this rack are purely logical (`{ type: 'out', node: null, isGate: true }`), so it reaches ENV gate/trig, KICK and a 960's CLK↓ through the shared `dispatchStepActions` with no new plumbing. Fired from **all three** note-change sites (worklet port message, knob-stepper, quantized FM), each delta-checked — `applyVcoKnobQuantize` gained its check here, or TRIG would fire on every pixel of knob travel. Width is a fixed **20 ms trigger, not a gate**: a quantizer knows when a note starts and cannot know when it ends.

**`GLIDE` (Phase 96)** applies to the worklet note path and to knob-stepper (its old fixed `0.02` de-click ramp is now the floor, so GLIDE 0 is unchanged behaviour). **Deliberately excluded from `qntFmTick`** — crisp stepped modulation is that path's entire purpose, and a glide smears it back into the smooth sweep it exists to replace. This knob wins over `glideForPitchSource`, which stays the fallback: gliding *into* a quantizer is largely pointless because the staircase eats it.

**Four modes, and which one is live is decided entirely by cables:**

| Cables | Who writes the VCO's GlideBus | Where |
|---|---|---|
| `→qnt-cv-in` **and** `qnt-cv-out→vco-cv` | the worklet's `port.onmessage` | melody quantize (Phase 20) |
| `qnt-cv-out→vco-cv` only (QNT idle) | `applyVcoKnobQuantize` | knob-stepper (Phase 57) — the FREQ knob itself snaps |
| as above **plus** `→vco-fm` | `qntFmTick` rAF | quantized FM (Phase 70) |
| any of the above **plus** `chordseq-cv-out→qnt-transpose-in` | + chord-override rAF owns root+scale | chord-aware (Phase 60e) |

These are **mutually exclusive by construction** — `vcoActiveCvRef` holds exactly one CV source per VCO — which is what keeps Single Writer per GlideBus. `qntHasCvInput(qid)` is the test that separates the first two.

**Modulation mode (Phase 58) is a per-sample range test, not a mode switch:** `|v| ≤ MOD_MAX (8)` is treated as modulator-range CV and mapped to `baseHz · 2^v` before quantizing (`baseHz` = the qnt-patched VCO's FREQ knob), so an LFO into `cv-in` becomes a stepped scale run; anything larger is read as Hz and quantized directly. **Output is clamped to MIDI 0…127** (`QNT_HZ_MIN/MAX`, mirrored in the worklet and in `quantizeHzJs`) — Web Audio *sums* cables into one input, so stacked modulators otherwise reach 8 octaves above base (measured 56 kHz, past Nyquist). `0` is exempt: it is the no-signal value, not a pitch.

**`snapMidiJs` / `quantizeHzJs` are a deliberate JS mirror of the worklet's snap**, because knob-stepper and quantized FM quantize without any audio-rate CV passing through the worklet. The two must stay in lockstep — `qnt-verify100.mjs` asserts they agree over 873 mode×scale×pitch cases. **Feed the mirror the Float32-rounded input when comparing them**: audio buffers are `Float32`, so a value that is an exact tie in double precision is not one inside the buffer. Handing the mirror a pristine `float64` note number manufactures "mismatches" at every tie — it cost a real detour, and a tie-break branch briefly landed in the per-sample loop for a case Float32 makes unreachable (reverted; both scans keep a plain `<`).

**Hysteresis (`HYST_SEMI = 0.35`, mirrored as `QNT_HYST_SEMI`).** Without it a CV near a boundary flips every wobble, and since Phase 96 each flip fires TRIG↑ — a 2 s E4→F4 sweep that should give 2 note changes gave 6 at 10 cents of vibrato, 14 at 25, 26 at 50. The rule is **"re-snap the input biased back toward the held note; if it still resolves there, don't move"** — deliberately mode-agnostic, because a plain distance comparison is right for NEAREST (boundary at the midpoint) and wrong for UP/DOWN (boundary on the note). Held state resets on cable pull and whenever the held note falls out of the scale. Applied in the worklet and in `qntFmTick` (per VCO); **not** in knob-stepper, where a knob is not a noisy source and the stickiness would just feel wrong.

**`SNAP` (Phase 100)** — `NEAR` / `UP` / `DOWN`. UP/DOWN walk to the next *in-scale* note on the required side, so they stay correct across gaps (A minor pentatonic: UP from A♯ → C, not B). The chip's values ARE the worklet's `SNAP_*` codes, so there is no lookup table to drift.

**`SCALE LEARN` (Phase 100)** hooks **`updateKeyboard`** — the one function every keyboard note passes through — so 953 mouse, QWERTY and MIDI all feed it with no changes to any of them. Note-ON only; the first note clears the scale; learned notes go through the same `commitMask` as clicks, so Phase 99 identification runs live. **Never persisted** — a rack restored mid-learn would eat the first notes played.

**TRP is main-thread, not audio-thread:** `-transpose-in` feeds an `Analyser`, and `QuantizerModule`'s rAF reads its average absolute value as a DC level (`> 10 Hz` = cable present, the reason every pitch source inits to `SEQ_HZ_MIN = 32.703` and never 0) and overrides the worklet root. **The keyboard follows that override** (`extRoot` state, published from the rAF's existing delta check): resolution order is **chord seq → any TRP cable → knob**. Before Phase 100 only the chord-seq case existed, so a 960 in TRP left the display lighting notes the audio was not playing. While it is active the panel's **ROOT chip glows** (`.chipOverridden`, Phase 95) — the same mint pulse as the VCO FREQ knob's `.knobGlow`, one indicator with one meaning: *this control is being driven from somewhere else*. **This rAF is deliberately NOT visibility-gated** — it drives the worklet root and must keep running while the Moog is hidden.

**The EXT chord takeover is keyed by QUANTIZER (Phase 95, extended 96).** It rides `qntChordLabelCbRefs[qid]`, fired from the same `qntChordOverrideRef` (qid → csId) walk that pushes the chord's scale, so it can only ever come from a chord sequencer actually patched into that quantizer's TRP. It previously rode a single per-chord-seq callback hard-wired to chordseq 1 → qnt 1, which could express neither multiple instances nor the pairing. Since Phase 96 it carries the chord's **intervals** too: a patched chord seq owns root *and* scale, so the note lights render the live chord (Am7 lights A C E G), the SCALE chip reads `CHORD` and takes the ROOT chip's glow, and note clicks refuse — accepting one would be a lie, since the override rAF overwrites it within a frame. It is React state, written once per chord (a bar or more), which is nowhere near the rAF path the Zero-Re-render Rule governs.

**There is no BYPASS (removed Phase 95).** It shipped in Phase 22 as a patching aid and nothing ever depended on it; its two musical uses — a smooth (unquantized) sweep, and returning a qnt-patched FREQ knob to continuous — are both "don't route through the quantizer", i.e. one cable pull. Do not re-add it: it also made OCT silently inert, since both snap implementations applied `octShift` inside the branch bypass skipped.

---

## Default Signal Chain (No Patch Cables)

**True modular routing since Moog Phase 10 — there is NO hardwired audio path.** Powering on starts the sources (VCOs, noise, LFOs, internal carriers) and the sequencer clocks, but no sound reaches the speakers until the user patches a source into the I/O module (`io-in` or a mixer channel `io-in1..4`). The minimal audible patch:

```
vco1-saw → vcf-in → (vcf-out) → vca-in → (vca-out) → io-in
seq-gate-out → env1-gate,  env1-out → vca-cv          ← gated sequencer arpeggio
```

(The only survivors of the old training-wheel wiring are module-internal fixed edges — e.g. glideBus → vco.frequency, FFB fan-out — documented per module above. Persisted racks restore the user's own cables on load, Phase 60f.)

---

## Tone.js Implementation Notes

| Rule | Detail |
|---|---|
| **Single writer per node** | Matches VoxDAW convention. Each AudioParam has exactly one writer. If both the Cutoff knob and an LFO drive the VCF cutoff, they must sum through an intermediary gain node — not both write to `filter.frequency` directly. |
| **No hardwiring** | In Phase 3, nodes are initialized disconnected. `connect(src, dest)` / `disconnect(src, dest)` methods in `useMoogAudio.js` manage the graph dynamically, enabling patch cable simulation. |
| **Ramp all params** | `.rampTo(value, 0.02)` on all audio parameters. Never `.value =` except for type switches (waveform, filter type). |
| **Tone.start() gate** | `useMoogAudio.js` must not call `Tone.start()` — it must be called on the first user gesture (same convention as VoxTool's `useAudioEngine`). |
| **Own AudioContext?** | The Moog engine should use Tone.js's shared context (not its own `new AudioContext()`), unlike the Vocoder. This avoids the 3-AudioContext browser limit and allows future integration with the Workstation transport clock. |

---

## Implementation Roadmap (Cross-Reference with MOOG_PLAN.md)

| Phase | Deliverable | Modules Covered |
|---|---|---|
| Moog Phase 1 ✅ | Visual shell, routing | All (scaffold only) |
| Moog Phase 1.5 ✅ | 4-tier visual expansion — 4 new module panels, thicker cabinet, metal texture | VCO+Noise (Row 1), CP3+VCF+LFO (Row 2), VCA+ENV×2+Multiples (Row 3), Sequencer blanks (Row 4) |
| Moog Phase 1.6 ✅ | Photorealistic UI overhaul — multi-cabinet tiers, cream typography, improved jacks | All |
| Moog Phase 2 ✅ | `MoogKnob.jsx` — drag-to-rotate with shift fine-mode, double-click reset | All knobs |
| Moog Phase 3 ✅ | `useMoogAudio.js` — 15 Tone.js nodes, jackMap, patch bridge via `MoogPatchContext` callbacks, Power/I/O module | VCO, VCF, VCA, Envelope, CP3, Noise, LFO, I/O |
| Moog Phase 7 ✅ | SVG patch cable simulation — zero-re-render drag, bezier droop, click-to-remove | All jacks |
| Moog Phase 4 ✅ | VCO panel knob wiring (freq, fine, wave, range) | VCO |
| Moog Phase 5 ✅ | VCF panel knob wiring (cutoff, resonance) | VCF |
| Moog Phase 6 ✅ | Envelope + VCA wiring + manual GATE button | VCA, Envelope |
| Moog Phase 8 ✅ | LFO audio wiring (rate, depth, wave) | LFO |
| Moog Phase 10 ✅ | Master I/O + true modular routing (vca→io-in hardwire removed) | I/O |
| Moog Phase 11 ✅ | Retro oscilloscope visualizer on I/O module | I/O |
| Moog Phase 9 ✅ | 960 Sequential Controller — 8-step sequencer, Tone.Loop, pitch CV out, gate routing | Sequencer |
| Bug Fix ✅ | `setTargetAtTime` for VCO/VCF frequency params — eliminates exponential-ramp-from-zero crashes | VCO, VCF |
| CV Scaling ✅ | FM + VCF CV input `Tone.Gain` scalers (×500 FM, ×5000 VCF cv, ×1000 VCF env) — LFO now audible | VCO FM, VCF |
| Moog Phase 13 ✅ | 953 Keyboard Controller — 3-oct piano (C3–B5), pitch CV + gate out, computer keyboard (A–K) | Keyboard |
| Moog Phase 8a ✖ | CP3 Mixer knob wiring — obsolete: CP3 removed (Rack Expansion 2026-06-10) | CP3 |
| Moog Phase 8b ✅ | Noise Generator LEVEL wiring — per-instance W/P gain pairs, unity at default | Noise |
| Moog Phase 42 ✅ | 16-band spectral vocoder — patchable MOD/CARR/OUT, envelope-follower bank, MIX/HISS/BUZZ, 16-seg meter | Vocoder |
| Moog Phase 43 ✅ | EXT IN — live mic via Tone.UserMedia (later merged into the Vocoder, Phase 48) | EXT IN |
| Moog Phase 48 ✅ | Merged EXT IN into the Vocoder — built-in mic feeds the modulator directly | Vocoder |
| Moog Phase 51 ✅ | Photorealistic material overhaul — black skirted knobs (+cream 960 dials), matte feTurbulence plates, cable plugs, LED bezels, dark walnut | All (visual) |
| Moog Phase 52 ✅ | Period-correct System 55 pass — spun-aluminum knob caps, worn lettering, jack thread, rubber cables, jewel-lamp facets | All (visual) |
| Moog Phase 53 ✅ | Viewport camera — wheel/pinch zoom 1–8× toward cursor, drag-pan, Esc reset; zero-re-render imperative transforms | Shell (interaction) |
| Moog Phase 54 ✅ | Rack densification — 960s de-stacked, I/O channel grid, components +20%, keyboard widened; controls ~28% bigger on screen | Shell (layout) |
| GPU Fix ✅ | Black-flashing modules — replaced static cabinet `will-change` with transient promotion during camera moves | Shell (compositing) |
| Moog Phases 55–59 ✅ | Typography pass, Reverb Aura displays, QNT knob-stepper + modulation modes, case system + module library | All |
| Moog Phase 60 series ✅ | **Dynamic Rack** — see the AS-BUILT section below | All |
| Moog Phase 12 ✅ | Knob hover tooltips shipped; module bypass rejected as superseded (MIX-at-zero / QNT BYPASS / library removal); mobile fallback deferred (touch camera subproject, desktop-first product) | All |
| Moog Phase 61 ✅ | Powered-rack frame rate — camera-driven `content-visibility` module culling + LED/meter write dedupe (see §Rendering Performance) | Shell (rendering) |
| Moog Phase 87 ✅ | 960 audit — CLK↓/CLK↑ made live (gate domain, ext clock overrides internal, chain-cycle guard), rest-mute no longer survives a pulled cable, per-instance CLOCK DIV, `16-STEP` silkscreen, `% steps.length`; adjacent: KBD GATE↑ → KICK GATE IN no longer throws | 960 SEQ (+ KBD) |
| Moog Phase 87b ✅ | Master clock consolidated — TEMPO removed from every 960, one knob + BPM readout on I/O (`4-CH MIXER · MASTER CLOCK · OUTPUT · POWER`); GLIDE promoted to `lg` in the freed space | 960 SEQ · I/O |
| Moog Phase 87c ✅ | CLOCK chip moved beside GLIDE and converted to the VCO RANGE drag gesture; I/O BPM chip made click-to-type (clamped 20–300, Escape reverts); `text` added to the camera's `isInteractive` cursor allow-list | 960 SEQ · I/O · Shell (camera) |
| Moog Phase 87d ✅ | BPM field no longer rescales the rack (always an `<input>`, never span↔input) + capture-phase click-away commit; `:focus` cue rescoped to beat the hover rule | I/O |
| Moog Phase 87e ✅ | BPM field restored to chip type scale — `font-size`/`weight`/`letter-spacing: inherit` were overriding `.selectorValue`'s 21px down to the body size | I/O |
| Moog Phase 89 ✅ | Per-step **SKIP** — third step-switch state removed from the cycle (vs REST, which keeps its time), making 3/4, 5/4, 7/8 etc. possible on a 16-step 960; live cycle-length readout in the plate subtitle | 960 SEQ |
| Moog Phase 89b ✅ | SKIP restyled as a **lit red lamp** on the `.seqGateOn` recipe (was an amber slash + dimmed column); column dimming dropped, lights-out exempts both lamp states | 960 SEQ (visual) |
| Moog Phase 104 ✅ | I/O mixer **4 channels → 8, in the same plate** — new `MoogFader` (late-60s slot + knurled cap) reserves 26px where a `sm` knob needed 52px, so the column is sized by the jack and 8 channels measure *narrower* than the old 5. Legacy `io-in` becomes **IN 5** with its first-ever fader + meter, **keeping its jack id** so saved cables survive; `chVols` pads 4→8 preserving existing positions | I/O |
| Moog Phase 103 ✅ | I/O: **PEAK became a real peak/clip lamp** (true uncapped sample peak + a 900 ms red latch — the old smoothed-RMS-clamped-to-1 could not tell "loud" from "clipping"), **`masterLimit` output brick wall** (−1 dB / 20:1, hard knee; PEAK + scope stay pre-limiter so the lamp can still warn you), and **MASTER at zero = true silence** (−∞ dB, was −60 dB) | I/O |
| Moog Phase 102 ✅ | **I/O audit** — POWER OFF re-opened the master gate, so power-down relied on every source stopping; the **mic never stops**, so mic + vocoder CLARITY + `voc-out→io-in` played through a power-down. `seqMasterGate` is now a real power gate (ramped closed/open, opened before sources start). Restored tempo validated + clamped (`?? 120` only caught null). §10 spec marked stale and an as-built added | I/O |
| Moog Phase 101 ✅ | QNT chips **stop resizing themselves** — LEARN going OFF→PLAY… had been wide enough to wrap the row and make controls jump lines. Two explicit `nowrap` rows (SCALE/ROOT/OCT, then SNAP/GLIDE/LEARN) + `ChipValue`, which sizes each box to its widest possible reading by stacking all of them in one grid cell | QNT · Shell (chips) |
| Moog Phase 100 ✅ | QNT: **hysteresis** (35 cents — killed the boundary chatter that TRIG↑ had been machine-gunning: 25-cent wobble went 14 note changes → 2), **SNAP** direction chip (near/up/down), **SCALE LEARN** off `updateKeyboard` (953 + QWERTY + MIDI for free), and the **TRP keyboard-root bug** (a 960 in TRP lit notes the audio wasn't playing) | QNT |
| Moog Phase 99 ✅ | QNT **names a hand-picked scale** instead of saying CUSTOM — `identifyScale` resolves the inherent ambiguity (one note set is many scales; G lydian == D major's notes) by trying the user's ROOT first, then widening and moving ROOT with it; `rebaseMask` makes that a relabelling with the audio provably unchanged. LOCRIAN added to complete the modes | QNT |
| Moog Phase 98 ✅ | QNT's keyboard rehoused as a **phosphor display** — oscilloscope bed/graticule/scanlines + Aura chrome bezel & glass sheen, keys become lit segments (dim outline → filled glow → full-brightness bloom). No 1960s module has a piano bolted to it; plenty have a screen showing one | QNT (visual) |
| Moog Phase 97 ✅ | QNT's 12-LED strip becomes a **real one-octave keyboard** — 953 construction (derived black-key lefts, matching ratios), 1.8× wider / 5.3× taller, scale membership shown by **material** (switched-off vs real ivory/ebony) rather than brightness, white-key note names + a mint **root marker** | QNT (visual) |
| Moog Phase 96 ✅ | **QNT features** — the 12 note lights become a **scale editor** (click to toggle, offsets-from-ROOT so ROOT transposes, last note protected, SCALE→CUSTOM); **7 new scales** (LYD/MIX/DOR/PHR/HMIN/BLUES/WHOLE, 12 total); **TRIG↑ jack** (pulse per new note → ENV re-articulation, fired from all 3 note-change sites); **GLIDE knob** (0–1.5 s, excluded from quantized FM by design). Chord-follow made legible: a patched chord seq lights its own chord and locks SCALE with the ROOT chip's glow | QNT |
| Moog Phase 95 ✅ | **QNT module-perfection pass** — snapping core verified correct; four panel-layer defects fixed (dynamic instances had no chord label; the label was keyed by chord seq, not quantizer, with no patched-together check; display/LEDs never cleared on cable pull; the chord name outlived its sequencer). **BYPASS removed** (a Phase-22 patching aid nothing depended on — which also un-broke OCT, silently inert while it was on). Output clamped to MIDI 0…127; ROOT chip glows while TRP overrides it; `applyQuantizerParams`' missing-braces trap closed. New §20 spec section — the quantizer had never had one | QNT |
| Moog Phase 94b ✅ | 7TH → VCO took the audio pass-through branch (Phase 91 missed `connect()`'s voice-out regex), giving that VCO two pitch writers; all three chord-output lookups now derive from one `CHORD_VOICE_KINDS` list | CHORD SEQ · VCO |
| Moog Phase 94 ✅ | Chord voice → VCO **octave select** — a VCO fed by ROOT/3RD/5TH/7TH now uses its FREQ knob to pick the register, snapping to octaves of that chord tone (knob-stepper glow shared with the quantizer); per-voice registers replace ROOT OCT's all-or-nothing shift | CHORD SEQ · VCO |
| Moog Phase 93 ✅ | **CYCLE↑** on every 960 — one pulse per completed cycle, derived from the step scan so it tracks the meter as skips are edited; patch it into a chord seq's **CLK↓** to pick which 960 a progression follows. **93b:** the separate CLK ÷ chip folded into CLOCK DIV, which now divides the incoming clock when one is patched | 960 · CHORD SEQ |
| Moog Phase 92 ✅ | CHORD SEQ brought to parity with the 960 — per-step **PLAY / REST / SKIP** (3- and 7-chord progressions), **GATE↑**, **CLK↓ / CLK↑** (chord follows a 960, incl. odd meters); shared `dispatchStepActions` + one clock-recursion guard across both module types. All value chips (VCO RANGE, 960 CLOCK, chord CLOCK DIV / ROOT OCT / per-step root + quality, QNT SCALE / ROOT / OCT) unified on one `beginDragSelect` gesture: drag to scrub, click to step | CHORD SEQ · QNT · VCO · 960 (UI) |
| Moog Phase 91 ✅ | LFO waveform taps → VCO's SVG glyphs + VCO's SIN·TRI·SAW·SQR order (jack ids unchanged). CHORD SEQ audit: **7TH voice out added** (the 4th voice was computed then discarded, so CMAJ/CDOM/CMAJ7 emitted an identical triad), step LED + chord label moved onto `drawAt` (were `lookAhead` early), `% 8` → `% steps.length` + step guards in the loop and the snapper | LFO · CHORD SEQ |
| Moog Phase 90 ✅ | Rest-step mute reached too far — `cvPassthroughInput` treated a chord seq's ROOT/3RD/5TH as pass-throughs of its `cv-in`, so a 960 rest silenced VCOs playing the chord voices; only `cv-out` is a pass-through | 960 SEQ · CHORD SEQ |
| Moog Phase 88 ✅ | Double-note through the chord sequencer — a 960 feeding `chordseq-cv-in` was POLLED by the snapper rAF while its gate was scheduled sample-accurately; step loop now writes the snapped pitch at the step's own `time`, snapper stands down, chord loop re-snaps on chord change | 960 SEQ · CHORD SEQ |

**Roadmap complete (2026-07-11)** — every phase shipped or resolved with a logged decision (full logs in MOOG_PLAN.md).

---

## Dynamic Rack — User-Customizable Modules (Phase 60 series) — AS BUILT

**Status: ✅ COMPLETE (2026-07-11).** All 14 removable module types are instantiable from the library with duplicates; the whole custom rack — instances AND patch cables — persists across reloads; expansion modules drag-to-reorder. The original decisions held: full customizability incl. duplicates; space policy = **fit-width floor + vertical scroll**. Deviations from the original proposal are noted inline below; per-phase logs live in MOOG_PLAN.md.

### Goals / Non-Goals

- **Goals:** add/remove any module from a bank; multiple instances of the same type; layout persists across sessions; patch cables work across all instances; no per-module shrink below the fit-width floor.
- **Non-goals (this series):** ~~drag-to-reorder, cable persistence~~ (both later SHIPPED — 60f), mobile layout, Workstation integration changes (`moogBus` tap unchanged).

### State Model (as built)

```js
// localStorage 'moog-rack-v2' — one record for the whole custom rack.
// Written ONLY from user event handlers / user-driven provider callbacks
// (the Phase 60c StrictMode wipe lesson); v1 (types only) migrates on read.
{
  modules:  [ { id: 'vco6', type: 'vco', num: 6 }, … ],   // array order = expansion-row order
  cables:   [ { from: 'seq-gate-out', to: 'kick2-gate-in', color: '#e84040' }, … ],
  settings: { vco1: { freqBase: 0.7, fineTune: 0.5, rangeOctave: 0, syncOn: false },
              vcf:  { cutoff: 0.4, res: 0.6, … }, seq2: { steps: [...], tempo: 128 }, … },
}
```

### Per-module settings persistence (Phase 63)

`settings` (added Phase 63) captures every module's knob/switch positions, keyed by canonical instance id (the jack prefix — same key space as `modules`/cables). This is what makes a reload / `.moog` load restore the *exact patch*, not just which modules and cables exist (60f). Two hooks in MoogShell.jsx, next to `readRackStore`:
- **`useSavedSettings(id)`** — lazy `useState(() => readModuleSettings(id))`, read ONCE at mount; each module seeds its `useState` as `saved.field ?? default`. Never-touched module → `{}` → all defaults.
- **`useModulePersist(id, values)`** — debounced 200 ms (coalesces a knob drag into one write), and writes the module's full snapshot ONLY when it differs from what's stored. That diff-guard is load-bearing: mount-time seeding and StrictMode's double-effect produce no write, honoring the "user events only" rule; and the write is merge-only (`{...settings, [id]: values}`) so it can never wipe `modules`/`cables` (the 60c hazard). The dep is `JSON.stringify(values)` so nested arrays (seq/chord `steps`, FFB `bands`) trigger correctly.

All 15 module types wired uniformly (id computed before `useState`; Vocoder `micStatus` excluded as runtime, not a setting). **SAVE/LOAD/RESET reuse the mount-time restore path**: the store is the whole setup, so SAVE serializes it to a `.moog` download, LOAD writes it + `window.location.reload()`, RESET clears it + reload. A reload lands on Root's home page, so reset/load set a one-shot `sessionStorage['voxdaw-return-page']='moogmodular'` that `Root.js` honors (minimal routing exception). Toolbar `[RESET] [SAVE SETUP] [LOAD SETUP]` in the top bar.

- **Instance id = jack prefix** (`vco6` → jacks `vco6-cv`, `vco6-saw`…). Static ids (`vco1…vco5`, `noise`, `vcf`, `qnt`…) are grandfathered as the default rack; new instances mint `type<n>` from `nextInstNumRef` (monotonic, minted eagerly in handlers). **Restore honors persisted nums** (`addModule(type, desiredNum)`, collision → fall back to minting) so cables stay valid across reloads.
- **Deviation from the proposal:** no `cases` array — added instances render in a wrapping **expansion row** inside the Voice Case at fixed per-type widths, growing the rack into the 60a floor+scroll. Simpler, and the case picker became unnecessary.

### Engine Instance Registry (as built — no separate `moduleFactories.js`)

**Deviation:** factories live inline as branches of `addModule(type)` in `useMoogAudio.js` (the co-location rule), not in a registry file. Each branch mirrors its static recipe exactly and registers nodes into `nodesRef.current` **under composed names** (`vco6GlideBus`, `ffb2Filter3`, `voc2CarrVCA7`…) so every existing name-composed lookup — param updaters, `getMeterValue`, `connect()`'s glideBus path, LED getters — works on dynamics with zero changes. Per-instance bookkeeping: `dynInstancesRef` (id → `{ type, num, nodeNames, sourceNames, jackIds }`); `sourceNames` makes powerOn/powerOff generic.

- **Per-type state went id-keyed maps** rather than one generic params bag: seq/chord loops (`buildSeqLoop(seqId)` / `buildChordSeqLoop(csId)` — one body serves statics + dynamics), kick tune/decay/trig-cb, vocoder shift refs, quantizer params/callbacks. Dispatch: `updateDynModuleParams(id, params)` for knob objects + dedicated `*ById` APIs where the callback shape differs (steps, LED callbacks, divisions, glide, sync).
- **Worklet types use a synchronous registry + deferred wiring:** `n.hardSyncNodes` / `n.qntNodes` objects are assigned at node-creation; the async worklet load defines an idempotent `wire(id)` that sweeps existing instances and parks in a ref (`wireHardSyncRef` / `wireQntRef`) for instances added later. Cleanup nulls the refs so a StrictMode remount can never wire against disposed nodes.
- **Shell bindings:** `bindingsFor(id)` caches per-instance closures (meter/params/LED/etc.) in a ref map so `Led` rAF loops and module effects never restart on unrelated renders.
- `removeModule` order (load-bearing): LibraryModal strips cables by `${id}-` prefix (fires audio disconnects) → native worklet nodes disconnected (no dispose) and the vocoder's shared-mic input edge severed **before** the `nodeNames` dispose sweep → per-type map cleanup → registry delete.
- **Cable restore (60f):** `MoogPatchProvider.restoreCables()` validates endpoints against the live jack registry, draws + fires the audio bridge; a `CableRestorer` (the provider's LAST child — sibling effect order guarantees jacks registered first) re-fires `connect()` on an idempotent retry schedule (0.8 s / 2.5 s) covering worklet-deferred jacks and the StrictMode engine rebuild.

### Per-Type Notes (duplicate cost & special handling)

| Type | Per-instance extras | Suggested cap |
|---|---|---|
| VCO | glideBus + hard-sync `AudioWorkletNode` + vibrato-tick registration (`VCO_IDS` const → registry query) | 10 |
| LFO / Noise / VCA / ENV / REV / BBD / Kick | plain node groups — cheap | 8 |
| 914 FFB | 14 filters+gains each | 4 |
| Vocoder | **16 bands × (BPF+rect+env+VCA) ≈ 70 nodes** + mic singleton (mic stays shared; MIC button on any instance grabs the one `Tone.UserMedia`) | 2 |
| QNT | own `AudioWorkletNode`; knob-stepper refs (`quantizerParamsRef`, baseHz, callbacks) become per-instance maps keyed by id | 4 |
| 960 SEQ / CHORD SEQ | own `Tone.Loop`; Transport is shared (tempo knobs all write `Transport.bpm` — last writer wins, as today with 2×960) | 4 |
| VOWEL (§13) | 3 bandpass+gain pairs + 2 analysers; own entry in `vowelTick` rAF (delta-gated); **dynamic-only → num starts at 1** (Phase 64) | 4 |
| I/O, 953 Keyboard | **fixed singletons** — not in the bank | 1 |

### Layout & Camera

- **(As built)** added instances land in the wrapping expansion row (`.tierDyn`) at fixed per-type px widths measured against their static siblings at `FLOOR_LAYOUT_W` — flex-wrap is safe there because below the floor the layout width is pinned, so wrapping cannot oscillate with fit(). Reordering = drag the grip tab (60f-2; order persists, cable overlay repositions via a resize nudge).
- **Camera change (small, standalone):** `fit()` scale becomes `clamp(availH/natH, availW/natW, 1)` — floored at fit-width. When floored, `clampPan` already permits vertical panning; add wheel-scroll (no ctrl) → vertical pan at z=1 so the tall rack is reachable without zooming.
- Blank-panel filler: a case's unused width renders as blank panels (authentic, keeps the wood frame visually full).

### Invariants preserved

Single Writer per node (per instance now); Zero-Re-render (all per-frame work stays in rAF/canvas/DOM refs; add/remove is event-driven React state like Phase 59); no static `will-change` on the cabinet; fit-stability probe must pass after every layout-affecting phase.

### Phasing (each lands green on its own)

| Phase | Scope |
|---|---|
| 60a ✅ 07-08 | Camera fit-width floor + vertical scroll (no engine changes — ships alone) |
| 60b ✅ 07-09 | Engine instance registry + factory contract; **pilot: VCO + Noise** migrated; static graph coexists for everything else |
| 60c ✅ 07-09 | Migrate LFO/VCA/ENV/REV/BBD/VCF + persistence-lite (type list in localStorage); Kick/914 slipped to 60d |
| 60d ✅ 07-10 | Kick + 914 (id-keyed refs, gate actions carry `kickId`) + **per-instance hard sync** (`hardSyncNodes` id-keyed, `wireHardSyncRef` for late adds) |
| 60e | **✅ COMPLETE 07-11 (4 parts):** 960s (id-keyed seq maps + `buildSeqLoop`, Tone.Loop lifecycle, restored-instance jackMap wipe fix) · CHORD (`buildChordSeqLoop`, per-instance snap/override) · VOCODER (~70-node factory, per-instance shift rAF, shared-mic fan-out) · QNT (per-instance worklets in `n.qntNodes`, knob-stepper machinery parameterized by owning instance, chord override as qid→csId map). Library v2's case picker was overtaken by the expansion-row design. |
| 60f | **✅ COMPLETE 07-11:** cable persistence — v2 rack store `{modules, cables}` with STABLE instance ids (`addModule(type, desiredNum)` + collision repair), `restoreCables` with jack-registry validation, idempotent connect-retry schedule for worklet-deferred jacks + StrictMode engine rebuild — **and drag-to-reorder** (grip tab per expansion slot, order persists, cable-overlay reposition nudge) |

### Risks

1. **Disposal leaks / crashes** — Tone `.dispose()` while a cable's audio connection exists; mitigated by cable-strip-first ordering + try/catch disconnects (existing pattern).
2. **Worklet-load races** — jack entries whose `dest` is a not-yet-loaded worklet node (existing `qnt-cv-in` null-until-loaded pattern generalizes: factories may return `dest: null` and patch the registry on load).
3. **GPU budget** — more modules = larger raster area; the transient `will-change` model already handles size, but 60e should re-run the black-flash regression check at 8+ cases.
4. **Registry/UI drift** — the registry must be the single source for what exists; MoogShell renders purely from state (no hardcoded rows after 60d).

---

## Rendering Performance — Powered-Rack Frame Rate (Phase 61) — AS BUILT

Large custom racks exposed a compositor bottleneck: **every visual invalidation re-runs Blink layerization (`PaintArtifactCompositor::Update`) at a cost proportional to the rack's total paint complexity** (~31 ms/pass at 31 added instances). The per-frame writers (Led opacity, FFB/vocoder segment meters, Aura/scope canvases) each pull that trigger every frame → ~30 fps while powered, even idle. JS is not the cost — the writers are triggers. (Full evidence chain: MOOG_PLAN.md, 2026-07-11/12 entries.)

**Mechanisms (all in `MoogShell.jsx` unless noted):**
- **Camera-driven module culling:** a visibility-manager effect stamps exact `contain-intrinsic-size` per `.module` (measured layout boxes — skipping can never shift layout, the Phase 55 fit() trap) and toggles `content-visibility` `'visible'`↔`'auto'` from the camera's `apply()` (`cameraViewRef` → `moduleVisRef`). Bands are **activity-adaptive**: 0.5-viewport promote lead / 1.0 demote hysteresis while the camera moves; a deep 0.05-viewport sweep after 1.2 s of stillness (at the fit-width floor one viewport ≈ 1800 layout px — fixed generous margins would exceed the whole rack and skip nothing). Promotions time-sliced ≤2/frame. Far state is always `'auto'`, never `'hidden'` — a banding miss costs perf, not pixels (a skipped module still paints its faceplate).
- **Power gate:** unpowered racks have no per-frame writers → the manager is dormant and clears its styles; unpowered scroll renders everything (pre-61 behavior).
- **Write dedupe:** `Led` / FFB / vocoder meter loops quantize opacity to 1/64 and skip identical writes — unchanged style strings never invalidate paint, so silent/steady LEDs stop re-triggering layerization. Aura + Oscilloscope canvas loops skip drawing when `checkVisibility({ contentVisibilityAuto: true })` reports their module skipped. **The QNT TRANSPOSE CV loop stays ungated** (drives the worklet root while hidden).
- **Cable-overlay resilience (`PatchCableOverlay.jsx`):** zero-size jack rects → null from `getSvgCoords`; a per-cable last-good endpoint cache keeps cables drawn through transient mid-promotion redraws.
- **Size gate (Phase 61b) — the shipped scroll fix:** toggling `content-visibility` invalidates the layer tree → one `Layerize` per toggle; during a scroll the band moves every frame, so the manager churns and saturates the main thread (which also delays the non-passive wheel handler → choppy scroll). On small/modest racks this is pure cost — they idle fine (~8 ms) without culling and scroll perfectly smooth fully rendered (this is why "lights out is smooth"). So the manager engages **only when `cabinet.offsetHeight > 2500` layout px** (`CULL_MIN_NATH`; between the default rack's 1799 and a large rack's 3415, zoom/viewport-independent). Below it, all `content-visibility` is cleared and the manager stays dormant. Default-rack powered scroll: p95 83 → 9.3 ms. **Rejected alternatives (do not retry):** a gesture writer-pause (LED/meter/canvas skip while the camera moves) — reverted, the writers were never the scroll cost, the toggling was; and removing knob `will-change: transform` — made scroll *worse* (p95 58→117 ms), since it correctly keeps knobs on GPU layers so a pan is a texture move, not a repaint.

- **Module-level layer promotion (Phase 61d) — the Retina SCROLL fix:** the culling above is about idle layerization; a separate cost dominates *scrolling* on a **2× (Retina) display** — the GPU re-composites the whole photoreal rack every frame during a pan, and the dominant term was the **~130 per-knob compositor layers** (each `.knob` had a permanent `will-change: transform`). Fix: promote layers at the **`.module`** level instead — `will-change: transform` on `.module`, removed from `.knob`. A pan then translates ~30 cached module textures (knobs paint into them) rather than blending 130 knob layers, dropping a real pan from ~1000 ms to ~370 ms GPU-thread busy (below lights-out) with **every component visible, full-res and animating — nothing hidden or frozen**. `MoogKnob.jsx` transiently re-promotes only the dragged knob (`will-change` on mousedown → cleared on mouseup) so rotation stays crisp without re-rastering its module. Sweet spot rationale: knob layers = too many composites; no layers = whole-cabinet raster-on-pan (catastrophic, measured 3781 ms); one cabinet layer = over-rasterized; ~30 module layers = few composites + bounded raster-on-pan. **Testing gotcha:** the default rack fits a normal viewport, so wheel hits the zoom path and doesn't pan — measure scrolling with a SHORT viewport (≤ ~650 px) at DPR 2 so it actually overflows/pans. *Rejected en route (do not retry): motion-mode knob-hiding (worked but Dylan rejected the vanishing visuals); an animation-freeze during pan (`viewportActivity.js`, deleted — only ~25 % off a real pan since knob composites, not animation, dominate); removing knob will-change (raster-on-pan, worse).*

**Invariants:** cabinet natural height is byte-identical with the manager on/off (no fit() feedback); jack rects inside skipped modules remain valid (Blink retains last layout — probe-verified); single writer holds (the manager is the only writer of `contentVisibility`/`containIntrinsicSize` on modules); Zero-Re-render holds (closure state + direct style writes only); module `will-change: transform` (61d) is a static CSS property — fewer/bounded layers than the knobs it replaced, so GPU-memory and black-flash risk are not increased. Measured on the 31-instance rack: powered idle ~33–42 ms/frame → ~22–24 ms; wins scale with rack height (test rack was only 1.9 viewports tall — skip ceiling ~50%). Browsers without `content-visibility` degrade gracefully to pre-61 behavior (unknown style values are no-ops).
