import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';

// Sequencer pitch range — same as VCO FREQ knob (C1–C6)
const SEQ_HZ_MIN  = 32.703;
const SEQ_HZ_MAX  = 1046.502;
const VCO_IDS     = ['vco1', 'vco2', 'vco3', 'vco4', 'vco5'];
// Dynamic instance-id prefixes that differ from their type name (jack-prefix
// compatibility with the static modules: reverb2-in, chorus2-in).
const DYN_ID_PREFIX = { rev: 'reverb', bbd: 'chorus' };

// ── VOWEL / FORMANT module (Phase 64) ──
// A 3-formant resonant filter bank (F1/F2/F3 parallel bandpass) that colours a
// raw signal into a vowel. Center frequencies (Hz) are the classic male-voice
// formant table for the five primary vowels; the VOWEL knob morphs between
// adjacent columns, SHAPE scales all three (vocal-tract length), and a
// FORMANT-CV input offsets the morph. Per-formant Q + relative gain are fixed
// (F1 dominant, giving the vowel its perceived body).
const VOWEL_ORDER = ['A', 'E', 'I', 'O', 'U'];
const VOWEL_FORMANTS = {            // [F1, F2, F3] Hz
  A: [730, 1090, 2440],
  E: [530, 1840, 2480],
  I: [270, 2290, 3010],
  O: [570, 840,  2410],
  U: [300, 870,  2240],
};
const VOWEL_Q    = [11, 13, 15];    // per-formant resonance (higher = more vocal)
const VOWEL_GAIN = [1.0, 0.55, 0.28]; // F1 loudest → down to F3
// morph position (0..4) → interpolated [F1,F2,F3]
function vowelFreqsAt(pos) {
  const p  = Math.max(0, Math.min(4, pos));
  const i  = Math.min(3, Math.floor(p));
  const f  = p - i;
  const a  = VOWEL_FORMANTS[VOWEL_ORDER[i]];
  const b  = VOWEL_FORMANTS[VOWEL_ORDER[i + 1]];
  return [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * f);
}

// DIRECT morph (Phase 75) — interpolate straight between TWO chosen vowels instead of
// walking the A→E→I→O→U chain. This is the whole point of the mode: vowelFreqsAt treats
// the five vowels as an ordered ROAD, so travelling U→A necessarily drives back through
// O, I and E — halfway through it is literally sounding the vowel I. Blending the two
// endpoints' formant triples directly means the sweep only ever contains shades of the
// two vowels you picked (U→A at 50% = 515/980/2340, which is between them and is not
// any other vowel). `from`/`to` are indices into VOWEL_ORDER; t is 0..1.
function vowelFreqsBetween(from, to, t) {
  const a = VOWEL_FORMANTS[VOWEL_ORDER[Math.max(0, Math.min(4, from))]];
  const b = VOWEL_FORMANTS[VOWEL_ORDER[Math.max(0, Math.min(4, to))]];
  const u = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * u);
}

// ── Kick CLICK TONE (Phase 80) ──
// The click transient's highpass was hardcoded at 2 kHz. Exposing it costs no new nodes
// and spans soft mallet thud → sharp beater snap. The range is built around the old
// value so knob CENTRE is exactly 2000 Hz and saved racks are unchanged: ratio 36 gives
// √36 = 6, so min = 2000/6 and max = 2000×6.
const KICK_CLICK_MID_HZ = 2000;
const KICK_CLICK_RATIO  = 36;                                   // 333 Hz … 12 kHz
const KICK_CLICK_MIN_HZ = KICK_CLICK_MID_HZ / Math.sqrt(KICK_CLICK_RATIO);
const kickClickToneHz = (k) =>
  KICK_CLICK_MIN_HZ * Math.pow(KICK_CLICK_RATIO, Math.max(0, Math.min(1, k)));

// ── Kick TUNE CV (Phase 80) ──
// This rack's pitch CVs are Hz-domain, not volts — every pitch out (960, quantizer,
// chord seq, keyboard) emits the frequency itself, which is what the VCOs' glideBus
// consumes. So the kick's TUNE CV is Hz-domain too: the patched signal's VALUE becomes
// the drum's fundamental, which is what makes sequenced tom fills and melodic drums
// work. With a cable present the TUNE knob stops being an absolute pitch and becomes a
// TRANSPOSE around it, exactly as a VCO's FREQ knob does against its CV — so neither
// control goes dead. Centre of the TUNE knob (40·√5) is unity transpose.
const KICK_TUNE_CENTER_HZ = 40 * Math.sqrt(5);   // ≈ 89.4 Hz, the TUNE knob's midpoint
const KICK_TUNE_MIN_HZ = 20;                     // clamp: a sub-20 Hz "kick" is just a thud
const KICK_TUNE_MAX_HZ = 2000;

// Engagement is CABLE-driven, not level-driven: a patched-but-idle pitch source reads
// 0, which is indistinguishable from no cable (the isLfoSync / FFB-sweep reasoning).
// Resolved at trigger time rather than cached — a kick fires a few times a second, so
// the scan is free next to a connect/disconnect invalidation surface.
function kickTuneHz(n, kid, connections, knobHz) {
  let patched = false;
  const suffix = `\u2192${kid}-tune-cv`;
  for (const k of connections.keys()) { if (k.endsWith(suffix)) { patched = true; break; } }
  if (!patched) return knobHz;
  const buf = n[`${kid}TuneCvAnalyser`]?.getValue();
  if (!buf || !buf.length) return knobHz;
  const cvHz = buf[buf.length - 1];
  if (!(cvHz > 0)) return knobHz;                       // source silent this instant
  const hz = cvHz * (knobHz / KICK_TUNE_CENTER_HZ);     // knob becomes transpose
  return Math.max(KICK_TUNE_MIN_HZ, Math.min(KICK_TUNE_MAX_HZ, hz));
}

// ── Percussion trigger hygiene (Phase 79) ──
// Tone's monophonic voices are Sources, and `Source.start()` asserts
// "Start time must be strictly greater than previous start time" — so two triggers
// landing on one kick instance at a non-increasing time throw and kill the step loop.
// Two ways that happens here, one of them trivially reachable:
//   1. The manual TRIG button fires at `Tone.now()`, while the sequencer schedules
//      lookAhead (~0.1 s) INTO THE FUTURE. Clicking TRIG while a step is already
//      pending is therefore in the PAST relative to it — a guaranteed throw, not a
//      rare race. (MOOG_PLAN logged this class as a heavy-load-only race; it isn't.)
//   2. Under a main-thread stall the step loop itself can fall behind its own last
//      scheduled time.
// Clamping strictly forward makes both harmless: a hit that would land in the past is
// nudged 1 ms past the previous one, which is far below audibility on a drum.
const KICK_MIN_GAP_S = 0.001;
function nextKickTime(lastMap, kid, time) {
  const t = Math.max(time, (lastMap[kid] ?? 0) + KICK_MIN_GAP_S);
  lastMap[kid] = t;
  return t;
}

// Run a visual callback AT an audio time rather than when it was scheduled. Tone's own
// docs on Draw: Transport callbacks "always happen _before_ the scheduled time and are
// not synchronized to the animation frame so they are not good for triggering tightly
// synchronized visuals and sound". Step loops fire lookAhead ahead of the audible
// moment, so LEDs driven straight from them lead the sound by ~100 ms — 40% of an
// eighth note at 120 BPM, plainly visible. Falls back to calling immediately if the
// context has no Draw, so the worst case is today's behaviour rather than a throw.
function drawAt(time, fn) {
  try {
    const d = Tone.getDraw?.();
    if (d?.schedule) { d.schedule(fn, time); return; }
  } catch (_) { /* fall through */ }
  fn();
}

// ── Pitch-CV origin resolution (Phase 76) ──
// A 960's rest steps mute the VCOs it drives, and that mute keys on JACK IDENTITY:
// `vcoActiveCvRef[vcoId] === 'seq-pitch-out'`. Patch the 960 straight into a VCO and
// that matches. Route it through a quantizer or chord sequencer first and the VCO's
// active CV becomes `qnt-cv-out` / `chordseq-cv-out`, which never matches — so off-steps
// silently stopped muting and the note droned through every rest (Dylan-reported).
//
// These two module types PASS a pitch CV through, so their output can be walked back to
// whatever feeds their input. Anything else terminates the walk. Keep this list to real
// pitch-CV processors: it decides what counts as "the same note travelling onward".
function cvPassthroughInput(jackId) {
  const q = jackId.match(/^(qnt\d*)-cv-out$/);
  if (q) return `${q[1]}-cv-in`;
  const c = jackId.match(/^(chordseq\d*)-(cv|root|3rd|5th)-out$/);
  if (c) return `${c[1]}-cv-in`;
  return null;
}

// Walk a VCO's immediate CV source back to the jack that originated it.
// `connections` is the live connectionsRef map (keys are `from→to`).
// Terminates at a non-pass-through jack, at an unpatched pass-through input (that
// module is then the origin — e.g. a chord seq running its own program), or at the
// hop guard, which also makes a cable cycle harmless.
function resolveCvOrigin(jackId, connections) {
  let cur = jackId;
  for (let hop = 0; hop < 4; hop++) {
    const inJack = cvPassthroughInput(cur);
    if (!inJack) return cur;
    let feeder = null;
    for (const key of connections.keys()) {
      const i = key.indexOf('\u2192');
      if (i !== -1 && key.slice(i + 1) === inJack) { feeder = key.slice(0, i); break; }
    }
    if (!feeder) return cur;
    cur = feeder;
  }
  return cur;
}

// ── LFO free-run rate range (Phase 70) ──
// RATE knob 0..1 → Hz, exponentially. Widened from the original 0.1–30 Hz (×300):
// the low end now reaches genuinely slow evolving sweeps (0.01 Hz = a 100-second
// cycle, matching MOOG_ARCHITECTURE §2's spec) and the top crosses into audio rate
// for FM/growl territory. The ×10000 span lands on a decade per quarter-turn
// (0.01 / 0.1 / 1 / 10 / 100 Hz), which keeps a knob this wide readable.
// SYNC mode is unaffected — it stores the raw 0..1 knob in lfoRateRefs and maps it
// to LFO_SYNC_DIVS, never to Hz.
// ── 914 FFB sweep (Phase 70) ──
// SWEEP CV moves a resonant gain hump across the 14 bands: a filter-bank formant
// sweep. FLOOR is how far the off-centre bands duck (0 would mute everything but the
// hump); SIGMA is the hump width in band indices.
const FFB_SWEEP_FLOOR = 0.10;
const FFB_SWEEP_SIGMA = 2.2;

// ── Reverb (Phase 70) ──
// ROOM is CLAMPED: Tone.Freeverb wires roomSize straight to the feedback gain of its
// eight parallel comb filters (`roomSize.connect(lowpassCombFilter.resonance)`), so at
// 1.0 the feedback hits unity — the tail never decays and the combs sum into a runaway
// build-up. 0.95 is the same cap the Workstation's effectDefs uses and the value
// CLAUDE.md lists as load-bearing. Unclamped ROOM was a real bug, not a hypothetical.
const REV_MAX_ROOM = 0.95;
// DAMP → Freeverb `dampening`: the lowpass inside each comb, i.e. how fast the tail
// loses its highs. Dark/distant hall → bright/splashy plate.
//
// TWO HAZARDS, both learned the hard way — do not "simplify" this:
//
// 1. STABILITY CEILING. `dampening` reaches OnePoleFilter, whose lowpass coefficients
//    are a0 = 2π·f/sr and b1 = a0 − 1, fed to createIIRFilter([a0,0],[1,b1]). A one-pole
//    IIR is stable only while |b1| < 1, i.e. **f < sr/π** (≈14 kHz at 44.1 kHz). Above
//    that the filter diverges, NaN floods the comb FEEDBACK loop, and the whole
//    AudioContext dies — audio stops rack-wide and only a page reload recovers it.
//    An 18 kHz ceiling shipped briefly and did exactly that. Cap at 70% of the limit.
// 2. EVERY WRITE REBUILDS NODES. OnePoleFilter.frequency's setter calls _createFilter(),
//    which disposes and re-creates its IIRFilter and re-wires the graph — ×8 comb
//    filters per write. Writing it per knob-frame is a continuous teardown/rebuild
//    storm that sounds like loud scratching. Hence the debounce in scheduleRevDamp:
//    a continuous drag must produce ZERO writes until the knob settles.
const REV_DAMP_MID_HZ    = 3000;  // Freeverb's original fixed value — pinned to knob centre
const REV_DAMP_DEBOUNCE_MS = 120;
// Range adapts to the device sample rate; the midpoint stays exactly 3000 Hz by
// construction, so a centred DAMP knob is byte-identical to the pre-knob behaviour.
function revDampRange() {
  const sr  = Tone.context?.sampleRate || 44100;
  const max = Math.min(12000, (sr / Math.PI) * 0.7);
  return { min: (REV_DAMP_MID_HZ * REV_DAMP_MID_HZ) / max, max };
}
function revDampHz(d) {
  const { min, max } = revDampRange();
  return min * Math.pow(max / min, Math.max(0, Math.min(1, d)));
}

// ── BBD chorus (Phase 70) ──
// The module is now a COMPOSITE, not a bare Tone.Chorus:
//   ${id}In ─┬─────────────────────────► ${id}Dry ──┐
//            └─► ${id} (Chorus, wet 1) ─► ${id}Tone ─► ${id}Wet ─┴─► ${id}Out
// Reason: the BBD colour filter must sit on the WET path only. Tone.Chorus's own
// dry/wet is internal, so a filter after it would darken the dry signal too. The
// Chorus therefore runs 100% wet and MIX crossfades the two external gains — the
// same composite shape the Workstation's delay uses for its dry-through.
// FEEDBACK is HAND-BUILT, not Tone.Chorus's internal `feedback` (which is left at 0).
// Tone's loop is a bare gain: nothing damps the resonance as it recirculates and nothing
// stops low frequencies accumulating, so at high settings the comb peak — which tracks
// delayTime, ≈190–560 Hz at DELAY 3.5 ms / DEPTH 0.5 — sings as a low bee-like hum, one
// per channel offset by the 180° stereo spread. Real BBDs band-limit INSIDE the loop.
// So the return path is Tone(lowpass) → FbHp(highpass) → Sat(tanh) → Fb(gain) → chorus
// input: the TONE filter is now in-loop, a highpass kills the mud buildup, and the tanh
// bounds any runaway. Same reasoning as CHRONOS's hand-built loop (MOOG_ARCHITECTURE §15).
const BBD_MAX_FEEDBACK = 0.9;   // feedback loop — same runaway class as reverb roomSize
const BBD_FB_HP_HZ     = 120;   // trims sub-bass from the recirculating signal only
// LOAD-BEARING: an explicit Delay must sit in the return path. Web Audio MUTES any
// cycle that contains no DelayNode, and Tone.Chorus has an internal DRY branch
// (input → CrossFade → output) with no delay in it — so routing feedback into the
// chorus input creates a delay-free cycle and Chrome silences the entire loop. The
// wet path goes dead: MIX just fades the dry away and every wet-side knob does
// nothing. Cycle detection is topological, so wet:1 muting that branch does NOT
// help. 5 ms clears one render quantum (2.9 ms @44.1k) at every sample rate.
const BBD_FB_DELAY_S   = 0.005;
// DELAY: knob 0..1 → 2–20 ms (Tone's documented nominal range). Default knob 0.25
// ≈ 3.56 ms, matching the 3.5 ms the module was fixed at before the knob existed.
const bbdDelayMs = (d) => 2 * Math.pow(10, Math.max(0, Math.min(1, d)));
// TONE: the bucket-brigade voice — real BBD chips lose their top end badly, and that
// dark blur is the whole character. knob 0..1 → 700 Hz … 14 kHz.
const bbdToneHz  = (t) => 700 * Math.pow(20, Math.max(0, Math.min(1, t)));

// ── Quantized FM (Phase 70) ──
// When a quantizer drives a VCO's CV and an LFO is patched to that VCO's FM jack,
// the modulation is snapped to the quantizer's scale instead of sliding through it
// (see qntFmTick). Full modulator swing (±1) = ±QNT_FM_SEMITONES around the FREQ
// knob — one octave each way, matching the quantizer worklet's own modulation mode.
const QNT_FM_SEMITONES = 12;
// Above this the 60 Hz rAF can't resolve the modulator's shape, so quantized FM
// disengages and the direct audio-rate FM path takes back over — the fast end of the
// RATE knob keeps its smooth FM growl rather than degrading into aliased stepping.
const QNT_FM_MAX_HZ = 10;

const LFO_RATE_MIN_HZ = 0.01;
const LFO_RATE_SPAN   = 10000;   // × from min → 100 Hz at the top of the knob
const lfoRateHz = (rate) =>
  LFO_RATE_MIN_HZ * Math.pow(LFO_RATE_SPAN, Math.max(0, Math.min(1, rate)));

// ── LFO tempo-sync (Phase 65) ──
// When a clock is patched into an LFO's SYNC jack, the RATE knob stops setting a
// free Hz and instead quantizes to one of these musical divisions — `beats` = how
// many quarter-note beats one full LFO cycle spans (4 beats = 1 bar in 4/4). The
// synced value is computed deterministically from Transport.seconds in a rAF
// (Tone.LFO.sync() proved NOT phase-repeatable in v15.1.22 — 0.28 phase error).
const LFO_SYNC_DIVS = [
  { id: '4m', label: '4 BAR', beats: 16 },
  { id: '2m', label: '2 BAR', beats: 8  },
  { id: '1m', label: '1 BAR', beats: 4  },
  { id: '2n', label: '1/2',   beats: 2  },
  { id: '4n', label: '1/4',   beats: 1  },
  { id: '8n', label: '1/8',   beats: 0.5 },
];
// RATE knob 0..1 → division (low = slow/4-bar, high = fast/eighth).
function lfoDivForRate(rate) {
  const i = Math.min(LFO_SYNC_DIVS.length - 1, Math.max(0, Math.floor((rate ?? 0.3) * LFO_SYNC_DIVS.length)));
  return LFO_SYNC_DIVS[i];
}
// Unit LFO waveform, phase 0..1 → −1..+1 (matches the four output-jack shapes).
function lfoWaveValue(type, phase) {
  switch (type) {
    case 'square':   return phase < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * phase - 1;
    case 'triangle': return phase < 0.5 ? (4 * phase - 1) : (3 - 4 * phase);
    default:         return Math.sin(2 * Math.PI * phase); // sine
  }
}

// 914 Fixed Filter Bank — 14 bands: LP shelf + 12 bandpass + HP shelf.
// Frequencies spaced at √2 intervals (2 bands/octave), authentic to the Moog 914.
// LP/HP use shelf filters; bandpass uses BiquadFilter(bandpass) → Gain (parallel sum).
// Live sample rate for UI analyser bin math. Hardcoding 44100 mis-maps every bin on a
// 48 kHz device (the common default on modern Macs), so meters light the wrong bands.
export const moogSampleRate = () => Tone.context?.sampleRate || 44100;
// Tone.Analyser('fft', N) sets the underlying analyser's fftSize to N*2 and returns N
// bins, so a bin spans sampleRate / (N*2) Hz — NOT sampleRate / N. Getting this wrong
// puts every reading a full octave off. Both LED meters derive their bin width here.
export const fftBinHz = (bins) => moogSampleRate() / (bins * 2);

export const FFB_BANDS = [
  { freq: 100,  type: 'lowpass',  Q: 0.7, label: 'LP'   },
  { freq: 125,  type: 'bandpass', Q: 2.8, label: '125'  },
  { freq: 175,  type: 'bandpass', Q: 2.8, label: '175'  },
  { freq: 250,  type: 'bandpass', Q: 2.8, label: '250'  },
  { freq: 350,  type: 'bandpass', Q: 2.8, label: '350'  },
  { freq: 500,  type: 'bandpass', Q: 2.8, label: '500'  },
  { freq: 700,  type: 'bandpass', Q: 2.8, label: '700'  },
  { freq: 1000, type: 'bandpass', Q: 2.8, label: '1k'   },
  { freq: 1400, type: 'bandpass', Q: 2.8, label: '1.4k' },
  { freq: 2000, type: 'bandpass', Q: 2.8, label: '2k'   },
  { freq: 2800, type: 'bandpass', Q: 2.8, label: '2.8k' },
  { freq: 4000, type: 'bandpass', Q: 2.8, label: '4k'   },
  { freq: 5600, type: 'bandpass', Q: 2.8, label: '5.6k' },
  { freq: 8000, type: 'highpass', Q: 0.7, label: 'HP'   },
];

// 16-band Vocoder — log-spaced bandpass bands 100 Hz → 8 kHz (geometric ratio ≈ 1.339).
// Each band exists twice: once in the modulator-analysis bank, once in the carrier-synthesis
// bank. Modulator bands drive the matching carrier band's VCA via an envelope follower.
export const VOC_BANDS = [
  { freq: 100,  Q: 4, label: '100'  },
  { freq: 135,  Q: 4, label: '135'  },
  { freq: 180,  Q: 4, label: '180'  },
  { freq: 240,  Q: 4, label: '240'  },
  { freq: 320,  Q: 4, label: '320'  },
  { freq: 430,  Q: 4, label: '430'  },
  { freq: 580,  Q: 4, label: '580'  },
  { freq: 770,  Q: 4, label: '770'  },
  { freq: 1035, Q: 4, label: '1k'   },
  { freq: 1385, Q: 4, label: '1.4k' },
  { freq: 1855, Q: 4, label: '1.9k' },
  { freq: 2485, Q: 4, label: '2.5k' },
  { freq: 3330, Q: 4, label: '3.3k' },
  { freq: 4460, Q: 4, label: '4.5k' },
  { freq: 5970, Q: 4, label: '6k'   },
  { freq: 8000, Q: 4, label: '8k'   },
];

// Rectifier drive — scales each band before rectification so the envelope follower drives
// the carrier VCA gain into a useful range. Lives in a per-band Gain (`${id}ModDrive${i}`)
// rather than inside the WaveShaper curve — see VOC_RECT_POINTS for why that matters.
//
// **This is the single most consequential number in the vocoder, and it was a constant
// from Phase 42 until Phase 82.** It decides how hard the voice gates the carrier:
//   too HIGH — every band's detector pins against the rectifier ceiling, so the band VCAs
//              sit near max whatever you say. Sixteen bandpasses of a saw, all open, sum
//              back to roughly the saw: you hear the SYNTH with vague vocal colour rather
//              than a voice. Dylan's "loose synth sound".
//   too LOW  — bands barely crack, output is thin and quiet.
// Measured at the shipped value of 8: the 8 kHz band pins at any band level above 0.031,
// and a 4× change in voice level moves it only 0.638 → 0.853. Phase 73's pre-emphasis
// tilt made that worse up top by multiplying the drive by up to 4×.
// The knob is exponential with its CENTRE on the historical 8, so saved racks are
// unchanged and the range reaches well below it (2) as well as above (32).
const VOC_ENV_DRIVE = 8;
// RES range + output makeup (Phase 83). VOC_RES_MAX_Q reaches past VOWEL's 11/13/15 so the
// carrier bank can actually cut formant-shaped peaks; VOC_OUT_MAKEUP is the historical ×3,
// now the value at the BASE Q rather than a constant.
// Asymmetric envelope following (Phase 84, env-follower-worklet.js). ATTACK is pinned
// fast — the useful range is tiny and 1 vs 3 ms is not worth a panel control — while the
// DECAY knob maps to RELEASE. VOC_ENV_POST_HZ is what the legacy ModEnv lowpass is parked
// at once the worklet owns the smoothing: high enough to be a pass-through for envelope
// content, low enough to take off any residual stair-stepping.
const VOC_ENV_ATK_S     = 0.0015;
const VOC_ENV_REL_MIN_S = 0.006;   // DECAY 0 — snappy
const VOC_ENV_REL_RATIO = 20;      // DECAY 1 → 120 ms; centre ≈ 27 ms
// De-ripple filter after the follower, PER BAND (Phase 86). The follower's 1.5 ms attack
// is fast enough to track individual GLOTTAL PULSES, so it re-imposes the speaker's PITCH
// on the carrier as amplitude modulation — measured at 18.9% ripple with this parked at a
// flat 300 Hz, which is heard as buzzy static on every voiced sound. (The pre-Phase-84
// symmetric follower was worse still at 28.7%, so 84 helped and simply did not go far
// enough; that is why DECAY "didn't make much difference" — release was never the culprit.)
//
// A FLAT cutoff can't win: pitch ripple (~120 Hz) and consonant onsets (~30 Hz bandwidth)
// are barely a decade apart, so 60 Hz flat still leaves 7.4% ripple AND slows consonants
// to 15 ms. Scaling with band frequency breaks the trade, because the two problems live in
// different bands: pitch ripple is a VOICED phenomenon concentrated low and mid, while
// consonants are high and mostly unvoiced noise with no pitch ripple to reject at all.
// 20 Hz at the 100 Hz band rising to 121 Hz at 8 kHz gives 6.0% ripple AND a 12.5 ms
// consonant rise — better than any single flat value on both counts.
const VOC_ENV_POST_BASE_HZ = 20;     // at VOC_BANDS[0]
const VOC_ENV_POST_EXP     = 0.41;   // → ~121 Hz at the 8 kHz band
const vocEnvPostHzFor = (hz) =>
  VOC_ENV_POST_BASE_HZ * Math.pow(hz / VOC_BANDS[0].freq, VOC_ENV_POST_EXP);
const vocEnvReleaseFor = (d) =>
  VOC_ENV_REL_MIN_S * Math.pow(VOC_ENV_REL_RATIO, Math.max(0, Math.min(1, d)));

const VOC_RES_MAX_Q = 20;
// ANALYSIS bank Q (Phase 85). Phase 83 sharpened only the CARRIER bank, which was half
// the job: the modulator bank stayed at VOC_BANDS' Q of 4, and at that width a single
// vocal formant at 730 Hz opens FIVE analysis bands (430/580/770/1035/1385 at
// 22/47/92/33/18%). So every formant was reproduced as a smeared cloud of five carrier
// peaks — sharp peaks after 83, but still five of them. VOWEL renders the same formant as
// exactly ONE peak, which is the difference Dylan keeps hearing.
// At Q≈12 the leakage collapses to a single band. Tied to RES at 0.8× so one knob
// sharpens analysis and synthesis together, floored at the original 4 (so RES at or below
// centre is byte-identical to before) and ceilinged at 14.
// Trade-off, accepted: a constant-Q bank rings for ~Q/(pi*f), so narrow LOW bands ring
// longest (~38 ms at 100 Hz, Q 12). It matters least exactly there — the 150 Hz highpass
// and the pre-emphasis tilt (-8.4 dB at 100 Hz) already suppress that region — and the
// Phase 84 fast attack tracks an onset before the ring settles.
const VOC_ANALYSIS_Q_RATIO = 0.8;
const VOC_ANALYSIS_Q_MIN   = 4;    // the historical VOC_BANDS Q
const VOC_ANALYSIS_Q_MAX   = 14;
const vocAnalysisQFor = (carrierQ) =>
  Math.max(VOC_ANALYSIS_Q_MIN, Math.min(VOC_ANALYSIS_Q_MAX, carrierQ * VOC_ANALYSIS_Q_RATIO));
const VOC_BASE_Q    = 4;     // VOC_BANDS' Q — the reference point for the makeup
const VOC_OUT_MAKEUP = 3;
const VOC_DRIVE_RATIO = 16;                               // knob 0 → /4, knob 1 → ×4
const vocDriveFor = (k) =>
  VOC_ENV_DRIVE * Math.pow(VOC_DRIVE_RATIO, Math.max(0, Math.min(1, k)) - 0.5);

// ── Modulator analysis rectifier (Phase 73) ───────────────────────────────────
// Each modulator band is rectified and smoothed into an envelope that opens the matching
// carrier band. Two things about this stage were wrong and both were audible.
//
// 1. THE CURVE MUST HAVE AN ODD POINT COUNT. `Tone.WaveShaper.setMap` samples the mapping
//    at `x = (i/(len-1))*2 - 1`; with the default even length of 1024, x = 0 falls between
//    samples 511 and 512, and since the mapping is |x|·8 BOTH neighbours are 0.0078. Web
//    Audio interpolates, so the curve returned 0.0078 for a SILENT input — a permanent
//    0.0078 gain on all 16 carrier VCAs. Through the ×3 output makeup that is raw carrier
//    at about −8.5 dB, always, whether or not anyone is talking, and loudest wherever the
//    carrier has the most energy: the saw's fundamental. That was the constant low buzz.
//    An odd count puts x = 0 exactly on a sample, so silence maps to exactly 0.
//    (Third time this class has bitten: the VCA LOG/LIN curve and the mic gate both had to
//    be built to pass through the origin for the same reason.)
// 2. THE CEILING WAS A HARD CLIP. `Math.min(1, …)` meant every band at or above 1/8 scale
//    pinned to exactly 1.0, so the loudest bands became indistinguishable from each other.
//    Vowel identity IS the relative height of the formant peaks, so flattening the tops
//    smears one vowel into another — the "vocals aren't clear" complaint. Now linear up to
//    VOC_RECT_KNEE (contrast preserved exactly where it matters) and asymptotic to 1 above
//    it, so nothing pins and nothing exceeds unity.
//
// Keeping the drive OUT of the curve is what makes the resolution honest: the shaper now
// sees an already-amplified signal that spans the full [-1, 1] domain, so every band gets
// the curve's full resolution. With the drive inside the curve, a band driven ×32 would
// have used ~1/32 of the table and quantised its envelope into a few dozen steps.
const VOC_RECT_POINTS = 2049;   // ODD — see (1)
const VOC_RECT_KNEE   = 0.6;    // linear below this, soft-limited above
const vocRectShape = (x) => {
  const a = Math.abs(x);
  if (a <= VOC_RECT_KNEE) return a;
  return 1 - (1 - VOC_RECT_KNEE) * Math.exp(-(a - VOC_RECT_KNEE) / (1 - VOC_RECT_KNEE));
};

// ── Analysis pre-emphasis (Phase 73) ──────────────────────────────────────────
// Speech energy falls roughly 6–9 dB per octave above ~500 Hz, so with a flat analysis
// bank the low bands sit wide open on the voice fundamental while the consonant bands
// (2–8 kHz) barely crack — a muffled robot with a droning bottom end. Every real vocoder
// pre-emphasises the analysis path to compensate; this is the per-band form of it, applied
// in each band's drive gain, so it costs no extra nodes and nothing downstream changes.
//
// Deliberately applied BEFORE the rectifier, not after the envelope: tilting the DETECTOR
// makes low bands less sensitive and high bands more sensitive while every carrier VCA
// stays bounded at unity. Tilting after the envelope would instead push the high carrier
// bands past unity and make the output level depend on the tilt.
//
// (f/500)^0.6 ≈ 3.6 dB/octave — a partial correction, not a full one. Full compensation
// measures "more correct" and sounds hissy; this leaves the voice sounding like a voice.
const VOC_TILT_PIVOT_HZ = 500;
const VOC_TILT_EXP      = 0.6;
const VOC_TILT_MIN      = 0.35;  // ≈ −9 dB floor, so the 100 Hz band can't dominate
const VOC_TILT_MAX      = 4.0;   // ≈ +12 dB ceiling, so the top bands can't hiss
const vocBandTilt = (hz) => Math.max(VOC_TILT_MIN,
  Math.min(VOC_TILT_MAX, Math.pow(hz / VOC_TILT_PIVOT_HZ, VOC_TILT_EXP)));

// ── Modulator noise gate (Phase 72) ───────────────────────────────────────────
// The mod pre-chain is HP(150) → Compressor(−28 dB, 4:1). That compressor is what
// makes vocoding consistent, but at a −28 dB threshold it also pulls ROOM NOISE up
// between words — the vocoder hisses at you whenever you stop talking. A gate in
// front of it is the fix. Order matters: gate BEFORE the compressor, so the gate
// sees the mic's natural dynamics; after it, the compressor has already flattened
// the difference between speech and noise and no threshold works.
//
//   ${id}ModHP ─┬──────────────────────────► ${id}GateGain ─► ${id}ModComp
//               └─► GateFollow ─► GateScale ─► GateCurve ──┘ (drives .gain)
//                   (envelope)    (1/thresh)   (soft knee)
//
// NOT `Tone.Gate`, though it exists and looks like an exact fit. Tone.Gate is
// Follower → GreaterThan → gain, and GreaterThan emits a hard 0/1 step: the gain
// snaps open the instant the threshold is crossed, which clicks on every word and
// chatters on breaths. Its `smoothing` only smooths DETECTION, not the gain. So the
// comparator is replaced by a soft-knee WaveShaper — same three-stage shape, but the
// gain eases open across the 6 dB below the threshold instead of switching.
//
// The threshold is applied by SCALING the follower into a FIXED curve rather than by
// rebuilding the curve: x = followerAmp / thresholdAmp, so the knob writes one plain
// gain param (rampable, single-writer) and the curve table is never rewritten (the
// reverb-DAMP rebuild-storm lesson). WaveShaper clamps its input to [-1, 1], which is
// exactly the behaviour wanted at the top: any level at or above the threshold gives
// x ≥ 1 → fully open. curve(0) = 0 keeps the gate shut on true silence (and a
// WaveShaper fed silence still emits curve(0), so this must be exact — the VCA
// LOG/LIN lesson from Phase 71).
const VOC_GATE_MIN_DB   = -80;   // knob 0 — below any real signal, i.e. effectively OFF
const VOC_GATE_MAX_DB   = -30;   // knob 1 — aggressive, for a noisy room
const VOC_GATE_SMOOTH   = 0.04;  // follower time constant. FIXED at construction and never
                                 // written: Follower wraps a OnePoleFilter, whose frequency
                                 // setter disposes and rebuilds its IIRFilter (Phase 70).
const VOC_GATE_KNEE     = 0.5;   // curve is 0 below half the threshold (−6 dB), 1 at it
const VOC_GATE_POINTS   = 513;   // odd, so x = 0 lands exactly on a sample

// knob 0–1 → the scaler that maps "amplitude equal to the threshold" onto x = 1.
const vocGateScaleFor = (g) =>
  1 / Math.pow(10, (VOC_GATE_MIN_DB + Math.max(0, Math.min(1, g)) * (VOC_GATE_MAX_DB - VOC_GATE_MIN_DB)) / 20);

const VOC_GATE_CURVE = (() => {
  const c = new Float32Array(VOC_GATE_POINTS);
  for (let i = 0; i < VOC_GATE_POINTS; i++) {
    const x = (i / (VOC_GATE_POINTS - 1)) * 2 - 1;   // WaveShaper maps the curve over [-1, 1]
    if (x <= VOC_GATE_KNEE) { c[i] = 0; continue; }  // covers x ≤ 0 too (Follower is non-negative anyway)
    const t = (x - VOC_GATE_KNEE) / (1 - VOC_GATE_KNEE);
    c[i] = t * t * (3 - 2 * t);                      // smoothstep — no corner at either end
  }
  return c;
})();

// Builds + splices one vocoder instance's modulator noise gate. `${id}ModHP` and
// `${id}ModComp` must already exist and must NOT already be connected to each other.
// Shared by the static instance (id 'voc' — its node names are `vocModHP` etc., so the
// composed names match exactly) and the addModule factory. Returns the created node
// names for the dynamic dispose sweep.
function buildVocGate(n, id) {
  n[`${id}GateFollow`] = new Tone.Follower({ smoothing: VOC_GATE_SMOOTH });
  n[`${id}GateScale`]  = new Tone.Gain(vocGateScaleFor(0));   // default OFF — saved racks unchanged
  n[`${id}GateCurve`]  = new Tone.WaveShaper(VOC_GATE_CURVE);
  n[`${id}GateGain`]   = new Tone.Gain(0);                    // intrinsic 0: the curve is the only driver
  // Audio path.
  n[`${id}ModHP`].connect(n[`${id}GateGain`]);
  n[`${id}GateGain`].connect(n[`${id}ModComp`]);
  // Side-chain detector — taps BEFORE the gate, so a closed gate can still reopen.
  n[`${id}ModHP`].connect(n[`${id}GateFollow`]);
  n[`${id}GateFollow`].connect(n[`${id}GateScale`]);
  n[`${id}GateScale`].connect(n[`${id}GateCurve`]);
  n[`${id}GateCurve`].connect(n[`${id}GateGain`].gain);
  return [`${id}GateFollow`, `${id}GateScale`, `${id}GateCurve`, `${id}GateGain`];
}

