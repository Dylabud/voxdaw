# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# VoxDaw - System Instructions & Coding Standards

## Session Initialization Protocol
**CRITICAL:** At the start of every new chat session, before writing any code or proposing solutions, you MUST read the following files in their entirety to establish context:
1. `CLAUDE.md` (System instructions and boundaries)
2. `ARCHITECTURE.md` (Technical stack and data flow)
3. `PLAN.md` (Current project state and immediate next steps)

**For Moog Modular work** (`src/components/MoogModular/`), the sub-project has its own single sources of truth — read these too and log Moog work ONLY there (root `PLAN.md` gets pointer entries at most):
- `src/components/MoogModular/MOOG_ARCHITECTURE.md` (module specs, signal flow, Dynamic Rack as-built)
- `src/components/MoogModular/MOOG_PLAN.md` (phase log — update at the end of every Moog session)

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
The app shell is a thin state-router — **no `react-router-dom`**. `Root.js` owns `page` (`'home' | 'voxtool' | 'workstation' | 'moogmodular'`), `isDarkMode`, and `pendingProject` state, applies `data-theme="light"` on a top-level wrapper, and threads `onNavigateHome` + theme props to each page. Pages mount on first visit (`visited` Set) and stay mounted `display:none` for audio continuity. `App.js` is the VoxTool page; Root renders `WorkstationShell` directly (the old under-construction `Workstation.jsx` wrapper was removed). Adding a new page = adding a branch in `Root.js`, not a routing library.

### Homepage dashboard + browser project store (`HomePage/`, `src/utils/projectStore.js`)
`HomePage` is a project dashboard: header nav (VoxTool / Workstation / Moog + theme toggle), `PROJECTS` card grid (+ New Project card; per-card hover kebab: rename / duplicate / download / delete), `[ import .voxdaw ]`, footer alpha note. Projects persist in **IndexedDB** (`projectStore.js`: db `voxdaw`, store `projects`, records `{ id: uuid, name, createdAt, updatedAt, bpm, trackCount, data }` — `data` = full `serializeProject()` output; `saveProject` upserts, stamps `updatedAt`, preserves `createdAt`). Workstation `[ save ]` upserts under `currentProjectId` state (null → first save mints the id); the `.voxdaw` file download lives in the export menu (mp3 / wav / `.voxdaw`); `[ load ]` file-opens reset `currentProjectId` to null so the next save creates a new record. Project `name` is an **additive** `.voxdaw` field (SCHEMA_VERSION not bumped) with a click-to-edit `NAME` transport block (the BPM-editor pattern). **Open-from-home:** Root's `openProject({ projectId, data })` bumps a monotonic `requestId` into `pendingProject` and navigates; the shell's apply-effect (guarded by `lastAppliedReqRef`, StrictMode-safe) runs `applyProjectData(data ?? BLANK_PROJECT_DATA)` — `BLANK_PROJECT_DATA` must mirror the shell's initial state exactly. A live workstation session prompts `window.confirm` before being replaced. HomePage stays mounted, so Root passes `active={page === 'home'}` to trigger grid re-lists.

### Workstation (`src/components/Workstation/`)
DAW-style page: `WorkstationShell.jsx` (transport bar / tracks / regions / ruler / playhead, rendered directly by Root) → `RegionEditor/` (bottom-docked editor with inspector + piano roll shell). State for tracks (`{ id, name, instrument, color, isMuted, isSolo, volume, pan, effects, envelope }`) and regions (`{ id, trackId, startMeasure, durationMeasures, clipOffset, fadeIn, fadeOut }`) lives in `WorkstationShell`. (`envelope` is the optional per-track ADSR override — see *Instrument-tab performance UI*.) Regions have 6 drag modes: `move`, `resize-left`, `resize-right`, `fade-left`, `fade-right`, `fade-both` (merged-joint slide). **Tone.Transport is the singleton clock** — `handlePlayPause` toggles based on `Tone.Transport.state` (start ↔ pause preserves position); `handleStop` resets to zero. Playhead transform + time text update through a single rAF loop reading `Tone.Transport.seconds`. **All hover/drag interactions are ref-based** (ghost region, region move, region resize, editor-panel divider): direct DOM mutation during the drag, one `setState` on `mouseup` — matches the Zero-Re-render Rule. Region clicks `stopPropagation` so only the ruler does seek/scrub. **The arrangement is ONE scroll surface**: the track-header column is a `position: sticky; left: 0` flex item *inside* the `.timeline` scroller (the piano roll's `.keys` pattern) — no vertical scroll mirroring exists; only horizontal timeline ↔ piano-roll scrollLeft sync remains (Phase-117 one-shot suppress flags). All grid coordinate math offsets by the dynamic `headerColW()` inset (the column is user-resizable via `--left-col-width`), and `handleMouseDown` early-returns for events originating inside the header column. Track headers have a right-click ContextMenu (rename / color / destructive pitch-shift / duplicate / paste-effects-to / per-track WAV+MP3 export submenu via force-solo `bounceProject` / delete — deletion relies on the audio hook reconcilers for node disposal; cloned/pasted effects always get fresh `e<n>` ids). Mute/Solo are **mutually exclusive per track** (turning one ON clears the other in `toggleMute`/`toggleSolo`), so the both-set state is unreachable; the audibility rule `!isMuted && (!anySoloed || isSolo)` is unchanged and shared by live playback and bounce. The region reconciler (effect #4 in `useWorkstationAudio`) tracks `trackId` in `appliedRegionStateRef` and **re-parents the region's `fadeGain`** (`disconnect()` → `connect(newTrackVolume)`) when a region is dragged to another track — without this, the region keeps playing through the old track's volume/pan/FX/mute chain. `.timelineInner` and `.trackHeaders` need `height: max-content` (+ `min-height: 100%`): flex-line stretch clamps their boxes to the scroller viewport, which cut the absolute playhead (`top:0; bottom:0`) short below the first screenful of tracks.

### Workstation IDs & project load repair (`projectIO.js`)
Four monotonic counters mint ids: `nextIdRef` (tracks `t<n>`), `nextRegionIdRef` (`r<n>`), `nextEffectIdRef` (`e<n>`), `nextNoteIdRef` (`note_<n>`). **All four must be restored on project load** — `deserializeProject` recomputes each via `nextSuffix()` (trailing-digits regex) and `handleLoadProject` assigns them. The note counter was historically omitted, so post-load mints collided with loaded note ids; duplicate note ids are catastrophic because deletes/commits/transposes key on id **sets/maps** (an innocent twin in another region gets deleted or has its `regionId` overwritten → ghost notes in mini-maps that the piano roll can't show, since mini-map/audio filter by regionId but the editor filters by trackId). `deserializeProject` therefore also runs a **repair pass** on notes (regionId is authoritative): re-mint duplicate ids, reconcile `trackId` to the owning region's track, drop orphans whose region no longer exists; returns `repairedCount` for the load toast. **Ids must always be minted eagerly in event handlers, never inside setState updaters** (StrictMode double-invokes updaters). `duplicateTrack` selects notes by `regionIdMap.has(n.regionId)` (region ownership), never by trackId-with-fallback — a fallback to the source regionId plants clones in the source track's regions.

### Piano-roll tool modes & note velocity (`RegionEditor.jsx`)
The notes tab has a `toolMode` toggle next to snap (`'editor' | 'velocity' | 'glide'`, ref-mirrored `toolModeRef` for the window drag handlers). Velocity mode freezes note geometry (selection/marquee unchanged; empty-grid click deselects only); vertical drag = screen-space `dy`, 1 px = 1 unit, one integer delta across the selected cluster, clamped **1–120 per note** (default 100). Drags are DOM-only (Zero-Re-render): the `data-vel-bar` child's **percentage** width (one write covers base + clipped loop ghosts) + the singleton `.velReadout`; one `onCommitNoteEdits` on mouseup. `note.velocity` (1–120 int) rides `buildRegionEvents` events and every trigger site passes `(ev.velocity ?? 100)/120` (live + bounce — never hardcode trigger velocity). **`computePartKey` includes velocity** — omit a new note field there and edits silently never reach playback. Persistence: `sanitizeVelocity` in `projectIO.js` (additive, SCHEMA_VERSION NOT bumped); the note clipboard rebuilds notes field-by-field, so any new note field must be added to copy/cut/paste explicitly. `transcribeAudio` emits 1–120.

### Piano-roll glide tool (`glideMath.js` / `RegionEditor.jsx` / `useWorkstationAudio.js` / `audioBounce.js`)
Per-note portamento + true legato. Invariants that must not break:
- **`note.glide` is pruned-to-undefined when inert** (`normalizeGlide`: not connected AND endPitch === own pitch) at EVERY write site — untouched notes carry no data, and `computePartKey` only appends a glide component when one exists, so glide-free projects rebuild/play byte-identically (hard perf contract; `buildRegionEvents` has a one-scan `hasGlide` bail).
- **Connections are resolved, never stored:** no target ids. Target = the UNIQUE same-region note whose start tick (`tickOf(beats, PPQ)` — the same rounding `buildRegionEvents` applies to event times) equals the host's end tick with pitch === `glide.endPitch`. One epsilon, three consumers (compiler `compileGlideChains`, UI claw, menu enable checks). Claw delete / menu "Disconnect connections" set `connected: false` — host keeps gliding, freed note re-attacks. Region split severing a chain degrades to unconnected glide (accepted). **Connections survive pitch edits:** every note-edit/transpose commit (`handleCommitNoteEdits` — AFTER dedupe — and both transpose paths) runs `retargetConnectedGlides` (pure, glideMath, tested): each connected `endPitch` is pinned to its prev-resolved target's post-edit pitch while the pair stays adjacent; commits whose updates explicitly carry a `glide` key (`'glide' in u` — claw-delete sends `glide: undefined`) are never overwritten; adjacency broken → untouched degrade.
- **Chain events**: connected runs compile to ONE event `{ time, note: head, duration: totalTicks, velocity: headVel, glide: { segments } }`; consumed members emit nothing (that IS the legato — never re-attack them). Plain events carry no `glide` key; `makePartCallback`'s hot path pays exactly one `ev.glide !== undefined` check. Chains unroll whole per loop iteration; clipping truncates the straddling segment mid-flight (`fullDurTicks`).
- **Synth family = per-region mono-voice pools** (`makeGlideVoice` via `voiceSpecFor` — PolySynth exposes no per-voice detune, and per-instrument detune can't do per-note chord glides). The glide scheduler is the SINGLE writer of a pool voice's `detune`/`volume`. Cap 8/region (4 reduced quality), oldest-stolen, lazy; disposed on region removal / instrument change / unmount; envelope-synced by effect 3c; **`silenceAll` must cancel scheduled detune/volume curves** or a seek-resume replays stale ramps.
- **Sampler family** rides the captured `_activeSources` buffer source: `playbackRate = r0·2^(cents/1200)` curves; `triggerRelease(head, chainEnd)` scheduled BEFORE the gain crossfade ramps (`stop()` runs `cancelStop`, which wipes gain events); crossfade window clamped inside (attack end, stop − ε). Chains longer than the sample truncate at buffer end (accepted; same private-API fallback as the ghost-note fix).
- **Curves are sampled, never stepped**: `planGlideSegments` (pure, shared live + offline) emits ≥64-point cents arrays for `setValueCurveAtTime`; under tempo ramps each sample's musical position goes through `measureAtSeconds` (exact). The SVG bezier (control `cy = y0+(y1−y0)(0.5+tension/2)`) traces exactly the audio's `g(u) = u + tension·u(1−u)` — keep them in lockstep (the mid-x identity is tension-independent). Tension range = ±`TENSION_LIMIT` (2): monotone only for |t| ≤ 1; beyond that the curve intentionally overshoots the target / dips below the source (max 12.5% of the span at ±2). Old builds clamp ±2 saves to ±1 via `sanitizeGlide` (accepted).
- UI: glide drags mutate SVG attributes only (geometry stamped on each `<g>`); connect-on-drop resolves at mouseup (drag-away disconnects); claw Delete uses a CAPTURE-phase keydown that `stopPropagation()`s past the shell's bubble-phase note-delete. Right-click **anywhere in the grid** (empty space, SVG anchors, curves — all bubble to the grid's `onContextMenu`; note bodies/claws stopPropagation with their own handlers) opens the note menu for the current selection in every tool mode. **Click-away-deselect exemptions:** the piano roll's capture-phase window-mousedown deselect (`onDocDown`) only spares `[data-note-id]`, the bare grid, and `[data-no-note-deselect]` — the glide `<svg>` root and the ContextMenu root carry the opt-out attr, or handle grabs / menu-button presses wipe the selection before their own handlers run (React stopPropagation can't stop a window capture listener). **Menu commands act on `menuNoteIdsRef`** — ids snapshotted at menu OPEN (same snapshot feeds `computeGlideFlags`), never the live selection ref at click time. Handle hit targets are invisible r=8 twins sharing the visible circles' `data-glide-*` attrs (`redrawGlideNote` uses `querySelectorAll`). Chord→chord Connect pairing = pure `planChordConnections` (glideMath, tested): group by (regionId, end tick), both sides pitch-descending, pair top→top; candidates include unselected notes. Drums are excluded (tool disabled + compiler/callback gates).

### Workstation export (`audioBounce.js` / `audioExport.js`)
`bounceProject({ tracks, regions, notes, bpm, tailSec = null, capSec = Infinity })` → `{ buffer, firstOnsetSec }`. Render duration = rightmost region end + tail, hard-capped at `capSec` (callers pass `totalMeasures * 4 * 60/bpm` — the growable right stop). `tailSec: null` means auto: `estimateFxTailSec` bounds the ring-out from audible tracks' non-bypassed delay (−60 dB through the feedback loop) and reverb (`1 + roomSize*9` s heuristic), clamped to [2, 30] s. `firstOnsetSec` = earliest note onset across **audible** tracks (analytic, from `buildRegionEvents` ticks), or `null` when nothing audible is scheduled. Both export paths (`handleExportAudio`, `exportTrack`) then call `trimExportBuffer(buffer, { startSec: firstOnsetSec })` (`audioExport.js`): drops everything before the first onset and trailing silence after the last sample above −80 dBFS peak (+0.25 s pad); returns `null` → "nothing to export", no file. **Start-trim is analytic, never a front signal-scan** — a threshold scan would eat `fadeInFloor: 0` fade-ins and slow attacks. `exportWAV`/`exportMP3` stay whole-buffer and untrimmed (RecordModal depends on them as-is).

### Drum kits (`drumKits.js`)
Three Tone.Sampler kits (`drums acoustic` / `drums 808` / `drums electro`), registered by `Object.assign`-merging `DRUM_KITS` into `SAMPLED_INSTRUMENTS` — so `isSampledInstrument`/`makeSynth`/loading-"…"/bounce `Tone.loaded()` all work with zero extra wiring. **`SAMPLED_MELODIC_NAMES` (captured pre-merge) feeds the dropdown's "sampled" optgroup; drums get their own optgroup** — using `SAMPLED_INSTRUMENT_NAMES` there would double-list. Shared key layout: C4 kick (+alts down white keys B3→C3), E4/D4 snares, F4/A4/C5 toms (**G4/B4 deliberately unmapped** — Sampler repitches from the nearest mapped key, 5 tom keys from 3 samples), C#5/D#5 closed/open hat, F#5/G#5/A#5 cymbals, D5/E5/F5 bonus percussion. Two drum-specific behaviors, applied at ALL THREE trigger sites (live `makePartCallback`, offline `audioBounce` Part callback, RegionEditor preview): **(1) one-shot** — skip the note-end `triggerRelease`; the ToneBufferSource self-stops at buffer end, so drawn note length never truncates a cymbal (this is also why `estimateFxTailSec` adds a 6 s floor for audible drum tracks); **(2) hi-hat choke** — `chokeTargetsFor(note)` (data-driven `DRUM_CHOKE_GROUPS = [['C#5','D#5']]`) is `triggerRelease`d immediately before every attack; safe no-op when nothing rings (Sampler.triggerRelease guards on `_activeSources`). The kit `release: 0.05` doubles as the choke fade (baked into each source's `fadeOut` at attack). Preview also skips `releaseAll()` for drums (one-shot audition) — gated through `instrumentRef` because the window-mouseup closure mounts once. Samples are vendored m4a (AAC) in `public/samples/drums-*/` with per-folder `CREDITS.txt` (acoustic/electro = Sonic Pi CC0; 808 = Music Machines archive); electro tom-low/high are varispeed repitches generated at asset-build time.

### Instrument-tab performance UI (`RegionEditor/InstrumentPanel.jsx`)
Drum kits get a clickable SVG drum kit + alt-pad strip (`DrumKitPanel`), melodic instruments a **transposing 2-octave keyboard** (`KeyboardPanel`) plus a **control chassis**; both share `InstrumentPanel.module.css` and the **single QWERTY window listener owned by `InstrumentPanel`**. Audio goes through the hook's **audition API** (`auditionAttack/auditionRelease/auditionReleaseAll/auditionPrime` from `useWorkstationAudio`): a per-track synth cached by trackId, connected to the track's `volume` Gain — that node's `volume → pan` output edge is **never** rewired by effect 1b, so audition rides `volume → pan → FX → mute` with zero rewiring. The RegionEditor piano-roll previews (side keys, grid placement, note grab) use this same API — its old Destination-routed `previewSynthCache` is gone; a priming effect (`auditionPrime` on `[track?.id, track?.instrument]`) starts sampler downloads on editor open. During a note drag (`move` mode), crossing a key row releases the old pitch and attacks the new one (pitch-change gate on `dD.lastAuditionedNote` = the throttle). Drum choke + one-shot live *inside* `auditionAttack`/`auditionRelease` so every caller gets them. Sampled audition synths join the loading bookkeeping under the synthetic key `'audition:<trackId>'` in `loadingRegionsRef` (values are trackIds, so the indicator derivation just works). Audition synths are hard-cut by `silenceAll` (shared `hardCutSynth`) but are NOT touched by its layer-2 fade ramp — audition stays usable right after a stop. Guards on the listener: `e.repeat`, meta/ctrl/alt passthrough, text-input focus, and `rootRef.offsetParent === null` (Root keeps pages mounted `display:none`) — the same guard was **added to MoogModular `KeyboardModule`**, whose window key listener previously played the hidden Moog from other pages.

**Keyboard & QWERTY.** `KeyboardPanel` geometry is a function of `octaveBase` (`buildKeyboard(octaveBase)`, memoized) so the whole 2-octave window **transposes** — `data-note` carries the real notes and all press/flash visuals are direct DOM on `[data-note]`. `octaveBase` (clamp `MIN_OCT=1 … MAX_OCT=7`) is **the only React state in the panel**. QWERTY: melodic = the extended chromatic map `a w s e d f t g y h u j k o l p ; ' ]` (home row = white keys, top row = black; `[` is the E–F no-black-key skip), `z/x` shifts octave; drums = piece hotkeys **filtered to the kit's `urls`** (a chromatic map would repitch unmapped keys). Keys are theme-aware "juicy" (gradient/3D + press-depression). The keyboard fills the tab and its width (`min(1100px, 95%)`) is **decoupled from the chassis** because `.content` fills the panel (child widths are panel-relative, not shrink-wrapped to the widest sibling).

**Control chassis** (reuses `RegionEditor/RotaryKnob.jsx` + a local `toKnob/fromKnob` mirroring `EffectsRack`): **Master** (Volume → `onVolumeChange` = `handleVolumeChange`, shares `track.volume` with the header slider) · **Envelope** (A/D/S/R for synths, A/R only for sampled melodic — Sampler has no decay/sustain) · **Pitch** (octave stepper). **Drum kits render no chassis** (volume lives in the track header; ADSR/octave don't apply).

**Per-track ADSR override (`track.envelope`).** Optional `{ attack, decay, sustain, release }` — absent = the instrument default. `synthFactory.js` owns the truth: `SYNTH_ENVELOPES` lookup, `defaultEnvelopeFor(instrument)` (drums → `null`; sampled → `{attack, release}` only), `applyEnvelope(synth, env)` (PolySynth `.set({envelope})` vs Sampler `.attack`/`.release`), and `makeSynth(instrument, { envelope })`. Applied at every synth build (region + audition + offline `audioBounce.js`) and kept live by **envelope-sync effect 3c** in `useWorkstationAudio.js` (object-reference compare like FX params, `appliedEnvByTrackIdRef`): on change it `applyEnvelope`s the audition synth **and** every region synth on the track — no rebuild. `WorkstationShell.handleEnvelopeChange` merges partial edits (seeded from `defaultEnvelopeFor` on first touch → one undo entry per drag via the burst-coalescer); `handleInstrumentChange` **clears** the override so knobs snap to the new instrument's defaults. Persisted additively in `projectIO.js` (`deserializeEnvelope`; **`SCHEMA_VERSION` intentionally NOT bumped** — old `.voxdaw` files load fine).

### Sampler ghost notes (`useWorkstationAudio.js`) — private Tone API
`Tone.Sampler.triggerAttackRelease` empties `_activeSources` at schedule time and pre-schedules `stop()` at absolute audio time, so Part-scheduled sampler notes are invisible to `releaseAll()` (→ ghost notes surviving pause/stop/seek). Fix: `makePartCallback` splits sampler notes into `triggerAttack(t)` → capture the new `ToneBufferSource`s from **private `Sampler._activeSources`** (verified on Tone 15.1.22) into `liveSamplerSourcesRef` (self-pruning Set via wrapped `onended`) → `triggerRelease(t + duration)`; `silenceAll` layer 0 re-stops every tracked source at `Tone.now()` with a hard-cut fade. There is a graceful fallback if `_activeSources` disappears, but it **silently reintroduces the ghost-note bug — re-verify on any Tone.js version bump**.

### Workstation per-track insert effects (`effectDefs.js` / `fxChain.js`)
`track.effects` = `[{ id, type, bypass, params }]`, **array order = signal order**. Registry `effectDefs.js` (`EFFECT_DEFS`: filter/delay/reverb/doubler/autofilter/autowah/eq/distortion/compressor/phaser/bitcrusher/tremolo/vibrato/widener/pitchshift/autopanner, param metadata incl. `kind: 'toggle'`/`'select'`); DSP factory `fxChain.js` (`makeFxGraph` → uniform `{ in, out, apply, dispose }` per type; `makeFx` wraps with **click-free bypass** via complementary 0.05s gain crossfade — the `setArpFx` pattern). Live chain sits at `pan → [FX] → mute` in `useWorkstationAudio.js` (effects 1b structural / 1c bypass / 1d params — 1b is the **only** post-creation writer of pan's output; params delta-check by object reference). Mirrored offline in `audioBounce.js` (non-bypassed only, back-to-front via `makeFxGraph`). Delay is a composite (FeedbackDelay `wet:1` + parallel `dryLvl`/`wetLvl` gains) so `dryThru` pins dry at unity with zero topology change. **Ranges are load-bearing:** delay time ≤ 1.0s (`maxDelay: 1` — rampTo above throws), feedback ≤ 0.9, roomSize ≤ 0.95. Chorus/AutoFilter/Tremolo/AutoPanner need `.start()` (Vibrato/Phaser auto-start their LFOs); `Chorus.depth`/`octaves`/`Tremolo.spread`/`PitchShift.pitch`+`windowSize` are plain setters (not rampable) — the applier handles both kinds.

### Workstation CPU: render-graph pruning + performance quality (`useWorkstationAudio.js` / `fxChain.js`)
The Web Audio render thread only processes nodes transitively connected to the destination — disconnecting a subtree at one point stops ALL of it (synths, fades, FX incl. always-running LFOs and feedback loops) from costing CPU. Three mechanisms exploit this:

- **Mute/solo (effect #2, still the single writer of the mute node):** inaudible tracks ramp to 0 (20ms) then **disconnect the mute node from Destination** after 50ms (`muteConnByTrackIdRef` `{connected, timer}`); reconnect happens while the gain is still 0, then ramps up — click-free both ways. Effect #2 also writes `audibleByTrackIdRef`, read by `makePartCallback` at fire time to **skip triggering notes on inaudible tracks** (trackId looked up LIVE via `appliedRegionStateRef` — a build-time capture would go stale because region drags don't rebuild Parts). Trade-off: unmuting mid-note waits for the next onset. Timers cleared on track removal (effect #1) and unmount.
- **Activity pruning (lossless, ALL quality tiers):** an *audible* track with no notes sounding is also disconnected — otherwise 17 audible tracks cost 17 tracks' worth of FX even when 6 have notes. `estimateTrackTailSec(track)` (exported; shared with `audioBounce.estimateFxTailSec`) bounds the ring-out (synth release + drum 6s floor + non-bypassed delay/reverb decay to −60 dB, clamp [2, 30]); cached in `tailByTrackIdRef`. Every note fire (`noteLifecycleRef.onNoteScheduled` in `makePartCallback` — runs BEFORE the sampler load guard on purpose) and every audition attack/release calls `connectTrack` + bumps `activeUntilByTrackIdRef` to `noteEnd + tail`. A **1 Hz sweeper** (effect 2b) disconnects connected+audible tracks past their window, guarded by `synthIsRinging` (PolySynth `activeVoices` / Sampler private `_activeSources` — covers held audition notes). Reconnect is click-free: idle-pruned gain sits at 1 and frozen FX content is ≤ −60 dB by construction; Part callbacks fire `lookAhead` ahead of the audible moment, so the reconnect always lands first. `connectTrack` is audibility-gated (mute/solo connection state stays effect #2's territory); the sweeper skips inaudible tracks for the same reason. Wall-clock based → an idle/paused project falls to near-zero audio CPU.
- **FX bypass = real prune (`makeFx`):** after the 0.05s crossfade, a 70ms timer disconnects `graph.out` from `onGain` (internal LFOs feed params of unreachable nodes → not rendered); un-bypass reconnects **before** ramping. Created-bypassed wrappers start pruned. *Accepted limitation:* delay/reverb buffers freeze while pruned, so un-bypass can briefly replay a stale tail at wet level.
- **Performance quality (transport `QUALITY` select):** `performanceQuality` state in `WorkstationShell`, persisted to localStorage (`voxdaw.performanceQuality`) — machine capability, **never** enters `.voxdaw`/undo. `high` = default behavior. `medium` = PolySynth `maxPolyphony` 32→12 (`REDUCED_MAX_POLYPHONY`; applied live by quality-sync effect 3d + at build time via `perfQualityRef` → `makeSynth({ maxPolyphony })`; Samplers skipped) + `Tone.getContext().lookAhead` 0.1→0.2s (scheduling headroom against the main-thread-starved "plays nothing" failure; context-global — adds VoxTool gesture latency while reduced). `low` = medium + force-bypass of `HEAVY_EFFECT_TYPES` (`effectDefs.js`: reverb/pitchshift/doubler/autofilter/autowah/phaser/tremolo/vibrato/autopanner). Effective bypass (`e.bypass || low && heavy`) is computed in effects **1b** (wrapper creation + seed — a structural rebuild under low never momentarily runs a heavy effect) and **1c** (`[tracks, performanceQuality]`); `track.effects` state is never mutated, so leaving low restores user bypass states in the same pass. EffectsRack grays blocked module bodies (`.bodyBlocked` + "increase sound quality to enable …" notice); header (bypass/×) stays interactive.
- **Hidden-page visual rAF loops** (Moog FFB/vocoder LED meters, VocoderTerminal spectrum) early-return on `offsetParent === null`. The Moog **TRANSPOSE CV loop is deliberately NOT gated** — it drives the worklet root and must keep running while the Moog plays hidden.

### Global tempo automation & track groups (Phases 144–146, `tempoMath.js` / `useWorkstationAudio.js` / `WorkstationShell.jsx` / `audioBounce.js`)
`recomputeTempo` (hook) is the single steady-state writer of `Transport.bpm` (shell `previewTempo` is the transient drag-preview exception — gated to a NON-RUNNING transport so a held point never stomps the playing curve; the mouseup commit re-anchors); pure `tempoMath.buildTempoMap` is the measures↔seconds source of truth (`tempoMapRef`), consumed by fades, automation, Part durations, and bounce. **Re-anchoring MUST use `cancelAndHoldAtTime`, never `cancelScheduledValues`:** `Transport.ticks` is the integral of the bpm curve — a plain cancel mid-ramp rewrites the already-played curve, so the musical position jumps (notes re-fire at the edit spot) and TickParam's tick bookkeeping corrupts into the `TickSource.getTicksAtTime` "reading 'time' of undefined" crash (which leaks a temp state event and keeps crashing until reload). Ordinary Params don't integrate ticks — their plain-cancel re-anchor pattern stays. Unmount cleanup restores flat base bpm AFTER `Transport.stop()`. **Second invariant: never two differing-value bpm events at one timestamp** — `TickParam.getTimeOfTick` reads a ramp's endpoint via last-wins `getValueAtTime(after.time)`, so a step (`set`) sharing a ramp's end time makes it solve the wrong quadratic (NaN on downward steps → same crash). All bpm scheduling goes through **`tempoScheduleOps`** (`tempoMath.js`, unit-tested, shared live + bounce): strictly increasing times — ramp to the FIRST stacked-point value at its true time, `set` each next value `TEMPO_STEP_EPS` (1 ms) later; the re-anchor set sits at `baseTime + eps` (clear of cancelAndHold's internal same-time pair).

Groups: per-group chain `memberMutes → groupIn → groupVolume → groupPan(inert, 0) → [group FX] → groupMute → Destination`. **Group pan (knob AND automation lane) is a member OFFSET, never a bus pan:** effective member pan = `clampPan(track.pan + group.pan)` written on the MEMBER panners (#3b manual path; `resolveAutomationTarget`/bounce `panEntries` for lanes, one entry per member with the base baked in — a member's own pan lane wins). `track.pan` is never mutated, so a wall-pinned member returns to its own value when the group un-pans. The bus `Panner` survives only as effect 1b's FX-splice head. Grouped members carry `groupId:pan` in effect 1e's chanKey (knob turn re-bases scheduled group-lane ramps); release-restore clears MEMBER panApp entries. Effect #3e syncs group volume only.

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