// Quantizer scale definitions (semitone offsets from root).
// Sent to the quantizer AudioWorklet via port.postMessage.
const SCALE_DEFS = {
  CHR:  [0,1,2,3,4,5,6,7,8,9,10,11],
  MAJ:  [0,2,4,5,7,9,11],
  MIN:  [0,2,3,5,7,8,10],
  PMAJ: [0,2,4,7,9],
  PMIN: [0,3,5,7,10],
  // Chord intervals — used by chord-aware quantization (ChordSeqModule → Quantizer).
  // When the chord sequencer fires, it sets root AND scale to one of these interval arrays;
  // the quantizer then snaps incoming melody notes to chord tones only.
  CMAJ:  [0,4,7],
  CMIN:  [0,3,7],
  CDOM:  [0,4,7,10],
  CMAJ7: [0,4,7,11],
  CMIN7: [0,3,7,10],
  CSUS4: [0,5,7],
  CDIM:  [0,3,6],
};

// Per-chord-type voice intervals for the polyphonic CV outputs (voices 2–4).
// Triads get an octave as their 4th voice; 4-note chords use all four tones.
const CHORD_VOICE_INTERVALS = {
  CMAJ:  [0, 4,  7, 12],
  CMIN:  [0, 3,  7, 12],
  CDOM:  [0, 4,  7, 10],
  CMAJ7: [0, 4,  7, 11],
  CMIN7: [0, 3,  7, 10],
  CSUS4: [0, 5,  7, 12],
  CDIM:  [0, 3,  6,  9],
};

// Base Hz for chord sequencer root CV output — C3 (MIDI 48).
// rootClass 0→11 maps to C3→B3 (130.81–246.94 Hz).
// All values > 10 Hz so the qnt-transpose-in analyser threshold correctly detects them.
const CHORD_BASE_HZ = 130.81;

// JS mirror of the quantizer worklet's snap logic — used by knob-stepper mode
// (Phase 57), where the VCO FREQ knob itself is quantized without any audio-rate
// CV passing through the worklet. Snaps hz to the nearest MIDI note whose pitch
// class (relative to root) is in the scale, then applies the octave shift.
// bypass passes the input through untouched (knob reverts to continuous).
function quantizeHzJs(inputHz, { scale, root, octShift, bypass }) {
  if (bypass) return inputHz;
  const midi = 69 + 12 * Math.log2(Math.max(0.001, inputHz) / 440);
  let best = Math.round(midi), bestDist = Infinity;
  for (let m = best - 12; m <= best + 12; m++) {
    if (!scale.includes((((m - root) % 12) + 12) % 12)) continue;
    const d = Math.abs(m - midi);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return 440 * Math.pow(2, (best + octShift * 12 - 69) / 12);
}

// Snap an input Hz to the nearest chord tone across all musical octaves.
// intervals: semitone array from SCALE_DEFS (e.g. [0,4,7] for major triad).
// Returns the chord-tone Hz closest in semitone distance to the input.
function snapToChordHz(inputHz, rootClass, chordType) {
  const intervals = SCALE_DEFS[chordType] ?? SCALE_DEFS.CMAJ;
  const rootHz    = CHORD_BASE_HZ * Math.pow(2, rootClass / 12);
  const inputMidi = 69 + 12 * Math.log2(Math.max(0.001, inputHz) / 440);
  let bestHz   = rootHz;
  let bestDist = Infinity;
  for (let oct = -3; oct <= 4; oct++) {
    for (const semitone of intervals) {
      const noteHz = rootHz * Math.pow(2, oct + semitone / 12);
      if (noteHz < 20 || noteHz > 20000) continue;
      const dist = Math.abs(inputMidi - (69 + 12 * Math.log2(noteHz / 440)));
      if (dist < bestDist) { bestDist = dist; bestHz = noteHz; }
    }
  }
  return bestHz;
}

// Safe parameter ramp.
//
// Problem: Tone.js Param.rampTo() calls assertRange(value, param.minValue, param.maxValue).
// When the AudioContext is suspended (before Tone.start()), AudioParams report
// minValue = maxValue = 0, so any non-zero value throws RangeError [0, 0].
// Additionally, for exponential-type params (frequency, Q), a target of 0 or a
// Tone-internal substitution of 1e-7 also triggers this check.
//
// Fix: use direct .value assignment (always valid regardless of context state) when the
// context is not running, and rampTo() only when it is running.  This also initialises
// params correctly so they are set to the right value the moment powerOn() resumes the context.
function safeRamp(param, value, rampTime = 0.05) {
  if (Tone.context.state === 'running') {
    param.rampTo(value, rampTime);
  } else {
    param.value = value;
  }
}

// ── VCF cutoff modulation (Phase 70) ──
// All three VCF CV inputs (ENV, CV 1, CV 2) sum onto the filter's DETUNE param
// (cents), NOT frequency (Hz). Native BiquadFilterNode computes the working
// cutoff as `frequency · 2^(detune/1200)`, so modulation becomes EXPONENTIAL:
// a given depth moves the cutoff by the same musical interval wherever the CUTOFF
// knob sits. The old linear-Hz summing made one envelope a 3.5-octave slam at a
// low cutoff and an inaudible nudge at a high one. Exponential also means the
// three inputs sum in cents (= multiply in Hz), which is how real 1V/oct
// modular CV behaves. Single writer holds: the CUTOFF knob owns
// `frequency.value`, the patch cables own the connected `detune` input.
// The CUTOFF knob sweeps VCF_CUTOFF_MIN_HZ … ×VCF_CUTOFF_RATIO (the `20 * 1000^cutoff`
// mapping in updateVcfParams) — keep these in step with that expression.
const VCF_CUTOFF_MIN_HZ = 20;
const VCF_CUTOFF_RATIO  = 1000;                 // 20 Hz → 20 kHz
// FULL-RANGE envelope depth: at ENV AMT = 1 a peaking envelope (Tone.Envelope tops
// out at exactly 1.0) must lift a fully-CLOSED cutoff to the very top of the knob's
// range — i.e. the whole 20 Hz → 20 kHz span, ~9.97 octaves. Anything less and the
// knob at max still feels weak, which is what a 6000-cent (5-octave) cap did.
const VCF_ENV_CENTS = Math.round(1200 * Math.log2(VCF_CUTOFF_RATIO));  // ≈ 11959
// CV 1 / CV 2 are BIPOLAR (an LFO swings ±1), so half the span each way already
// covers the full range end-to-end — deliberately not the same number as ENV.
const VCF_CV_CENTS  = Math.round(VCF_ENV_CENTS / 2);                   // ≈ 5980, ±~5 oct
// ENV AMT knob (0–1) → the ENV-jack scaler's gain, in cents.
const vcfEnvAmtCents = (amt) => Math.max(0, Math.min(1, amt)) * VCF_ENV_CENTS;

// ── VCA CV chain (Phase 71 · CV 2 added Phase 77) ─────────────────────────────
// The -cv jack used to land straight on the Tone.Gain's `gain` param, which left
// the faceplate's attenuator knob wired to nothing and the LOG/LIN lever wired to
// nothing. There are now TWO attenuated control inputs feeding one response curve:
//
//   -cv  jack → ${id}Cv  (CV 1 attenuator) ─┐
//                                            ├→ ${id}CvShape (LOG/LIN) → ${id}.gain
//   -cv2 jack → ${id}Cv2 (CV 2 attenuator) ─┘
//
// **The two CVs sum BEFORE the response curve, not after.** That is how a real VCA
// behaves — several control voltages meet at one control port and the amplifier's
// linear or exponential response acts on their SUM — and it is why there is one
// shaper rather than two. Shaping each input separately and adding the results
// would make two half-open CVs read as two small gains instead of one large one,
// which is both wrong and, in LOG, drastically quieter. Web Audio sums multiple
// connections into a node's input, so no summing node is needed.
//
// The attenuators matter far more here than they did on the VCF, where they were
// declined in Phase 70 on the grounds that "an LFO has its own DEPTH knob": the
// VCA's usual CV source is an ENVELOPE, which has no level knob at all, so
// without this there was no way to set modulation depth. (MOOG_PLAN Phase 70
// already flagged level-less sources as the gap in that decision.)
//
// LOG/LIN is that CV's response curve — the 902's LIN/EXP switch:
//   LIN  gain follows the voltage 1:1. A linear envelope ramp stays loud and
//        then drops away sharply at the very end.
//   LOG  gain follows the voltage in dB across VCA_LOG_RANGE_DB. Because hearing
//        is logarithmic, a linear envelope ramp fades perfectly evenly — the
//        "natural instrument" decay.
// Both curves are normalised so f(0) = 0 and f(1) = 1: switching never changes
// the fully-open or fully-closed level, and — load-bearing — an UNPATCHED CV
// input adds exactly 0. A WaveShaper fed silence still emits curve(0), so a
// curve that didn't pass through the origin would park a permanent DC offset on
// every VCA's gain. VCA_CURVE_POINTS is ODD so x = 0 lands exactly on a sample.
// Negative CV clamps to 0 in LOG (there is no negative dB-domain gain); LIN
// passes it through, so a bipolar LFO can still subtract from the GAIN bias
// exactly as it did before this chain existed.
const VCA_LOG_RANGE_DB = 60;
const VCA_CURVE_POINTS = 1025;

function makeVcaCurve(log) {
  const c = new Float32Array(VCA_CURVE_POINTS);
  const floor = Math.pow(10, -VCA_LOG_RANGE_DB / 20);   // 0.001 at 60 dB
  for (let i = 0; i < VCA_CURVE_POINTS; i++) {
    const x = (i / (VCA_CURVE_POINTS - 1)) * 2 - 1;     // WaveShaper maps the curve over [-1, 1]
    if (!log)   { c[i] = x; continue; }
    if (x <= 0) { c[i] = 0; continue; }
    c[i] = (Math.pow(10, ((x - 1) * VCA_LOG_RANGE_DB) / 20) - floor) / (1 - floor);
  }
  return c;
}
const VCA_CURVE_LIN = makeVcaCurve(false);
const VCA_CURVE_LOG = makeVcaCurve(true);

// Builds + wires one VCA instance's CV chain and its output meter. `n[id]` (the
// Tone.Gain) must already exist. Shared by the three statics and the addModule
// factory; returns the node names it created for the dynamic dispose sweep.
// The meter is a dead-end tap on the OUTPUT (the Phase 56 post-effect rule), so
// the panel LED shows the envelope actually opening — the VCA is the one module
// where "is anything getting through?" is the whole question, and it was the
// only signal-path module on the rack with no indicator at all.
function buildVcaCv(n, id) {
  n[`${id}Cv`]      = new Tone.Gain(1);                    // CV 1 attenuator
  n[`${id}Cv2`]     = new Tone.Gain(1);                    // CV 2 attenuator
  n[`${id}CvShape`] = new Tone.WaveShaper(VCA_CURVE_LIN);   // LOG/LIN response, shared
  n[`${id}Meter`]   = new Tone.Meter({ normalRange: true, smoothing: 0.2 });
  n[`${id}Cv`].connect(n[`${id}CvShape`]);                  // both attenuators sum at the
  n[`${id}Cv2`].connect(n[`${id}CvShape`]);                 // shaper's input — see above
  n[`${id}CvShape`].connect(n[id].gain);
  n[id].connect(n[`${id}Meter`]);
  return [`${id}Cv`, `${id}Cv2`, `${id}CvShape`, `${id}Meter`];
}

// Noise module colours (Phase 69). Each colour has its own LEVEL-tap gain (the
// jack taps it) and a per-colour makeup so they sit at comparable loudness at the
// shared LEVEL default (rising colours are perceptually loud → trimmed).
// [suffix, makeup]. updateNoiseParams is the single writer of every gain.
const NOISE_LEVEL_GAINS = [
  ['WGain',   1.0],  // white  — flat
  ['PGain',   1.0],  // pink   — −3 dB/oct (native)
  ['BrnGain', 1.4],  // red    — −6 dB/oct (native 'brown'); deep, perceptually quiet → boost
  ['BluGain', 0.55], // blue   — +3 dB/oct (pink differentiated); bright → trim
  ['VioGain', 0.40], // violet — +6 dB/oct (white differentiated); brightest → trim hard
  ['GryGain', 0.85], // grey   — inverse-loudness voiced
];

// Builds the red (brown) source, the four new colour gains, and the BLU/VIO/GRY
// shapers for a noise instance, then wires them. The white (`${id}W`) and pink
// (`${id}P`) sources must already exist. Shared by the static instances and the
// addModule factory. Returns the node-name list it created (dynamic dispose sweep).
//
// True spectral slopes (not shelf approximations):
//   violet (+6 dB/oct) = WHITE through a first-difference differentiator y[n]=x[n]−x[n−1]
//   blue   (+3 dB/oct) = PINK  through the same differentiator (pink −3 + 6 = +3)
//   grey               = white shaped by an inverse equal-loudness voicing
// The differentiator is a native IIRFilter — a biquad shelf can't make a constant
// broadband slope, which is why the earlier shelf versions sounded like white.
function buildNoiseColors(n, id) {
  const rawCtx = Tone.context.rawContext;
  n[`${id}Brn`]     = new Tone.Noise({ type: 'brown' });   // red / brown noise
  n[`${id}BrnGain`] = new Tone.Gain(1);
  n[`${id}BluGain`] = new Tone.Gain(1);
  n[`${id}VioGain`] = new Tone.Gain(1);
  n[`${id}GryGain`] = new Tone.Gain(1);
  // Exact rising slopes via first-difference differentiators.
  n[`${id}VioDiff`] = rawCtx.createIIRFilter([1, -1], [1]); // white → +6 dB/oct
  n[`${id}BluDiff`] = rawCtx.createIIRFilter([1, -1], [1]); // pink  → +3 dB/oct
  // Grey — boost lows + air, dip 2–5 kHz (the ear's most sensitive band) so all
  // octaves sound about equally loud (white sounds bright because the ear isn't flat).
  n[`${id}GryLo`]  = new Tone.Filter({ type: 'lowshelf',  frequency: 500,  gain: 5 });
  n[`${id}GryMid`] = new Tone.Filter({ type: 'peaking',   frequency: 3500, Q: 0.8, gain: -9 });
  n[`${id}GryHi`]  = new Tone.Filter({ type: 'highshelf', frequency: 9000, gain: 7 });
  // wiring (Tone ↔ native edges use the same .input pattern as the VCO splitter)
  n[`${id}Brn`].connect(n[`${id}BrnGain`]);
  n[`${id}W`].connect(n[`${id}VioDiff`]);  n[`${id}VioDiff`].connect(n[`${id}VioGain`].input);
  n[`${id}P`].connect(n[`${id}BluDiff`]);  n[`${id}BluDiff`].connect(n[`${id}BluGain`].input);
  n[`${id}W`].connect(n[`${id}GryLo`]);    n[`${id}GryLo`].connect(n[`${id}GryMid`]);
  n[`${id}GryMid`].connect(n[`${id}GryHi`]); n[`${id}GryHi`].connect(n[`${id}GryGain`]);
  // LEVEL CV (Phase 69b) — an LFO/CV patched to the LEVEL-CV jack modulates the
  // level of all six colours. It fans through per-colour makeup scalers into each
  // colour gain's AudioParam, so the CV scales level exactly like the knob does
  // (makeup-balanced). The knob still owns each gain's intrinsic .value (single
  // writer); the CV sums on top — the established Moog knob+CV pattern.
  n[`${id}LevelCv`] = new Tone.Gain(1);
  const cvNames = [`${id}LevelCv`];
  for (const [suf, mk] of NOISE_LEVEL_GAINS) {
    const sc = new Tone.Gain(mk);
    n[`${id}${suf}Cv`] = sc;
    n[`${id}LevelCv`].connect(sc);
    sc.connect(n[`${id}${suf}`].gain);
    cvNames.push(`${id}${suf}Cv`);
  }
  return [`${id}Brn`, `${id}BrnGain`, `${id}BluGain`, `${id}VioGain`, `${id}GryGain`,
          `${id}VioDiff`, `${id}BluDiff`, `${id}GryLo`, `${id}GryMid`, `${id}GryHi`,
          ...cvNames];
}

// Maps all jack IDs to Tone.js port descriptors.
// type:'out' → source node (plus optional waveform to set before connecting)
// type:'in'  → destination: ToneAudioNode (audio input) or AudioParam (CV input)
// dest:null  → deferred jack (patching does nothing until a later phase wires it)
function buildJackMap(n) {
  return {
    // ── VCOs (Phase 68b — worklet core, 4 SIMULTANEOUS waveform outs + PWM) ──
    // cv  → glideBus (isVcoCv): Hz-range sources (sequencer, keyboard) patch here.
    // fm  → vcoNfmIn (unity) → vcoNfm Gain(500) → worklet slaveFreq: LFO/audio-rate
    //      mod, ±1 → ±500 Hz. fmIn also feeds vcoNfmAnalyser so qntFmTick can read
    //      the RAW modulator while the ×500 path is muted for quantized FM (Phase 70).
    // pw  → vcoNpw Gain(0.4) → worklet pulseWidth: pulse-width CV for the SQR out.
    // sin/tri/saw/sqr each tap their own splitter channel (all live at once).
    // sync-in feeds the worklet master input; sync-out is the SAW tap (sharp edge).
    'vco1-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco1-fm':  { type: 'in',  dest: n.vco1fmIn },
    'vco1-pw':  { type: 'in',  dest: n.vco1pw },
    'vco1-sin': { type: 'out', node: n.vco1Sin },
    'vco1-tri': { type: 'out', node: n.vco1Tri },
    'vco1-saw': { type: 'out', node: n.vco1Saw },
    'vco1-sqr': { type: 'out', node: n.vco1Pulse },
    'vco1-sync-in':  { type: 'in',  dest: n.vco1syncIn },
    'vco1-sync-out': { type: 'out', node: n.vco1Saw },
    'vco2-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco2-fm':  { type: 'in',  dest: n.vco2fmIn },
    'vco2-pw':  { type: 'in',  dest: n.vco2pw },
    'vco2-sin': { type: 'out', node: n.vco2Sin },
    'vco2-tri': { type: 'out', node: n.vco2Tri },
    'vco2-saw': { type: 'out', node: n.vco2Saw },
    'vco2-sqr': { type: 'out', node: n.vco2Pulse },
    'vco2-sync-in':  { type: 'in',  dest: n.vco2syncIn },
    'vco2-sync-out': { type: 'out', node: n.vco2Saw },
    'vco3-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco3-fm':  { type: 'in',  dest: n.vco3fmIn },
    'vco3-pw':  { type: 'in',  dest: n.vco3pw },
    'vco3-sin': { type: 'out', node: n.vco3Sin },
    'vco3-tri': { type: 'out', node: n.vco3Tri },
    'vco3-saw': { type: 'out', node: n.vco3Saw },
    'vco3-sqr': { type: 'out', node: n.vco3Pulse },
    'vco3-sync-in':  { type: 'in',  dest: n.vco3syncIn },
    'vco3-sync-out': { type: 'out', node: n.vco3Saw },
    'vco4-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco4-fm':  { type: 'in',  dest: n.vco4fmIn },
    'vco4-pw':  { type: 'in',  dest: n.vco4pw },
    'vco4-sin': { type: 'out', node: n.vco4Sin },
    'vco4-tri': { type: 'out', node: n.vco4Tri },
    'vco4-saw': { type: 'out', node: n.vco4Saw },
    'vco4-sqr': { type: 'out', node: n.vco4Pulse },
    'vco4-sync-in':  { type: 'in',  dest: n.vco4syncIn },
    'vco4-sync-out': { type: 'out', node: n.vco4Saw },
    'vco5-cv':  { type: 'in',  dest: null, isVcoCv: true },
    'vco5-fm':  { type: 'in',  dest: n.vco5fmIn },
    'vco5-pw':  { type: 'in',  dest: n.vco5pw },
    'vco5-sin': { type: 'out', node: n.vco5Sin },
    'vco5-tri': { type: 'out', node: n.vco5Tri },
    'vco5-saw': { type: 'out', node: n.vco5Saw },
    'vco5-sqr': { type: 'out', node: n.vco5Pulse },
    'vco5-sync-in':  { type: 'in',  dest: n.vco5syncIn },
    'vco5-sync-out': { type: 'out', node: n.vco5Saw },
    // ── Noise ──
    // Noise jacks tap the LEVEL gains (Phase 8b), not the raw sources.
    // Six colours per instance (Phase 69): wht/pnk/brn sources + blu/vio/gry
    // filtered off white. Each taps its own LEVEL gain.
    'noise-wht':  { type: 'out', node: n.noiseWGain },
    'noise-pnk':  { type: 'out', node: n.noisePGain },
    'noise-brn':  { type: 'out', node: n.noiseBrnGain },
    'noise-blu':  { type: 'out', node: n.noiseBluGain },
    'noise-vio':  { type: 'out', node: n.noiseVioGain },
    'noise-gry':  { type: 'out', node: n.noiseGryGain },
    'noise-lvl-cv':  { type: 'in', dest: n.noiseLevelCv },
    'noise2-wht': { type: 'out', node: n.noise2WGain },
    'noise2-pnk': { type: 'out', node: n.noise2PGain },
    'noise2-brn': { type: 'out', node: n.noise2BrnGain },
    'noise2-blu': { type: 'out', node: n.noise2BluGain },
    'noise2-vio': { type: 'out', node: n.noise2VioGain },
    'noise2-gry': { type: 'out', node: n.noise2GryGain },
    'noise2-lvl-cv': { type: 'in', dest: n.noise2LevelCv },
    'noise3-wht': { type: 'out', node: n.noise3WGain },
    'noise3-pnk': { type: 'out', node: n.noise3PGain },
    'noise3-brn': { type: 'out', node: n.noise3BrnGain },
    'noise3-blu': { type: 'out', node: n.noise3BluGain },
    'noise3-vio': { type: 'out', node: n.noise3VioGain },
    'noise3-gry': { type: 'out', node: n.noise3GryGain },
    'noise3-lvl-cv': { type: 'in', dest: n.noise3LevelCv },
    // ── Kick ──
    'kick-out': { type: 'out', node: n.kickOut },
    // ── 914 FFB ──
    'ffb-in':        { type: 'in',  dest: n.ffbIn },
    'ffb-master-cv': { type: 'in',  dest: n.ffbMasterCv },
    'ffb-sweep-cv':  { type: 'in',  dest: n.ffbSweepCv },
    'ffb-out':       { type: 'out', node: n.ffbMaster },
    // ── 16-band Vocoder ── modulator + carrier audio inputs, vocoded output.
    'voc-mod-in':  { type: 'in',  dest: n.vocModRaw },
    'voc-carr-in': { type: 'in',  dest: n.vocCarrIn },
    'voc-out':     { type: 'out', node: n.vocVolume },
    // ── VCF ──  (Phase 70: all three CV inputs are CENTS scalers → filter.detune)
    // cv1/cv2 → vcfcv1/vcfcv2 Gain(VCF_CV_CENTS): CV ±1 → ±~5 octaves of cutoff
    // env     → vcfenv, gain owned by the ENV AMT knob: at max, env 0→1 sweeps the
    //           cutoff across its ENTIRE 20 Hz–20 kHz range (VCF_ENV_CENTS)
    'vcf-in':  { type: 'in',  dest: n.vcf },
    'vcf-cv1': { type: 'in',  dest: n.vcfcv1 },
    'vcf-cv2': { type: 'in',  dest: n.vcfcv2 },
    'vcf-env': { type: 'in',  dest: n.vcfenv },
    'vcf-out': { type: 'out', node: n.vcf },
    // ── VCF 2 ──
    'vcf2-in':  { type: 'in',  dest: n.vcf2 },
    'vcf2-cv1': { type: 'in',  dest: n.vcf2cv1 },
    'vcf2-cv2': { type: 'in',  dest: n.vcf2cv2 },
    'vcf2-env': { type: 'in',  dest: n.vcf2env },
    'vcf2-out': { type: 'out', node: n.vcf2 },
    // ── VCA ──
    // -cv lands on the ENV AMT attenuator, never on `gain` directly (see buildVcaCv).
    // -out taps the VCA itself on every instance. It used to tap seqGateNode for
    // vca1 (plus an unreachable `vca-out2` on seq2GateNode), which silently chopped
    // VCA 1's output to sequencer 1's rhythm with no cable patched — a hardwired
    // audio path, which MOOG_ARCHITECTURE forbids since Phase 10.
    // `-cv` keeps its original id (it is `vca-cv`, not `vca-cv1`) so cables saved
    // before CV 2 existed still resolve; only its panel LABEL became "CV 1".
    'vca-in':  { type: 'in',  dest: n.vca },
    'vca-cv':  { type: 'in',  dest: n.vcaCv },
    'vca-cv2': { type: 'in',  dest: n.vcaCv2 },
    'vca-out':  { type: 'out', node: n.vca },
    'vca2-in':  { type: 'in',  dest: n.vca2 },
    'vca2-cv':  { type: 'in',  dest: n.vca2Cv },
    'vca2-cv2': { type: 'in',  dest: n.vca2Cv2 },
    'vca2-out': { type: 'out', node: n.vca2 },
    'vca3-in':  { type: 'in',  dest: n.vca3 },
    'vca3-cv':  { type: 'in',  dest: n.vca3Cv },
    'vca3-cv2': { type: 'in',  dest: n.vca3Cv2 },
    'vca3-out': { type: 'out', node: n.vca3 },
    // ── Reverb ──
    'reverb-in':      { type: 'in',  dest: n.reverb  },
    'reverb-mix-cv':  { type: 'in',  dest: n.reverbMixCv },
    'reverb-out':     { type: 'out', node: n.reverb  },
    'reverb2-in':     { type: 'in',  dest: n.reverb2 },
    'reverb2-mix-cv': { type: 'in',  dest: n.reverb2MixCv },
    'reverb2-out':    { type: 'out', node: n.reverb2 },
    // ── Chorus ──
    // BBD is a composite (Phase 70): jacks land on the wrapper In/Out, not the Chorus.
    'chorus-in':      { type: 'in',  dest: n.chorusIn },
    'chorus-rate-cv': { type: 'in',  dest: n.chorusRateCv },
    'chorus-out':     { type: 'out', node: n.chorusOut },
    // ── Kick gate ── fires kickSynth.triggerAttackRelease on each gate-on event.
    // isKick:true distinguishes it from ENV gates in the loop and connect() handler.
    'kick-gate-in':  { type: 'in', dest: null, isGate: true, isKick: true },
    // ── Kick click CV ── audio-rate CV into kickClickGain.gain for accent modulation.
    'kick-click-in': { type: 'in', dest: n.kickClickGain.gain },
    // Hz-domain: patch a pitch out here and its value becomes the drum's fundamental.
    'kick-tune-cv':  { type: 'in', dest: n.kickTuneCv },
    // ── ENV 1 ── gate + trig jacks both wired to gateActionsRef by connect()
    'env1-gate': { type: 'in', dest: null, isGate: true, envId: 'env1' },
    'env1-trig': { type: 'in', dest: null, isGate: true, envId: 'env1', isTrig: true },
    'env1-out':  { type: 'out', node: n.env1 },
    // ── ENV 2 ──
    'env2-gate': { type: 'in', dest: null, isGate: true, envId: 'env2' },
    'env2-trig': { type: 'in', dest: null, isGate: true, envId: 'env2', isTrig: true },
    'env2-out':  { type: 'out', node: n.env2 },
    'env3-gate': { type: 'in', dest: null, isGate: true, envId: 'env3' },
    'env3-trig': { type: 'in', dest: null, isGate: true, envId: 'env3', isTrig: true },
    'env3-out':  { type: 'out', node: n.env3 },
    // ── LFO ──
    // lfo-fm → lfo1modGain (Gain): patched CV * MOD DEPTH knob gain → lfo.frequency
    // Output jacks route from `${id}Out` (post free/sync crossfade) but still set
    // the waveform on the oscillator via waveformTarget (Phase 65).
    'lfo-sync':  { type: 'in',  dest: null, isLfoSync: true, lfoId: 'lfo' },
    'lfo-fm':    { type: 'in',  dest: n.lfo1modGain },
    'lfo-sin':   { type: 'out', node: n.lfoOut,  waveformTarget: n.lfo,  waveform: 'sine'      },
    'lfo-tri':   { type: 'out', node: n.lfoOut,  waveformTarget: n.lfo,  waveform: 'triangle'  },
    'lfo-sqr':   { type: 'out', node: n.lfoOut,  waveformTarget: n.lfo,  waveform: 'square'    },
    'lfo-saw':   { type: 'out', node: n.lfoOut,  waveformTarget: n.lfo,  waveform: 'sawtooth'  },
    'lfo2-sync': { type: 'in',  dest: null, isLfoSync: true, lfoId: 'lfo2' },
    'lfo2-fm':   { type: 'in',  dest: n.lfo2modGain },
    'lfo2-sin':  { type: 'out', node: n.lfo2Out, waveformTarget: n.lfo2, waveform: 'sine'      },
    'lfo2-tri':  { type: 'out', node: n.lfo2Out, waveformTarget: n.lfo2, waveform: 'triangle'  },
    'lfo2-sqr':  { type: 'out', node: n.lfo2Out, waveformTarget: n.lfo2, waveform: 'square'    },
    'lfo2-saw':  { type: 'out', node: n.lfo2Out, waveformTarget: n.lfo2, waveform: 'sawtooth'  },
    // ── Sequencer 1 ──
    'seq-pitch-out': { type: 'out', node: n.seqPitchOut },
    'seq-gate-out':  { type: 'out', node: null, isGate: true },
    'seq-clk-in':    { type: 'in',  dest: null },
    'seq-clk-out':   { type: 'out', node: null },
    // ── Sequencer 2 ──
    'seq2-pitch-out': { type: 'out', node: n.seq2PitchOut },
    'seq2-gate-out':  { type: 'out', node: null, isGate: true },
    'seq2-clk-in':    { type: 'in',  dest: null },
    'seq2-clk-out':   { type: 'out', node: null },
    // ── Chord Sequencer ──
    'chordseq-cv-in':   { type: 'in',  dest: n.chordseqInputAnalyser },
    'chordseq-cv-out':     { type: 'out', node: n.chordseqPitchOut  },
    'chordseq-root-out':   { type: 'out', node: n.chordseqRootOut   },
    'chordseq-3rd-out':    { type: 'out', node: n.chordseqThirdOut },
    'chordseq-5th-out':    { type: 'out', node: n.chordseqFifthOut },
    // ── Keyboard ──
    'kbd-pitch-out': { type: 'out', node: n.kbdPitchOut },
    'kbd-gate-out':  { type: 'out', node: null, isGate: true },
    // ── Quantizer ──
    // qnt-cv-in        → AudioWorkletNode audio input (null until worklet loads)
    // qnt-cv-out       → Tone.Gain wrapper (always live)
    // qnt-transpose-in → waveform analyser; rAF loop in QuantizerModule reads Hz → note class
    'qnt-cv-in':        { type: 'in',  dest: n.qntNodes?.qnt ?? null   },
    'qnt-cv-out':       { type: 'out', node: n.qntOut             },
    'qnt-transpose-in': { type: 'in',  dest: n.qntTransposeAnalyser    },
    // ── I/O ── audio signal enters the I/O module here and exits to Destination
    // io-in routes directly to master (legacy single-input path, kept for patch compat).
    // io-in1–4 each route through independent channel gain nodes → master.
    'io-in':  { type: 'in', dest: n.master },
    'io-in1': { type: 'in', dest: n.ioCh1  },
    'io-in2': { type: 'in', dest: n.ioCh2  },
    'io-in3': { type: 'in', dest: n.ioCh3  },
    'io-in4': { type: 'in', dest: n.ioCh4  },
  };
}

export default function useMoogAudio() {
  const [isPowered, setIsPowered] = useState(false);

  const isPoweredRef        = useRef(false);
  const nodesRef            = useRef(null);
  const jackMapRef          = useRef(null);
  const connectionsRef      = useRef(new Map()); // key: "fromId→toId" → { node, dest }
  const vco1SyncEnabledRef  = useRef(false);
  const vco2SyncEnabledRef  = useRef(false);     // tracks HARD SYNC toggle state across power cycles
  const vco3SyncEnabledRef  = useRef(false);
  const vco4SyncEnabledRef  = useRef(false);
  const vco5SyncEnabledRef  = useRef(false);
  const extMicRef           = useRef(null);      // Tone.UserMedia mic instance (lazy, on enable)
  // Vocoder spectral-shift state — read by the shift rAF loop, written by updateVocoderParams.
  // Vocoder spectral-shift state — id-keyed maps (Phase 60e part 3): 'voc' is
  // the static module, 'voc2'+ are dynamic instances. Node names compose from
  // the id (`${vid}CarrBPF3`, `${vid}Wet`…). vocIdsRef is the instance list the
  // shift rAF iterates.
  const vocIdsRef             = useRef(['voc']);
  const vocShiftBaseRefs      = useRef({ voc: 1.0 });  // base ratio (1 = no shift)
  const vocShiftLfoRateRefs   = useRef({ voc: 0.7 });  // Hz
  const vocShiftLfoAmpRefs    = useRef({ voc: 0 });    // octaves of swing
  const vocDecayRefs          = useRef({});            // id → DECAY knob, replayed when the worklet wires late
  const vocShiftLastRatioRefs = useRef({});            // delta gates — static shift settles to 0 writes
  // Vowel/formant module state (Phase 64) — id-keyed. vowelIdsRef is the list
  // the vowelTick rAF (sole writer of the 3 filter frequencies) iterates. The
  // knob updaters write morph/shape refs ONLY; the rAF combines morph + shape +
  // the FORMANT-CV input into the final formant frequencies.
  const vowelIdsRef      = useRef([]);                 // no static instance — dynamic only
  // 914 FFB instances (Phase 70) — 'ffb' is the static one; the sweep rAF iterates this.
  const ffbIdsRef        = useRef(['ffb']);
  const ffbSweepActiveRef = useRef({});   // id → true while a cable feeds its SWEEP CV
  const ffbSweepLastRef   = useRef({});   // id → last written weights (delta gate)
  const recomputeFfbSweepRef = useRef(null);
  const vowelMorphRefs   = useRef({});                 // id → morph position 0..4 (A..U)
  const vowelShapeRefs   = useRef({});                 // id → tract-scale factor
  const vowelLastFreqRefs = useRef({});                // id → last [F1,F2,F3] (delta gate)
  // DIRECT mode (Phase 75) — id-keyed. Empty/false = CHAIN, i.e. the pre-Phase-75
  // behaviour, so a saved rack that never touched MODE is bit-identical.
  const vowelDirectRefs  = useRef({});                 // id → true while MODE is DIRECT
  const vowelFromRefs    = useRef({});                 // id → FROM vowel index 0..4
  const vowelToRefs      = useRef({});                 // id → TO vowel index 0..4
  // ── LFO tempo-sync (Phase 65) ── all id-keyed; cover static 'lfo'/'lfo2' + dynamics.
  const lfoSyncActiveRef = useRef({});                 // id → true when a clock is patched to -sync
  const lfoRateRefs      = useRef({});                 // id → RATE knob 0..1 (drives sync division)
  const lfoOffsetRefs    = useRef({});                 // id → MOD knob 0..1, reused as sync phase offset
  const lfoDepthRefs     = useRef({});                 // id → DEPTH knob 0..1 (sync output scale)
  const lfoWaveRefs      = useRef({});                 // id → active waveform type (for the synced value)
  const lfoSyncLastRefs  = useRef({});                 // id → last written synced value (delta gate)
  // Glide time in seconds (0 = off). Written by the UI knob, read by the Tone.Loop.
  const kbdGlideRef   = useRef(0);
  const chordSeqGlideRefs = useRef({ chordseq: 0 }); // csId → glide (s) for root/3rd/5th CV outs
  // Keyboard vibrato — depth in Hz, rate in Hz. Driven by a rAF loop inside useEffect.
  const kbdVibratoDepthRef = useRef(0);
  const kbdVibratoRateRef  = useRef(5);
  const kbdVibratoDelayRef = useRef(0);     // delay ramp time in seconds (0 = instant)
  const kbdBaseHzRef       = useRef(220);   // last note Hz from keyboard, for vibrato center
  const kbdNoteOnsetRef    = useRef(null);  // AudioContext time of last note-on (null = no note yet)
  const kbdVibratoResetRef = useRef(false); // set true on note-on; rAF consumes it with its own `now`
  const kbdCurrentHzRef    = useRef(220);   // smoothly-interpolated Hz (glide state, base only)
  const kbdLastOutputHzRef = useRef(220);   // actual last-written Hz including swing — glide seeds from here
  const kbdPrevRafTimeRef  = useRef(null);  // last rAF AudioContext time for delta-time glide
  // 960 sequencer state — id-keyed maps (Phase 60e). 'seq' / 'seq2' are the
  // static modules; dynamic instances are 'seq3'+. Node names compose from the
  // id (`${seqId}PitchOut`, `${seqId}GateNode`) and every map is read by the
  // shared loop body at fire time, so a dynamic seq is just four map entries
  // plus a Tone.Loop from buildSeqLoop().
  const defaultSeqSteps = () =>
    Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 }));
  const seqLoopsRef        = useRef({});                       // seqId → Tone.Loop
  const seqStepsRefs       = useRef({ seq: defaultSeqSteps(), seq2: defaultSeqSteps() });
  const seqCurrentStepRefs = useRef({ seq: -1, seq2: -1 });
  const seqStepCbRefs      = useRef({});                       // seqId → UI LED callback
  const seqGlideRefs       = useRef({ seq: 0, seq2: 0 });      // seconds (0 = off)
  const gateActionsRef      = useRef(new Map()); // cable key → { env, fromId, isTrig } | kick action

// TRIG vs GATE. A GATE holds the envelope at SUSTAIN for as long as it stays high, so the
// note's length is the incoming gate's length. A TRIG is a momentary spike: it fires
// attack → decay → release as a ONE-SHOT whose length comes from the envelope's own A+D
// knobs, so a clock pulse or a one-step sequencer gate plays a percussive hit regardless
// of how long the source is held. That distinction is the whole reason MOOG_ARCHITECTURE
// §5 lists the two as separate ports on the 911.
const triggerEnvOneShot = (env, time) => {
  // A+D reaches the sustain point and releases from there, so the knobs still shape it.
  // Floored so an all-zero envelope still produces an audible click rather than nothing.
  const dur = Math.max(0.002, env.toSeconds(env.attack) + env.toSeconds(env.decay));
  if (time === undefined) env.triggerAttackRelease(dur);
  else                    env.triggerAttackRelease(dur, time);
};


  // Chord sequencer — separate slower-clocked 8-step pitch CV source.
  // Each step stores { rootClass: 0-11, chordType: keyof SCALE_DEFS }.
  // On step fire: outputs root Hz via `${csId}PitchOut` AND calls the instance's
  // chord callback so MoogShell can sync the quantizer scale / chord label.
  // All state is id-keyed (Phase 60e part 2): 'chordseq' = the static module,
  // 'chordseq2'+ are dynamic instances. Node names compose from the id.
  const defaultChordSteps = () =>
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i], // Am Am F F C C E E
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }));
  const chordSeqIdsRef          = useRef(['chordseq']);   // registered instances (snap rAF iterates)
  const chordSeqLoopsRef        = useRef({});             // csId → Tone.Loop
  const chordSeqStepsRefs       = useRef({ chordseq: defaultChordSteps() });
  const chordSeqCurrentStepRefs = useRef({ chordseq: -1 });
  const chordSeqStepCbRefs      = useRef({});
  const chordSeqChordCbRefs     = useRef({});             // fn(rootClass, chordType) per instance
  const chordSeqDivisionRefs    = useRef({ chordseq: '1m' }); // default: advance every 1 bar
  const chordSeqRootOctaveRefs  = useRef({ chordseq: 0 }); // octave offset for `${csId}-root-out` (-3..+3)
  const chordSeqInputActiveRefs = useRef({});              // csId → true when CV patched to its cv-in
  // Per-quantizer chord override (Phase 60e part 4): qid → the chordseq
  // instance id whose cv-out is patched to that quantizer's transpose-in.
  // Each quantizer has exactly one owner (Single Writer per instance).
  const qntChordOverrideRef    = useRef({});
  // Stores the last Hz value from each VCO knob so it can be restored when a CV cable is removed.
  const vcoKnobHzRef      = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  // Tracks which source jack is actively driving each VCO cv-in (null = knob only).
  // Written by connect/disconnect; read by step loops and quantizer callback.
  const vcoActiveCvRef   = useRef({ vco1: null, vco2: null, vco3: null, vco4: null, vco5: null });
  // Quantizer state — id-keyed maps (Phase 60e part 4): 'qnt' is the static
  // module, 'qnt2'+ are dynamic instances. Worklet nodes live in n.qntNodes
  // (assigned synchronously, keyed like hardSyncNodes); wireQntRef holds the
  // per-instance wiring closure once the worklet module loads.
  const qntIdsRef             = useRef(['qnt']);
  const wireQntRef            = useRef(null);
  const quantizerStepCbRefs   = useRef({});          // qid → UI LED/display callback
  const lastQuantizedMidiRefs = useRef({ qnt: 69 }); // A4 default — updated on each note change
  // Inline-synced mirror of applyQuantizerParams (declared later, after the
  // knob-stepper helpers it depends on) so updateDynModuleParams can dispatch
  // dynamic 'qnt' params without a TDZ-breaking dependency.
  const applyQuantizerParamsRef = useRef(null);
  const vcoQuantizedCbRef     = useRef(null);   // UI callback: (vcoIds[]) in knob-stepper mode
  // Quantized FM (Phase 70) — vcoId → owning qid while engaged, else null/undefined.
  // qntFmTick is the sole writer of those VCOs' GlideBus; muted/lastHz are its own
  // bookkeeping (mute transition edge + delta gate).
  const qntFmEngagedRef = useRef({});
  const qntFmMutedRef   = useRef({});
  const qntFmLastHzRef  = useRef({});
  const recomputeQntFmRef = useRef(null);   // inline-synced below recomputeQntFm's definition

  // ── Dynamic module instances (Phase 60b) ──
  // Pilot types: 'vco' | 'noise'. Instance nodes live in nodesRef.current under
  // the same name-composition scheme as the static graph (`vco6`, `vco6GlideBus`,
  // `vco6Meter`…) so every existing name-composed lookup (updateVcoParams,
  // getMeterValue, connect()'s glideBus resolution) works unchanged.
  // dynInstancesRef records ownership for disposal; allVcoIdsRef is the combined
  // static+dynamic VCO list read by the step loops / vibrato rAF / qnt fanouts.
  const dynInstancesRef = useRef(new Map()); // id → { type, num, nodeNames, sourceNames, jackIds }
  const allVcoIdsRef    = useRef([...VCO_IDS]);
  // Monotonic per-type counters — minted eagerly, never reused. Start above the
  // static instances so ids can never collide (vcf1/vcf2 static → dynamic from 3, etc.).
  // vowel starts at 1 — it's the first dynamic-ONLY type (no static instance in
  // the default rack), unlike the others which start past their statics.
  const nextInstNumRef  = useRef({ vco: 6, noise: 4, vcf: 3, lfo: 3, vca: 4, env: 4, rev: 3, bbd: 2, kick: 2, ffb: 2, seq: 3, chordseq: 2, voc: 2, qnt: 2, vowel: 1, panner: 1, chronos: 1, folder: 1 });
  // Per-instance hard sync (Phase 60d): wireHardSyncRef holds the wire() closure
  // once the worklet module loads (null before load / after unmount) so addModule
  // can mint a worklet for VCOs added later. dynVcoSyncRef tracks each dynamic
  // VCO's HARD SYNC toggle across power cycles (the static VCOs use 5 dedicated refs).
  const wireHardSyncRef = useRef(null);
  const wireEnvFollowRef = useRef(null);   // Phase 84 — wires a vocoder added after the worklet loaded
  const dynVcoSyncRef   = useRef({});
  // Persists each quantizer's latest config (keyed by qid) so it can be flushed
  // when its worklet node is created. baseHz — modulation-mode center for the
  // worklet (Phase 58): the FREQ knob of the qnt-patched VCO. Last-moved knob
  // wins when several VCOs share one quantizer's cv-out.
  const defaultQntParams   = () => ({ scale: SCALE_DEFS.MAJ, root: 0, octShift: 0, bypass: false, baseHz: 220 });
  const quantizerParamsRefs = useRef({ qnt: defaultQntParams() });

  // Glide τ for a managed pitch source — used wherever a downstream module
  // (chord snap, quantizer port) traces which source feeds it. seq ids are
  // open-ended ('seq', 'seq2', 'seq3'+ dynamics — Phase 60e).
  const glideForPitchSource = useCallback((srcId) => {
    if (srcId === 'kbd-pitch-out') return kbdGlideRef.current;
    if (srcId && /^seq\d*-pitch-out$/.test(srcId))
      return seqGlideRefs.current[srcId.replace('-pitch-out', '')] ?? 0;
    return 0;
  }, []);

  // One 960 loop body for every instance (Phase 60e) — reads all per-seq state
  // from the id-keyed maps at fire time. Advances the step, writes the pitch
  // Signal (instant — it feeds quantizer/analyser paths), applies glide at each
  // connected VCO's glideBus, gates the seq's VCA tap + connected VCO buses,
  // and fires env/kick gate actions registered from `${seqId}-gate-out`.
  // seqMasterGate is NOT written — it would silence the other sequencers.
  const buildSeqLoop = useCallback((seqId) => new Tone.Loop((time) => {
    const n = nodesRef.current;
    const steps = seqStepsRefs.current[seqId];
    if (!n || !steps) return;
    seqCurrentStepRefs.current[seqId] = (seqCurrentStepRefs.current[seqId] + 1) % 16;
    const idx  = seqCurrentStepRefs.current[seqId];
    const step = steps[idx];
    const hz    = SEQ_HZ_MIN * Math.pow(SEQ_HZ_MAX / SEQ_HZ_MIN, step.voltage);
    const glide = seqGlideRefs.current[seqId] ?? 0;
    const pitchSrc = `${seqId}-pitch-out`;
    n[`${seqId}PitchOut`].setValueAtTime(hz, time);
    // Glide on every VCO that has this seq's pitch out connected to its cv-in.
    for (const vcoId of allVcoIdsRef.current) {
      if (vcoActiveCvRef.current[vcoId] !== pitchSrc) continue;
      const gb = n[`${vcoId}GlideBus`];
      if (glide < 0.001) gb.setValueAtTime(hz, time);
      else               gb.rampTo(hz, glide, time);
      // (glideBus is connected to the worklet's slaveFreq — no separate write.)
    }
    const fires = step.gate && Math.random() < step.prob;
    const gateVal = fires ? 1 : 0;
    // Legacy per-seq VCA tap. No instance has a GateNode any more (Phase 71
    // removed the two statics'; dynamics never had one), so this is a no-op —
    // kept only so a future per-seq output gate can drop straight back in.
    // Native AudioParam directly: Tone.Param's event queue conflicts with rampTo.
    n[`${seqId}GateNode`]?.gain._param.setValueAtTime(gateVal, time);
    // Rest-step mute. Unlike the glide write above — which must stay on the IMMEDIATE
    // source, because whoever sits directly upstream owns the pitch — this resolves the
    // source TRANSITIVELY, so a rest still mutes through a quantizer or chord sequencer.
    // The `=== pitchSrc` short-circuit means a direct patch never pays for the walk, and
    // the walk itself only runs for a VCO whose CV really is a pass-through output.
    // Resolved per step rather than cached: the origin depends on cables that never touch
    // the VCO (patching seq→qnt-cv-in changes it for a VCO already fed by qnt-cv-out), so
    // a cache would need invalidating from every connect/disconnect site — more failure
    // surface than the few microseconds it saves at four steps a second.
    for (const vcoId of allVcoIdsRef.current) {
      const src = vcoActiveCvRef.current[vcoId];
      if (!src) continue;
      if (src === pitchSrc || resolveCvOrigin(src, connectionsRef.current) === pitchSrc)
        n[`${vcoId}bus`].gain._param.setValueAtTime(gateVal, time);
    }
    if (gateActionsRef.current.size > 0) {
      const stepDur  = fires ? Tone.Time('8n').toSeconds() : 0;
      const gateSrc  = `${seqId}-gate-out`;
      for (const [, action] of gateActionsRef.current) {
        if (action.fromId !== gateSrc) continue;
        if (action.isKick) {
          const kid = action.kickId ?? 'kick';
          if (fires && n[`${kid}Synth`]) {
            const kt = nextKickTime(kickLastTimeRef.current, kid, time);
            const kd = kickDecayRef.current[kid] ?? 0.4;
            const khz = kickTuneHz(n, kid, connectionsRef.current, kickTuneRef.current[kid] ?? 55);
            n[`${kid}Synth`].triggerAttackRelease(khz, kd, kt);
            n[`${kid}ClickSynth`]?.triggerAttackRelease(kd * 0.1, kt);
            drawAt(kt, () => kickTrigCbRef.current[kid]?.());
          }
        } else if (action.isTrig) {
          // One-shot: a trigger has no "off", so a rest step simply doesn't fire.
          if (fires) triggerEnvOneShot(action.env, time);
        } else {
          if (fires) {
            action.env.triggerAttack(time);
            action.env.triggerRelease(time + stepDur * 0.8);
          } else {
            action.env.triggerRelease(time);
          }
        }
      }
    }
    // Notify UI for LED animation, scheduled AT the step's audio time — firing it
    // straight from this callback lit the LED ~lookAhead early (see drawAt).
    drawAt(time, () => seqStepCbRefs.current[seqId]?.(idx));
  }, '8n'), []);

  // One chord-seq loop body for every instance (Phase 60e part 2) — the chord
  // analog of buildSeqLoop. Advances the 8-step chord program, writes the root
  // CV (unless the instance's cv-in snapper owns it), fires the polyphonic
  // root/3rd/5th voice outs with glide at each connected VCO's glideBus, and
  // pushes root+scale into the quantizer when THIS instance owns the
  // qnt-transpose-in override.
  const buildChordSeqLoop = useCallback((csId) => new Tone.Loop((time) => {
    const n = nodesRef.current;
    const steps = chordSeqStepsRefs.current[csId];
    if (!n || !steps) return;
    chordSeqCurrentStepRefs.current[csId] = (chordSeqCurrentStepRefs.current[csId] + 1) % 8;
    const idx  = chordSeqCurrentStepRefs.current[csId];
    const step = steps[idx];
    // Only write root Hz when no CV source is patched — the rAF snapper owns
    // the PitchOut while an input is active (single-writer rule).
    const chordHz  = CHORD_BASE_HZ * Math.pow(2, step.rootClass / 12);
    const cvOutSrc = `${csId}-cv-out`;
    if (!chordSeqInputActiveRefs.current[csId]) {
      n[`${csId}PitchOut`].setValueAtTime(chordHz, time);
      // No glide for the raw cv-out — instant jumps at the chord boundary.
      for (const vcoId of allVcoIdsRef.current) {
        if (vcoActiveCvRef.current[vcoId] === cvOutSrc)
          n[`${vcoId}GlideBus`]?.setValueAtTime(chordHz, time);
      }
    }
    // Polyphonic voice outputs — always fire regardless of cv-in state.
    const oct         = Math.pow(2, chordSeqRootOctaveRefs.current[csId] ?? 0);
    const shiftedRoot = chordHz * oct;
    const intervals   = CHORD_VOICE_INTERVALS[step.chordType] ?? CHORD_VOICE_INTERVALS.CMAJ;
    const voiceHz     = intervals.map(st => shiftedRoot * Math.pow(2, st / 12));
    n[`${csId}RootOut`].setValueAtTime(voiceHz[0], time);
    n[`${csId}ThirdOut`].setValueAtTime(voiceHz[1], time);
    n[`${csId}FifthOut`].setValueAtTime(voiceHz[2], time);
    // Glide (portamento) for the voice CV outs — applied at each VCO's glideBus,
    // matching the seq-pitch-out convention (instant signal jump, ramp at the bus).
    const chordGlide = chordSeqGlideRefs.current[csId] ?? 0;
    const VOICE_HZ = {
      [`${csId}-root-out`]: voiceHz[0],
      [`${csId}-3rd-out`]:  voiceHz[1],
      [`${csId}-5th-out`]:  voiceHz[2],
    };
    for (const vcoId of allVcoIdsRef.current) {
      const src = vcoActiveCvRef.current[vcoId];
      const vhz = VOICE_HZ[src];
      if (vhz === undefined) continue;
      const gb = n[`${vcoId}GlideBus`];
      if (!gb) continue;
      if (chordGlide < 0.001) gb.setValueAtTime(vhz, time);
      else                    gb.rampTo(vhz, chordGlide, time);
    }

    chordSeqStepCbRefs.current[csId]?.(idx);
    chordSeqChordCbRefs.current[csId]?.(step.rootClass, step.chordType);
    // Push root+scale into every quantizer whose transpose-in THIS instance's
    // cv-out is patched to (override owner per quantizer — Single Writer).
    for (const [qid, owner] of Object.entries(qntChordOverrideRef.current)) {
      if (owner !== csId || !n.qntNodes?.[qid]) continue;
      const qp = quantizerParamsRefs.current[qid];
      if (!qp) continue;
      qp.root  = step.rootClass;
      qp.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
      n.qntNodes[qid].port.postMessage(qp);
    }
  }, chordSeqDivisionRefs.current[csId] ?? '1m'), []);

  // Node creation runs in a LAYOUT effect (not passive): React fires ALL layout
  // effects before ANY passive effect, so the nodes exist by the time each
  // module's passive `onParamUpdate` effect fires on mount. As a plain
  // useEffect this was a passive PARENT effect, which runs AFTER the child
  // module passive effects — so a module's mount-time param write hit
  // `nodesRef.current === null` and no-op'd, leaving the audio at each node's
  // hardcoded default until the knob was moved. Invisible pre-Phase-63 (knobs
  // always started at those same defaults); the bug surfaced once saved
  // settings could differ from the node defaults. (Phase 63b fix.)
  useLayoutEffect(() => {
    const n = {
      // VCO core is the hard-sync AudioWorklet (Phase 68b) — one phase accumulator
      // emitting 4 simultaneous waveforms. These per-VCO Signals are the SOLE
      // writers of its params (connected in wire()): GlideBus → a-rate slaveFreq
      // (Hz; FM sums on top), DetuneSig → slaveDetune (cents), WidthSig →
      // pulseWidth (0..1; PW-CV sums on top). Signals hold their value before the
      // async worklet loads, so restored knob positions apply the instant it wires.
      // GlideBus ~185 Hz = freqBase 0.5; DetuneSig 0; WidthSig 0.5 (square).
      vco1GlideBus: new Tone.Signal(185),
      vco2GlideBus: new Tone.Signal(185),
      vco3GlideBus: new Tone.Signal(185),
      vco4GlideBus: new Tone.Signal(185),
      vco5GlideBus: new Tone.Signal(185),
      vco1DetuneSig: new Tone.Signal(0),
      vco2DetuneSig: new Tone.Signal(0),
      vco3DetuneSig: new Tone.Signal(0),
      vco4DetuneSig: new Tone.Signal(0),
      vco5DetuneSig: new Tone.Signal(0),
      vco1WidthSig: new Tone.Signal(0.5),
      vco2WidthSig: new Tone.Signal(0.5),
      vco3WidthSig: new Tone.Signal(0.5),
      vco4WidthSig: new Tone.Signal(0.5),
      vco5WidthSig: new Tone.Signal(0.5),
      noiseW:      new Tone.Noise({ type: 'white' }),
      noiseP:      new Tone.Noise({ type: 'pink'  }),
      noise2W:     new Tone.Noise({ type: 'white' }),
      noise2P:     new Tone.Noise({ type: 'pink'  }),
      noise3W:     new Tone.Noise({ type: 'white' }),
      noise3P:     new Tone.Noise({ type: 'pink'  }),
      // Noise LEVEL gains (Phase 8b) — the WHT/PNK jacks tap these, one pair
      // per module so the LEVEL knob scales both outputs. Gain(1) = unity at
      // the knob's 0.7 default (updateNoiseParams maps level × 1/0.7).
      noiseWGain:  new Tone.Gain(1),
      noisePGain:  new Tone.Gain(1),
      noise2WGain: new Tone.Gain(1),
      noise2PGain: new Tone.Gain(1),
      noise3WGain: new Tone.Gain(1),
      noise3PGain: new Tone.Gain(1),
      vcf:         new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vcf2:        new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 }),
      vca:         new Tone.Gain(1.0),
      vca2:        new Tone.Gain(1.0),
      vca3:        new Tone.Gain(1.0),
      env1:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env2:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env3:        new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      lfo:         new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),
      lfo2:        new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),

      // Rate-mod Gain nodes — sit between an incoming CV cable and lfo.frequency.
      // gain=0 on init so no modulation until the MOD DEPTH knob is raised.
      // Single writer: updateLfoParams/updateLfo2Params owns these via safeRamp.
      lfo1modGain: new Tone.Gain(0),
      lfo2modGain: new Tone.Gain(0),

      // Waveform analyser taps — read last sample each rAF for an instantaneous
      // phase value that drives the rate LED (pulses at the actual modulated rate).
      // 32-sample buffer = 0.73ms at 44100Hz — effectively instantaneous at LFO rates.
      lfoWaveAnalyser:  new Tone.Analyser('waveform', 32),
      lfo2WaveAnalyser: new Tone.Analyser('waveform', 32),

      // LFO tempo-sync output stage (Phase 65). Every output jack taps `${id}Out`.
      // Free mode: oscillator → oscGain(1) → Out. Sync mode: syncSig (rAF-written)
      // → syncGain(1) → Out, oscGain crossfaded to 0. The two gains crossfade over
      // 50 ms so mode flips are click-free (the setArpFx pattern). Meter + wave
      // analyser tap Out so the LED/display reflect whichever source is live.
      lfoOut:      new Tone.Gain(1),   lfo2Out:      new Tone.Gain(1),
      lfoOscGain:  new Tone.Gain(1),   lfo2OscGain:  new Tone.Gain(1),
      lfoSyncSig:  new Tone.Signal(0), lfo2SyncSig:  new Tone.Signal(0),
      lfoSyncGain: new Tone.Gain(0),   lfo2SyncGain: new Tone.Gain(0),
      master:      new Tone.Volume(-14),             // no longer goes direct to Destination
      seqMasterGate: new Tone.Gain(1).toDestination(), // sole gateway to speakers — Loop gates here
      analyser:    new Tone.Analyser('waveform', 512),
      seqPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // never init to 0 — exponential ramps from 0 are undefined
      seq2PitchOut:      new Tone.Signal(SEQ_HZ_MIN), // second sequencer pitch CV — same non-zero init rule
      kbdPitchOut:       new Tone.Signal(SEQ_HZ_MIN), // keyboard pitch CV out — same non-zero init rule
      chordseqPitchOut:      new Tone.Signal(SEQ_HZ_MIN), // chord sequencer root CV out — same rule
      chordseqRootOut:       new Tone.Signal(SEQ_HZ_MIN), // independent root-note CV out (octave-shifted)
      chordseqThirdOut:      new Tone.Signal(SEQ_HZ_MIN), // 3rd of chord CV
      chordseqFifthOut:      new Tone.Signal(SEQ_HZ_MIN), // 5th of chord CV
      chordseqInputAnalyser: new Tone.Analyser('waveform', 256), // detects patched pitch CV input

      // Studio reverb — Freeverb (proven in this codebase via VoxTool arpReverb).
      // wet starts at 0 so patching in the reverb doesn't colour sound until MIX is raised.
      reverb:  new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),
      reverb2: new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 }),

      // Aura display FFT taps (Phase 56) — dead-end side connections on each
      // reverb's OUTPUT (not input) so the halo keeps shimmering through the
      // tail after the source stops — that's what reads as "reverb" on screen.
      reverbAnalyser:  new Tone.Analyser('fft', 256),
      reverb2Analyser: new Tone.Analyser('fft', 256),
      // MIX CV (Phase 70) — sums onto Freeverb's `wet` (a CrossFade fade Signal, so it
      // is connectable and self-clamps to 0..1). The MIX knob owns the intrinsic value,
      // the cable owns the connected input: the standard Moog knob+CV split. Unity gain
      // — depth is set at the source (an LFO's DEPTH knob), matching the decision not to
      // put attenuators on the VCF's CV inputs.
      reverbMixCv:  new Tone.Gain(1),
      reverb2MixCv: new Tone.Gain(1),

      // Bucket Brigade Chorus — internal LFOs require explicit start()/stop() in powerOn/powerOff.
      // wet:1 — the Chorus runs fully wet and the EXTERNAL Dry/Wet gains do the mix, so
      // the BBD tone filter can sit on the wet path alone (see the BBD notes above).
      // Dry starts at 1 / Wet at 0, so patching is transparent until MIX is raised.
      chorus:     new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 1.0 }),
      chorusIn:   new Tone.Gain(1),
      chorusDry:  new Tone.Gain(1),
      chorusWet:  new Tone.Gain(0),
      chorusTone: new Tone.Filter({ frequency: bbdToneHz(0.75), type: 'lowpass', rolloff: -12 }),
      chorusOut:  new Tone.Gain(1),
      chorusRateCv: new Tone.Gain(3),   // CV ±1 → ±3 Hz on the chorus LFO
      // Hand-built feedback return — see the BBD notes.
      chorusFbHp: new Tone.Filter({ frequency: BBD_FB_HP_HZ, type: 'highpass', rolloff: -12 }),
      chorusSat:  new Tone.WaveShaper((x) => Math.tanh(x * 1.2), 1024),
      chorusFb:   new Tone.Gain(0),
      chorusFbDly: new Tone.Delay(BBD_FB_DELAY_S),   // breaks the delay-free cycle — see BBD_FB_DELAY_S

      // (Phase 71: seqGateNode / seq2GateNode removed — they sat between n.vca and
      // the vca-out jacks and chopped VCA 1's output to sequencer 1's rhythm with no
      // cable patched. buildSeqLoop's write is optional-chained, so the statics now
      // behave exactly like the dynamic sequencers, which never had a VCA tap.)

      // Recording tap — side connection from seqMasterGate so the Workstation's
      // Tone.Recorder can capture Moog audio without touching the speaker path.
      moogBus: new Tone.Gain(1),

      // I/O 4-channel input gains — each sums independently into n.master.
      // Single writer per node: updateIoChannelVol owns these gain params.
      // Meters tap post-gain so LEDs show each channel's actual contribution.
      ioCh1: new Tone.Gain(0.8),
      ioCh2: new Tone.Gain(0.8),
      ioCh3: new Tone.Gain(0.8),
      ioCh4: new Tone.Gain(0.8),
      ioCh1Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh2Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh3Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),
      ioCh4Meter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),

      // Built-in vocoder mic — Tone.UserMedia (opened on enable) → extMicGain (MIC IN level)
      // → vocModRaw (the vocoder modulator pre-chain). extMicMeter taps post-gain for the
      // SIG LED (getMeterValue('extMic')).
      extMicGain:  new Tone.Gain(1),
      // Per-vocoder mic level. The Tone.UserMedia and extMicGain are a SINGLETON shared
      // by every vocoder instance, but the MIC knob is per-instance — so before Phase 81
      // both instances' knobs wrote the one extMicGain and fought over it (turning voc2's
      // MIC silently moved voc1's, and the two knob positions disagreed with reality).
      // One gain per instance restores single-writer; extMicGain now stays at unity and
      // is purely the shared tap point for the mic + its SIG meter.
      vocMicGain:  new Tone.Gain(1),
      extMicMeter: new Tone.Meter({ normalRange: true, smoothing: 0.2 }),

      // VCO core routing (Phase 68b), replicated per VCO. The hard-sync worklet
      // (created in wire()) emits ONE 4-channel signal → coreGate (power gate) →
      // bus (sequencer per-step gate) → ChannelSplitter (in wire()) → 4 waveform
      // tap gains (Sin/Tri/Saw/Pulse) → the output jacks. syncIn buffers the
      // master patched to SYNC IN into the worklet input; pw scales PW-CV onto
      // the worklet's pulseWidth param.
      vco1syncIn: new Tone.Gain(1), vco1coreGate: new Tone.Gain(0), vco1bus: new Tone.Gain(1),
      vco1Sin: new Tone.Gain(1), vco1Tri: new Tone.Gain(1), vco1Saw: new Tone.Gain(1), vco1Pulse: new Tone.Gain(1), vco1pw: new Tone.Gain(0.4),
      vco2syncIn: new Tone.Gain(1), vco2coreGate: new Tone.Gain(0), vco2bus: new Tone.Gain(1),
      vco2Sin: new Tone.Gain(1), vco2Tri: new Tone.Gain(1), vco2Saw: new Tone.Gain(1), vco2Pulse: new Tone.Gain(1), vco2pw: new Tone.Gain(0.4),
      vco3syncIn: new Tone.Gain(1), vco3coreGate: new Tone.Gain(0), vco3bus: new Tone.Gain(1),
      vco3Sin: new Tone.Gain(1), vco3Tri: new Tone.Gain(1), vco3Saw: new Tone.Gain(1), vco3Pulse: new Tone.Gain(1), vco3pw: new Tone.Gain(0.4),
      vco4syncIn: new Tone.Gain(1), vco4coreGate: new Tone.Gain(0), vco4bus: new Tone.Gain(1),
      vco4Sin: new Tone.Gain(1), vco4Tri: new Tone.Gain(1), vco4Saw: new Tone.Gain(1), vco4Pulse: new Tone.Gain(1), vco4pw: new Tone.Gain(0.4),
      vco5syncIn: new Tone.Gain(1), vco5coreGate: new Tone.Gain(0), vco5bus: new Tone.Gain(1),
      vco5Sin: new Tone.Gain(1), vco5Tri: new Tone.Gain(1), vco5Saw: new Tone.Gain(1), vco5Pulse: new Tone.Gain(1), vco5pw: new Tone.Gain(0.4),

      // Quantizer output wrapper — gain 1 (always pass-through).
      // AudioWorkletNode (quantizerNode) connects to .input after worklet loads.
      // Tone.Gain so that downstream Tone.js nodes (vco.frequency) can receive it.
      qntOut:    new Tone.Gain(1),
      // Silent keepalive — qntOut must stay connected to the audio graph or
      // Chrome's tail-time optimisation stops calling the worklet's process(), which
      // silences port.postMessage() and breaks the managed glideBus path.
      qntKeepAlive: new Tone.Gain(0),

      // Transposition CV analyser — taps the incoming TRANSPOSE CV signal so the
      // QuantizerModule's rAF loop can read the current Hz value and derive a note class.
      // Tone.Analyser with 'waveform' type calls getFloatTimeDomainData, which returns
      // the actual float values (Hz) from the ConstantSourceNode inside Tone.Signal.
      // When nothing is connected the analyser returns all zeros → avgHz = 0 < 10 → inactive.
      qntTransposeAnalyser: new Tone.Analyser('waveform', 256),

      // Level meters — dead-end side taps for LED feedback (no effect on audio routing).
      // smoothing controls the RMS window: higher = more averaged, lower = more transient-responsive.
      vco1Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco3Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco4Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      vco5Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.15 }),
      lfoMeter:    new Tone.Meter({ normalRange: true, smoothing: 0.7  }),
      lfo2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.7  }),
      env1Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      env2Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      env3Meter:   new Tone.Meter({ normalRange: true, smoothing: 0.25 }),
      masterMeter: new Tone.Meter({ normalRange: true, smoothing: 0.2  }),

      // CV input scalers — LFO outputs -1..+1 which adds ±1 Hz directly to frequency
      // params: completely inaudible. These Gain nodes sit between a patch cable's source
      // and the AudioParam, scaling the signal to a musically useful range.
      //
      // vco?-cv (pitch CV) stays DIRECT to frequency — the sequencer outputs Hz values
      // (32–1046 Hz) and patches here; multiplying by 500 would wreck it.
      // vco?-fm (FM / LFO mod) goes through a ×500 scaler: LFO at depth=1 → ±500 Hz.
      //
      // VCF cv1/cv2/env are CENTS scalers feeding filter.detune (Phase 70) — see
      // VCF_CV_CENTS. The env scaler's gain is owned by the ENV AMT knob and is
      // initialised at the knob's default (0.5) so the mount-time param write is a no-op.
      // FM chain per VCO (Phase 70): the JACK now lands on `${id}fmIn` (unity), which
      // fans to `${id}fm` (×500 → slaveFreq, the direct audio-rate path) and to
      // `${id}fmAnalyser`. Quantized FM mutes `${id}fm` while still reading the raw
      // ±1 modulator off the analyser — which is why the tap has to sit BEFORE the
      // ×500 stage rather than after it.
      vco1fmIn: new Tone.Gain(1),
      vco2fmIn: new Tone.Gain(1),
      vco3fmIn: new Tone.Gain(1),
      vco4fmIn: new Tone.Gain(1),
      vco5fmIn: new Tone.Gain(1),
      vco1fmAnalyser: new Tone.Analyser('waveform', 32),
      vco2fmAnalyser: new Tone.Analyser('waveform', 32),
      vco3fmAnalyser: new Tone.Analyser('waveform', 32),
      vco4fmAnalyser: new Tone.Analyser('waveform', 32),
      vco5fmAnalyser: new Tone.Analyser('waveform', 32),
      vco1fm: new Tone.Gain(500),
      vco2fm: new Tone.Gain(500),
      vco3fm: new Tone.Gain(500),
      vco4fm: new Tone.Gain(500),
      vco5fm: new Tone.Gain(500),
      vcfcv1: new Tone.Gain(VCF_CV_CENTS),
      vcfcv2: new Tone.Gain(VCF_CV_CENTS),
      vcfenv: new Tone.Gain(vcfEnvAmtCents(0.5)),
      vcf2cv1: new Tone.Gain(VCF_CV_CENTS),
      vcf2cv2: new Tone.Gain(VCF_CV_CENTS),
      vcf2env: new Tone.Gain(vcfEnvAmtCents(0.5)),

      // 914 Fixed Filter Bank — parallel bandpass architecture.
      // ffbIn fans out to 14 filters; each filter → Gain (slider-controlled); all Gains → ffbSum → ffbMaster.
      // The analyser taps ffbMaster (post-bank), so the per-band LEDs show FILTERED output.
      // LP/HP use shelf filters; bandpass use Tone.Filter(bandpass). The Gain nodes (not filter.gain)
      // control amplitude — BiquadFilter bandpass type has no gain parameter.
      // Kick drum engine — MembraneSynth (pitch-drop oscillator + envelope) in parallel
      // with a NoiseSynth click transient through a 2 kHz highpass.
      // kickOut is the jack output; kickClickGain scales the transient independently.
      kickSynth:      new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 5,
                          envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } }),
      kickClickSynth: new Tone.NoiseSynth({ noise: { type: 'white' },
                          envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } }),
      kickClickFilter: new Tone.Filter({ frequency: 2000, type: 'highpass', rolloff: -12 }),
      kickClickGain:   new Tone.Gain(0.25),
      kickTuneCv:         new Tone.Gain(1),                        // TUNE CV jack buffer
      kickTuneCvAnalyser: new Tone.Analyser('waveform', 128),      // sampled at trigger time
      kickOut:         new Tone.Gain(1),

      // 914 Fixed Filter Bank — parallel bandpass architecture.
      ffbIn:       new Tone.Gain(1),
      ffbSum:      new Tone.Gain(1),
      ffbMaster:   new Tone.Gain(1),
      ffbAnalyser: new Tone.Analyser('fft', 512),
      ...Object.fromEntries(FFB_BANDS.map((b, i) => [`ffbFilter${i}`, new Tone.Filter({ type: b.type, frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      ...Object.fromEntries(FFB_BANDS.map((_, i) => [`ffbGain${i}`,   new Tone.Gain(0.75)])),
      // SWEEP stage (Phase 70): filter → Sweep(rAF-owned) → Gain(knob-owned) → sum.
      // Two separate stages so single-writer holds — the sweep rAF and the band knobs
      // would otherwise both write the same gain node.
      ...Object.fromEntries(FFB_BANDS.map((_, i) => [`ffbSweep${i}`,  new Tone.Gain(1)])),
      ffbMasterCv: new Tone.Gain(1),                      // CV sums onto ffbMaster.gain
      ffbSweepCv:  new Tone.Gain(1),
      ffbSweepAnalyser: new Tone.Analyser('waveform', 32), // rAF samples the sweep CV here

      // 16-band Vocoder — modulator analysis bank gates a carrier synthesis bank.
      // vocModIn fans to 16 modulator bands: BPF → full-wave rectifier (WaveShaper, drive
      // baked in) → ~20 Hz envelope-follower LP. Each envelope LP connects to the matching
      // carrier band's VCA gain (audio-rate, zero polling). MIX crossfades carrier-dry
      // (vocDry) ↔ vocoded-wet (vocWet) into vocOut. vocAnalyser taps vocModIn for the meter.
      vocModIn:    new Tone.Gain(1),
      vocCarrIn:   new Tone.Gain(1),
      vocSum:      new Tone.Gain(1),
      vocWet:      new Tone.Gain(1),
      vocDry:      new Tone.Gain(0),
      vocOut:      new Tone.Gain(3),  // fixed internal makeup (the band bank is quiet); user level is VOLUME
      vocAnalyser: new Tone.Analyser('fft', 512),
      // Carrier bank feed — patched carrier + HISS/BUZZ excitation sum here before the
      // filter bank. vocDry taps vocCarrIn (raw carrier) directly, so HISS/BUZZ never
      // leak into the dry path — they only appear in the vocoded (wet) signal.
      vocCarrBank: new Tone.Gain(1),
      // Internal carrier oscillator (FREQ + PWIDTH) crossfaded with the external
      // voc-carr-in by CARR MIX. vocCarrSum = mixed carrier (no noise) → feeds both the
      // band bank and vocDry. A pulse wave is a harmonically rich, classic vocoder carrier.
      vocCarrOsc:     new Tone.PulseOscillator({ frequency: 130, width: 0 }),
      vocCarrOscGain: new Tone.Gain(0),  // internal-osc level (CARR MIX)
      vocCarrExtGain: new Tone.Gain(1),  // external-carrier level (CARR MIX)
      vocCarrSum:     new Tone.Gain(1),  // mixed carrier bus
      vocVolume:      new Tone.Gain(1),  // final module output (VOLUME) — the voc-out jack node
      // HISS — high-passed white noise added to the carrier so unvoiced consonants
      // (s, sh, t, f) surface through the high bands. Gain owned by updateVocoderParams.
      vocHissNoise: new Tone.Noise({ type: 'white' }),
      vocHissHP:    new Tone.Filter({ type: 'highpass', frequency: 3500, rolloff: -12 }),
      vocHissGain:  new Tone.Gain(0),
      // BUZZ — low-passed pink noise added to the carrier for low-end body/thump,
      // thickening vowels. Gain owned by updateVocoderParams.
      vocBuzzNoise: new Tone.Noise({ type: 'pink' }),
      vocBuzzLP:    new Tone.Filter({ type: 'lowpass', frequency: 250, rolloff: -12 }),
      vocBuzzGain:  new Tone.Gain(0),
      // CLARITY — high-passed (~1.5 kHz) dry modulator (the real voice's consonants/
      // sibilance) blended straight into the output for word intelligibility. Bypasses
      // the band bank entirely (it is the actual voice, not vocoded). Gain owned by
      // updateVocoderParams. The headline intelligibility control.
      vocClarityHP:   new Tone.Filter({ type: 'highpass', frequency: 1500, rolloff: -12 }),
      vocClarityGain: new Tone.Gain(0),
      // Modulator pre-processing chain (always on, voice-optimized): the voc-mod-in jack
      // lands on vocModRaw → highpass (rumble/plosive removal; voice intelligibility lives
      // in formants >300 Hz so the lost lows don't matter) → compressor (even drive into the
      // envelope followers = consistent, "pro" vocoding) → vocModIn (existing fan-out).
      vocModRaw:  new Tone.Gain(1),
      vocModHP:   new Tone.Filter({ type: 'highpass', frequency: 150, rolloff: -12 }),
      vocModComp: new Tone.Compressor({ threshold: -28, ratio: 4, attack: 0.003, release: 0.12 }),
      // PRESENCE — peaking EQ (~2.7 kHz) on the vocoded output so the robot voice cuts
      // through. Gain (dB) owned by updateVocoderParams; sits vocOut → vocPresence → vocVolume.
      vocPresence: new Tone.Filter({ type: 'peaking', frequency: 2700, Q: 1, gain: 0 }),
      // Hard-knee brick wall, copied from the VOWEL module's output stage — NOT Tone.Limiter,
      // whose 30 dB soft knee barely compresses (the Phase 64a finding). It catches the peaks
      // the Q-tracking makeup lets through and is a large part of why VOWEL reads as "clean".
      // Sits before VOLUME so the user's level control isn't fighting it, and CLARITY still
      // sums after it — the real voice bypasses the bank's limiter exactly as in VOWEL.
      vocLimit: new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0.003, release: 0.05 }),
      ...Object.fromEntries(VOC_BANDS.map((b, i) => [`vocModBPF${i}`,  new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      // Per-band drive = VOC_ENV_DRIVE × the pre-emphasis tilt. Set once at construction;
      // nothing writes these afterwards, so the env follower stays the VCA gain's one driver.
      ...Object.fromEntries(VOC_BANDS.map((b, i) => [`vocModDrive${i}`, new Tone.Gain(VOC_ENV_DRIVE * vocBandTilt(b.freq))])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocModRect${i}`, new Tone.WaveShaper(vocRectShape, VOC_RECT_POINTS)])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocModEnv${i}`,  new Tone.Filter({ type: 'lowpass', frequency: 20, Q: 0.5, rolloff: -12 })])),
      ...Object.fromEntries(VOC_BANDS.map((b, i) => [`vocCarrBPF${i}`, new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 })])),
      ...Object.fromEntries(VOC_BANDS.map((_, i) => [`vocCarrVCA${i}`, new Tone.Gain(0)])),
    };

    // VCO core routing (Phase 68b). The worklet → coreGate, the ChannelSplitter →
    // waveform taps, and glideBus/fm/pw → worklet params are all wired in wire()
    // once the async worklet loads. Here we wire the synchronous Tone edges:
    // coreGate (power gate) → bus (sequencer per-step gate), and the SAW tap → the
    // level meter. The four waveform taps route to their jacks directly.
    for (const v of ['vco1', 'vco2', 'vco3', 'vco4', 'vco5']) {
      n[`${v}coreGate`].connect(n[`${v}bus`]);
      n[`${v}Saw`].connect(n[`${v}Meter`]);
    }

    // Keyboard vibrato — additive pitch modulation on all VCOs.

    // → detune (cents), not frequency (Hz): exponential cutoff modulation. Phase 70.
    // FM tap chain (Phase 70) — fmIn → fm (×500 → slaveFreq, wired in the worklet
    // wire()) and fmIn → analyser (raw ±1, read by qntFmTick).
    for (const v of VCO_IDS) {
      n[`${v}fmIn`].connect(n[`${v}fm`]);
      n[`${v}fmIn`].connect(n[`${v}fmAnalyser`]);
    }

    // → detune (cents), not frequency (Hz): exponential cutoff modulation. Phase 70.
    n.vcfcv1.connect(n.vcf.detune);
    n.vcfcv2.connect(n.vcf.detune);
    n.vcfenv.connect(n.vcf.detune);
    n.vcf2cv1.connect(n.vcf2.detune);
    n.vcf2cv2.connect(n.vcf2.detune);
    n.vcf2env.connect(n.vcf2.detune);

    // I/O channel gains → master: each channel has its own Gain node so the
    // 4-channel mixer faders are independent. Meters tap from the channel output
    // (post-gain) so LEDs reflect the actual contribution of each channel.
    n.ioCh1.connect(n.master);
    n.ioCh2.connect(n.master);
    n.ioCh3.connect(n.master);
    n.ioCh4.connect(n.master);
    n.ioCh1.connect(n.ioCh1Meter);
    n.ioCh2.connect(n.ioCh2Meter);
    n.ioCh3.connect(n.ioCh3Meter);
    n.ioCh4.connect(n.ioCh4Meter);
    n.extMicGain.connect(n.extMicMeter); // dead-end level tap for the mic LED
    // Built-in mic → vocoder modulator. The mic feeds the same pre-chain front (vocModRaw)
    // as the MOD jack, so enabling the mic + a carrier vocodes instantly (no patching), and
    // an external MOD patch still sums in. extMicGain is silent until the mic is enabled.
    n.extMicGain.connect(n.vocMicGain);
    n.vocMicGain.connect(n.vocModRaw);
    // (VCO level meters are fed from each VCO's SAW tap in the core-routing loop above.)

    // master → seqMasterGate → Destination: every patch cable that reaches io-in
    // or any io-inN channel flows through master, then seqMasterGate. No step loop
    // writes seqMasterGate (that would silence the other sequencers) — powerOff is
    // its only writer, so it is a unity pass-through in practice.
    n.master.connect(n.seqMasterGate);

    // moogBus: side tap after the master gate, feeds the Workstation's Tone.Recorder.
    // Does not connect to Destination — purely a recording tap.
    n.seqMasterGate.connect(n.moogBus);

    // Oscilloscope taps master (pre-gate, so the scope still shows waveform shape
    // even on muted steps — useful for debugging patches).
    n.master.connect(n.analyser);
    // Quantizer keepalive: gain(0) ensures qntOut stays connected to the
    // audio graph so Chrome never stops calling the worklet's process() callback.
    n.qntOut.connect(n.qntKeepAlive);
    n.qntKeepAlive.connect(Tone.Destination);

    // Noise sources → LEVEL gains (Phase 8b) — the jacks tap the gains.
    n.noiseW.connect(n.noiseWGain);
    n.noiseP.connect(n.noisePGain);
    n.noise2W.connect(n.noise2WGain);
    n.noise2P.connect(n.noise2PGain);
    n.noise3W.connect(n.noise3WGain);
    n.noise3P.connect(n.noise3PGain);
    // Brown source + blue/violet/grey colour chains (Phase 69), per static instance.
    buildNoiseColors(n, 'noise');
    buildNoiseColors(n, 'noise2');
    buildNoiseColors(n, 'noise3');

    // Kick engine — MembraneSynth and click transient both feed kickOut
    n.kickSynth.connect(n.kickOut);
    n.kickClickSynth.connect(n.kickClickFilter);
    n.kickClickFilter.connect(n.kickClickGain);
    n.kickClickGain.connect(n.kickOut);
    n.kickTuneCv.connect(n.kickTuneCvAnalyser);

    // 914 FFB — parallel bandpass sum
    FFB_BANDS.forEach((_, i) => {
      n.ffbIn.connect(n[`ffbFilter${i}`]);
      n[`ffbFilter${i}`].connect(n[`ffbSweep${i}`]);
      n[`ffbSweep${i}`].connect(n[`ffbGain${i}`]);
      n[`ffbGain${i}`].connect(n.ffbSum);
    });
    n.ffbSum.connect(n.ffbMaster);
    n.ffbMaster.connect(n.ffbAnalyser);   // POST-bank: LEDs must follow the sliders (Phase 56 rule)
    n.ffbMasterCv.connect(n.ffbMaster.gain);
    n.ffbSweepCv.connect(n.ffbSweepAnalyser);

    // 16-band Vocoder — modulator envelope followers gate carrier band VCAs.
    // Single writer per node: each vocCarrVCA.gain is driven only by its env follower
    // (audio connection into the AudioParam); vocWet/vocDry.gain owned by updateVocoderParams.
    VOC_BANDS.forEach((_, i) => {
      n.vocModIn.connect(n[`vocModBPF${i}`]);
      n[`vocModBPF${i}`].connect(n[`vocModDrive${i}`]);   // drive + pre-emphasis tilt
      n[`vocModDrive${i}`].connect(n[`vocModRect${i}`]);
      n[`vocModRect${i}`].connect(n[`vocModEnv${i}`]);
      n[`vocModEnv${i}`].connect(n[`vocCarrVCA${i}`].gain); // audio-rate env → VCA gain
      n.vocCarrBank.connect(n[`vocCarrBPF${i}`]);
      n[`vocCarrBPF${i}`].connect(n[`vocCarrVCA${i}`]);
      n[`vocCarrVCA${i}`].connect(n.vocSum);
    });
    // Carrier sum — external (voc-carr-in) + internal pulse osc, blended by CARR MIX.
    // Feeds both the band bank (vocoded) and vocDry (passthrough). HISS/BUZZ go to the
    // bank only, so they never leak into vocDry.
    n.vocCarrIn.connect(n.vocCarrExtGain);
    n.vocCarrExtGain.connect(n.vocCarrSum);
    n.vocCarrOsc.connect(n.vocCarrOscGain);
    n.vocCarrOscGain.connect(n.vocCarrSum);
    n.vocCarrSum.connect(n.vocCarrBank); // mixed carrier → band bank (vocoded path)
    n.vocCarrSum.connect(n.vocDry);      // dry = mixed carrier passthrough (no HISS/BUZZ)
    // HISS/BUZZ excitation → bank only, shaped by the modulator envelope.
    n.vocHissNoise.connect(n.vocHissHP);
    n.vocHissHP.connect(n.vocHissGain);
    n.vocHissGain.connect(n.vocCarrBank);
    n.vocBuzzNoise.connect(n.vocBuzzLP);
    n.vocBuzzLP.connect(n.vocBuzzGain);
    n.vocBuzzGain.connect(n.vocCarrBank);
    // Modulator pre-processing — jack lands on vocModRaw; HP + noise gate + compressor
    // condition the voice before it fans out (vocModIn keeps all its downstream edges).
    n.vocModRaw.connect(n.vocModHP);
    buildVocGate(n, 'voc');          // splices vocModHP → gate → vocModComp
    n.vocModComp.connect(n.vocModIn);
    // Output stage: vocoded (wet) + carrier (dry) → vocOut (OUT makeup) → vocPresence (EQ).
    n.vocSum.connect(n.vocWet);
    n.vocWet.connect(n.vocOut);
    n.vocDry.connect(n.vocOut);
    n.vocOut.connect(n.vocPresence);
    // CLARITY — high-passed real voice to the volume stage (bypasses OUT makeup + presence).
    n.vocModIn.connect(n.vocClarityHP);
    n.vocClarityHP.connect(n.vocClarityGain);
    n.vocClarityGain.connect(n.vocVolume);
    // Final master volume (VOL) → voc-out jack.
    n.vocPresence.connect(n.vocLimit);
    n.vocLimit.connect(n.vocVolume);
    n.vocModIn.connect(n.vocAnalyser); // FFT tap for the 16-segment meter

    // VCA CV chains (Phase 71) — ENV AMT attenuator + LOG/LIN response curve
    // between each -cv jack and the Gain's gain param. See buildVcaCv.
    buildVcaCv(n, 'vca');
    buildVcaCv(n, 'vca2');
    buildVcaCv(n, 'vca3');

    // Aura display taps — dead-end, post-reverb (see node creation note).
    n.reverb.connect(n.reverbAnalyser);
    n.reverb2.connect(n.reverb2Analyser);
    n.reverbMixCv.connect(n.reverb.wet);
    n.reverb2MixCv.connect(n.reverb2.wet);

    // BBD composite (Phase 70) — see the BBD notes for why the tone filter is wet-only.
    n.chorusIn.connect(n.chorusDry);
    n.chorusIn.connect(n.chorus);
    n.chorus.connect(n.chorusTone);
    n.chorusTone.connect(n.chorusWet);
    n.chorusDry.connect(n.chorusOut);
    n.chorusWet.connect(n.chorusOut);
    n.chorusRateCv.connect(n.chorus.frequency);
    // Feedback return: tapped POST-tone so the lowpass is inside the loop.
    n.chorusTone.connect(n.chorusFbHp);
    n.chorusFbHp.connect(n.chorusSat);
    n.chorusSat.connect(n.chorusFb);
    n.chorusFb.connect(n.chorusFbDly);
    n.chorusFbDly.connect(n.chorus);

    // LFO output stage (Phase 65): osc → oscGain → Out; syncSig → syncGain → Out.
    // Out is the sole node the output jacks + meter + wave analyser tap.
    n.lfo.connect(n.lfoOscGain);     n.lfoOscGain.connect(n.lfoOut);
    n.lfoSyncSig.connect(n.lfoSyncGain); n.lfoSyncGain.connect(n.lfoOut);
    n.lfo2.connect(n.lfo2OscGain);   n.lfo2OscGain.connect(n.lfo2Out);
    n.lfo2SyncSig.connect(n.lfo2SyncGain); n.lfo2SyncGain.connect(n.lfo2Out);

    // Level meter taps — all dead-end side connections, do not affect audio routing.
    n.lfoOut.connect(n.lfoMeter);
    n.lfo2Out.connect(n.lfo2Meter);

    // Rate-mod Gain nodes feed directly into each LFO's frequency AudioParam.
    // When no cable is patched (gain=0) this adds exactly 0 Hz — fully transparent.
    n.lfo1modGain.connect(n.lfo.frequency);
    n.lfo2modGain.connect(n.lfo2.frequency);

    // Waveform analyser taps — dead-end, do not affect audio routing.
    n.lfoOut.connect(n.lfoWaveAnalyser);
    n.lfo2Out.connect(n.lfo2WaveAnalyser);
    n.env1.connect(n.env1Meter);
    n.env2.connect(n.env2Meter);
    n.env3.connect(n.env3Meter);
    // I/O PEAK lamp. Taps n.master — i.e. the actual signal leaving the rack,
    // post-MASTER-knob, which is what a peak indicator on an output stage should
    // read. It previously tapped seqGateNode (VCA 1's seq-gated output), so it was
    // blind to the MASTER knob and to every patch that didn't run through VCA 1.
    n.master.connect(n.masterMeter);

    // 960 sequencer loops — 8th-note clocks driven by Tone.Transport. Both
    // statics share the generic buildSeqLoop body (Phase 60e); dynamic
    // instances get theirs from addModule('seq').
    seqLoopsRef.current.seq  = buildSeqLoop('seq');
    seqLoopsRef.current.seq2 = buildSeqLoop('seq2');

    // Chord sequencer loop — the static instance shares the generic
    // buildChordSeqLoop body (Phase 60e part 2); dynamics get theirs from
    // addModule('chordseq').
    chordSeqLoopsRef.current.chordseq = buildChordSeqLoop('chordseq');

    // Pitch-snapping rAF — for EVERY registered chord seq (Phase 60e part 2):
    // reads each instance's cv-in analyser, snaps incoming Hz to that instance's
    // current chord tones, writes the snapped pitch to its PitchOut so a
    // downstream VCO always plays in tune. When no cable is patched an analyser
    // returns ~0 Hz (below the 10 Hz threshold) so that instance is a cheap
    // no-op and its chord Tone.Loop resumes ownership of the PitchOut.
    let chordSnapRafId;
    const prevChordSnaps = {}; // csId → delta gate — ramp only when pitch changes
    const chordSnapTick = () => {
      chordSnapRafId = requestAnimationFrame(chordSnapTick);
      for (const csId of chordSeqIdsRef.current) {
        const analyser = n[`${csId}InputAnalyser`];
        const data = analyser?.getValue();
        if (!data || !data.length) continue;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        const avgHz   = sum / data.length;
        const isActive = avgHz > 10;
        chordSeqInputActiveRefs.current[csId] = isActive;
        if (isActive && Tone.context.state === 'running') {
          const stepIdx = chordSeqCurrentStepRefs.current[csId];
          const step    = chordSeqStepsRefs.current[csId][Math.max(0, stepIdx)];
          const snapped = snapToChordHz(avgHz, step.rootClass, step.chordType);
          // Use value setter (immediate) — setValueAtTime with a future-scheduled
          // chord loop tick would otherwise fight this write in the same block.
          n[`${csId}PitchOut`].value = snapped;
          // Drive glideBus for VCOs connected from this instance's cv-out.
          // Delta-gated so rampTo fires once per pitch change, not every frame.
          if (snapped !== prevChordSnaps[csId]) {
            prevChordSnaps[csId] = snapped;
            // Glide amount: look up the source feeding this cv-in and use its glide ref.
            const cvKey = [...connectionsRef.current.keys()].find(k => k.endsWith(`→${csId}-cv-in`));
            const cvGlide = glideForPitchSource(cvKey?.split('→')[0]);
            const cvOutSrc = `${csId}-cv-out`;
            for (const vcoId of allVcoIdsRef.current) {
              if (vcoActiveCvRef.current[vcoId] !== cvOutSrc) continue;
              const gb = n[`${vcoId}GlideBus`];
              if (!gb) continue;
              if (cvGlide < 0.001) gb.setValueAtTime(snapped, Tone.now());
              else                  gb.rampTo(snapped, cvGlide, Tone.now());
            }
          }
        }
      }
    };
    chordSnapTick();

    // Quantizer chord-override rAF — continuously holds each overridden
    // quantizer's root+scale to its OWNING chord seq's current step at 60fps
    // (qntChordOverrideRef maps qid → owning csId). Running continuously means
    // nothing (QuantizerModule rAF, React effects, manual knob writes) can
    // overwrite the chord seq's chord for more than one frame. Per-qid
    // delta-checks so postMessage only fires when a chord actually changes.
    let qntOverrideRafId;
    const lastOverrideRoots  = {};
    const lastOverrideScales = {};
    const qntOverrideTick = () => {
      qntOverrideRafId = requestAnimationFrame(qntOverrideTick);
      for (const [qid, csId] of Object.entries(qntChordOverrideRef.current)) {
        const node  = n.qntNodes?.[qid];
        const steps = chordSeqStepsRefs.current[csId];
        const qp    = quantizerParamsRefs.current[qid];
        if (!node || !steps || !qp) continue;
        const stepIdx  = chordSeqCurrentStepRefs.current[csId];
        const step     = steps[Math.max(0, stepIdx)];
        const newRoot  = step.rootClass;
        const newScale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
        if (newRoot === lastOverrideRoots[qid] && newScale === lastOverrideScales[qid]) continue;
        lastOverrideRoots[qid]  = newRoot;
        lastOverrideScales[qid] = newScale;
        qp.root  = newRoot;
        qp.scale = newScale;
        node.port.postMessage(qp);
      }
    };
    qntOverrideTick();

    // Keyboard vibrato rAF — writes baseHz + depth*sin(2π*rate*t) to the glideBus
    // of every VCO connected from kbd-pitch-out. Uses the same native _param path
    // as the glide system — guaranteed to reach the actual AudioParam.
    let vibratoRafId;
    // Combined glide + vibrato rAF — the single writer for kbd-connected VCO glideBuses.
    // Glide is handled here via exponential lerp so setValueAtTime never conflicts with
    // a scheduled LinearRamp (which any setValueAtTime call would cancel).
    const vibratoTick = () => {
      vibratoRafId = requestAnimationFrame(vibratoTick);
      const now = Tone.context.rawContext.currentTime;

      // Consume note-on reset flag — stamp onset with THIS frame's `now` so elapsed is exactly 0.
      // Seed kbdCurrentHzRef from kbdLastOutputHzRef (actual pitch including any vibrato swing)
      // so the glide starts from the true current pitch with zero discontinuity.
      if (kbdVibratoResetRef.current) {
        kbdNoteOnsetRef.current  = now;
        kbdCurrentHzRef.current  = kbdLastOutputHzRef.current;
        kbdVibratoResetRef.current = false;
      }

      // Delta time for exponential glide lerp
      const prev = kbdPrevRafTimeRef.current ?? now;
      const dt   = Math.min(now - prev, 0.1); // cap at 100ms (e.g. tab backgrounding)
      kbdPrevRafTimeRef.current = now;

      // Glide: exponentially approach target Hz
      const glide = kbdGlideRef.current;
      const targetHz = kbdBaseHzRef.current;
      if (glide < 0.001) {
        kbdCurrentHzRef.current = targetHz;
      } else {
        const alpha = 1 - Math.exp(-dt / glide);
        kbdCurrentHzRef.current += alpha * (targetHz - kbdCurrentHzRef.current);
      }

      // Vibrato swing
      const depth     = kbdVibratoDepthRef.current;
      const delayTime = kbdVibratoDelayRef.current;
      const elapsed   = kbdNoteOnsetRef.current === null ? 0 : now - kbdNoteOnsetRef.current;
      const effectiveDepth = depth < 0.001 ? 0 : delayTime < 0.01
        ? depth
        : depth * Math.min(1, Math.max(0, elapsed / delayTime));
      const swing = effectiveDepth < 0.001
        ? 0
        : effectiveDepth * Math.sin(2 * Math.PI * kbdVibratoRateRef.current * now);

      // Write once per frame. During glide (glide > 0) we linearly ramp to the new
      // Hz over ~2 frames instead of a setValueAtTime hold — a bare setValueAtTime is
      // a zero-order hold, so the ~60 fps target updates render as an audible staircase
      // during a portamento sweep. linearRampToValueAtTime interpolates at audio rate,
      // giving a pure continuous glide (and smoother vibrato on held notes). Glide-off
      // keeps the instant setValueAtTime so note attacks stay snappy (no 32 ms slur).
      // This rAF is the sole writer of these glideBuses, so the ramps chain cleanly.
      const hz = Math.max(1, kbdCurrentHzRef.current + swing);
      kbdLastOutputHzRef.current = hz;
      const rampAhead = Math.max(dt * 2, 1 / 30); // stay ahead of the next frame so the param never holds flat
      const gliding = glide >= 0.001;
      for (const vcoId of allVcoIdsRef.current) {
        if (vcoActiveCvRef.current[vcoId] !== 'kbd-pitch-out') continue;
        const p = n[`${vcoId}GlideBus`]?._param;
        if (!p) continue;
        if (gliding) p.linearRampToValueAtTime(hz, now + rampAhead);
        else         p.setValueAtTime(hz, now);
      }
    };
    vibratoTick();

    // Vocoder spectral-shift rAF — for EVERY registered vocoder instance
    // (Phase 60e part 3): scales its 16 carrier bandpass center freqs by
    // ratio = base · 2^(ampOct · sin(2π·rate·t)). base ← SHIFT knob; LFO ← SH RATE / SH AMP.
    // Sole writer of `${vid}CarrBPF*`.frequency. Per-id delta gates — a static
    // shift settles to 0 writes.
    let vocShiftRafId;
    const vocShiftTick = () => {
      vocShiftRafId = requestAnimationFrame(vocShiftTick);
      const now = Tone.context.rawContext.currentTime;
      for (const vid of vocIdsRef.current) {
        const amp   = vocShiftLfoAmpRefs.current[vid] ?? 0;
        const lfo   = amp < 0.001 ? 1 : Math.pow(2, amp * Math.sin(2 * Math.PI * (vocShiftLfoRateRefs.current[vid] ?? 0.7) * now));
        const ratio = (vocShiftBaseRefs.current[vid] ?? 1) * lfo;
        if (Math.abs(ratio - (vocShiftLastRatioRefs.current[vid] ?? 0)) < 1e-4) continue; // unchanged — skip
        vocShiftLastRatioRefs.current[vid] = ratio;
        for (let i = 0; i < VOC_BANDS.length; i++) {
          const f = n[`${vid}CarrBPF${i}`];
          if (!f) continue;
          f.frequency.setValueAtTime(Math.max(20, Math.min(18000, VOC_BANDS[i].freq * ratio)), now);
        }
      }
    };
    vocShiftTick();

    // Vowel/formant rAF (Phase 64) — SOLE writer of every vowel instance's 3
    // formant filter frequencies. Combines the VOWEL-knob morph ref, the SHAPE
    // ref, and the sampled FORMANT-CV level; a per-instance delta gate makes an
    // idle module cost zero AudioParam writes (the vocShiftTick pattern).
    let vowelRafId;
    const vowelTick = () => {
      vowelRafId = requestAnimationFrame(vowelTick);
      const ids = vowelIdsRef.current;
      if (ids.length === 0) return;
      const now = Tone.context.rawContext.currentTime;
      for (const id of ids) {
        let cv = 0;
        const buf = n[`${id}CvAnalyser`]?.getValue();
        if (buf && buf.length) { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; cv = s / buf.length; }
        const shape = vowelShapeRefs.current[id] ?? 1.0;
        // CHAIN walks the A→E→I→O→U road; DIRECT flies straight between FROM and TO.
        // Both read the SAME morph knob + FORMANT-CV sum, so an envelope patched into
        // FORM CV drives either mode identically — only the path through vowel space
        // differs. In DIRECT the knob is the manual position along that line, and the
        // CV rides on top of it, so a full-scale envelope with the knob at 0 travels
        // exactly FROM → TO.
        const base = vowelMorphRefs.current[id] ?? 2;
        const freqs = vowelDirectRefs.current[id]
          ? vowelFreqsBetween(vowelFromRefs.current[id] ?? 4, vowelToRefs.current[id] ?? 0, base / 4 + cv)
          : vowelFreqsAt(base + cv * 4);
        const scaled = freqs.map(f => Math.max(20, Math.min(18000, f * shape)));
        const last = vowelLastFreqRefs.current[id];
        if (last && Math.abs(scaled[0] - last[0]) < 0.5 && Math.abs(scaled[1] - last[1]) < 0.5 && Math.abs(scaled[2] - last[2]) < 0.5) continue;
        for (let k = 0; k < 3; k++) n[`${id}F${k}`]?.frequency.setValueAtTime(scaled[k], now);
        vowelLastFreqRefs.current[id] = scaled;
      }
    };
    vowelTick();

    // ── Quantized FM rAF (Phase 70) ── SOLE writer of the GlideBus for any VCO whose
    // CV is driven by a quantizer AND whose FM jack is patched.
    //
    // Why a rAF and not an audio connection: quantizing is a nearest-note LOOKUP, not
    // a sum, so it cannot be expressed as a connection into an AudioParam. The FM jack
    // sums into the worklet's slaveFreq at audio rate — i.e. AFTER quantization — which
    // is why a patched LFO used to slide the pitch straight through the scale. Same
    // reasoning (and same shape) as vowelTick: a nonlinear map has to be computed.
    //
    // While engaged, `${id}fm` is muted to 0 so the direct ×500 path cannot ALSO move
    // the pitch — otherwise the smooth slide plays underneath the stepped one.
    //
    // Single-writer holds against the keyboard: vcoActiveCvRef holds exactly ONE CV
    // source per VCO, so a VCO driven by a quantizer is by construction not driven by
    // kbd-pitch-out, and vibratoTick skips it. The two rAFs can never both own a bus.
    let qntFmRafId;
    const qntFmTick = () => {
      qntFmRafId = requestAnimationFrame(qntFmTick);
      const ids = allVcoIdsRef.current;
      const now = Tone.context.rawContext.currentTime;
      for (const vcoId of ids) {
        const engaged = qntFmEngagedRef.current[vcoId];
        const gain = n[`${vcoId}fm`];
        if (!engaged) {
          // Restore the direct FM path once (ramped — a hard jump would click).
          if (qntFmMutedRef.current[vcoId]) {
            qntFmMutedRef.current[vcoId] = false;
            qntFmLastHzRef.current[vcoId] = undefined;
            if (gain) safeRamp(gain.gain, 500, 0.03);
          }
          continue;
        }
        if (!qntFmMutedRef.current[vcoId]) {
          qntFmMutedRef.current[vcoId] = true;
          if (gain) safeRamp(gain.gain, 0, 0.03);
        }
        const kHz = vcoKnobHzRef.current[vcoId];
        const q   = quantizerParamsRefs.current[engaged];
        const gb  = n[`${vcoId}GlideBus`];
        if (kHz == null || !q || !gb) continue;
        // Sample the RAW modulator (pre-×500). Last sample, not an average: an average
        // over a 32-frame window flattens a fast LFO toward its DC mean.
        const buf = n[`${vcoId}fmAnalyser`]?.getValue();
        if (!buf || !buf.length) continue;
        const level = Math.max(-1, Math.min(1, buf[buf.length - 1]));
        // ±1 → ±QNT_FM_SEMITONES around the FREQ knob, exponential (equal intervals),
        // matching the quantizer worklet's own modulation mode.
        const target = kHz * Math.pow(2, level * (QNT_FM_SEMITONES / 12));
        const hz = q.bypass ? target : quantizeHzJs(target, q);
        const last = qntFmLastHzRef.current[vcoId];
        if (last !== undefined && Math.abs(hz - last) < 0.01) continue;
        qntFmLastHzRef.current[vcoId] = hz;
        gb.setTargetAtTime(hz, now, 0.005);   // tiny smoothing kills the step edge click
        // Mirror the stepped note onto the owning QNT's display + LEDs.
        if (!q.bypass && quantizerStepCbRefs.current[engaged]) {
          const midi = Math.round(69 + 12 * Math.log2(hz / 440));
          if (midi !== lastQuantizedMidiRefs.current[engaged]) {
            lastQuantizedMidiRefs.current[engaged] = midi;
            quantizerStepCbRefs.current[engaged](((midi % 12) + 12) % 12, midi, undefined);
          }
        }
      }
    };
    qntFmTick();

    // ── 914 SWEEP rAF (Phase 70) ── SOLE writer of every ffbSweep{i} gain.
    // A CV can't drive this through an AudioParam: "sweep" is a nonlinear map from one
    // voltage to 14 correlated gains (a resonant hump travelling across the bank), the
    // same reason vowelTick exists for the formant morph. The band KNOBS keep their own
    // gain stage, so the two writers never touch the same node.
    // Idle cost: instances with nothing patched write their weights back to 1 once and
    // are then skipped entirely by the delta gate.
    let ffbSweepRafId;
    const ffbSweepTick = () => {
      ffbSweepRafId = requestAnimationFrame(ffbSweepTick);
      const ids = ffbIdsRef.current;
      if (!ids.length) return;
      const now = Tone.context.rawContext.currentTime;
      const N = FFB_BANDS.length;
      for (const id of ids) {
        const active = ffbSweepActiveRef.current[id];
        let cv = 0;
        if (active) {
          const buf = n[`${id}SweepAnalyser`]?.getValue();
          if (buf && buf.length) cv = Math.max(-1, Math.min(1, buf[buf.length - 1]));
        }
        // CV −1..+1 → hump centre travelling across band 0..N−1. Unpatched (or centred)
        // still means "no colouring" only when inactive — hence the explicit flag.
        const centre = ((cv + 1) / 2) * (N - 1);
        const last = ffbSweepLastRef.current[id];
        let changed = !last;
        const weights = new Array(N);
        for (let i = 0; i < N; i++) {
          const w = active
            ? FFB_SWEEP_FLOOR + (1 - FFB_SWEEP_FLOOR) *
              Math.exp(-((i - centre) * (i - centre)) / (2 * FFB_SWEEP_SIGMA * FFB_SWEEP_SIGMA))
            : 1;
          weights[i] = w;
          if (last && Math.abs(w - last[i]) > 0.004) changed = true;
        }
        if (!changed) continue;
        for (let i = 0; i < N; i++) n[`${id}Sweep${i}`]?.gain.setTargetAtTime(weights[i], now, 0.01);
        ffbSweepLastRef.current[id] = weights;
      }
    };
    ffbSweepTick();

    // ── LFO tempo-sync rAF (Phase 65) ── sole writer of each synced LFO's SyncSig.
    // Value is derived deterministically from Transport.seconds so phase is exact,
    // repeatable, and lines up with the sequencer grid; the OFFSET knob rotates the
    // start point. Idle (no synced LFO) costs one `for…in` over an empty object.
    let lfoSyncRafId;
    const lfoSyncTick = () => {
      lfoSyncRafId = requestAnimationFrame(lfoSyncTick);
      const active = lfoSyncActiveRef.current;
      const bpm = Tone.Transport.bpm.value;
      const t   = Tone.Transport.seconds;
      const now = Tone.context.rawContext.currentTime;
      for (const id in active) {
        if (!active[id] || !n[`${id}SyncSig`]) continue;
        const div       = lfoDivForRate(lfoRateRefs.current[id]);
        const periodSec = div.beats * (60 / bpm);
        if (!(periodSec > 0)) continue;
        const offset = lfoOffsetRefs.current[id] ?? 0;
        let phase = ((t / periodSec) + offset) % 1;
        if (phase < 0) phase += 1;
        const v = lfoWaveValue(lfoWaveRefs.current[id] ?? 'sine', phase) * (lfoDepthRefs.current[id] ?? 0.5);
        const last = lfoSyncLastRefs.current[id];
        if (last !== undefined && Math.abs(v - last) < 0.001) continue;
        n[`${id}SyncSig`].setTargetAtTime(v, now, 0.008); // smooth the 60 Hz steps
        lfoSyncLastRefs.current[id] = v;
      }
    };
    lfoSyncTick();

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    // rawCtx must be declared before either worklet load block — both share it.
    const rawCtx = Tone.context.rawContext;

    // Load the quantizer AudioWorklet asynchronously (parallel to hard sync load).
    // One worklet node per quantizer instance, keyed by qid in n.qntNodes
    // (Phase 60e part 4 — same registry pattern as hardSyncNodes; assigned
    // synchronously so lookups always share it, keys appear at load).
    const qntNodes = {};
    n.qntNodes = qntNodes;
    rawCtx.audioWorklet.addModule('/quantizer-worklet.js').then(() => {
      if (nodesRef.current !== n) return;

      // Idempotent per-instance wiring: creates the worklet node, connects it to
      // the instance's Out wrapper, flushes buffered config, installs the port
      // handler, and makes the `${qid}-cv-in` jack live.
      const wire = (qid) => {
        if (qntNodes[qid] || !n[`${qid}Out`]) return;
        // Use Tone.context.createAudioWorkletNode() — NOT `new AudioWorkletNode(rawCtx, ...)`.
        // Tone.js wraps all nodes in standardized-audio-context (SAC). SAC's connect() throws
        // InvalidAccessError when connecting TO any node created outside its own registry
        // (i.e. native AudioWorkletNode). Tone.context.createAudioWorkletNode() creates a
        // SAC-wrapped node that is accepted by every SAC connect() call in the graph.
        const node = Tone.context.createAudioWorkletNode('quantizer-processor');
        qntNodes[qid] = node;

        // Connect worklet output to the Tone.Gain wrapper via its native GainNode.
        // (Same pattern as hard sync: native AudioWorkletNode.connect() needs native AudioNode.)
        node.connect(n[`${qid}Out`].input);

        // Flush the latest scale/root config that may have been set before the worklet loaded.
        node.port.postMessage(quantizerParamsRefs.current[qid] ?? defaultQntParams());

        // Route port messages to this instance's UI callback (delta-checked in
        // the worklet). noteClass/midiNote → LED + display; hasSignal → IN LED
        // (fires only on cable connect/disconnect). Callback signature is
        // (noteClass, midiNote, hasSignal); null noteClass = signal-state-only.
        node.port.onmessage = ({ data }) => {
          if (data.midiNote !== undefined) lastQuantizedMidiRefs.current[qid] = data.midiNote;
          const cb = quantizerStepCbRefs.current[qid];
          if (cb) {
            if (data.noteClass !== undefined) cb(data.noteClass, data.midiNote, undefined);
            if (data.hasSignal !== undefined) cb(null, null, data.hasSignal);
          }
          // Drive glideBus for any VCO connected from this instance's cv-out —
          // the quantizer produces an instant quantized target; the glideBus
          // applies the glide AFTER quantization so the slide is always between
          // two in-scale notes.
          if (data.midiNote !== undefined && nodesRef.current) {
            const hz = 440 * Math.pow(2, (data.midiNote - 69) / 12);
            // Determine glide τ by tracing what drives this instance's cv-in.
            const qntSource = [...connectionsRef.current.keys()]
              .find(k => k.endsWith(`→${qid}-cv-in`))?.split('→')[0];
            const rawGlide = glideForPitchSource(qntSource);
            const cvOutSrc = `${qid}-cv-out`;
            for (const vcoId of allVcoIdsRef.current) {
              if (vcoActiveCvRef.current[vcoId] !== cvOutSrc) continue;
              const gb = nodesRef.current[`${vcoId}GlideBus`];
              if (!gb) continue;
              if (rawGlide < 0.001) gb.setValueAtTime(hz, Tone.now());
              else                  gb.rampTo(hz, rawGlide, Tone.now());
              // (glideBus → worklet slaveFreq is connected — no separate write.)
            }
          }
        };

        // Make this instance's cv-in jack live (was dest:null before the worklet).
        // Uniform for statics and dynamics, added before OR after load.
        jackMapRef.current = { ...jackMapRef.current, [`${qid}-cv-in`]: { type: 'in', dest: node } };
      };

      // Statics + any dynamic quantizers added before the module finished
      // loading (the shell's localStorage restore runs on mount, ahead of this).
      qntIdsRef.current.forEach(wire);
      // Dynamic quantizers added from now on wire inline in addModule.
      wireQntRef.current = wire;

      // Rebuild jackMap so the static qnt-cv-in is live via buildJackMap too.
      // Preserve dynamic-instance entries (Phase 60e bug fix): instances restored
      // from localStorage register their jacks during mount, BEFORE this async
      // load resolves — a bare rebuild wiped them, so cables to restored modules
      // silently no-op'd in connect().
      const dynEntries = {};
      for (const inst of dynInstancesRef.current.values()) {
        inst.jackIds.forEach(j => {
          if (jackMapRef.current?.[j]) dynEntries[j] = jackMapRef.current[j];
        });
      }
      jackMapRef.current = { ...buildJackMap(n), ...dynEntries };
    }).catch(err => {
      console.warn('[MoogAudio] Quantizer worklet unavailable:', err);
    });

    // Load the hard sync AudioWorklet asynchronously.
    // One worklet node is created per VCO, keyed by vcoId (Phase 60d — dynamic
    // VCOs mint per-instance worklets too). If the load fails the sync jacks
    // remain no-ops and the VCOs stay silent (their only sound source is the
    // worklet core). outputChannelCount:[4] carries the 4 waveforms on one output.
    // The registry object is assigned synchronously so addModule and the loops
    // always share it; keys appear once the worklet module loads.
    const hardSyncNodes = {};
    n.hardSyncNodes = hardSyncNodes;
    // ── Asymmetric envelope followers (Phase 84) ──
    // Splices ONE 16-channel worklet into each vocoder's modulator bank, replacing the
    // symmetric ModEnv lowpasses as the smoothing stage. Load-failure safety is the whole
    // shape of this block: the existing `ModRect → ModEnv → CarrVCA.gain` path is left
    // wired at construction and only unhooked HERE, once the worklet actually exists — so
    // if the file 404s or the browser refuses it, the vocoder keeps working exactly as it
    // did before, just symmetrically.
    const envFollowNodes = {};
    n.envFollowNodes = envFollowNodes;
    rawCtx.audioWorklet.addModule('/env-follower-worklet.js').then(() => {
      if (nodesRef.current !== n) return;
      const wireEnv = (vid) => {
        if (envFollowNodes[vid] || !n[`${vid}ModRect0`]) return;
        // Tone.context.createAudioWorkletNode (not `new AudioWorkletNode`) — see the
        // quantizer block: SAC refuses connections to nodes outside its own registry.
        const node = Tone.context.createAudioWorkletNode('env-follower-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [VOC_BANDS.length],
          channelCount: VOC_BANDS.length, channelCountMode: 'explicit',
          channelInterpretation: 'discrete',   // 16 independent bands, never up/down-mixed
        });
        const merger = rawCtx.createChannelMerger(VOC_BANDS.length);
        const split  = rawCtx.createChannelSplitter(VOC_BANDS.length);
        for (let i = 0; i < VOC_BANDS.length; i++) {
          // Rectifier now feeds the worklet instead of the lowpass...
          try { n[`${vid}ModRect${i}`].disconnect(n[`${vid}ModEnv${i}`]); } catch (_) {}
          n[`${vid}ModRect${i}`].connect(merger, 0, i);
          // ...and the worklet's output re-enters through ModEnv, which keeps its existing
          // ModEnv → CarrVCA.gain edge. Reusing it as the landing point avoids 16 adapter
          // nodes AND avoids connecting a raw splitter straight to a Tone param.
          split.connect(n[`${vid}ModEnv${i}`].input, i);
          // The worklet owns the envelope SHAPE; this filter's job is now to strip the
          // pitch-rate ripple the fast attack lets through — see vocEnvPostHzFor.
          // setTargetAtTime, not safeRamp: rampTo on a frequency param goes exponential.
          n[`${vid}ModEnv${i}`].frequency.setTargetAtTime(
            vocEnvPostHzFor(VOC_BANDS[i].freq), Tone.now(), 0.02);
        }
        merger.connect(node);
        node.connect(split);
        try { node.parameters.get('attack').setValueAtTime(VOC_ENV_ATK_S, Tone.now()); } catch (_) {}
        try { node.parameters.get('release').setValueAtTime(
                vocEnvReleaseFor(vocDecayRefs.current[vid] ?? 0.5), Tone.now()); } catch (_) {}
        envFollowNodes[vid] = { node, merger, split };
      };
      vocIdsRef.current.forEach(wireEnv);   // instances that already exist
      wireEnvFollowRef.current = wireEnv;   // and any added later
    }).catch(err => {
      console.warn('[MoogAudio] Envelope-follower worklet unavailable, using symmetric filters:', err);
    });

    rawCtx.audioWorklet.addModule('/hard-sync-worklet.js').then(() => {
      if (nodesRef.current !== n) return;

      // Idempotent per-VCO wiring (Phase 68b): the worklet is the VCO CORE. Its
      // one 4-channel output → coreGate (power) → bus (seq gate) → a splitter →
      // the four waveform tap gains → jacks. The master patched to SYNC IN feeds
      // the worklet input; GlideBus/FM → slaveFreq (a-rate), DetuneSig →
      // slaveDetune, WidthSig/PW-CV → pulseWidth. syncEnabled + coreGate power are
      // restored from refs since the worklet can load after powerOn / a saved setup.
      const wire = (vcoId) => {
        if (hardSyncNodes[vcoId] || !n[`${vcoId}syncIn`]) return;
        const node = Tone.context.createAudioWorkletNode('hard-sync-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [4],
        });
        n[`${vcoId}syncIn`].output.connect(node);          // master → worklet input
        node.connect(n[`${vcoId}coreGate`].input);         // 4ch core → power gate
        const split = rawCtx.createChannelSplitter(4);
        n[`${vcoId}bus`].connect(split);                   // seq-gated 4ch → splitter
        split.connect(n[`${vcoId}Sin`].input,   0);
        split.connect(n[`${vcoId}Tri`].input,   1);
        split.connect(n[`${vcoId}Saw`].input,   2);
        split.connect(n[`${vcoId}Pulse`].input, 3);
        n[`${vcoId}Split`] = split;
        try { n[`${vcoId}GlideBus`].connect(node.parameters.get('slaveFreq')); }   catch (_) {}
        try { n[`${vcoId}fm`].connect(node.parameters.get('slaveFreq')); }         catch (_) {}
        try { n[`${vcoId}DetuneSig`].connect(node.parameters.get('slaveDetune')); } catch (_) {}
        try { n[`${vcoId}WidthSig`].connect(node.parameters.get('pulseWidth')); }   catch (_) {}
        try { n[`${vcoId}pw`].connect(node.parameters.get('pulseWidth')); }         catch (_) {}
        const seRef = { vco1: vco1SyncEnabledRef, vco2: vco2SyncEnabledRef, vco3: vco3SyncEnabledRef,
                        vco4: vco4SyncEnabledRef, vco5: vco5SyncEnabledRef }[vcoId];
        const se = seRef ? seRef.current : !!dynVcoSyncRef.current[vcoId];
        node.parameters.get('syncEnabled').setValueAtTime(se ? 1 : 0, Tone.now());
        n[`${vcoId}coreGate`].gain.value = isPoweredRef.current ? 1 : 0;
        hardSyncNodes[vcoId] = node;
      };

      // Statics + any dynamic VCOs added before the module finished loading
      // (the shell's localStorage restore runs on mount, ahead of this .then()).
      allVcoIdsRef.current.forEach(wire);
      // Dynamic VCOs added from now on wire inline in addModule.
      wireHardSyncRef.current = wire;
    }).catch(err => {
      console.warn('[MoogAudio] Hard sync worklet unavailable:', err);
    });

    return () => {
      cancelAnimationFrame(chordSnapRafId);
      cancelAnimationFrame(qntOverrideRafId);
      cancelAnimationFrame(vibratoRafId);
      cancelAnimationFrame(vocShiftRafId);
      cancelAnimationFrame(vowelRafId);
      cancelAnimationFrame(lfoSyncRafId);
      cancelAnimationFrame(qntFmRafId);
      cancelAnimationFrame(ffbSweepRafId);
      // Pending DAMP writes must not land on disposed Freeverbs (Phase 70).
      Object.values(revDampTimerRef.current).forEach(clearTimeout);
      revDampTimerRef.current  = {};
      revDampTargetRef.current = {};
      // A remount rebuilds every WaveShaper at the LIN curve — the delta cache
      // must forget this mount's state or a saved LOG rack never re-applies it.
      vcaLinRefs.current = {};
      // Release the mic device if it was opened, so the OS mic indicator clears on unmount.
      if (extMicRef.current) {
        try { extMicRef.current.close(); } catch (_) {}
        try { extMicRef.current.dispose(); } catch (_) {}
        extMicRef.current = null;
      }
      // Null out nodesRef first so any in-flight worklet Promise .then() bails immediately.
      nodesRef.current = null;
      jackMapRef.current = null;
      [n.noiseW, n.noiseP, n.noiseBrn, n.noise2W, n.noise2P, n.noise2Brn, n.noise3W, n.noise3P, n.noise3Brn, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      Object.values(seqLoopsRef.current).forEach(loop => {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      });
      seqLoopsRef.current = {};
      Object.values(chordSeqLoopsRef.current).forEach(loop => {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      });
      chordSeqLoopsRef.current = {};
      chordSeqIdsRef.current = ['chordseq'];
      try { Tone.Transport.stop(); } catch (_) {}
      // Disconnect AudioWorkletNodes (not Tone.js nodes — no .dispose()).
      wireEnvFollowRef.current = null;
      Object.values(envFollowNodes).forEach(({ node, merger, split }) => {
        try { node.disconnect(); } catch (_) {}
        try { merger.disconnect(); } catch (_) {}
        try { split.disconnect(); } catch (_) {}
      });
      wireHardSyncRef.current = null; // a remount must never wire against this mount's disposed nodes
      Object.values(hardSyncNodes).forEach(node => { try { node.disconnect(); } catch (_) {} });
      wireQntRef.current = null; // a remount must never wire against this mount's disposed nodes
      Object.values(qntNodes).forEach(node => { try { node.disconnect(); } catch (_) {} });
      Object.values(n).forEach(node => {
        try { node.dispose(); } catch (_) {}
      });
      connectionsRef.current.clear();
      gateActionsRef.current.clear();
      // Dynamic instances (Phase 60b): their nodes were disposed by the
      // Object.values(n) sweep above; reset the registries so a StrictMode
      // remount starts clean.
      dynInstancesRef.current.clear();
      allVcoIdsRef.current = [...VCO_IDS];
      dynVcoSyncRef.current = {};
      kickTuneRef.current   = { kick: 55 };
      kickDecayRef.current  = { kick: 0.4 };
      kickTrigCbRef.current = {};
      kickLastTimeRef.current = {};
      vowelIdsRef.current           = [];
      vowelDirectRefs.current       = {};
      vowelFromRefs.current         = {};
      vowelToRefs.current           = {};
      vowelMorphRefs.current        = {};
      vowelShapeRefs.current        = {};
      vowelLastFreqRefs.current     = {};
      lfoSyncActiveRef.current      = {};
      lfoRateRefs.current           = {};
      ffbIdsRef.current             = ['ffb'];
      ffbSweepActiveRef.current     = {};
      ffbSweepLastRef.current        = {};
      qntFmEngagedRef.current       = {};
      qntFmMutedRef.current         = {};
      qntFmLastHzRef.current        = {};
      lfoOffsetRefs.current         = {};
      lfoDepthRefs.current          = {};
      lfoWaveRefs.current           = {};
      lfoSyncLastRefs.current       = {};
      vocIdsRef.current             = ['voc'];
      vocShiftBaseRefs.current      = { voc: 1.0 };
      vocShiftLfoRateRefs.current   = { voc: 0.7 };
      vocShiftLfoAmpRefs.current    = { voc: 0 };
      vocShiftLastRatioRefs.current = {};
      qntIdsRef.current             = ['qnt'];
      quantizerParamsRefs.current   = { qnt: defaultQntParams() };
      lastQuantizedMidiRefs.current = { qnt: 69 };
      quantizerStepCbRefs.current   = {};
      qntChordOverrideRef.current   = {};
      isPoweredRef.current = false;
    };
  }, []);

  const powerOn = useCallback(async () => {
    if (isPoweredRef.current) return;
    await Tone.start(); // satisfies browser autoplay policy
    isPoweredRef.current = true;

    const n = nodesRef.current;
    if (!n) return;
    [n.noiseW, n.noiseP, n.noiseBrn, n.noise2W, n.noise2P, n.noise2Brn, n.noise3W, n.noise3P, n.noise3Brn, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
      try { node.start(); } catch (_) {}
    });
    // Dynamic instances' sound sources (Phase 60b)
    dynInstancesRef.current.forEach(inst =>
      inst.sourceNames.forEach(sn => { try { n[sn]?.start(); } catch (_) {} }));

    // Open every VCO's power gate (coreGate) — the worklet core runs continuously
    // and is silenced while unpowered by coreGate=0 (Phase 68b). HARD SYNC state
    // lives on the worklet's syncEnabled param (set by the sync setters / wire()),
    // so it is untouched here. Static + dynamic VCOs alike.
    ['vco1', 'vco2', 'vco3', 'vco4', 'vco5'].forEach(v => { if (n[`${v}coreGate`]) n[`${v}coreGate`].gain.value = 1; });
    dynInstancesRef.current.forEach((inst, id) => {
      if (inst.type === 'vco' && n[`${id}coreGate`]) n[`${id}coreGate`].gain.value = 1;
    });

    // Start sequencer clocks — reset steps so first tick lands on step 0
    for (const id of Object.keys(seqLoopsRef.current)) seqCurrentStepRefs.current[id] = -1;
    for (const id of Object.keys(chordSeqLoopsRef.current)) chordSeqCurrentStepRefs.current[id] = -1;
    Tone.Transport.start();
    Object.values(seqLoopsRef.current).forEach(loop => { try { loop.start(0); } catch (_) {} });
    Object.values(chordSeqLoopsRef.current).forEach(loop => { try { loop.start(0); } catch (_) {} });

    setIsPowered(true);
  }, []);

  const powerOff = useCallback(() => {
    if (!isPoweredRef.current) return;
    isPoweredRef.current = false;

    const n = nodesRef.current;
    if (!n) return;
    [n.noiseW, n.noiseP, n.noiseBrn, n.noise2W, n.noise2P, n.noise2Brn, n.noise3W, n.noise3P, n.noise3Brn, n.vocHissNoise, n.vocBuzzNoise, n.vocCarrOsc, n.lfo, n.lfo2, n.chorus].forEach(node => {
      try { node.stop(); } catch (_) {}
    });
    // Dynamic instances' sound sources (Phase 60b)
    dynInstancesRef.current.forEach(inst =>
      inst.sourceNames.forEach(sn => { try { n[sn]?.stop(); } catch (_) {} }));

    // Stop sequencer loops and clear active LEDs
    for (const [id, loop] of Object.entries(seqLoopsRef.current)) {
      try { loop.stop(); } catch (_) {}
      seqCurrentStepRefs.current[id] = -1;
      seqStepCbRefs.current[id]?.(-1);
    }
    for (const [id, loop] of Object.entries(chordSeqLoopsRef.current)) {
      try { loop.stop(); } catch (_) {}
      chordSeqCurrentStepRefs.current[id] = -1;
      chordSeqStepCbRefs.current[id]?.(-1);
    }
    Tone.Transport.stop();

    // Gate every VCO core to silence (Phase 68b). The worklet core returns true so
    // it runs indefinitely — coreGate=0 is the only thing stopping its 4 waveforms
    // from flowing (when patched) through bus → master → seqMasterGate → speakers.
    ['vco1', 'vco2', 'vco3', 'vco4', 'vco5'].forEach(v => { if (n[`${v}coreGate`]) n[`${v}coreGate`].gain.value = 0; });
    dynInstancesRef.current.forEach((inst, id) => {
      if (inst.type === 'vco' && n[`${id}coreGate`]) n[`${id}coreGate`].gain.value = 0;
    });

    // Release every envelope. Holding the manual GATE button (or a patched gate) while
    // powering down otherwise leaves the Tone.Envelope parked at its sustain level, and
    // since an envelope is not a source nothing else brings it back down — so the next
    // power-up starts with that VCA already wide open and drones until something
    // releases it. Same class as the VCO bus gates below.
    for (const envId of ['env1', 'env2', 'env3']) { try { n[envId]?.triggerRelease(); } catch (_) {} }
    dynInstancesRef.current.forEach((inst, id) => {
      if (inst.type === 'env') { try { n[id]?.triggerRelease(); } catch (_) {} }
    });

    // Re-open every VCO's per-step gate. Powering down on a REST step would otherwise
    // leave that VCO's bus at 0, so it stayed silent on the next power-up until the
    // sequencer happened to reach a gated step. Latent before Phase 76 and easier to hit
    // now that the mute also reaches VCOs fed through a quantizer / chord seq.
    for (const vcoId of allVcoIdsRef.current) {
      if (n[`${vcoId}bus`]) n[`${vcoId}bus`].gain.value = 1;
    }

    // Re-open the master gate so keyboard / manual playing is audible after the
    // sequencer stops. (The per-seq GateNodes are gone as of Phase 71; the loop
    // below is a guarded no-op, kept for a future per-seq output gate.)
    n.seqMasterGate.gain.value = 1;
    for (const id of Object.keys(seqLoopsRef.current)) {
      const gn = n[`${id}GateNode`];
      if (gn) gn.gain.value = 1;
    }

    setIsPowered(false);
  }, []);

  // Kick drum state — keyed by kick id ('kick' = the static module; 'kick2'+ are
  // dynamic instances). Tune/decay are read by the seq-loop gate handlers at
  // fire time; trig callbacks flash each module's LED (registered by KickModule).
  const kickTuneRef   = useRef({ kick: 55 });
  const kickDecayRef  = useRef({ kick: 0.4 });
  const kickTrigCbRef = useRef({});
  const kickLastTimeRef = useRef({});   // kid → last scheduled trigger time (monotonic clamp)

  // Single writer for a kick instance's synth params.
  // tune: Hz (40–200), pitchEnv: octave drop (0–5), decay: seconds (0.05–2), click: gain (0–1).
  const applyKickParams = useCallback((kid, { tune, pitchEnv, decay, click, clickTone } = {}) => {
    const n = nodesRef.current;
    const synth = n?.[`${kid}Synth`];
    if (!synth) return;
    if (tune  !== undefined) kickTuneRef.current[kid] = tune;
    if (decay !== undefined) {
      kickDecayRef.current[kid] = decay;
      synth.envelope.decay   = decay;
      synth.envelope.release = decay * 0.25;
    }
    if (pitchEnv !== undefined) synth.octaves = pitchEnv;
    if (click    !== undefined) safeRamp(n[`${kid}ClickGain`].gain, click, 0.02);
    // setTargetAtTime, matching every other frequency-type param on the rack (rampTo
    // dispatches an exponential ramp, which is unsafe near 0).
    if (clickTone !== undefined)
      n[`${kid}ClickFilter`]?.frequency.setTargetAtTime(kickClickToneHz(clickTone), Tone.now(), 0.02);
  }, []);

  // Single writer for a vocoder instance's params (Phase 60e part 3) — MIX
  // crossfades carrier-dry ↔ vocoded-wet; HISS/BUZZ scale the noise excitation;
  // CLARITY blends the high-passed real voice; SHIFT trio writes the rAF refs.
  // vid: 'voc' (static) | 'voc2'+ (dynamic). All node names compose from vid.
  const applyVocoderParams = useCallback((vid, p = {}) => {
    const n = nodesRef.current;
    if (!n || !n[`${vid}Wet`]) return;
    const { mix, hiss, buzz, clarity, gate, drive,
            pwidth, carrierMix, shift, res, shiftRate, shiftAmp, decay, volume, presence } = p;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    if (mix !== undefined) {
      const m = clamp01(mix);
      safeRamp(n[`${vid}Wet`].gain, m, 0.05);
      safeRamp(n[`${vid}Dry`].gain, 1 - m, 0.05);
    }
    // Knob 0–1 → conservative gain ceilings so the excitation supports rather than swamps.
    if (hiss !== undefined)    safeRamp(n[`${vid}HissGain`].gain,    clamp01(hiss) * 0.5, 0.05);
    if (buzz !== undefined)    safeRamp(n[`${vid}BuzzGain`].gain,    clamp01(buzz) * 0.7, 0.05);
    // Voice clarity: knob 0–1 → 0–0.9× of the high-passed dry voice.
    if (clarity !== undefined) safeRamp(n[`${vid}ClarityGain`].gain, clamp01(clarity) * 0.9, 0.05);

    // Internal carrier oscillator (fixed pitch — set at construction).
    // PWIDTH: knob 0–1 → width −0.95..0.95 (0.5 = square). Tone.PulseOscillator.width.
    if (pwidth !== undefined)  safeRamp(n[`${vid}CarrOsc`].width, (clamp01(pwidth) * 2 - 1) * 0.95, 0.05);
    // CARR MIX: knob 0 = external carrier only, 1 = internal osc only.
    if (carrierMix !== undefined) {
      const cm = clamp01(carrierMix);
      safeRamp(n[`${vid}CarrExtGain`].gain, 1 - cm, 0.05);
      safeRamp(n[`${vid}CarrOscGain`].gain, cm, 0.05);
    }
    // RES: carrier band Q, exponential 1 → 20 (Phase 83). The old range topped out at 7,
    // which is why this could never sound like the VOWEL module: VOWEL's formants run at
    // Q 11/13/15, so the vocoder's carrier bands were 3–4× too BROAD to cut the carrier
    // into anything voice-shaped.
    //
    // Phase 73 aimed at the wrong target here. It derived Q ≈ 3.45 as the point where
    // adjacent bands' −3 dB skirts exactly meet and called that "clean" — but contiguous
    // coverage means the carrier's spectrum passes through largely INTACT, which is
    // precisely the "loose synth sound". VOWEL has three filters with enormous gaps
    // between them and sounds excellent *because* everything between the formants is
    // discarded; a talk box is the same idea, a resonant tube with a few sharp peaks.
    // Sparse and resonant is the goal, not flat and continuous.
    //
    // 20^res keeps the lower half almost exactly where it was (0.5 → 4.5 vs the old 4,
    // 0.408 → 3.4 vs the old 3.45) so saved racks barely shift, and opens the top half
    // into VOWEL territory.
    if (res !== undefined) {
      const q = Math.pow(VOC_RES_MAX_Q, clamp01(res));
      const aq = vocAnalysisQFor(q);
      for (let i = 0; i < VOC_BANDS.length; i++) {
        safeRamp(n[`${vid}CarrBPF${i}`].Q, q, 0.05);
        // The ANALYSIS bank tracks it (Phase 85) — sharpening only the carrier left every
        // formant opening ~5 bands, so the output stayed a smear of sharp peaks.
        safeRamp(n[`${vid}ModBPF${i}`].Q, aq, 0.05);
      }
      // A bandpass keeps unity gain at its centre but its BANDWIDTH shrinks as 1/Q, so the
      // energy it passes from a broadband carrier falls as amplitude ∝ √(1/Q). Without
      // compensation, turning RES up just goes quiet and the resonance reads as "thin"
      // rather than "vocal". VOWEL solves the same problem with a fixed ×7 makeup into a
      // hard-knee limiter; here the makeup TRACKS Q so the level holds across the sweep.
      // Sole writer of vocOut.gain (set at construction, touched only here afterwards).
      safeRamp(n[`${vid}Out`].gain, VOC_OUT_MAKEUP * Math.sqrt(q / VOC_BASE_Q), 0.05);
    }
    // DECAY: the envelope follower's RELEASE. With the worklet wired, attack stays pinned
    // fast and this knob only controls how quickly a band falls back — which is what lets
    // consonants punch AND vowels stay smooth at the same time (see env-follower-worklet.js).
    // The legacy symmetric ModEnv filters are still written when the worklet is absent, so
    // a failed worklet load degrades to exactly the pre-Phase-84 behaviour rather than
    // going silent.
    if (decay !== undefined) {
      const d = clamp01(decay);
      vocDecayRefs.current[vid] = d;
      const ef = n.envFollowNodes?.[vid];
      if (ef) {
        try { ef.node.parameters.get('release').setTargetAtTime(vocEnvReleaseFor(d), Tone.now(), 0.01); } catch (_) {}
      } else {
        const cutoff = 20 * Math.pow(2, (0.5 - d) * 3);
        for (let i = 0; i < VOC_BANDS.length; i++) safeRamp(n[`${vid}ModEnv${i}`].frequency, cutoff, 0.05);
      }
    }
    // SHIFT / SH RATE / SH AMP — ref writes consumed by the spectral-shift rAF loop.
    if (shift !== undefined)     vocShiftBaseRefs.current[vid]    = Math.pow(2, (clamp01(shift) - 0.5) * 2); // ±1 octave
    if (shiftRate !== undefined) vocShiftLfoRateRefs.current[vid] = 0.05 * Math.pow(2, clamp01(shiftRate) * 7.64); // 0.05–10 Hz
    if (shiftAmp !== undefined)  vocShiftLfoAmpRefs.current[vid]  = clamp01(shiftAmp); // 0–1 octave swing
    // VOLUME: final module output level. knob 0–1 → 0–2× (0.5 = nominal; combines with the
    // fixed 3× makeup on the Out gain → up to 6× total). Also scales the CLARITY blend (it sums here).
    if (volume !== undefined)  safeRamp(n[`${vid}Volume`].gain, clamp01(volume) * 2, 0.05);
    // PRESENCE: peaking EQ gain at ~2.7 kHz. knob 0–1 → 0..+12 dB (boost only).
    if (presence !== undefined) safeRamp(n[`${vid}Presence`].gain, clamp01(presence) * 12, 0.05);
    // GATE: mic noise-gate threshold. knob 0–1 → VOC_GATE_MIN_DB..VOC_GATE_MAX_DB, applied by
    // scaling the detector into the fixed soft-knee curve. Sole writer of GateScale; the curve
    // is the sole writer of GateGain.gain, so the two never collide.
    if (gate !== undefined) safeRamp(n[`${vid}GateScale`].gain, vocGateScaleFor(gate), 0.05);
    // DRIVE: rewrites all 16 per-band drive gains, each keeping its pre-emphasis tilt.
    // Sole writer of those nodes (they are set once at construction and only here after).
    if (drive !== undefined) {
      const d = vocDriveFor(drive);
      for (let i = 0; i < VOC_BANDS.length; i++)
        safeRamp(n[`${vid}ModDrive${i}`].gain, d * vocBandTilt(VOC_BANDS[i].freq), 0.05);
    }
  }, []);

  // ── Dynamic module add/remove (Phase 60b — pilot: 'vco' | 'noise') ──
  // addModule mirrors the static graph's per-instance recipe exactly; nodes are
  // registered into nodesRef.current by composed name so all existing lookups
  // (updateVcoParams / getMeterValue / connect's glideBus path) work unchanged.
  // desiredNum (Phase 60f): the restore path passes the PERSISTED instance
  // number so jack ids — and therefore persisted cables — stay valid across
  // reloads. Honored only when free (duplicate ids are catastrophic for
  // jack/cable keying — the Workstation projectIO lesson); the mint counter is
  // bumped past it either way. User adds keep minting monotonically.
  // Returns { id, num } or null.
  const addModule = useCallback((type, desiredNum = null) => {
    const n = nodesRef.current;
    if (!n || !nextInstNumRef.current[type]) return null;
    let num;
    // Honor the persisted number (>= 1). It was >= 2 to avoid ever minting a
    // dynamic instance over a static's num-1, but the rack store only ever holds
    // real DYNAMIC instances, so num 1 is legit for a dynamic-only type (vowel).
    // Honoring it is also what keeps a StrictMode remount reusing the same id
    // instead of drifting (vowel1 → vowel2) — the num-1 case previously fell to
    // the mint path and double-incremented.
    if (Number.isInteger(desiredNum) && desiredNum >= 1 &&
        !dynInstancesRef.current.has(`${DYN_ID_PREFIX[type] ?? type}${desiredNum}`)) {
      num = desiredNum;
      nextInstNumRef.current[type] = Math.max(nextInstNumRef.current[type], desiredNum + 1);
    } else {
      num = nextInstNumRef.current[type]++;
    }

    if (type === 'vco') {
      // Worklet-core VCO (Phase 68b) — same topology as the statics. The worklet,
      // splitter, waveform taps and param connections are all built by wire()
      // (below / the load sweep); here we create the Tone nodes it wires into.
      const id = `vco${num}`;
      n[`${id}GlideBus`]  = new Tone.Signal(185);
      n[`${id}DetuneSig`] = new Tone.Signal(0);
      n[`${id}WidthSig`]  = new Tone.Signal(0.5);
      n[`${id}coreGate`]  = new Tone.Gain(0);   // power gate
      n[`${id}bus`]       = new Tone.Gain(1);    // sequencer per-step gate
      n[`${id}Sin`]       = new Tone.Gain(1);
      n[`${id}Tri`]       = new Tone.Gain(1);
      n[`${id}Saw`]       = new Tone.Gain(1);
      n[`${id}Pulse`]     = new Tone.Gain(1);
      n[`${id}fm`]        = new Tone.Gain(500);
      n[`${id}fmIn`]      = new Tone.Gain(1);    // jack lands here — see the static FM chain note
      n[`${id}fmAnalyser`] = new Tone.Analyser('waveform', 32);
      n[`${id}pw`]        = new Tone.Gain(0.4);
      n[`${id}Meter`]     = new Tone.Meter({ normalRange: true, smoothing: 0.15 });
      n[`${id}syncIn`]    = new Tone.Gain(1);
      n[`${id}fmIn`].connect(n[`${id}fm`]);
      n[`${id}fmIn`].connect(n[`${id}fmAnalyser`]);
      n[`${id}coreGate`].connect(n[`${id}bus`]);
      n[`${id}Saw`].connect(n[`${id}Meter`]);
      vcoKnobHzRef.current[id]   = null;
      vcoActiveCvRef.current[id] = null;
      dynVcoSyncRef.current[id]  = false;
      allVcoIdsRef.current = [...allVcoIdsRef.current, id];
      const jackEntries = {
        [`${id}-cv`]:  { type: 'in',  dest: null, isVcoCv: true },
        [`${id}-fm`]:  { type: 'in',  dest: n[`${id}fmIn`] },
        [`${id}-pw`]:  { type: 'in',  dest: n[`${id}pw`] },
        [`${id}-sync-in`]:  { type: 'in',  dest: n[`${id}syncIn`] },
        [`${id}-sync-out`]: { type: 'out', node: n[`${id}Saw`] },
        [`${id}-sin`]: { type: 'out', node: n[`${id}Sin`] },
        [`${id}-tri`]: { type: 'out', node: n[`${id}Tri`] },
        [`${id}-saw`]: { type: 'out', node: n[`${id}Saw`] },
        [`${id}-sqr`]: { type: 'out', node: n[`${id}Pulse`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, {
        type, num,
        // Split is created + registered in wire(); include it so removeModule
        // disconnects it. sourceNames is empty — the worklet has no start/stop.
        nodeNames:   [`${id}GlideBus`, `${id}DetuneSig`, `${id}WidthSig`, `${id}coreGate`,
                      `${id}bus`, `${id}Sin`, `${id}Tri`, `${id}Saw`, `${id}Pulse`,
                      `${id}fm`, `${id}fmIn`, `${id}fmAnalyser`, `${id}pw`,
                      `${id}Meter`, `${id}syncIn`, `${id}Split`],
        sourceNames: [],
        jackIds:     Object.keys(jackEntries),
      });
      // Worklet module already loaded → mint this instance's core now; otherwise
      // the load .then() sweeps allVcoIdsRef and wires it (setting coreGate power).
      wireHardSyncRef.current?.(id);
      return { id, num };
    }

    if (type === 'noise') {
      const id = `noise${num}`;
      n[`${id}W`]     = new Tone.Noise({ type: 'white' });
      n[`${id}P`]     = new Tone.Noise({ type: 'pink'  });
      n[`${id}WGain`] = new Tone.Gain(1); // LEVEL stage (Phase 8b) — jacks tap these
      n[`${id}PGain`] = new Tone.Gain(1);
      n[`${id}W`].connect(n[`${id}WGain`]);
      n[`${id}P`].connect(n[`${id}PGain`]);
      // Brown source + blue/violet/grey colour chains (Phase 69).
      const colorNames = buildNoiseColors(n, id);
      if (isPoweredRef.current) {
        try { n[`${id}W`].start();   } catch (_) {}
        try { n[`${id}P`].start();   } catch (_) {}
        try { n[`${id}Brn`].start(); } catch (_) {}
      }
      const jackEntries = {
        [`${id}-wht`]: { type: 'out', node: n[`${id}WGain`] },
        [`${id}-pnk`]: { type: 'out', node: n[`${id}PGain`] },
        [`${id}-brn`]: { type: 'out', node: n[`${id}BrnGain`] },
        [`${id}-blu`]: { type: 'out', node: n[`${id}BluGain`] },
        [`${id}-vio`]: { type: 'out', node: n[`${id}VioGain`] },
        [`${id}-gry`]: { type: 'out', node: n[`${id}GryGain`] },
        [`${id}-lvl-cv`]: { type: 'in', dest: n[`${id}LevelCv`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, {
        type, num,
        nodeNames:   [`${id}W`, `${id}P`, `${id}WGain`, `${id}PGain`, ...colorNames],
        sourceNames: [`${id}W`, `${id}P`, `${id}Brn`],
        jackIds:     Object.keys(jackEntries),
      });
      return { id, num };
    }

    if (type === 'vcf') {
      const id = `vcf${num}`;
      n[id]          = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -24 });
      // Cents scalers → detune (exponential cutoff modulation) — mirrors the statics. Phase 70.
      n[`${id}cv1`]  = new Tone.Gain(VCF_CV_CENTS);
      n[`${id}cv2`]  = new Tone.Gain(VCF_CV_CENTS);
      n[`${id}env`]  = new Tone.Gain(vcfEnvAmtCents(0.5));
      n[`${id}cv1`].connect(n[id].detune);
      n[`${id}cv2`].connect(n[id].detune);
      n[`${id}env`].connect(n[id].detune);
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-cv1`]: { type: 'in',  dest: n[`${id}cv1`] },
        [`${id}-cv2`]: { type: 'in',  dest: n[`${id}cv2`] },
        [`${id}-env`]: { type: 'in',  dest: n[`${id}env`] },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}cv1`, `${id}cv2`, `${id}env`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'vca') {
      const id = `vca${num}`;
      n[id] = new Tone.Gain(1.0);
      const cvNames = buildVcaCv(n, id);   // ENV AMT attenuator + LOG/LIN curve
      const jackEntries = {
        [`${id}-in`]:  { type: 'in',  dest: n[id] },
        [`${id}-cv`]:  { type: 'in',  dest: n[`${id}Cv`] },
        [`${id}-cv2`]: { type: 'in',  dest: n[`${id}Cv2`] },
        [`${id}-out`]: { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, ...cvNames], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'env') {
      const id = `env${num}`;
      n[id]          = new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 });
      n[`${id}Meter`] = new Tone.Meter({ normalRange: true, smoothing: 0.25 });
      n[id].connect(n[`${id}Meter`]);
      const jackEntries = {
        [`${id}-gate`]: { type: 'in',  dest: null, isGate: true, envId: id },
        [`${id}-trig`]: { type: 'in',  dest: null, isGate: true, envId: id, isTrig: true },
        [`${id}-out`]:  { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}Meter`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'lfo') {
      const id = `lfo${num}`;
      n[id]                  = new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 });
      n[`${id}modGain`]      = new Tone.Gain(0);
      n[`${id}WaveAnalyser`] = new Tone.Analyser('waveform', 32);
      // Tempo-sync output stage (Phase 65) — mirrors the static lfo/lfo2 topology.
      n[`${id}Out`]      = new Tone.Gain(1);
      n[`${id}OscGain`]  = new Tone.Gain(1);
      n[`${id}SyncSig`]  = new Tone.Signal(0);
      n[`${id}SyncGain`] = new Tone.Gain(0);
      n[`${id}modGain`].connect(n[id].frequency);
      n[id].connect(n[`${id}OscGain`]);      n[`${id}OscGain`].connect(n[`${id}Out`]);
      n[`${id}SyncSig`].connect(n[`${id}SyncGain`]); n[`${id}SyncGain`].connect(n[`${id}Out`]);
      n[`${id}Out`].connect(n[`${id}WaveAnalyser`]);
      if (isPoweredRef.current) { try { n[id].start(); } catch (_) {} }
      const jackEntries = {
        [`${id}-sync`]: { type: 'in',  dest: null, isLfoSync: true, lfoId: id },
        [`${id}-fm`]:   { type: 'in',  dest: n[`${id}modGain`] },
        [`${id}-sin`]:  { type: 'out', node: n[`${id}Out`], waveformTarget: n[id], waveform: 'sine'     },
        [`${id}-tri`]:  { type: 'out', node: n[`${id}Out`], waveformTarget: n[id], waveform: 'triangle' },
        [`${id}-sqr`]:  { type: 'out', node: n[`${id}Out`], waveformTarget: n[id], waveform: 'square'   },
        [`${id}-saw`]:  { type: 'out', node: n[`${id}Out`], waveformTarget: n[id], waveform: 'sawtooth' },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}modGain`, `${id}WaveAnalyser`, `${id}Out`, `${id}OscGain`, `${id}SyncSig`, `${id}SyncGain`],
        sourceNames: [id], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'rev') {
      const id = `reverb${num}`; // id doubles as jack prefix — matches ReverbModule's naming
      n[id]              = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.0 });
      n[`${id}Analyser`] = new Tone.Analyser('fft', 256); // Aura tap — post-reverb (Phase 56 rule)
      n[`${id}MixCv`]    = new Tone.Gain(1);              // MIX CV → wet (Phase 70)
      n[id].connect(n[`${id}Analyser`]);
      n[`${id}MixCv`].connect(n[id].wet);
      const jackEntries = {
        [`${id}-in`]:     { type: 'in',  dest: n[id] },
        [`${id}-mix-cv`]: { type: 'in',  dest: n[`${id}MixCv`] },
        [`${id}-out`]:    { type: 'out', node: n[id] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}Analyser`, `${id}MixCv`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'bbd') {
      const id = `chorus${num}`;
      // Mirrors the static BBD composite exactly — see the BBD notes.
      n[id]             = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 1.0 });
      n[`${id}In`]      = new Tone.Gain(1);
      n[`${id}Dry`]     = new Tone.Gain(1);
      n[`${id}Wet`]     = new Tone.Gain(0);
      n[`${id}Tone`]    = new Tone.Filter({ frequency: bbdToneHz(0.75), type: 'lowpass', rolloff: -12 });
      n[`${id}Out`]     = new Tone.Gain(1);
      n[`${id}RateCv`]  = new Tone.Gain(3);
      n[`${id}FbHp`]    = new Tone.Filter({ frequency: BBD_FB_HP_HZ, type: 'highpass', rolloff: -12 });
      n[`${id}Sat`]     = new Tone.WaveShaper((x) => Math.tanh(x * 1.2), 1024);
      n[`${id}Fb`]      = new Tone.Gain(0);
      n[`${id}FbDly`]   = new Tone.Delay(BBD_FB_DELAY_S);
      n[`${id}In`].connect(n[`${id}Dry`]);
      n[`${id}In`].connect(n[id]);
      n[id].connect(n[`${id}Tone`]);
      n[`${id}Tone`].connect(n[`${id}Wet`]);
      n[`${id}Dry`].connect(n[`${id}Out`]);
      n[`${id}Wet`].connect(n[`${id}Out`]);
      n[`${id}RateCv`].connect(n[id].frequency);
      n[`${id}Tone`].connect(n[`${id}FbHp`]);
      n[`${id}FbHp`].connect(n[`${id}Sat`]);
      n[`${id}Sat`].connect(n[`${id}Fb`]);
      n[`${id}Fb`].connect(n[`${id}FbDly`]);
      n[`${id}FbDly`].connect(n[id]);
      if (isPoweredRef.current) { try { n[id].start(); } catch (_) {} }
      const jackEntries = {
        [`${id}-in`]:      { type: 'in',  dest: n[`${id}In`] },
        [`${id}-rate-cv`]: { type: 'in',  dest: n[`${id}RateCv`] },
        [`${id}-out`]:     { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [id, `${id}In`, `${id}Dry`, `${id}Wet`, `${id}Tone`, `${id}Out`,
                    `${id}RateCv`, `${id}FbHp`, `${id}Sat`, `${id}Fb`, `${id}FbDly`],
        sourceNames: [id], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'vowel') {
      const id = `vowel${num}`;
      n[`${id}In`]  = new Tone.Gain(1);
      // makeup (parallel bandpasses trim ~7× of level) → brick-wall limiter.
      // The vowels are very unequal in level (open 'A' peaks ~4× the closed
      // 'I'/'U' because its low F1 sits in a strong region of the source), so a
      // big fixed makeup alone would clip 'A'. The limiter lets the closed
      // vowels be loud while catching 'A'/'O' peaks click-free.
      n[`${id}Mix`] = new Tone.Gain(7);
      // Hard-knee limiter (Tone.Limiter's default 30 dB soft knee barely
      // compresses). knee:0 + ratio 20 brick-walls at ~-1 dB so 'A'/'O' don't
      // clip while the closed vowels stay at full makeup. -out jack + display
      // tap here.
      n[`${id}Out`] = new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0.003, release: 0.05 });
      n[`${id}Mix`].connect(n[`${id}Out`]);
      n[`${id}CvIn`]       = new Tone.Gain(1);     // FORMANT-CV input buffer
      n[`${id}CvAnalyser`] = new Tone.Analyser('waveform', 128); // rAF reads the CV level
      n[`${id}CvIn`].connect(n[`${id}CvAnalyser`]);
      const nodeNames = [`${id}In`, `${id}Mix`, `${id}Out`, `${id}CvIn`, `${id}CvAnalyser`];
      // Default morph = 2 ('I'), matching VowelModule's knob default (0.5 → pos 2).
      const f0 = vowelFreqsAt(2);
      for (let k = 0; k < 3; k++) {
        n[`${id}F${k}`] = new Tone.Filter({ type: 'bandpass', frequency: f0[k], Q: VOWEL_Q[k] });
        n[`${id}G${k}`] = new Tone.Gain(VOWEL_GAIN[k]);
        n[`${id}In`].connect(n[`${id}F${k}`]);
        n[`${id}F${k}`].connect(n[`${id}G${k}`]);
        n[`${id}G${k}`].connect(n[`${id}Mix`]);
        nodeNames.push(`${id}F${k}`, `${id}G${k}`);
      }
      n[`${id}Analyser`] = new Tone.Analyser('fft', 256); // output spectrum → formant display
      n[`${id}Out`].connect(n[`${id}Analyser`]);
      nodeNames.push(`${id}Analyser`);
      // Seed morph/shape refs + register for the rAF (sole filter-freq writer).
      vowelMorphRefs.current[id]  = 2;
      vowelShapeRefs.current[id]  = 1.0;
      vowelLastFreqRefs.current[id] = null;
      vowelIdsRef.current = [...vowelIdsRef.current, id];
      const jackEntries = {
        [`${id}-in`]:    { type: 'in',  dest: n[`${id}In`] },
        [`${id}-cv-in`]: { type: 'in',  dest: n[`${id}CvIn`] },
        [`${id}-out`]:   { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num, nodeNames, sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'panner') {
      // Voltage-Controlled Panner (Phase 67) — places a (typically mono) source
      // in the stereo field. Tone.Panner wraps the native StereoPannerNode, which
      // is already an EQUAL-POWER panner, so one node gives Gemini's requested law
      // (no dual-VCA matrix). The whole rack downstream of io-in is 2-channel
      // (master Volume → seqMasterGate → Destination + moogBus tap), so this pans
      // to both the speakers and the Workstation recording tap.
      const id = `panner${num}`;
      n[`${id}In`]  = new Tone.Gain(1);
      n[`${id}Pan`] = new Tone.Panner(0);   // -1 L … +1 R; 0 = centre (equal-power)
      n[`${id}Out`] = new Tone.Gain(1);
      n[`${id}In`].connect(n[`${id}Pan`]);
      n[`${id}Pan`].connect(n[`${id}Out`]);
      // CV: cv-in → DEPTH attenuator → pan param. The PAN knob writes pan's
      // INTRINSIC value (updateDynModuleParams); this connected CV SUMS at the
      // AudioParam (Web Audio semantics) and clamps to [-1,1] — the established
      // Moog knob+CV pattern (single writer per node holds: knob owns .value,
      // the cable owns the connected input).
      n[`${id}CvIn`]    = new Tone.Gain(1);
      n[`${id}CvDepth`] = new Tone.Gain(0.5); // CV DEPTH / attenuator, knob 0..1
      n[`${id}CvIn`].connect(n[`${id}CvDepth`]);
      n[`${id}CvDepth`].connect(n[`${id}Pan`].pan);
      // Meters — input level + CV level, read by getPanMeterData for the L/R LEDs.
      n[`${id}InAnalyser`] = new Tone.Analyser('waveform', 128);
      n[`${id}CvAnalyser`] = new Tone.Analyser('waveform', 128);
      n[`${id}In`].connect(n[`${id}InAnalyser`]);
      n[`${id}CvIn`].connect(n[`${id}CvAnalyser`]);
      const nodeNames = [`${id}In`, `${id}Pan`, `${id}Out`, `${id}CvIn`, `${id}CvDepth`, `${id}InAnalyser`, `${id}CvAnalyser`];
      const jackEntries = {
        [`${id}-in`]:    { type: 'in',  dest: n[`${id}In`] },
        [`${id}-cv-in`]: { type: 'in',  dest: n[`${id}CvIn`] },
        [`${id}-out`]:   { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num, nodeNames, sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'chronos') {
      // Chronos Multi-Zone Delay (Phase 68) — MONO in → STEREO out. A HAND-BUILT
      // stereo feedback loop around two native Tone.Delay lines, so COLOR (loop
      // lowpass), HALO (allpass diffusion + L↔R cross-feedback smear) and a tanh
      // soft-clip all live INSIDE the feedback path (a Tone.FeedbackDelay black
      // box can't host them). Modulating delayTime (TIME knob / TIME CV) varispeed-
      // warps pitch with NO dropouts (native DelayNode interpolation) = tape-stop /
      // skid. Stereo width is synthesized: the L/R delay times drift apart (HALO)
      // and cross-feed, so WetL→OutBusL / WetR→OutBusR stay decorrelated; the dry
      // path sums equally to both buses (centre). NB Web Audio clamps any delay in
      // a feedback cycle to ≥1 render quantum (~2.9 ms), so Micro floors ~3 ms.
      const id = `chronos${num}`;
      const MAXD = 4; // seconds — sized once; ZONE/TIME/CV always stay within it
      n[`${id}In`]      = new Tone.Gain(1);
      n[`${id}HpPre`]   = new Tone.Filter({ type: 'highpass', frequency: 90, Q: 0.5 });
      n[`${id}Dry`]     = new Tone.Gain(0.707);  // dry leg (MIX, equal-power)
      // Internal hard-pan legs place wet-L on the left channel and wet-R on the
      // right (dry fans to both → centred), then BOTH sum into a single stereo
      // Out Gain feeding ONE central OUT jack — the whole stereo image travels
      // down one cable (same convention as the Panner module). Plain Gains here
      // would be mono and collapse the width.
      n[`${id}OutBusL`] = new Tone.Panner(-1);
      n[`${id}OutBusR`] = new Tone.Panner(1);
      n[`${id}Out`]     = new Tone.Gain(1); // stereo sum → single OUT jack
      n[`${id}OutBusL`].connect(n[`${id}Out`]);
      n[`${id}OutBusR`].connect(n[`${id}Out`]);
      n[`${id}In`].connect(n[`${id}HpPre`]);
      n[`${id}In`].connect(n[`${id}Dry`]);
      n[`${id}Dry`].connect(n[`${id}OutBusL`]);
      n[`${id}Dry`].connect(n[`${id}OutBusR`]); // dry fans to both legs → centred
      const nodeNames = [`${id}In`, `${id}HpPre`, `${id}Dry`, `${id}OutBusL`, `${id}OutBusR`, `${id}Out`];

      for (const S of ['L', 'R']) {
        n[`${id}Sum${S}`]   = new Tone.Gain(1);
        n[`${id}Delay${S}`] = new Tone.Delay({ delayTime: 0.18, maxDelay: MAXD });
        n[`${id}Hp${S}`]    = new Tone.Filter({ type: 'highpass', frequency: 90,   Q: 0.5 });
        n[`${id}Lp${S}`]    = new Tone.Filter({ type: 'lowpass',  frequency: 8000, Q: 0.4 });
        n[`${id}Ap1${S}`]   = new Tone.Filter({ type: 'allpass',  frequency: 600,  Q: 1.2 });
        n[`${id}Ap2${S}`]   = new Tone.Filter({ type: 'allpass',  frequency: 1900, Q: 1.2 });
        n[`${id}Sat${S}`]   = new Tone.WaveShaper((x) => Math.tanh(1.2 * x), 2048); // loop soft-clip
        n[`${id}Fb${S}`]    = new Tone.Gain(0.4);  // self feedback (REPEATS)
        n[`${id}Xfb${S}`]   = new Tone.Gain(0);    // cross feedback (HALO smear)
        n[`${id}Wet${S}`]   = new Tone.Gain(0.707); // wet leg level (MIX)
        // forward chain (the Delay in this cycle satisfies the ≥1-quantum rule)
        n[`${id}HpPre`].connect(n[`${id}Sum${S}`]);
        n[`${id}Sum${S}`].connect(n[`${id}Delay${S}`]);
        n[`${id}Delay${S}`].connect(n[`${id}Hp${S}`]);
        n[`${id}Hp${S}`].connect(n[`${id}Lp${S}`]);
        n[`${id}Lp${S}`].connect(n[`${id}Ap1${S}`]);
        n[`${id}Ap1${S}`].connect(n[`${id}Ap2${S}`]);
        n[`${id}Ap2${S}`].connect(n[`${id}Wet${S}`]);
        n[`${id}Wet${S}`].connect(n[`${id}OutBus${S}`]);       // wet → its own bus (stereo)
        n[`${id}Ap2${S}`].connect(n[`${id}Sat${S}`]);          // post-diffusion → feedback
        n[`${id}Sat${S}`].connect(n[`${id}Fb${S}`]);
        n[`${id}Sat${S}`].connect(n[`${id}Xfb${S}`]);
        n[`${id}Fb${S}`].connect(n[`${id}Sum${S}`]);           // self loop
        nodeNames.push(`${id}Sum${S}`, `${id}Delay${S}`, `${id}Hp${S}`, `${id}Lp${S}`, `${id}Ap1${S}`, `${id}Ap2${S}`, `${id}Sat${S}`, `${id}Fb${S}`, `${id}Xfb${S}`, `${id}Wet${S}`);
      }
      n[`${id}XfbL`].connect(n[`${id}SumR`]); // L diffusion → R loop (stereo smear)
      n[`${id}XfbR`].connect(n[`${id}SumL`]); // R diffusion → L loop

      // CV: TIME CV varispeed-warps both delay lines; REPEAT CV pushes feedback
      // (the tanh soft-clip bounds self-oscillation rather than letting it blow up).
      n[`${id}TimeCvIn`]    = new Tone.Gain(1);
      n[`${id}TimeCvDepth`] = new Tone.Gain(0.15); // ±1 CV → ±0.15 s
      n[`${id}TimeCvIn`].connect(n[`${id}TimeCvDepth`]);
      n[`${id}TimeCvDepth`].connect(n[`${id}DelayL`].delayTime);
      n[`${id}TimeCvDepth`].connect(n[`${id}DelayR`].delayTime);
      n[`${id}RepCvIn`]    = new Tone.Gain(1);
      n[`${id}RepCvDepth`] = new Tone.Gain(0.25);
      n[`${id}RepCvIn`].connect(n[`${id}RepCvDepth`]);
      n[`${id}RepCvDepth`].connect(n[`${id}FbL`].gain);
      n[`${id}RepCvDepth`].connect(n[`${id}FbR`].gain);

      n[`${id}Analyser`] = new Tone.Analyser('waveform', 128); // display energy tap
      n[`${id}Ap2L`].connect(n[`${id}Analyser`]);
      n[`${id}Ap2R`].connect(n[`${id}Analyser`]);
      nodeNames.push(`${id}TimeCvIn`, `${id}TimeCvDepth`, `${id}RepCvIn`, `${id}RepCvDepth`, `${id}Analyser`);

      const jackEntries = {
        [`${id}-in`]:      { type: 'in',  dest: n[`${id}In`] },
        [`${id}-time-cv`]: { type: 'in',  dest: n[`${id}TimeCvIn`] },
        [`${id}-rep-cv`]:  { type: 'in',  dest: n[`${id}RepCvIn`] },
        [`${id}-out`]:     { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num, nodeNames, sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'folder') {
      // Wavefolder (Phase 68c) — a West-Coast sine wavefolder. FOLD pre-gain drives
      // the signal into a fixed multi-fold sine transfer curve (Tone.WaveShaper), so
      // more drive = more folds = more added harmonics. SYMMETRY adds a DC offset
      // before the fold for asymmetric (even-harmonic) folding. Output-domain
      // waveshaping — works on ANY audio in (VCO, chord, external), which is exactly
      // why it is its OWN module rather than a VCO knob (VCO SHAPE is phase-domain).
      const id = `folder${num}`;
      const FOLDS = 4; // fold count across the full ±1 curve at max drive
      n[`${id}In`]      = new Tone.Gain(1);
      n[`${id}Drive`]   = new Tone.Gain(0.4);  // FOLD amount (pre-shaper gain 0.2..1.0)
      n[`${id}FoldCv`]  = new Tone.Gain(0.5);  // FOLD-CV → Drive.gain (sums onto knob)
      n[`${id}Bias`]    = new Tone.Signal(0);  // SYMMETRY — DC offset before the fold
      n[`${id}BiasSum`] = new Tone.Gain(1);
      n[`${id}Shaper`]  = new Tone.WaveShaper((x) => Math.sin(x * Math.PI * FOLDS), 4096);
      n[`${id}Out`]     = new Tone.Gain(1);    // OUTPUT level
      n[`${id}Analyser`] = new Tone.Analyser('waveform', 256); // → folded-wave scope
      n[`${id}In`].connect(n[`${id}Drive`]);
      n[`${id}Drive`].connect(n[`${id}BiasSum`]);
      n[`${id}Bias`].connect(n[`${id}BiasSum`]);   // DC offset sums with the driven signal
      n[`${id}BiasSum`].connect(n[`${id}Shaper`]);
      n[`${id}Shaper`].connect(n[`${id}Out`]);
      n[`${id}Shaper`].connect(n[`${id}Analyser`]);
      n[`${id}FoldCv`].connect(n[`${id}Drive`].gain); // CV sums onto the FOLD knob
      const nodeNames = [`${id}In`, `${id}Drive`, `${id}FoldCv`, `${id}Bias`, `${id}BiasSum`, `${id}Shaper`, `${id}Out`, `${id}Analyser`];
      const jackEntries = {
        [`${id}-in`]:      { type: 'in',  dest: n[`${id}In`] },
        [`${id}-fold-cv`]: { type: 'in',  dest: n[`${id}FoldCv`] },
        [`${id}-out`]:     { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num, nodeNames, sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'kick') {
      const id = `kick${num}`;
      n[`${id}Synth`]       = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 5,
                                  envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } });
      n[`${id}ClickSynth`]  = new Tone.NoiseSynth({ noise: { type: 'white' },
                                  envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } });
      n[`${id}ClickFilter`] = new Tone.Filter({ frequency: 2000, type: 'highpass', rolloff: -12 });
      n[`${id}ClickGain`]   = new Tone.Gain(0.25);
      n[`${id}TuneCv`]         = new Tone.Gain(1);
      n[`${id}TuneCvAnalyser`] = new Tone.Analyser('waveform', 128);
      n[`${id}TuneCv`].connect(n[`${id}TuneCvAnalyser`]);
      n[`${id}Out`]         = new Tone.Gain(1);
      n[`${id}Synth`].connect(n[`${id}Out`]);
      n[`${id}ClickSynth`].connect(n[`${id}ClickFilter`]);
      n[`${id}ClickFilter`].connect(n[`${id}ClickGain`]);
      n[`${id}ClickGain`].connect(n[`${id}Out`]);
      // Seed tune/decay so a gate cable patched before the module's first knob
      // write still triggers at sane values (KickModule's mount effect overwrites).
      kickTuneRef.current[id]  = 55;
      kickDecayRef.current[id] = 0.4;
      const jackEntries = {
        [`${id}-gate-in`]:  { type: 'in',  dest: null, isGate: true, isKick: true, kickId: id },
        [`${id}-click-in`]: { type: 'in',  dest: n[`${id}ClickGain`].gain },
        [`${id}-tune-cv`]:  { type: 'in',  dest: n[`${id}TuneCv`] },
        [`${id}-out`]:      { type: 'out', node: n[`${id}Out`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}Synth`, `${id}ClickSynth`, `${id}ClickFilter`, `${id}ClickGain`, `${id}Out`,
                    `${id}TuneCv`, `${id}TuneCvAnalyser`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }


    if (type === 'ffb') {
      const id = `ffb${num}`;
      n[`${id}In`]       = new Tone.Gain(1);
      n[`${id}Sum`]      = new Tone.Gain(1);
      n[`${id}Master`]   = new Tone.Gain(1);
      n[`${id}Analyser`] = new Tone.Analyser('fft', 512);
      n[`${id}MasterCv`]      = new Tone.Gain(1);
      n[`${id}SweepCv`]       = new Tone.Gain(1);
      n[`${id}SweepAnalyser`] = new Tone.Analyser('waveform', 32);
      FFB_BANDS.forEach((b, i) => {
        n[`${id}Filter${i}`] = new Tone.Filter({ type: b.type, frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}Sweep${i}`]  = new Tone.Gain(1);   // rAF-owned — see the static note
        n[`${id}Gain${i}`]   = new Tone.Gain(0.75);
        n[`${id}In`].connect(n[`${id}Filter${i}`]);
        n[`${id}Filter${i}`].connect(n[`${id}Sweep${i}`]);
        n[`${id}Sweep${i}`].connect(n[`${id}Gain${i}`]);
        n[`${id}Gain${i}`].connect(n[`${id}Sum`]);
      });
      n[`${id}Sum`].connect(n[`${id}Master`]);
      n[`${id}Master`].connect(n[`${id}Analyser`]);   // POST-bank — see the static note
      n[`${id}MasterCv`].connect(n[`${id}Master`].gain);
      n[`${id}SweepCv`].connect(n[`${id}SweepAnalyser`]);
      ffbIdsRef.current = [...ffbIdsRef.current, id];
      const jackEntries = {
        [`${id}-in`]:        { type: 'in',  dest: n[`${id}In`] },
        [`${id}-master-cv`]: { type: 'in',  dest: n[`${id}MasterCv`] },
        [`${id}-sweep-cv`]:  { type: 'in',  dest: n[`${id}SweepCv`] },
        [`${id}-out`]:       { type: 'out', node: n[`${id}Master`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}In`, `${id}Sum`, `${id}Master`, `${id}Analyser`,
                    `${id}MasterCv`, `${id}SweepCv`, `${id}SweepAnalyser`,
                    ...FFB_BANDS.flatMap((_, i) => [`${id}Filter${i}`, `${id}Sweep${i}`, `${id}Gain${i}`])],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'seq') {
      const id = `seq${num}`;
      n[`${id}PitchOut`] = new Tone.Signal(SEQ_HZ_MIN); // never 0 — exponential-ramp rule
      seqStepsRefs.current[id]       = defaultSeqSteps();
      seqCurrentStepRefs.current[id] = -1;
      seqGlideRefs.current[id]       = 0;
      const loop = buildSeqLoop(id);
      seqLoopsRef.current[id] = loop;
      // Transport is already running while powered — join it immediately.
      if (isPoweredRef.current) { try { loop.start(0); } catch (_) {} }
      const jackEntries = {
        [`${id}-pitch-out`]: { type: 'out', node: n[`${id}PitchOut`] },
        [`${id}-gate-out`]:  { type: 'out', node: null, isGate: true },
        [`${id}-clk-in`]:    { type: 'in',  dest: null },  // no-op, parity with statics
        [`${id}-clk-out`]:   { type: 'out', node: null },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}PitchOut`], sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'chordseq') {
      const id = `chordseq${num}`;
      n[`${id}PitchOut`]      = new Tone.Signal(SEQ_HZ_MIN); // never 0 — exponential-ramp rule
      n[`${id}RootOut`]       = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}ThirdOut`]      = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}FifthOut`]      = new Tone.Signal(SEQ_HZ_MIN);
      n[`${id}InputAnalyser`] = new Tone.Analyser('waveform', 256);
      chordSeqStepsRefs.current[id]       = defaultChordSteps();
      chordSeqCurrentStepRefs.current[id] = -1;
      chordSeqDivisionRefs.current[id]    = '1m';
      chordSeqRootOctaveRefs.current[id]  = 0;
      chordSeqGlideRefs.current[id]       = 0;
      chordSeqInputActiveRefs.current[id] = false;
      chordSeqIdsRef.current = [...chordSeqIdsRef.current, id];
      const loop = buildChordSeqLoop(id);
      chordSeqLoopsRef.current[id] = loop;
      // Transport is already running while powered — join it immediately.
      if (isPoweredRef.current) { try { loop.start(0); } catch (_) {} }
      const jackEntries = {
        [`${id}-cv-in`]:    { type: 'in',  dest: n[`${id}InputAnalyser`] },
        [`${id}-cv-out`]:   { type: 'out', node: n[`${id}PitchOut`] },
        [`${id}-root-out`]: { type: 'out', node: n[`${id}RootOut`]  },
        [`${id}-3rd-out`]:  { type: 'out', node: n[`${id}ThirdOut`] },
        [`${id}-5th-out`]:  { type: 'out', node: n[`${id}FifthOut`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}PitchOut`, `${id}RootOut`, `${id}ThirdOut`, `${id}FifthOut`, `${id}InputAnalyser`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'voc') {
      const id = `voc${num}`;
      // Mirror the static 16-band vocoder recipe exactly (~70 nodes).
      n[`${id}ModIn`]       = new Tone.Gain(1);
      n[`${id}CarrIn`]      = new Tone.Gain(1);
      n[`${id}Sum`]         = new Tone.Gain(1);
      n[`${id}Wet`]         = new Tone.Gain(1);
      n[`${id}Dry`]         = new Tone.Gain(0);
      n[`${id}Out`]         = new Tone.Gain(3); // fixed internal makeup; user level is VOLUME
      n[`${id}Analyser`]    = new Tone.Analyser('fft', 512);
      n[`${id}CarrBank`]    = new Tone.Gain(1);
      n[`${id}CarrOsc`]     = new Tone.PulseOscillator({ frequency: 130, width: 0 });
      n[`${id}CarrOscGain`] = new Tone.Gain(0);
      n[`${id}CarrExtGain`] = new Tone.Gain(1);
      n[`${id}CarrSum`]     = new Tone.Gain(1);
      n[`${id}Volume`]      = new Tone.Gain(1); // the `${id}-out` jack node
      n[`${id}HissNoise`]   = new Tone.Noise({ type: 'white' });
      n[`${id}HissHP`]      = new Tone.Filter({ type: 'highpass', frequency: 3500, rolloff: -12 });
      n[`${id}HissGain`]    = new Tone.Gain(0);
      n[`${id}BuzzNoise`]   = new Tone.Noise({ type: 'pink' });
      n[`${id}BuzzLP`]      = new Tone.Filter({ type: 'lowpass', frequency: 250, rolloff: -12 });
      n[`${id}BuzzGain`]    = new Tone.Gain(0);
      n[`${id}ClarityHP`]   = new Tone.Filter({ type: 'highpass', frequency: 1500, rolloff: -12 });
      n[`${id}ClarityGain`] = new Tone.Gain(0);
      n[`${id}ModRaw`]      = new Tone.Gain(1);
      n[`${id}ModHP`]       = new Tone.Filter({ type: 'highpass', frequency: 150, rolloff: -12 });
      n[`${id}ModComp`]     = new Tone.Compressor({ threshold: -28, ratio: 4, attack: 0.003, release: 0.12 });
      n[`${id}Presence`]    = new Tone.Filter({ type: 'peaking', frequency: 2700, Q: 1, gain: 0 });
      n[`${id}Limit`]       = new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0.003, release: 0.05 });
      VOC_BANDS.forEach((b, i) => {
        n[`${id}ModBPF${i}`]  = new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}ModDrive${i}`] = new Tone.Gain(VOC_ENV_DRIVE * vocBandTilt(b.freq));
        n[`${id}ModRect${i}`] = new Tone.WaveShaper(vocRectShape, VOC_RECT_POINTS);
        n[`${id}ModEnv${i}`]  = new Tone.Filter({ type: 'lowpass', frequency: 20, Q: 0.5, rolloff: -12 });
        n[`${id}CarrBPF${i}`] = new Tone.Filter({ type: 'bandpass', frequency: b.freq, Q: b.Q, rolloff: -12 });
        n[`${id}CarrVCA${i}`] = new Tone.Gain(0);
        n[`${id}ModIn`].connect(n[`${id}ModBPF${i}`]);
        n[`${id}ModBPF${i}`].connect(n[`${id}ModDrive${i}`]);   // drive + pre-emphasis tilt
        n[`${id}ModDrive${i}`].connect(n[`${id}ModRect${i}`]);
        n[`${id}ModRect${i}`].connect(n[`${id}ModEnv${i}`]);
        n[`${id}ModEnv${i}`].connect(n[`${id}CarrVCA${i}`].gain); // audio-rate env → VCA gain
        n[`${id}CarrBank`].connect(n[`${id}CarrBPF${i}`]);
        n[`${id}CarrBPF${i}`].connect(n[`${id}CarrVCA${i}`]);
        n[`${id}CarrVCA${i}`].connect(n[`${id}Sum`]);
      });
      n[`${id}CarrIn`].connect(n[`${id}CarrExtGain`]);
      n[`${id}CarrExtGain`].connect(n[`${id}CarrSum`]);
      n[`${id}CarrOsc`].connect(n[`${id}CarrOscGain`]);
      n[`${id}CarrOscGain`].connect(n[`${id}CarrSum`]);
      n[`${id}CarrSum`].connect(n[`${id}CarrBank`]);
      n[`${id}CarrSum`].connect(n[`${id}Dry`]);
      n[`${id}HissNoise`].connect(n[`${id}HissHP`]);
      n[`${id}HissHP`].connect(n[`${id}HissGain`]);
      n[`${id}HissGain`].connect(n[`${id}CarrBank`]);
      n[`${id}BuzzNoise`].connect(n[`${id}BuzzLP`]);
      n[`${id}BuzzLP`].connect(n[`${id}BuzzGain`]);
      n[`${id}BuzzGain`].connect(n[`${id}CarrBank`]);
      n[`${id}ModRaw`].connect(n[`${id}ModHP`]);
      const gateNames = buildVocGate(n, id);   // splices ModHP → gate → ModComp
      n[`${id}ModComp`].connect(n[`${id}ModIn`]);
      n[`${id}Sum`].connect(n[`${id}Wet`]);
      n[`${id}Wet`].connect(n[`${id}Out`]);
      n[`${id}Dry`].connect(n[`${id}Out`]);
      n[`${id}Out`].connect(n[`${id}Presence`]);
      n[`${id}ModIn`].connect(n[`${id}ClarityHP`]);
      n[`${id}ClarityHP`].connect(n[`${id}ClarityGain`]);
      n[`${id}ClarityGain`].connect(n[`${id}Volume`]);
      n[`${id}Presence`].connect(n[`${id}Limit`]);
      n[`${id}Limit`].connect(n[`${id}Volume`]);
      n[`${id}ModIn`].connect(n[`${id}Analyser`]);
      // Shared mic fan-out — the singleton Tone.UserMedia feeds every instance's
      // modulator pre-chain (matching the static hardwire); silent until enabled.
      n[`${id}MicGain`] = new Tone.Gain(1);          // this instance's MIC knob target
      n.extMicGain.connect(n[`${id}MicGain`]);
      n[`${id}MicGain`].connect(n[`${id}ModRaw`]);
      if (isPoweredRef.current) {
        [n[`${id}HissNoise`], n[`${id}BuzzNoise`], n[`${id}CarrOsc`]].forEach(s => { try { s.start(); } catch (_) {} });
      }
      vocShiftBaseRefs.current[id]    = 1.0;
      vocShiftLfoRateRefs.current[id] = 0.7;
      vocShiftLfoAmpRefs.current[id]  = 0;
      vocIdsRef.current = [...vocIdsRef.current, id];
      wireEnvFollowRef.current?.(id);   // worklet may already have loaded
      const jackEntries = {
        [`${id}-mod-in`]:  { type: 'in',  dest: n[`${id}ModRaw`] },
        [`${id}-carr-in`]: { type: 'in',  dest: n[`${id}CarrIn`] },
        [`${id}-out`]:     { type: 'out', node: n[`${id}Volume`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [
          `${id}ModIn`, `${id}CarrIn`, `${id}Sum`, `${id}Wet`, `${id}Dry`, `${id}Out`, `${id}Analyser`,
          `${id}CarrBank`, `${id}CarrOsc`, `${id}CarrOscGain`, `${id}CarrExtGain`, `${id}CarrSum`, `${id}Volume`,
          `${id}HissNoise`, `${id}HissHP`, `${id}HissGain`, `${id}BuzzNoise`, `${id}BuzzLP`, `${id}BuzzGain`,
          `${id}ClarityHP`, `${id}ClarityGain`, `${id}ModRaw`, `${id}ModHP`, `${id}ModComp`, `${id}Presence`,
          `${id}MicGain`, `${id}Limit`,
          ...gateNames,
          ...VOC_BANDS.flatMap((_, i) =>
            [`${id}ModBPF${i}`, `${id}ModDrive${i}`, `${id}ModRect${i}`, `${id}ModEnv${i}`, `${id}CarrBPF${i}`, `${id}CarrVCA${i}`]),
        ],
        sourceNames: [`${id}HissNoise`, `${id}BuzzNoise`, `${id}CarrOsc`],
        jackIds: Object.keys(jackEntries) });
      return { id, num };
    }

    if (type === 'qnt') {
      const id = `qnt${num}`;
      n[`${id}Out`]              = new Tone.Gain(1); // worklet → Out wrapper; the `${id}-cv-out` jack node
      n[`${id}KeepAlive`]        = new Tone.Gain(0); // silent keepalive — see the static qntKeepAlive note
      n[`${id}TransposeAnalyser`] = new Tone.Analyser('waveform', 256);
      n[`${id}Out`].connect(n[`${id}KeepAlive`]);
      n[`${id}KeepAlive`].connect(Tone.Destination);
      quantizerParamsRefs.current[id]   = defaultQntParams();
      lastQuantizedMidiRefs.current[id] = 69;
      qntIdsRef.current = [...qntIdsRef.current, id];
      const jackEntries = {
        [`${id}-cv-in`]:        { type: 'in',  dest: n.qntNodes?.[id] ?? null }, // live after wire()
        [`${id}-cv-out`]:       { type: 'out', node: n[`${id}Out`] },
        [`${id}-transpose-in`]: { type: 'in',  dest: n[`${id}TransposeAnalyser`] },
      };
      jackMapRef.current = { ...jackMapRef.current, ...jackEntries };
      dynInstancesRef.current.set(id, { type, num,
        nodeNames: [`${id}Out`, `${id}KeepAlive`, `${id}TransposeAnalyser`],
        sourceNames: [], jackIds: Object.keys(jackEntries) });
      // Worklet module already loaded → mint this instance's worklet now (also
      // patches the cv-in jack live); otherwise the load .then() sweeps qntIdsRef.
      wireQntRef.current?.(id);
      return { id, num };
    }

    // Unreachable for known types (every type has a branch above); defensive
    // only. Nothing to roll back — the counter was max()'d or incremented and
    // monotonic counters are never reused by design.
    return null;
  }, [buildSeqLoop, buildChordSeqLoop]);

  // Shared LFO param applier (static + dynamic — Phase 65). Stores every knob
  // value into the id-keyed refs the sync rAF reads, AND drives the free-running
  // oscillator's Hz/amplitude/type/mod-gain. In sync mode the oscillator is
  // crossfaded to silent (applyLfoMode) and the rAF owns the audible signal, so
  // these writes to the muted oscillator are harmless; RATE/OFFSET/DEPTH/type
  // still land in the refs and take effect on the synced value immediately.
  // Debounced, delta-checked dampening writer — the ONLY path that may assign
  // `dampening` (see the REV_DAMP notes: each write rebuilds 8 IIRFilter nodes).
  // The delta check is what stops ROOM/MIX moves from touching it at all: the param
  // effect re-sends `damp` unchanged on every render, and an identical target is a
  // no-op here. The debounce collapses a DAMP drag into one write when it settles.
  const revDampTargetRef = useRef({});   // nodeName → last REQUESTED Hz
  const revDampTimerRef  = useRef({});   // nodeName → pending timeout
  // Chorus DEPTH is a plain setter (recomputes both LFOs' min/max), so like the
  // reverb's DAMP it gets re-sent unchanged every time RATE or MIX moves — the param
  // effect always sends the whole object. Far cheaper than DAMP (no node rebuild, so
  // no scratching), but it still writes LFO scaling for no reason. Delta-check it.
  const chorusDepthRef = useRef({});
  const applyChorusDepth = useCallback((nodeName, depth) => {
    if (chorusDepthRef.current[nodeName] === depth) return;
    chorusDepthRef.current[nodeName] = depth;
    const n = nodesRef.current;
    if (n && n[nodeName]) n[nodeName].depth = depth;
  }, []);

  // delayTime is likewise a plain setter (it re-applies depth to both LFOs), so it gets
  // the same delta guard rather than being rewritten on every RATE/MIX move.
  const chorusDelayRef = useRef({});
  const applyChorusDelay = useCallback((nodeName, delay) => {
    const ms = bbdDelayMs(delay);
    if (chorusDelayRef.current[nodeName] === ms) return;
    chorusDelayRef.current[nodeName] = ms;
    const n = nodesRef.current;
    if (n && n[nodeName]) n[nodeName].delayTime = ms;
  }, []);

  // Shared by the static + dynamic BBD paths so the two can never drift.
  const applyChorusParams = useCallback((id, { rate, depth, wet, feedback, delay, tone } = {}) => {
    const n = nodesRef.current;
    if (!n || !n[id]) return;
    if (rate  !== undefined) safeRamp(n[id].frequency, 0.1 * Math.pow(50, rate));
    if (depth !== undefined) applyChorusDepth(id, depth);
    if (delay !== undefined) applyChorusDelay(id, delay);
    // MIX is now an external equal-gain crossfade (the Chorus itself stays 100% wet).
    if (wet   !== undefined) {
      safeRamp(n[`${id}Dry`].gain, 1 - wet);
      safeRamp(n[`${id}Wet`].gain, wet);
    }
    // Drives the HAND-BUILT return gain, not Tone's internal `feedback` (kept at 0 —
    // its loop has no in-line filtering). Clamped: >0.9 runs away, the roomSize lesson.
    if (feedback !== undefined) safeRamp(n[`${id}Fb`].gain, Math.min(BBD_MAX_FEEDBACK, feedback));
    // Filter frequency IS an AudioParam, so TONE is smooth — unlike the reverb's DAMP.
    if (tone  !== undefined) n[`${id}Tone`].frequency.setTargetAtTime(bbdToneHz(tone), Tone.now(), 0.02);
  }, [applyChorusDepth, applyChorusDelay]);

  const scheduleRevDamp = useCallback((nodeName, damp) => {
    const hz = revDampHz(damp);
    if (revDampTargetRef.current[nodeName] === hz) return;   // nothing new asked for
    // First request at exactly the centre value: the node was CONSTRUCTED there, so
    // record it and skip the pointless mount-time rebuild.
    if (revDampTargetRef.current[nodeName] === undefined && hz === REV_DAMP_MID_HZ) {
      revDampTargetRef.current[nodeName] = hz;
      return;
    }
    revDampTargetRef.current[nodeName] = hz;
    clearTimeout(revDampTimerRef.current[nodeName]);
    revDampTimerRef.current[nodeName] = setTimeout(() => {
      const n = nodesRef.current;
      if (n && n[nodeName]) n[nodeName].dampening = hz;
    }, REV_DAMP_DEBOUNCE_MS);
  }, []);

  const applyLfoParams = useCallback((id, { rate, depth, type, modDepth } = {}) => {
    const n = nodesRef.current; if (!n || !n[id]) return;
    // Legacy quirk: the static LFO's rate-mod gain is `lfo1modGain`, not `lfomodGain`.
    const modName = id === 'lfo' ? 'lfo1modGain' : `${id}modGain`;
    if (rate     !== undefined) { lfoRateRefs.current[id]   = rate;  safeRamp(n[id].frequency, lfoRateHz(rate));
                                  recomputeQntFmRef.current?.(); }  // rate may cross QNT_FM_MAX_HZ
    if (depth    !== undefined) { lfoDepthRefs.current[id]  = depth; safeRamp(n[id].amplitude, depth); }
    if (type     !== undefined) { lfoWaveRefs.current[id]   = type;  n[id].type = type; }
    // MOD knob doubles as the sync OFFSET (phase) — store it either way.
    if (modDepth !== undefined) { lfoOffsetRefs.current[id] = modDepth; if (n[modName]) safeRamp(n[modName].gain, modDepth * 10); }
  }, []);

  // id → last applied LOG/LIN state, so applyVcaParams can skip redundant curve
  // writes. Seeded lazily; buildVcaCv constructs every shaper with the LIN curve.
  const vcaLinRefs = useRef({});

  // Single writer for one VCA instance's params — shared by the three static
  // updaters and updateDynModuleParams (the applyLfoParams / applyChorusParams
  // pattern), so every instance behaves identically.
  //   gain   (0–1) → the Gain's own gain param: the manual bias / INITIAL GAIN.
  //                  CV sums on top of it; set GAIN = 0 for full envelope gating.
  //   envAmt (0–1) → the CV 1 attenuator (`${id}Cv`). Legacy param name — the knob is
  //                  labelled CV 1 since Phase 77, but the key is kept so saved racks
  //                  restore the value they were set to.
  //   cv2Amt (0–1) → the CV 2 attenuator (`${id}Cv2`). Sums with CV 1 into one curve.
  //   lin    (bool)→ the CV response curve (`${id}CvShape`). See buildVcaCv.
  // Three disjoint nodes, one writer each — the knob owns the Gain's intrinsic
  // value while the cable owns its connected input, the standard Moog knob+CV split.
  const applyVcaParams = useCallback((id, { gain, envAmt, cv2Amt, lin } = {}) => {
    const n = nodesRef.current;
    if (!n || !n[id]) return;
    if (gain   !== undefined) safeRamp(n[id].gain, gain);
    if (envAmt !== undefined) safeRamp(n[`${id}Cv`].gain,  Math.max(0, Math.min(1, envAmt)));
    if (cv2Amt !== undefined) safeRamp(n[`${id}Cv2`].gain, Math.max(0, Math.min(1, cv2Amt)));
    if (lin !== undefined && vcaLinRefs.current[id] !== lin) {
      // Delta-checked against a ref, not against `.curve`: the param effect
      // re-sends the whole object on every knob move, and assigning `.curve`
      // rebuilds the native curve table (the reverb-DAMP class of waste). The
      // node's own getter is not a reliable identity check — Web Audio copies
      // the array on set.
      vcaLinRefs.current[id] = lin;
      n[`${id}CvShape`].curve = lin ? VCA_CURVE_LIN : VCA_CURVE_LOG;
    }
  }, []);

  // Click-free crossfade between free (oscillator) and sync (rAF signal) output.
  const applyLfoMode = useCallback((id, synced) => {
    const n = nodesRef.current; if (!n || !n[`${id}OscGain`]) return;
    if (synced) { safeRamp(n[`${id}OscGain`].gain, 0); safeRamp(n[`${id}SyncGain`].gain, 1); }
    else        { safeRamp(n[`${id}OscGain`].gain, 1); safeRamp(n[`${id}SyncGain`].gain, 0);
                  lfoSyncLastRefs.current[id] = undefined; }
  }, []);

  // Generic param dispatch for dynamic instances (Phase 60c) — mirrors each
  // static updater's mapping exactly. UI passes the same param objects the
  // static modules send; shell binds `(p) => updateDynModuleParams(id, p)`.
  const updateDynModuleParams = useCallback((id, params = {}) => {
    const inst = dynInstancesRef.current.get(id);
    const n    = nodesRef.current;
    // No bare n[id] guard — kick/ffb instances compose all node names
    // (`kick2Synth`, `ffb2In`…); the registry entry guarantees the nodes exist.
    if (!inst || !n) return;
    switch (inst.type) {
      case 'vcf':
        if (params.cutoff    !== undefined) n[id].frequency.setTargetAtTime(20 * Math.pow(1000, params.cutoff), Tone.now(), 0.02);
        if (params.resonance !== undefined) safeRamp(n[id].Q, Math.max(0.001, params.resonance * 20));
        if (params.envAmt    !== undefined) safeRamp(n[`${id}env`].gain, vcfEnvAmtCents(params.envAmt));
        break;
      case 'vca':
        applyVcaParams(id, params);
        break;
      case 'lfo':
        applyLfoParams(id, params);
        break;
      case 'rev':  // mirrors updateReverbParams exactly — see its notes on the clamp/setter
        if (params.roomSize !== undefined) safeRamp(n[id].roomSize, Math.min(REV_MAX_ROOM, params.roomSize));
        if (params.wet      !== undefined) safeRamp(n[id].wet,      params.wet);
        if (params.damp     !== undefined) scheduleRevDamp(id, params.damp);
        break;
      case 'bbd':
        applyChorusParams(id, params);
        break;
      case 'vowel':
        // Write refs ONLY — vowelTick is the sole writer of the filter freqs.
        if (params.vowel !== undefined) vowelMorphRefs.current[id] = Math.max(0, Math.min(4, params.vowel * 4));
        if (params.shape !== undefined) vowelShapeRefs.current[id] = 0.7 + params.shape * 0.6; // tract scale 0.7..1.3
        if (params.direct !== undefined) {
          vowelDirectRefs.current[id] = !!params.direct;
          vowelLastFreqRefs.current[id] = undefined;   // re-arm the delta gate across the mode change
        }
        if (params.from !== undefined) { vowelFromRefs.current[id] = params.from; vowelLastFreqRefs.current[id] = undefined; }
        if (params.to   !== undefined) { vowelToRefs.current[id]   = params.to;   vowelLastFreqRefs.current[id] = undefined; }
        break;
      case 'panner':
        // PAN knob 0..1 → pan -1..1 (intrinsic value; CV sums on top of it).
        if (params.pan   !== undefined) safeRamp(n[`${id}Pan`].pan, params.pan * 2 - 1, 0.02);
        if (params.depth !== undefined) safeRamp(n[`${id}CvDepth`].gain, Math.max(0, params.depth), 0.02);
        break;
      case 'chronos': {
        // Module sends the full {zone,time,repeats,halo,color,mix} each change.
        const CHRONOS_RANGES = { micro: [0.003, 0.03], mini: [0.03, 0.28], macro: [0.28, 3.0] };
        const zone = params.zone ?? 'mini';
        const [minT, maxT] = CHRONOS_RANGES[zone] || CHRONOS_RANGES.mini;
        const time    = Math.max(0, Math.min(1, params.time    ?? 0.5));
        const halo    = Math.max(0, Math.min(1, params.halo    ?? 0.3));
        const repeats = Math.max(0, Math.min(1, params.repeats ?? 0.45));
        const color   = Math.max(0, Math.min(1, params.color   ?? 0.6));
        const mix     = Math.max(0, Math.min(1, params.mix     ?? 0.5));
        const now  = Tone.now();
        const base = minT * Math.pow(maxT / minT, time); // log-mapped delay time
        n[`${id}DelayL`].delayTime.setTargetAtTime(base, now, 0.05);
        n[`${id}DelayR`].delayTime.setTargetAtTime(base * (1 + 0.035 * halo), now, 0.05); // R drifts → width
        const cut = 400 * Math.pow(50, color); // 400 Hz (dark) … 20 kHz (bright)
        n[`${id}LpL`].frequency.setTargetAtTime(cut, now, 0.05);
        n[`${id}LpR`].frequency.setTargetAtTime(cut, now, 0.05);
        // Feedback + cross share headroom so the coupled loop stays stable
        // (|self| + |cross| ≤ ~0.9; the tanh soft-clip guards the rest).
        const cross = halo * 0.4;
        const fb    = repeats * (0.9 - 0.4 * halo);
        safeRamp(n[`${id}FbL`].gain,  fb);    safeRamp(n[`${id}FbR`].gain,  fb);
        safeRamp(n[`${id}XfbL`].gain, cross); safeRamp(n[`${id}XfbR`].gain, cross);
        // HALO also widens the allpass diffusion spread
        n[`${id}Ap1L`].frequency.setTargetAtTime(300 + halo * 700, now, 0.05);
        n[`${id}Ap1R`].frequency.setTargetAtTime(360 + halo * 700, now, 0.05);
        n[`${id}Ap2L`].frequency.setTargetAtTime(1500 + halo * 1500, now, 0.05);
        n[`${id}Ap2R`].frequency.setTargetAtTime(1700 + halo * 1500, now, 0.05);
        // MIX — equal-power dry/wet crossfade
        const wetG = Math.sin(mix * Math.PI / 2), dryG = Math.cos(mix * Math.PI / 2);
        safeRamp(n[`${id}WetL`].gain, wetG); safeRamp(n[`${id}WetR`].gain, wetG);
        safeRamp(n[`${id}Dry`].gain,  dryG);
        break;
      }
      case 'folder':
        if (params.fold     !== undefined) safeRamp(n[`${id}Drive`].gain, 0.2 + params.fold * 0.8); // 0.2..1.0
        if (params.symmetry !== undefined) safeRamp(n[`${id}Bias`], (params.symmetry - 0.5));       // -0.5..0.5 DC
        if (params.output   !== undefined) safeRamp(n[`${id}Out`].gain, params.output * 2);          // 0..2×
        break;
      case 'kick':
        applyKickParams(id, params);
        break;
      case 'voc':
        applyVocoderParams(id, params);
        break;
      case 'qnt':
        applyQuantizerParamsRef.current?.(id, params);
        break;
      case 'ffb':
        if (params.bands) {
          params.bands.forEach((v, i) => {
            const g = n[`${id}Gain${i}`];
            if (g) safeRamp(g.gain, Math.max(0, Math.min(1.5, v)), 0.02);
          });
        }
        if (params.master !== undefined) safeRamp(n[`${id}Master`].gain, Math.max(0, params.master), 0.02);
        break;
      default: break; // vco uses updateVcoParams, env uses updateEnvParams (both id-keyed already)
    }
  }, [applyKickParams, applyVocoderParams, applyLfoParams, applyVcaParams, scheduleRevDamp, applyChorusParams]);

  // Instantaneous LFO phase by instance id — generic name composition covers
  // static ('lfo'/'lfo2') and dynamic ('lfo3'+) analysers alike.
  const getLfoInstantById = useCallback((id) => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    const data = n?.[`${id}WaveAnalyser`]?.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2;
  }, []);

  // Caller (LibraryModal) MUST strip the instance's cables first — disposal
  // while an audio connection exists is the Phase 60 risk #1.
  const removeModule = useCallback((id) => {
    const inst = dynInstancesRef.current.get(id);
    const n    = nodesRef.current;
    if (!inst || !n) return;
    const jm = { ...jackMapRef.current };
    inst.jackIds.forEach(j => delete jm[j]);
    jackMapRef.current = jm;
    // Per-instance VCO core worklet (Phase 60d/68b): a native AudioWorkletNode —
    // disconnect only (no dispose), and BEFORE its syncIn/coreGate neighbors go.
    const hs = n.hardSyncNodes?.[id];
    if (hs) {
      try { hs.disconnect(); } catch (_) {}
      delete n.hardSyncNodes[id];
    }
    // Vocoder: sever the shared mic fan-out INTO this instance BEFORE disposal —
    // node.disconnect() only drops a node's own outputs, never its inputs, so a
    // disposed ModRaw would leave a dangling edge on the singleton extMicGain.
    if (inst.type === 'voc') {
      try { n.extMicGain.disconnect(n[`${id}MicGain`]); } catch (_) {}
      // Native worklet/merger/splitter are not Tone nodes — disconnect, never dispose,
      // and do it BEFORE the nodeNames sweep takes their neighbours (the hardSync order).
      const ef = n.envFollowNodes?.[id];
      if (ef) {
        try { ef.node.disconnect(); }   catch (_) {}
        try { ef.merger.disconnect(); } catch (_) {}
        try { ef.split.disconnect(); }  catch (_) {}
        delete n.envFollowNodes[id];
      }
      delete vocDecayRefs.current[id];
    }
    // Quantizer: its worklet is a native AudioWorkletNode — disconnect only
    // (no dispose), and BEFORE its Out/KeepAlive neighbors are disposed.
    if (inst.type === 'qnt') {
      const qn = n.qntNodes?.[id];
      if (qn) {
        try { qn.disconnect(); } catch (_) {}
        delete n.qntNodes[id];
      }
    }
    inst.nodeNames.forEach(name => {
      const node = n[name];
      if (!node) return;
      try { node.stop?.(); }       catch (_) {}
      try { node.disconnect(); }   catch (_) {}
      try { node.dispose(); }      catch (_) {}
      delete n[name];
    });
    if (inst.type === 'bbd') { delete chorusDepthRef.current[id]; delete chorusDelayRef.current[id]; }
    if (inst.type === 'vca') delete vcaLinRefs.current[id];
    if (inst.type === 'rev') {
      // Kill any debounced DAMP write before the Freeverb is gone (Phase 70).
      clearTimeout(revDampTimerRef.current[id]);
      delete revDampTimerRef.current[id];
      delete revDampTargetRef.current[id];
    }
    if (inst.type === 'vco') {
      allVcoIdsRef.current = allVcoIdsRef.current.filter(v => v !== id);
      delete vcoKnobHzRef.current[id];
      delete vcoActiveCvRef.current[id];
      delete qntFmEngagedRef.current[id];   // Phase 70 — quantized-FM bookkeeping
      delete qntFmMutedRef.current[id];
      delete qntFmLastHzRef.current[id];
      delete dynVcoSyncRef.current[id];
    }
    if (inst.type === 'kick') {
      delete kickTuneRef.current[id];
      delete kickDecayRef.current[id];
      delete kickTrigCbRef.current[id];
    }
    if (inst.type === 'seq') {
      const loop = seqLoopsRef.current[id];
      if (loop) {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      }
      delete seqLoopsRef.current[id];
      delete seqStepsRefs.current[id];
      delete seqCurrentStepRefs.current[id];
      delete seqStepCbRefs.current[id];
      delete seqGlideRefs.current[id];
    }
    if (inst.type === 'voc') {
      delete vocShiftBaseRefs.current[id];
      delete vocShiftLfoRateRefs.current[id];
      delete vocShiftLfoAmpRefs.current[id];
      delete vocShiftLastRatioRefs.current[id];
      vocIdsRef.current = vocIdsRef.current.filter(v => v !== id);
    }
    if (inst.type === 'vowel') {
      vowelIdsRef.current = vowelIdsRef.current.filter(v => v !== id); // stop the rAF iterating it
      delete vowelMorphRefs.current[id];
      delete vowelShapeRefs.current[id];
      delete vowelLastFreqRefs.current[id];
      delete vowelDirectRefs.current[id];
      delete vowelFromRefs.current[id];
      delete vowelToRefs.current[id];
    }
    if (inst.type === 'lfo') {
      delete lfoSyncActiveRef.current[id]; // stop the sync rAF iterating it
      delete lfoRateRefs.current[id];
      delete lfoOffsetRefs.current[id];
      delete lfoDepthRefs.current[id];
      delete lfoWaveRefs.current[id];
      delete lfoSyncLastRefs.current[id];
    }
    if (inst.type === 'chordseq') {
      const loop = chordSeqLoopsRef.current[id];
      if (loop) {
        try { loop.stop(); }    catch (_) {}
        try { loop.dispose(); } catch (_) {}
      }
      delete chordSeqLoopsRef.current[id];
      delete chordSeqStepsRefs.current[id];
      delete chordSeqCurrentStepRefs.current[id];
      delete chordSeqStepCbRefs.current[id];
      delete chordSeqChordCbRefs.current[id];
      delete chordSeqDivisionRefs.current[id];
      delete chordSeqRootOctaveRefs.current[id];
      delete chordSeqGlideRefs.current[id];
      delete chordSeqInputActiveRefs.current[id];
      chordSeqIdsRef.current = chordSeqIdsRef.current.filter(c => c !== id);
      // Any quantizer this chord seq was overriding reverts to manual control.
      for (const [qid, owner] of Object.entries(qntChordOverrideRef.current))
        if (owner === id) delete qntChordOverrideRef.current[qid];
    }
    if (inst.type === 'qnt') {
      delete quantizerParamsRefs.current[id];
      delete lastQuantizedMidiRefs.current[id];
      delete quantizerStepCbRefs.current[id];
      delete qntChordOverrideRef.current[id];
      qntIdsRef.current = qntIdsRef.current.filter(q => q !== id);
    }
    dynInstancesRef.current.delete(id);
  }, []);

  // ── VCO knob-stepper mode (Phase 57, id-keyed since 60e part 4) ──
  // Active for a VCO when some quantizer's cv-out → vcoN-cv is patched AND
  // nothing feeds THAT quantizer's cv-in. With a melody source patched into the
  // quantizer, its worklet's port.onmessage owns the glideBus (melody-quantize
  // path); with no input, ownership falls to the FREQ knob, snapped through
  // quantizeHzJs against that instance's config. The two writers are mutually
  // exclusive by construction (Single Writer rule, per instance).
  const qntHasCvInput = useCallback((qid = 'qnt') =>
    [...connectionsRef.current.keys()].some(k => k.endsWith(`→${qid}-cv-in`)), []);

  // The quantizer id driving a VCO's cv-in, or null ('qnt' | 'qnt2' | …).
  const qntIdForVco = useCallback((vcoId) =>
    vcoActiveCvRef.current[vcoId]?.match(/^(qnt\d*)-cv-out$/)?.[1] ?? null, []);

  // VCOs currently snapping their FREQ knob (bypass counts as mode-off for the UI glow).
  const knobQuantizedVcoIds = useCallback(() =>
    allVcoIdsRef.current.filter(id => {
      const qid = qntIdForVco(id);
      return qid && !qntHasCvInput(qid) && !quantizerParamsRefs.current[qid]?.bypass;
    }), [qntHasCvInput, qntIdForVco]);

  const notifyKnobQuantize = useCallback(() => {
    vcoQuantizedCbRef.current?.(knobQuantizedVcoIds());
  }, [knobQuantizedVcoIds]);

  // Quantized FM engagement (Phase 70) — recomputed on cable changes and on LFO RATE
  // moves (the rate can cross QNT_FM_MAX_HZ). Sets qntFmEngagedRef[vcoId] = owning qid
  // or null; qntFmTick reads it every frame and handles the mute/restore transitions.
  const recomputeQntFm = useCallback(() => {
    const keys = [...connectionsRef.current.keys()];
    for (const vcoId of allVcoIdsRef.current) {
      const qid = qntIdForVco(vcoId);
      // Only in knob-stepper mode: if the QNT has its own CV input, its worklet already
      // owns the pitch and the GlideBus is not ours to write.
      if (!qid || qntHasCvInput(qid) || !quantizerParamsRefs.current[qid]) {
        qntFmEngagedRef.current[vcoId] = null;
        continue;
      }
      const fmKey = keys.find(k => k.endsWith(`→${vcoId}-fm`));
      if (!fmKey) { qntFmEngagedRef.current[vcoId] = null; continue; }
      // Rate gate — only meaningful when the source is an LFO we can measure. A synced
      // LFO is always slow (divisions are ≤ 1/8), so it always qualifies.
      const src = fmKey.split('→')[0];
      const lfoMatch = src.match(/^(lfo\d*)-(sin|tri|sqr|saw)$/);
      let rateOk = true;
      if (lfoMatch && !lfoSyncActiveRef.current[lfoMatch[1]]) {
        rateOk = lfoRateHz(lfoRateRefs.current[lfoMatch[1]] ?? 0.3) <= QNT_FM_MAX_HZ;
      }
      qntFmEngagedRef.current[vcoId] = rateOk ? qid : null;
    }
  }, [qntIdForVco, qntHasCvInput]);
  // Inline-synced mirror — applyLfoParams and connect()/disconnect() are all defined
  // above this point, so they reach it through the ref (the applyQuantizerParams pattern).
  recomputeQntFmRef.current = recomputeQntFm;

  // SWEEP engagement is cable-driven (the isLfoSync pattern): a patched-but-silent CV
  // reads 0 V, which is indistinguishable from no cable, so the flag — not the level —
  // decides whether the hump applies. Without it an unpatched bank would sit permanently
  // humped at its centre band.
  const recomputeFfbSweep = useCallback(() => {
    const keys = [...connectionsRef.current.keys()];
    for (const id of ffbIdsRef.current) {
      ffbSweepActiveRef.current[id] = keys.some(k => k.endsWith(`→${id}-sweep-cv`));
    }
  }, []);
  recomputeFfbSweepRef.current = recomputeFfbSweep;

  // Write the FREQ knob's Hz — snapped, or raw when bypassed — to a qnt-patched
  // VCO's glideBus, and mirror the snapped note onto that QNT's display/LEDs.
  const applyVcoKnobQuantize = useCallback((vcoId) => {
    const n = nodesRef.current;
    if (!n) return;
    // Quantized FM owns this VCO's GlideBus while engaged (single writer) — it reads
    // vcoKnobHzRef itself, so a knob turn still lands on the very next frame.
    if (qntFmEngagedRef.current[vcoId]) return;
    const kHz = vcoKnobHzRef.current[vcoId];
    if (kHz == null) return;
    const qid = qntIdForVco(vcoId);
    const q   = qid && quantizerParamsRefs.current[qid];
    if (!q) return;
    const hz = quantizeHzJs(kHz, q);
    const gb = n[`${vcoId}GlideBus`];
    if (!gb) return;
    if (Tone.context.state === 'running') gb.rampTo(hz, 0.02);
    else                                  gb.value = hz;
    // (glideBus → worklet slaveFreq is connected — no separate write.)
    if (!q.bypass && quantizerStepCbRefs.current[qid]) {
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      lastQuantizedMidiRefs.current[qid] = midi;
      quantizerStepCbRefs.current[qid](((midi % 12) + 12) % 12, midi, undefined);
    }
  }, [qntIdForVco]);

  const connect = useCallback((fromId, toId) => {
    const jm = jackMapRef.current;
    const n  = nodesRef.current;
    if (!jm || !n) return;

    let from = jm[fromId];
    let to   = jm[toId];
    if (!from || !to) return;

    // Normalize cable direction: audio always flows out→in.
    // If the user dragged from an 'in' jack to an 'out' jack, swap so the key
    // and audio wiring are consistent regardless of which end the drag started from.
    let effFrom = fromId, effTo = toId;
    if (from.type === 'in' && to.type === 'out') {
      [effFrom, effTo] = [toId, fromId];
      [from, to] = [to, from];
    }

    const key = `${effFrom}→${effTo}`;
    if (connectionsRef.current.has(key)) return;

    // Gate cable: any isGate out → env?-gate — register programmatic trigger.
    // Keyed by full cable key so kbd-gate and seq-gate can both connect to the
    // same env jack independently without overwriting each other.
    if (from.isGate && to.isGate) {
      if (to.isKick) {
        // Kick gate — store without an env ref; loop handlers detect isKick and
        // resolve the target instance via kickId ('kick' = the static module).
        gateActionsRef.current.set(key, { isKick: true, kickId: to.kickId ?? 'kick', fromId: effFrom });
        connectionsRef.current.set(key, { isGate: true, toId: effTo });
      } else {
        const env = n[to.envId];
        if (env) {
          gateActionsRef.current.set(key, { env, fromId: effFrom, isTrig: !!to.isTrig });
          connectionsRef.current.set(key, { isGate: true, toId: effTo });
        }
      }
      return;
    }

    if (from.type !== 'out' || to.type !== 'in') return;

    // LFO tempo-sync (Phase 65): any clock/CV patched into an LFO's -sync jack
    // engages sync mode. No audio is routed — the value is computed in lfoSyncTick
    // from the Transport grid; the cable is purely the mode gesture.
    if (to.isLfoSync) {
      const lid = to.lfoId;
      lfoSyncActiveRef.current[lid] = true;
      lfoSyncLastRefs.current[lid]  = undefined;
      applyLfoMode(lid, true);
      connectionsRef.current.set(key, { isLfoSync: true, lfoId: lid });
      return;
    }

    if (from.node === null) return; // unimplemented output (e.g. seq-clk-out)

    // VCO cv-in — managed by glideBus, never audio-connected directly.
    // "Managed" sources (seq/kbd/qnt) are written by step loops/callbacks.
    // "Pass-through" sources (chord seq, other audio) audio-connect to the glideBus
    // which passes the signal through transparently (offset stays 0).
    if (to.isVcoCv) {
      const vcoId     = effTo.replace('-cv', '');
      const glideBus  = n[`${vcoId}GlideBus`];
      if (!glideBus) return;
      vcoActiveCvRef.current[vcoId] = effFrom;
      // Managed sources: no audio cable — step loops / rAF / port.onmessage write to glideBus.
      const MANAGED = new Set(['kbd-pitch-out']);
      // Any 960's pitch out / chord seq's CV outs / quantizer's cv-out are
      // managed — instance ids are open-ended (Phase 60e). Node names compose
      // from the jack id: chordseq2-3rd-out → n.chordseq2ThirdOut.
      const isSeqPitch   = /^seq\d*-pitch-out$/.test(effFrom);
      const chordOutKind = effFrom.match(/^(chordseq\d*)-(cv|root|3rd|5th)-out$/);
      const qntOutMatch  = effFrom.match(/^(qnt\d*)-cv-out$/);
      const CHORD_OUT_SUFFIX = { cv: 'PitchOut', root: 'RootOut', '3rd': 'ThirdOut', '5th': 'FifthOut' };
      if (MANAGED.has(effFrom) || isSeqPitch || chordOutKind || qntOutMatch) {
        // No audio cable — step loops/quantizer callback write to glideBus on each event.
        // Seed the glideBus with the source's current value so there's no jump on connect.
        const seedHz = isSeqPitch    ? (n[`${effFrom.replace('-pitch-out', '')}PitchOut`]?.value ?? SEQ_HZ_MIN)
                     : chordOutKind  ? (n[`${chordOutKind[1]}${CHORD_OUT_SUFFIX[chordOutKind[2]]}`]?.value ?? SEQ_HZ_MIN)
                     : qntOutMatch   ? 440 * Math.pow(2, ((lastQuantizedMidiRefs.current[qntOutMatch[1]] ?? 69) - 69) / 12)
                     : effFrom === 'kbd-pitch-out'     ? (n.kbdPitchOut.value       ?? SEQ_HZ_MIN)
                     : SEQ_HZ_MIN;
        glideBus.setValueAtTime(seedHz, Tone.now());
      } else {
        // Pass-through: audio-connect so the source flows to the glideBus offset-addition.
        // Zero the offset so only the source drives the bus (no double-counting).
        glideBus.setValueAtTime(0, Tone.now());
        try { from.node.connect(glideBus); } catch (e) {
          console.warn(`[MoogAudio] vco-cv pass-through connect ${key}:`, e.message);
        }
      }
      connectionsRef.current.set(key, { isVcoCv: true, vcoId, sourceId: effFrom,
        audioNode: (MANAGED.has(effFrom) || isSeqPitch || chordOutKind || qntOutMatch) ? null : from.node });
      // Knob-stepper mode: quantizer idle (no CV input) — snap the knob's value
      // immediately (overrides the generic seed) and light the FREQ knob glow.
      // Either way, seed the worklet's modulation-mode base from this knob.
      if (qntOutMatch) {
        const qid = qntOutMatch[1];
        const kHz = vcoKnobHzRef.current[vcoId];
        if (kHz != null && quantizerParamsRefs.current[qid]) {
          quantizerParamsRefs.current[qid].baseHz = kHz;
          n.qntNodes?.[qid]?.port.postMessage({ baseHz: kHz });
        }
        if (!qntHasCvInput(qid)) applyVcoKnobQuantize(vcoId);
        notifyKnobQuantize(); recomputeQntFmRef.current?.();
      }
      return;
    }

    if (to.dest === null) return;   // deferred jack — silently no-op

    // Set VCO or LFO waveform to match the specific output jack patched.
    // waveformTarget separates the waveform-setting node (e.g. n.vco2) from the
    // routing node (e.g. n.vco2bus) when they differ.
    const waveformNode = from.waveformTarget ?? from.node;
    if (from.waveform) waveformNode.type = from.waveform;
    // Keep the synced value's waveform in step with whichever LFO output is patched.
    const lfoWaveMatch = effFrom.match(/^(lfo\d*)-(sin|tri|sqr|saw)$/);
    if (lfoWaveMatch) lfoWaveRefs.current[lfoWaveMatch[1]] = from.waveform;

    // Chord-seq → quantizer scale override: when any chord seq's cv-out is
    // patched to qnt-transpose-in, THAT instance's loop takes ownership of the
    // quantizer's root+scale (last patch wins). Apply the current chord
    // immediately so the quantizer is correct right away — don't wait for the
    // next bar boundary.
    const trpMatch = effTo.match(/^(qnt\d*)-transpose-in$/);
    if (/^chordseq\d*-cv-out$/.test(effFrom) && trpMatch) {
      const csId = effFrom.replace('-cv-out', '');
      const qid  = trpMatch[1];
      qntChordOverrideRef.current[qid] = csId;
      const stepIdx = chordSeqCurrentStepRefs.current[csId] ?? -1;
      const step    = chordSeqStepsRefs.current[csId]?.[Math.max(0, stepIdx)];
      const qp      = quantizerParamsRefs.current[qid];
      if (step && qp) {
        qp.root  = step.rootClass;
        qp.scale = SCALE_DEFS[step.chordType] ?? SCALE_DEFS.CMAJ;
        n.qntNodes?.[qid]?.port.postMessage(qp);
      }
    }

    try {
      from.node.connect(to.dest);
      connectionsRef.current.set(key, { node: from.node, dest: to.dest });
    } catch (e) {
      console.warn(`[MoogAudio] connect ${key}:`, e.message);
    }

    // A CV source now feeds a quantizer — its worklet takes over qnt-driven
    // VCO pitch; any knob-stepper glow on that instance's VCOs turns off.
    if (/^qnt\d*-cv-in$/.test(effTo)) notifyKnobQuantize();
    // Any cable can change quantized-FM engagement (an FM patch, a qnt→cv patch, or a
    // qnt-cv-in patch handing pitch to the worklet), so recompute unconditionally.
    recomputeQntFmRef.current?.();
    recomputeFfbSweepRef.current?.();
  }, [qntHasCvInput, applyVcoKnobQuantize, notifyKnobQuantize, applyLfoMode]);

  const disconnect = useCallback((fromId, toId) => {
    // Mirror the same direction normalization as connect() so the key matches.
    const jm = jackMapRef.current;
    let effFrom = fromId, effTo = toId;
    if (jm) {
      const f = jm[fromId], t = jm[toId];
      if (f?.type === 'in' && t?.type === 'out') {
        [effFrom, effTo] = [toId, fromId];
      }
    }

    const key  = `${effFrom}→${effTo}`;
    const conn = connectionsRef.current.get(key);
    if (!conn) return;

    // LFO tempo-sync cable removed (Phase 65) — revert to free-running unless
    // another cable still feeds this LFO's -sync jack (multi-patch safety).
    if (conn.isLfoSync) {
      const lid = conn.lfoId;
      connectionsRef.current.delete(key);
      let stillSynced = false;
      for (const c of connectionsRef.current.values()) {
        if (c.isLfoSync && c.lfoId === lid) { stillSynced = true; break; }
      }
      if (!stillSynced) {
        lfoSyncActiveRef.current[lid] = false;
        applyLfoMode(lid, false);
      }
      return;
    }

    if (conn.isGate) {
      gateActionsRef.current.delete(key); // keyed by cable key, not toId
      connectionsRef.current.delete(key);
      return;
    }

    // VCO cv-in disconnect — restore glideBus to knob value, clear source tracking.
    if (conn.isVcoCv) {
      const n = nodesRef.current;
      if (!n) { connectionsRef.current.delete(key); return; }
      const { vcoId, audioNode } = conn;
      // Disconnect pass-through audio cable if present.
      if (audioNode) {
        try { audioNode.disconnect(n[`${vcoId}GlideBus`]); } catch (_) {}
      }
      vcoActiveCvRef.current[vcoId] = null;
      connectionsRef.current.delete(key);
      // Restore knob Hz to the glideBus (instant — no glide on cable-remove).
      const kHz = vcoKnobHzRef.current[vcoId];
      if (kHz != null) {
        n[`${vcoId}GlideBus`].setValueAtTime(kHz, Tone.now());
        // (glideBus → worklet slaveFreq is connected — no separate write.)
      }
      if (/^qnt\d*-cv-out$/.test(conn.sourceId)) notifyKnobQuantize(); recomputeQntFmRef.current?.(); // glow off for this VCO
      return;
    }

    try {
      conn.node.disconnect(conn.dest);
    } catch (e) {
      console.warn(`[MoogAudio] disconnect ${key}:`, e.message);
    }
    connectionsRef.current.delete(key);

    // Chord-seq → quantizer override: clear when the OWNING chord seq's cable
    // to that quantizer is removed (a stale cable from another chord seq must
    // not clear a newer owner).
    const trpOff = effTo.match(/^(qnt\d*)-transpose-in$/);
    if (trpOff &&
        qntChordOverrideRef.current[trpOff[1]] === effFrom.replace('-cv-out', '')) {
      delete qntChordOverrideRef.current[trpOff[1]];
    }

    // A quantizer's CV input removed — pitch ownership of ITS qnt-patched VCOs
    // falls back to their FREQ knobs (snapped); re-apply and re-light the glow.
    const cvInOff = effTo.match(/^(qnt\d*)-cv-in$/);
    if (cvInOff) {
      const cvOutSrc = `${cvInOff[1]}-cv-out`;
      for (const id of allVcoIdsRef.current)
        if (vcoActiveCvRef.current[id] === cvOutSrc) applyVcoKnobQuantize(id);
      notifyKnobQuantize();
    }
    // Unconditional, for the same reason as in connect() — pulling the FM cable must
    // disengage and hand the direct ×500 path back.
    recomputeQntFmRef.current?.();
    recomputeFfbSweepRef.current?.();
  }, [applyVcoKnobQuantize, notifyKnobQuantize, applyLfoMode]);

  // Update VCO audio parameters — single writer per node.
  // vcoId: 'vco1' | 'vco2' | 'vco3'
  //
  // Uses setTargetAtTime (τ=20ms) instead of safeRamp/rampTo for frequency and detune.
  // Reason: rampTo dispatches to exponentialRampTo for frequency-type AudioParams.
  // Exponential ramps are undefined at 0 — if seqPitchOut (initialized to 0 before this
  // fix) schedules a setValueAtTime(0) on the same AudioParam via a patch cable, the
  // subsequent exponential ramp crashes: "Value must be within [0, 0]".
  // setTargetAtTime bypasses Tone.js assertRange, accepts any value, and approaches the
  // target asymptotically (never actually reaches 0), so it is safe in all cases.
  // Phase 68b: the VCO core is the worklet; pitch/detune/width are written to
  // per-VCO Signals (GlideBus/DetuneSig/WidthSig) which are connected to the
  // worklet params in wire(). No direct oscillator node any more (`width` 0..1).
  const updateVcoParams = useCallback((vcoId, { hz, detune, width } = {}) => {
    const n = nodesRef.current;
    if (!n || !n[`${vcoId}GlideBus`]) return;
    if (hz !== undefined) {
      const safeHz = Math.max(0.1, hz);
      vcoKnobHzRef.current[vcoId] = safeHz;
      // Only write when no CV source is connected — glideBus is the sole pitch writer.
      const hasCv = vcoActiveCvRef.current[vcoId] != null;
      if (!hasCv) {
        const gb = n[`${vcoId}GlideBus`];
        if (Tone.context.state === 'running') gb.rampTo(safeHz, 0.02);
        else                                  gb.value = safeHz;
      } else {
        const qid = qntIdForVco(vcoId);
        if (qid && quantizerParamsRefs.current[qid]) {
          // The knob is that quantizer's center (Phase 58): post as its worklet's
          // modulation-mode base so LFO-through-QNT sweeps track the knob…
          quantizerParamsRefs.current[qid].baseHz = safeHz;
          n.qntNodes?.[qid]?.port.postMessage({ baseHz: safeHz });
          // …and in knob-stepper mode (no CV into that quantizer, Phase 57) snap
          // it to the scale now (raw when bypassed).
          if (!qntHasCvInput(qid)) applyVcoKnobQuantize(vcoId);
        }
      }
    }
    if (detune !== undefined) {
      const d = n[`${vcoId}DetuneSig`];
      if (d) { if (Tone.context.state === 'running') d.rampTo(detune, 0.02); else d.value = detune; }
    }
    if (width !== undefined) {
      const w = n[`${vcoId}WidthSig`];
      if (w) { if (Tone.context.state === 'running') w.rampTo(width, 0.02); else w.value = width; }
    }
  }, [qntHasCvInput, applyVcoKnobQuantize, qntIdForVco]);

  // Update VCF audio parameters — single writer per node.
  // cutoff   (0–1) → exponential 20 Hz–20 kHz  (20 * 1000^cutoff)
  // resonance (0–1) → Q 0–20; floored at 0.001 — Q=0 fails exponential ramp.
  //
  // cutoff uses setTargetAtTime for the same reason as VCO frequency — it is a
  // frequency-type AudioParam where rampTo → exponentialRampTo, unsafe near 0.
  // resonance uses safeRamp (linear path, floor already applied, no crash risk).
  //
  // envAmt (0–1) → the ENV-jack cents scaler (Phase 70). This knob is the SOLE
  // writer of `vcfenv.gain`; the cable patched into the ENV jack owns the signal
  // flowing through it. A plain linear ramp is safe (Gain, floor 0).
  const updateEnvParams = useCallback((envId, { attack, decay, sustain, release } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    const env = n[envId];
    if (!env) return;
    if (attack  !== undefined) env.attack  = 0.01 * Math.pow(1000, attack);
    if (decay   !== undefined) env.decay   = 0.01 * Math.pow(1000, decay);
    if (sustain !== undefined) env.sustain = sustain;
    if (release !== undefined) env.release = 0.01 * Math.pow(1000, release);
  }, []);

  // Trigger or release an envelope gate.  envId: 'env1' | 'env2'.
  // Tone.Envelope outputs a 0–1 CV signal — when patched to vca-cv it runs through
  // that VCA's ENV AMT attenuator and LOG/LIN curve (buildVcaCv), and the Web Audio
  // API adds the result to vca.gain's base value (the GAIN knob / updateVcaParams).
  const triggerGate = useCallback((envId, isDown) => {
    const n = nodesRef.current;
    if (!n) return;
    const env = n[envId];
    if (!env) return;
    if (isDown) env.triggerAttack();
    else        env.triggerRelease();
  }, []);

  // Static VCA updaters — thin id-bound wrappers over the shared applier above.
  const updateVcaParams  = useCallback((p) => applyVcaParams('vca',  p), [applyVcaParams]);
  const updateVca2Params = useCallback((p) => applyVcaParams('vca2', p), [applyVcaParams]);
  const updateVca3Params = useCallback((p) => applyVcaParams('vca3', p), [applyVcaParams]);

  // Update LFO parameters.
  // rate  (0–1) → exponential 0.1 Hz–30 Hz  (0.1 * 300^rate)
  // depth (0–1) → lfo.amplitude 0–1 (scales the ±1 output swing)
  // type  (string) → lfo.type; UI-driven default, overridden by whichever waveform jack
  //        is patched (the connect() function also sets lfo.type via from.waveform).
  // Both static LFOs route through the shared applier (Phase 65) so the sync refs
  // stay populated. modDepth (0–1) → lfoNmodGain.gain (0–10 Hz) in free mode; the
  // same value is reused as the sync OFFSET (phase). See applyLfoParams.
  const updateLfoParams  = useCallback((p) => applyLfoParams('lfo',  p), [applyLfoParams]);
  const updateLfo2Params = useCallback((p) => applyLfoParams('lfo2', p), [applyLfoParams]);

  // Update reverb parameters — single writer on n.reverb.
  // roomSize (0–1): 0 = small/tight, capped at REV_MAX_ROOM (see the const — 1.0 is a
  //                 unity-feedback runaway, not a "bigger room").
  // wet      (0–1): dry/wet mix crossfade. The MIX-CV cable sums on top of this value.
  // damp     (0–1): tail brightness → Freeverb `dampening`, via the debounced scheduler
  //                 (every write rebuilds 8 IIRFilter nodes — see the REV_DAMP notes).
  const updateReverbParams = useCallback(({ roomSize, wet, damp } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (roomSize !== undefined) safeRamp(n.reverb.roomSize, Math.min(REV_MAX_ROOM, roomSize));
    if (wet      !== undefined) safeRamp(n.reverb.wet,      wet);
    if (damp     !== undefined) scheduleRevDamp('reverb', damp);
  }, [scheduleRevDamp]);

  const updateReverb2Params = useCallback(({ roomSize, wet, damp } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (roomSize !== undefined) safeRamp(n.reverb2.roomSize, Math.min(REV_MAX_ROOM, roomSize));
    if (wet      !== undefined) safeRamp(n.reverb2.wet,      wet);
    if (damp     !== undefined) scheduleRevDamp('reverb2', damp);
  }, [scheduleRevDamp]);

  // BBD chorus — delegates to the shared applier so static and dynamic never drift.
  const updateChorusParams = useCallback((p) => applyChorusParams('chorus', p), [applyChorusParams]);

  // Update VCF audio parameters — single writer per node.
  // cutoff    (0–1) → exponential 20 Hz–20 kHz  (20 * 1000^cutoff)
  // resonance (0–1) → Q 0–20; floored at 0.001 — Q=0 fails exponential ramp.
  // cutoff uses setTargetAtTime (frequency params dispatch rampTo → exponential, unsafe near 0).
  // envAmt    (0–1) → the ENV-jack cents scaler (Phase 70); this knob is its SOLE writer.
  const updateVcfParams = useCallback(({ cutoff, resonance, envAmt } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (cutoff    !== undefined) n.vcf.frequency.setTargetAtTime(20 * Math.pow(1000, cutoff), Tone.now(), 0.02);
    if (resonance !== undefined) safeRamp(n.vcf.Q, Math.max(0.001, resonance * 20));
    if (envAmt    !== undefined) safeRamp(n.vcfenv.gain, vcfEnvAmtCents(envAmt));
  }, []);

  const updateVcf2Params = useCallback(({ cutoff, resonance, envAmt } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (cutoff    !== undefined) n.vcf2.frequency.setTargetAtTime(20 * Math.pow(1000, cutoff), Tone.now(), 0.02);
    if (resonance !== undefined) safeRamp(n.vcf2.Q, Math.max(0.001, resonance * 20));
    if (envAmt    !== undefined) safeRamp(n.vcf2env.gain, vcfEnvAmtCents(envAmt));
  }, []);


  // Update per-channel mixer volume for the 4-channel I/O input stage.
  // channelIndex: 1–4  value: 0–1 linear gain (0 = muted, 1 = unity gain).
  // Single writer per node — this is the only function that touches ioCh1–ioCh4.gain.
  const updateIoChannelVol = useCallback((channelIndex, value) => {
    const n = nodesRef.current;
    if (!n) return;
    const node = n[`ioCh${channelIndex}`];
    if (!node) return;
    safeRamp(node.gain, value);
  }, []);

  // Update master output volume — single writer on n.master.volume.
  // volume (0–1) → -60 dB to +6 dB  (linear dB scale; 0.75 ≈ -13.5 dB, matching init)
  const updateIoParams = useCallback(({ volume } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (volume !== undefined) safeRamp(n.master.volume, -60 + volume * 66);
  }, []);

  // Returns the Moog recording bus node (Tone.Gain) for the Workstation's Tone.Recorder.
  // Returns null until the audio engine has initialised (before POWER is first clicked is fine —
  // the bus node exists from creation, not from powerOn).
  const getMoogBusNode = useCallback(() => nodesRef.current?.moogBus ?? null, []);

  // Returns the current waveform snapshot from the oscilloscope analyser tap.
  // Returns Float32Array of 512 samples in [-1, 1], or null before nodes are created.
  const getOscilloscopeData = useCallback(() => {
    const n = nodesRef.current;
    if (!n) return null;
    return n.analyser.getValue();
  }, []);

  // Returns the FFT snapshot (Float32Array of dB values) from a reverb's Aura
  // analyser tap, or null before nodes are created. num: 1 | 2 selects the module.
  // num: 1 | 2 for the static reverbs, or a dynamic instance id ('reverb3'+).
  const getReverbAuraData = useCallback((num = 1) => {
    const n = nodesRef.current;
    if (!n) return null;
    const analyser = num === 1 ? n.reverbAnalyser
                   : num === 2 ? n.reverb2Analyser
                   : n[`${num}Analyser`];
    return analyser?.getValue() ?? null;
  }, []);

  // Returns the raw waveform data from the TRANSPOSE CV analyser.
  // The average absolute value of these samples is the DC level = Hz from the patched source.
  // Returns Float32Array of 256 samples, or null before nodes are created.
  // id-generic (Phase 60e part 4): 'qnt' (static, default) or a dynamic
  // instance id — name composition covers both ('qntTransposeAnalyser' /
  // 'qnt2TransposeAnalyser').
  const getQntTransposeData = useCallback((qid = 'qnt') => {
    const n = nodesRef.current;
    return n?.[`${qid}TransposeAnalyser`]?.getValue() ?? null;
  }, []);

  // Returns the normalised level [0, 1] from a named meter tap.
  // id: 'lfo' | 'env1' | 'env2' | 'master'
  // Returns 0 if nodes not yet created or id is unknown. Handles -Infinity (silence)
  // and NaN gracefully — Tone.Meter can return -Infinity in dB mode, but with
  // normalRange:true it returns 0 for silence, so isFinite is a safety net.
  const getMeterValue = useCallback((id) => {
    const n = nodesRef.current;
    if (!n) return 0;
    const meter = n[`${id}Meter`];
    if (!meter) return 0;
    const v = meter.getValue();
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }, []);

  // Instantaneous LFO phase value [0, 1] for the rate LED — reads the last sample of
  // the waveform analyser buffer rather than a smoothed RMS meter, so the LED pulses
  // at the actual modulated rate (including any incoming FM CV on lfo-fm).
  // Returns 0 when not powered so the LED stays dim when the synth is off.
  const getLfoInstant = useCallback(() => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    if (!n) return 0;
    const data = n.lfoWaveAnalyser.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2; // [-1,1] → [0,1]
  }, []);

  const getLfo2Instant = useCallback(() => {
    if (!isPoweredRef.current) return 0;
    const n = nodesRef.current;
    if (!n) return 0;
    const data = n.lfo2WaveAnalyser.getValue();
    if (!data || !data.length) return 0;
    return (data[data.length - 1] + 1) / 2;
  }, []);

  // Sequencer BPM — ramps Transport tempo so the change is click-free.
  const setTempo = useCallback((bpm) => {
    Tone.Transport.bpm.rampTo(bpm, 0.1);
  }, []);

  // Push latest step data into the audio loop maps — no React state involved.
  // id-keyed (Phase 60e): 'seq' / 'seq2' statics, 'seq3'+ dynamics.
  const updateSeqStepsById = useCallback((seqId, steps) => {
    seqStepsRefs.current[seqId] = steps;
  }, []);

  // Register the UI step-advance callback (called inside Tone.Loop, main thread).
  // Pass null to deregister. The callback receives: (stepIndex: 0–15) | -1 (clear all).
  const setSeqStepCallbackById = useCallback((seqId, fn) => {
    seqStepCbRefs.current[seqId] = fn;
  }, []);

  const setSeqGlideById = useCallback((seqId, v) => {
    seqGlideRefs.current[seqId] = v;
  }, []);

  // Legacy static-module wrappers — the shell's seq1/seq2 call sites use these.
  const updateSequencerSteps = useCallback((steps) => updateSeqStepsById('seq', steps),  [updateSeqStepsById]);
  const setSeqStepCallback   = useCallback((fn)    => setSeqStepCallbackById('seq', fn), [setSeqStepCallbackById]);
  const updateSeq2Steps      = useCallback((steps) => updateSeqStepsById('seq2', steps), [updateSeqStepsById]);
  const setSeq2StepCallback  = useCallback((fn)    => setSeqStepCallbackById('seq2', fn), [setSeqStepCallbackById]);

  // Update a quantizer's scale and/or root note (id-keyed, Phase 60e part 4).
  // scale (string key: 'CHR' | 'MAJ' | 'MIN' | 'PMAJ' | 'PMIN')
  // root  (0–11: 0=C, 1=C#, …, 11=B)
  // Params are buffered per instance so they are sent correctly even if
  // called before its AudioWorkletNode exists.
  const applyQuantizerParams = useCallback((qid, { scale, root, octShift, bypass } = {}) => {
    const qp = quantizerParamsRefs.current[qid];
    if (!qp) return;
    if (scale    !== undefined) qp.scale    = SCALE_DEFS[scale] ?? SCALE_DEFS.MAJ;
    if (root     !== undefined) qp.root     = root;
    if (octShift !== undefined) qp.octShift = octShift;
    if (bypass   !== undefined) qp.bypass   = bypass;
    // Knob-stepper mode (Phase 57): config changes re-snap the VCO knobs THIS
    // quantizer drives (bypass ON writes the raw knob Hz — reverts to continuous).
    if (!qntHasCvInput(qid)) {
      const cvOutSrc = `${qid}-cv-out`;
      for (const id of allVcoIdsRef.current)
        if (vcoActiveCvRef.current[id] === cvOutSrc) applyVcoKnobQuantize(id);
    }
    if (bypass !== undefined) notifyKnobQuantize(); recomputeQntFmRef.current?.(); // glow follows bypass state
    nodesRef.current?.qntNodes?.[qid]?.port.postMessage(qp);
  }, [qntHasCvInput, applyVcoKnobQuantize, notifyKnobQuantize]);
  // Inline ref sync (the App.js mappingsRef pattern): updateDynModuleParams is
  // declared before the knob-stepper helpers this depends on, so it dispatches
  // dynamic 'qnt' params through this ref instead of a direct dependency.
  applyQuantizerParamsRef.current = applyQuantizerParams;

  // Legacy static-module wrapper — the shell's static QuantizerModule call site.
  const updateQuantizerParams = useCallback((p = {}) => applyQuantizerParams('qnt', p), [applyQuantizerParams]);

  // Chord sequencer setters — id-keyed (Phase 60e part 2): 'chordseq' static,
  // 'chordseq2'+ dynamics. The legacy no-id exports below wrap the static id.
  const updateChordSeqStepsById = useCallback((csId, steps) => {
    chordSeqStepsRefs.current[csId] = steps;
  }, []);

  // Register a chord sequencer LED step callback (same pattern as setSeqStepCallbackById).
  const setChordSeqStepCallbackById = useCallback((csId, fn) => {
    chordSeqStepCbRefs.current[csId] = fn;
  }, []);

  // Register a callback fired on each chord step advance: fn(rootClass: 0-11, chordType: string).
  // MoogShell uses the static instance's to update the QNT chord-type label.
  const setChordSeqChordCallbackById = useCallback((csId, fn) => {
    chordSeqChordCbRefs.current[csId] = fn;
  }, []);

  // Set the octave offset for an instance's independent chord root output.
  // octave: integer -3..+3
  const setChordSeqRootOctaveById = useCallback((csId, octave) => {
    chordSeqRootOctaveRefs.current[csId] = octave;
  }, []);

  // Change a chord sequencer's clock division — takes effect immediately.
  // interval: Tone.js time string ('2n' | '1m' | '2m' | '4m')
  const setChordSeqDivisionById = useCallback((csId, interval) => {
    chordSeqDivisionRefs.current[csId] = interval;
    const loop = chordSeqLoopsRef.current[csId];
    if (loop) loop.interval = interval;
  }, []);

  const setChordSeqGlideById = useCallback((csId, v) => {
    chordSeqGlideRefs.current[csId] = v;
  }, []);

  // Legacy static-module wrappers — the shell's static ChordSeqModule call sites.
  const updateChordSeqSteps      = useCallback((steps)  => updateChordSeqStepsById('chordseq', steps),   [updateChordSeqStepsById]);
  const setChordSeqStepCallback  = useCallback((fn)     => setChordSeqStepCallbackById('chordseq', fn),  [setChordSeqStepCallbackById]);
  const setChordSeqChordCallback = useCallback((fn)     => setChordSeqChordCallbackById('chordseq', fn), [setChordSeqChordCallbackById]);
  const setChordSeqRootOctave    = useCallback((octave) => setChordSeqRootOctaveById('chordseq', octave), [setChordSeqRootOctaveById]);
  const setChordSeqDivision      = useCallback((interval) => setChordSeqDivisionById('chordseq', interval), [setChordSeqDivisionById]);

  // Register the quantizer LED callback (called from quantizer port.onmessage, main thread).
  // The callback receives: (noteClass: 0–11, midiNote: int) when the quantized note changes.
  const setQuantizerCallbackById = useCallback((qid, fn) => {
    quantizerStepCbRefs.current[qid] = fn;
  }, []);
  const setQuantizerCallback = useCallback((fn) => setQuantizerCallbackById('qnt', fn), [setQuantizerCallbackById]);

  // Register the knob-stepper UI callback: fn(vcoIds[]) — the VCOs whose FREQ
  // knob is currently quantized (MoogShell lights those knobs' glow).
  // Fires immediately with the current state so a re-mounting UI syncs up.
  const setVcoQuantizedCallback = useCallback((fn) => {
    vcoQuantizedCbRef.current = fn;
    fn?.(knobQuantizedVcoIds());
  }, [knobQuantizedVcoIds]);

  // Returns a quantizer's last quantized frequency in Hz (A4 = 440 Hz default).
  // Used by VcoModule's TUNE button to back-compute the correct FREQ knob position.
  const getLastQuantizedHz = useCallback((qid = 'qnt') => {
    return 440 * Math.pow(2, ((lastQuantizedMidiRefs.current[qid] ?? 69) - 69) / 12);
  }, []);

  // Kick triggers — id-keyed (Phase 60d). The static KickModule uses the
  // 'kick'-bound wrappers; dynamic instances bind their own id in MoogShell.
  const triggerKickById = useCallback((kid, onFlash) => {
    const n = nodesRef.current;
    const synth = n?.[`${kid}Synth`];
    if (!synth) return;
    // Clamped against the sequencer's already-scheduled hits — see nextKickTime.
    const t  = nextKickTime(kickLastTimeRef.current, kid, Tone.now());
    const kd = kickDecayRef.current[kid] ?? 0.4;
    const khz = kickTuneHz(n, kid, connectionsRef.current, kickTuneRef.current[kid] ?? 55);
    synth.triggerAttackRelease(khz, kd, t);
    n[`${kid}ClickSynth`]?.triggerAttackRelease(kd * 0.1, t);
    if (onFlash) drawAt(t, onFlash);   // lamp matches the (possibly nudged) hit
  }, []);

  const updateKickParams = useCallback((p = {}) => applyKickParams('kick', p), [applyKickParams]);
  const triggerKick      = useCallback((onFlash) => triggerKickById('kick', onFlash), [triggerKickById]);
  const setKickTrigCallbackById = useCallback((kid, fn) => { kickTrigCbRef.current[kid] = fn; }, []);

  // Keyboard vibrato — depth in Hz (0–20), rate in Hz, delay bool. Drives the rAF loop refs.
  const setKbdVibrato = useCallback(({ depth, rate, delay } = {}) => {
    if (depth !== undefined) kbdVibratoDepthRef.current = depth;
    if (rate  !== undefined) kbdVibratoRateRef.current  = rate;
    if (delay !== undefined) kbdVibratoDelayRef.current = delay; // delay = time in seconds
  }, []);

  // Noise LEVEL (Phase 8b) — id-keyed ('noise' | 'noise2' | 'noise3' statics,
  // 'noise4'+ dynamics). Knob 0–1 → gain 0–1.43× with unity at the 0.7 default,
  // so pre-8b patches (no gain stage) sound identical until the knob moves.
  const updateNoiseParams = useCallback((id, { level } = {}) => {
    const n = nodesRef.current;
    if (!n || !n[`${id}WGain`] || level === undefined) return;
    const g = Math.max(0, level) / 0.7;
    // Single writer of all six colour gains — each scaled by its makeup so the
    // colours sit at comparable loudness at the shared LEVEL (Phase 69).
    for (const [suf, mk] of NOISE_LEVEL_GAINS) {
      const node = n[`${id}${suf}`];
      if (node) safeRamp(node.gain, g * mk, 0.02);
    }
  }, []);

  const setSeqGlide  = useCallback((v) => setSeqGlideById('seq', v),  [setSeqGlideById]);
  const setChordSeqGlide = useCallback((v) => setChordSeqGlideById('chordseq', v), [setChordSeqGlideById]);
  const setSeq2Glide = useCallback((v) => setSeqGlideById('seq2', v), [setSeqGlideById]);
  const setKbdGlide  = useCallback((v) => { kbdGlideRef.current  = v; }, []);

  // 914 FFB — single writer per band gain node; master owns ffbMaster.gain.
  const updateFFBParams = useCallback(({ bands, master } = {}) => {
    const n = nodesRef.current;
    if (!n) return;
    if (bands) {
      bands.forEach((v, i) => {
        const g = n[`ffbGain${i}`];
        if (g) safeRamp(g.gain, Math.max(0, Math.min(1.5, v)), 0.02);
      });
    }
    if (master !== undefined) safeRamp(n.ffbMaster.gain, Math.max(0, master), 0.02);
  }, []);

  // id-generic (Phase 60d): 'ffb' (static, default) or a dynamic instance id
  // ('ffb2'…) — name composition covers both ('ffbAnalyser' / 'ffb2Analyser').
  const getFFBAnalyserData = useCallback((id = 'ffb') => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
  }, []);

  // 16-band Vocoder — legacy static-module wrapper (the full mapping lives in
  // applyVocoderParams, id-keyed since Phase 60e part 3).
  const updateVocoderParams = useCallback((p = {}) => applyVocoderParams('voc', p), [applyVocoderParams]);

  // id-generic: 'voc' (static, default) or a dynamic instance id ('voc2'…).
  const getVocAnalyserData = useCallback((id = 'voc') => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
  }, []);

  // Vowel/formant output spectrum (Phase 64) → drives the module's formant display.
  const getVowelAnalyserData = useCallback((id) => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
  }, []);

  // Panner L/R distribution (Phase 67) → drives the module's two stereo LEDs.
  // Per-channel level = input peak × equal-power gain at the EFFECTIVE pan
  // (knob base + sampled CV × depth), so the LEDs track both signal and motion.
  const getPanMeterData = useCallback((id) => {
    const n = nodesRef.current;
    if (!n || !n[`${id}InAnalyser`]) return null;
    const inWave = n[`${id}InAnalyser`].getValue();
    let peak = 0;
    for (let i = 0; i < inWave.length; i++) { const a = Math.abs(inWave[i]); if (a > peak) peak = a; }
    const level = Math.min(1, peak);
    const cvWave = n[`${id}CvAnalyser`].getValue();
    let sum = 0;
    for (let i = 0; i < cvWave.length; i++) sum += cvWave[i];
    const cv = sum / cvWave.length; // DC/mean of the CV input (bipolar)
    const base  = n[`${id}Pan`].pan.value;      // knob intrinsic value
    const depth = n[`${id}CvDepth`].gain.value; // CV attenuator
    const eff = Math.max(-1, Math.min(1, base + cv * depth));
    const angle = (eff + 1) * 0.25 * Math.PI;   // (eff+1)/2 · π/2 → equal-power
    return { l: level * Math.cos(angle), r: level * Math.sin(angle) };
  }, []);

  // Chronos delay display (Phase 68) → echo-ring visualizer. energy = post-
  // diffusion peak (feedback activity); delaySec = live L delay time (ring gap).
  const getChronosDisplay = useCallback((id) => {
    const n = nodesRef.current;
    if (!n || !n[`${id}Analyser`]) return null;
    const w = n[`${id}Analyser`].getValue();
    let peak = 0;
    for (let i = 0; i < w.length; i++) { const a = Math.abs(w[i]); if (a > peak) peak = a; }
    return { energy: Math.min(1, peak), delaySec: n[`${id}DelayL`].delayTime.value };
  }, []);

  // Wavefolder output waveform (Phase 68c) → drives the folded-wave scope.
  const getFolderScope = useCallback((id) => {
    const n = nodesRef.current;
    return n?.[`${id}Analyser`]?.getValue() ?? null;
  }, []);

  // Built-in vocoder mic — opens a Tone.UserMedia stream (requires a user gesture for the
  // browser permission prompt) and routes it into extMicGain, which feeds the vocoder
  // modulator (vocModRaw). Returns true on success, false if permission denied / unavailable.
  // Idempotent: a second call while already open is a no-op success.
  const enableMic = useCallback(async () => {
    const n = nodesRef.current;
    if (!n) return false;
    if (extMicRef.current) return true;
    try {
      await Tone.start(); // resume context + satisfy autoplay policy
      const mic = new Tone.UserMedia();
      await mic.open();
      mic.connect(n.extMicGain);
      extMicRef.current = mic;
      return true;
    } catch (e) {
      console.warn('[MoogAudio] mic enable failed:', e?.message ?? e);
      return false;
    }
  }, []);

  const disableMic = useCallback(() => {
    const mic = extMicRef.current;
    if (!mic) return;
    try { mic.close(); } catch (_) {}
    try { mic.dispose(); } catch (_) {}
    extMicRef.current = null;
  }, []);

  // External mic INPUT gain — single writer (this owns extMicGain.gain).
  // Sole writer of ONE vocoder instance's mic level. vid: 'voc' (static) | 'voc2'+.
  // extMicGain itself is never written — it is the shared tap for the singleton mic.
  const updateVocMicGain = useCallback((vid, { gain } = {}) => {
    const g = nodesRef.current?.[`${vid}MicGain`];
    if (!g || gain === undefined) return;
    safeRamp(g.gain, Math.max(0, gain), 0.05);
  }, []);

  // HARD SYNC enable — see the worklet-core note on the setters below.
  // The ref is always recorded so powerOn restores the correct crossfade.
  // Phase 68b: HARD SYNC is now the worklet core's syncEnabled param (0/1) — when
  // off the core free-runs (a normal 4-waveform VCO); when on it phase-resets to a
  // master patched into SYNC IN, syncing ALL FOUR outputs. No power-gating here —
  // coreGate silences the core while unpowered. The ref is recorded so wire()
  // restores syncEnabled after an async worklet load / saved setup.
  const setVco1SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco1SyncEnabledRef.current = enabled;
    n.hardSyncNodes?.vco1?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);
  const setVco2SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco2SyncEnabledRef.current = enabled;
    n.hardSyncNodes?.vco2?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);
  const setVco3SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco3SyncEnabledRef.current = enabled;
    n.hardSyncNodes?.vco3?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);
  const setVco4SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco4SyncEnabledRef.current = enabled;
    n.hardSyncNodes?.vco4?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);
  const setVco5SyncEnabled = useCallback((enabled) => {
    const n = nodesRef.current; if (!n) return;
    vco5SyncEnabledRef.current = enabled;
    n.hardSyncNodes?.vco5?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);
  // Dynamic-instance variant (Phase 60d) — state in dynVcoSyncRef so wire() restores it.
  const setVcoSyncEnabledById = useCallback((vcoId, enabled) => {
    const n = nodesRef.current; if (!n) return;
    dynVcoSyncRef.current[vcoId] = enabled;
    n.hardSyncNodes?.[vcoId]?.parameters.get('syncEnabled').setValueAtTime(enabled ? 1 : 0, Tone.now());
  }, []);

  // Keyboard pitch + gate control.
  // hz: the note frequency in Hz (e.g. Tone.Frequency("C4").toFrequency()).
  // isGateDown: true = note on (triggerAttack), false = note off (triggerRelease).
  // Only envelopes connected via kbd-gate-out are triggered; seq-gate-out is unaffected.
  const updateKeyboard = useCallback((hz, isGateDown) => {
    const n = nodesRef.current;
    if (!n) return;
    // Update refs — the vibratoTick rAF owns all glideBus writes for kbd-connected VCOs.
    // kbdPitchOut drives quantizer and other non-VCO destinations (instant, no glide needed).
    kbdBaseHzRef.current = hz;
    if (isGateDown) kbdVibratoResetRef.current = true; // rAF will stamp its own `now` as onset
    n.kbdPitchOut.setValueAtTime(hz, Tone.now());
    for (const [, { env, fromId, isTrig }] of gateActionsRef.current) {
      if (fromId !== 'kbd-gate-out') continue;
      if (isTrig) { if (isGateDown) triggerEnvOneShot(env); continue; } // key-up does nothing
      if (isGateDown) env.triggerAttack();
      else            env.triggerRelease();
    }
  }, []);

  // Restart every sequencer (960 + chord) from step 0 — the next Transport tick
  // lands on the first step. Used by the Workstation's Moog-record count-in so a
  // take begins at the top of the sequence (Phase 66). Same reset powerOn does.
  const resetSequencers = useCallback(() => {
    for (const id of Object.keys(seqLoopsRef.current))      seqCurrentStepRefs.current[id]      = -1;
    for (const id of Object.keys(chordSeqLoopsRef.current)) chordSeqCurrentStepRefs.current[id] = -1;
  }, []);

  // Live power state for cross-page callers (the boolean in the return is a
  // render-time snapshot; this reads the ref that powerOn/powerOff own).
  const getIsPowered = useCallback(() => isPoweredRef.current, []);

  return {
    powerOn, powerOff, connect, disconnect, isPowered,
    updateVcoParams, updateVcfParams, updateVcf2Params, updateEnvParams, triggerGate,
    updateVcaParams, updateVca2Params, updateVca3Params,
    updateLfoParams, updateLfo2Params, updateIoParams, updateIoChannelVol,
    updateReverbParams, updateReverb2Params, getReverbAuraData, updateChorusParams, getMoogBusNode,
    getOscilloscopeData, getQntTransposeData, getMeterValue, getLfoInstant, getLfo2Instant,
    setTempo, updateSequencerSteps, setSeqStepCallback,
    updateSeq2Steps, setSeq2StepCallback, updateKeyboard,
    updateSeqStepsById, setSeqStepCallbackById, setSeqGlideById,
    updateChordSeqSteps, setChordSeqStepCallback, setChordSeqDivision,
    setChordSeqChordCallback, setChordSeqRootOctave, setChordSeqGlide,
    updateChordSeqStepsById, setChordSeqStepCallbackById, setChordSeqDivisionById,
    setChordSeqRootOctaveById, setChordSeqGlideById,
    setVco1SyncEnabled, setVco2SyncEnabled, setVco3SyncEnabled, setVco4SyncEnabled, setVco5SyncEnabled,
    setSeqGlide, setSeq2Glide, setKbdGlide, setKbdVibrato, updateNoiseParams,
    updateFFBParams, getFFBAnalyserData,
    updateVocoderParams, getVocAnalyserData,
    getVowelAnalyserData,
    getPanMeterData,
    getChronosDisplay,
    getFolderScope,
    enableMic, disableMic, updateVocMicGain,
    updateKickParams, triggerKick, triggerKickById, setKickTrigCallbackById,
    setKickTrigCallback: (fn) => { kickTrigCbRef.current.kick = fn; },
    setVcoSyncEnabledById,
    updateQuantizerParams, setQuantizerCallback, setQuantizerCallbackById, setVcoQuantizedCallback,
    addModule, removeModule, updateDynModuleParams, getLfoInstantById,
    resetSequencers, getIsPowered,
  };
}
