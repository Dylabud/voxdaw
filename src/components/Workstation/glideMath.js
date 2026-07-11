// Pure math + data helpers for the piano-roll glide tool. No Tone.js imports —
// unit-tested like tempoMath.js. Consumers: RegionEditor (SVG overlay, drags),
// useWorkstationAudio (chain compiler + curve scheduling), audioBounce (offline
// mirror), projectIO (sanitizer), WorkstationShell (connect commands).

import { KEYS } from './pitchKeys';

const keyIndexByName = new Map(KEYS.map((k, i) => [k.name, i]));

export function keyIndexOf(name) {
  return keyIndexByName.get(name) ?? -1;
}

// KEYS is ordered high→low (index 0 = B8), so ascending pitch = descending
// index: semitonesUp('C4','D4') = +2.
export function semitonesUp(fromPitch, toPitch) {
  return keyIndexOf(fromPitch) - keyIndexOf(toPitch);
}

// Shared adjacency quantum: two notes are "adjacent" (connectable) when the
// host's end tick equals the target's start tick. This is the SAME rounding
// buildRegionEvents applies to event times, so "connected in the compiler"
// ⇔ "adjacent in the schedule" by construction. One epsilon, all consumers
// (compiler, claw hit-test, context-menu candidate check).
export function tickOf(beats, PPQ) {
  return Math.round(beats * PPQ);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Tension bound. Monotone (no overshoot) only for |tension| ≤ 1; the extended
// range is deliberate expressive territory: t > 1 overshoots PAST the target
// and settles back, t < −1 dips below the source before sweeping (max
// excursion at |t| = 2 is 12.5% of the pitch span). The SVG bezier identity
// below holds for ANY tension, so screen and audio stay in lockstep.
export const TENSION_LIMIT = 2;

// Canonical glide shape: normalized time u ∈ [0,1] → normalized pitch progress.
//   g(u) = u + tension·u·(1−u)
// tension  0 → straight line; −1 → u² (hold near source, sweep late);
// +1 → 2u−u² (sweep early, ease into target). Monotonic for |tension| ≤ 1
// (g′(u) = 1 + tension(1−2u) ≥ 0); beyond ±1 (up to ±TENSION_LIMIT) the curve
// intentionally overshoots the target / dips below the source (audible scoop).
// The SVG quadratic bezier with control point cy = y0 + (y1−y0)(0.5+tension/2)
// at mid-x traces EXACTLY this function — screen and audio always agree
// (mid-x control point ⇒ x is linear in the bezier parameter, an identity
// independent of |tension| ≤ 1).
export function glideShape(u, tension) {
  return u + tension * u * (1 - u);
}

// Clamp + prune a glide object. Returns undefined when the glide is inert
// (not connected AND endPitch === the note's own pitch — offset/tension are
// meaningless without a pitch change). Pruning is applied at EVERY write site
// so untouched notes carry no data and glide-free computePartKey stays
// byte-identical (the hard performance requirement).
export function normalizeGlide(glide, notePitch) {
  if (!glide || typeof glide !== 'object') return undefined;
  const so = Number(glide.startOffset);
  const tn = Number(glide.tension);
  const startOffset = clamp(Number.isFinite(so) ? so : 0, 0, 1);
  const tension     = clamp(Number.isFinite(tn) ? tn : 0, -TENSION_LIMIT, TENSION_LIMIT);
  const endPitch    = keyIndexByName.has(glide.endPitch) ? glide.endPitch : notePitch;
  const connected   = !!glide.connected;
  if (!connected && endPitch === notePitch) return undefined;
  return { startOffset, endPitch, tension, connected };
}

// projectIO consumer — identical semantics, named for the additive-field
// sanitizer convention (sanitizeVelocity pattern).
export const sanitizeGlide = normalizeGlide;

// ≥64 samples ⇒ never a staircase (setValueCurveAtTime linearly interpolates
// between samples); ~96 pts/s keeps sub-semitone interp error inaudible; 512
// caps allocation for very long segments.
export function curveSampleCount(durSec) {
  return Math.min(512, Math.max(64, Math.ceil(durSec * 96)));
}

// Sample the pitch curve for one glide segment as cents offsets.
// `uAt(i)` maps sample index → normalized MUSICAL time (defaults to uniform);
// under a tempo ramp the scheduler passes the tempo-map inverse so samples
// (uniform in seconds) still evaluate g at the right musical position.
export function sampleCentsCurve({ fromCents, toCents, tension, n, uAt = null }) {
  const out = new Float32Array(n);
  const span = toCents - fromCents;
  for (let i = 0; i < n; i++) {
    const u = uAt ? uAt(i) : i / (n - 1);
    out[i] = fromCents + span * glideShape(clamp(u, 0, 1), tension);
  }
  return out;
}

// Linear gain lerp for the velocity crossfade between connected notes.
export function sampleGainCurve({ fromGain, toGain, n }) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fromGain + (toGain - fromGain) * (i / (n - 1));
  return out;
}

// SVG path for a glide segment: flat hold from the note's left edge to the
// start anchor, then the quadratic bezier to the right anchor. The control
// point (mid-x, y0 + (y1−y0)(0.5+tension/2)) makes the drawn curve identical
// to glideShape (see above).
export function svgPathFor({ xFlat, x0, y0, x1, y1, tension }) {
  const cx = (x0 + x1) / 2;
  const cy = y0 + (y1 - y0) * (0.5 + tension / 2);
  const hold = xFlat != null && xFlat < x0 ? `M ${xFlat} ${y0} L ${x0} ${y0} ` : `M ${x0} ${y0} `;
  return `${hold}Q ${cx} ${cy} ${x1} ${y1}`;
}

// On-curve midpoint (u = 0.5) — where the tension handle renders.
export function tensionHandlePoint({ x0, y0, x1, y1, tension }) {
  return {
    x: (x0 + x1) / 2,
    y: y0 + (y1 - y0) * (0.5 + tension / 4), // g(0.5) = 0.5 + tension/4
  };
}

// Resolve a connected glide's target among the notes sharing the host's end
// tick: exactly ONE candidate at that tick with pitch === endPitch, not
// already consumed by another host. Shared by the compiler, the UI claw, and
// the context-menu enable checks (via resolveGlideTarget below).
export function resolveGlideTarget(host, byStartTick, PPQ, consumed = null) {
  const g = host.glide;
  if (!g || !g.connected) return null;
  const endTick = tickOf(host.startBeat + host.durationBeats, PPQ);
  const cands = (byStartTick.get(endTick) ?? []).filter(t => t.note === g.endPitch && t.id !== host.id);
  if (cands.length !== 1) return null;
  if (consumed && consumed.has(cands[0].id)) return null;
  return cands[0];
}

export function indexNotesByStartTick(notes, PPQ) {
  const byStartTick = new Map();
  for (const n of notes) {
    const t = tickOf(n.startBeat, PPQ);
    const arr = byStartTick.get(t);
    if (arr) arr.push(n); else byStartTick.set(t, [n]);
  }
  return byStartTick;
}

// Chord→chord connection planning for the glide context menu's Connect /
// Glide-to commands. Hosts group by (regionId, end tick); each group's
// candidates are ALL notes starting at that tick (selected or not). Both sides
// sort pitch-descending (KEYS high→low ⇒ ascending keyIndex) and pair
// top→top / mid→mid by index; unmapped extras stay untouched (3 hosts → 2
// targets leaves the bass unglided; 2 → 3 leaves the lowest target
// un-glided-into). Selecting a whole progression works because every chord is
// its own end-tick group: A's notes pair into B, B's into C, C finds no
// candidates. Pure — returns Map(hostId → endPitch); the caller wraps with
// normalizeGlide + the connected flag.
export function planChordConnections(hostIds, allNotes, PPQ) {
  const byId = new Map(allNotes.map(n => [n.id, n]));
  const hosts = hostIds.map(i => byId.get(i)).filter(Boolean);
  const groups = new Map(); // "regionId|endTick" → host chord
  for (const h of hosts) {
    const key = `${h.regionId}|${tickOf(h.startBeat + h.durationBeats, PPQ)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const out = new Map(); // hostId → endPitch
  for (const [key, chord] of groups) {
    const sep = key.lastIndexOf('|');
    const regionId = key.slice(0, sep);
    const endTick  = Number(key.slice(sep + 1));
    const cands = allNotes
      .filter(x => x.regionId === regionId && tickOf(x.startBeat, PPQ) === endTick)
      .sort((a, b) => keyIndexOf(a.note) - keyIndexOf(b.note));
    chord.sort((a, b) => keyIndexOf(a.note) - keyIndexOf(b.note));
    const count = Math.min(chord.length, cands.length);
    for (let i = 0; i < count; i++) out.set(chord[i].id, cands[i].note);
  }
  return out;
}

// Auto-pitch tracking for connected glides across note edits. Given the note
// array BEFORE an edit commit (prevNotes) and AFTER it (nextNotes), returns
// Map(hostId → normalized glide) pinning each surviving connection's endPitch
// to its target's post-edit pitch. Rules:
//   - Connections are RESOLVED on the prev state (resolveGlideTarget, no
//     consumed set — same semantics as the UI claw). Ambiguous → skip.
//   - skipHostIds = hosts whose glide was EXPLICITLY edited this commit
//     (glide-right re-aim, disconnect, claw delete) — never overwrite intent.
//   - The pin only lands while the pair stays adjacent in the next state
//     (host end tick === target start tick, same region). Adjacency broken
//     (horizontal solo move / resize) → glide untouched, existing accepted
//     degrade-to-unconnected; it reconnects live if moved back.
//   - Pins spread the NEXT-state glide (transposeNote may already have
//     shifted endPitch/kept offset+tension) and overwrite only endPitch.
//     Entries are emitted only when endPitch actually changes.
// This one prev→next pass also self-corrects transposeNote's unconditional
// endPitch shift when the HOST moved but its target stayed, and handles whole
// chains (each edge resolves on prev, pins on next — no iteration needed).
// Pure — safe inside a setState updater under StrictMode double-invoke.
export function retargetConnectedGlides({ prevNotes, nextNotes, PPQ, skipHostIds = null }) {
  const out = new Map();
  // Fast bail — glide-free (or connection-free) projects pay one scan.
  if (!prevNotes.some(n => n.glide?.connected)) return out;
  const nextById = new Map(nextNotes.map(n => [n.id, n]));
  const idxByRegion = new Map(); // prev-state per-region start-tick index, lazy
  for (const host of prevNotes) {
    if (!host.glide?.connected) continue;
    if (skipHostIds?.has(host.id)) continue;
    if (!idxByRegion.has(host.regionId)) {
      idxByRegion.set(host.regionId,
        indexNotesByStartTick(prevNotes.filter(n => n.regionId === host.regionId), PPQ));
    }
    const target = resolveGlideTarget(host, idxByRegion.get(host.regionId), PPQ);
    if (!target) continue;
    const hostNext   = nextById.get(host.id);
    const targetNext = nextById.get(target.id);
    if (!hostNext?.glide?.connected || !targetNext) continue;
    if (hostNext.regionId !== targetNext.regionId) continue;
    if (tickOf(hostNext.startBeat + hostNext.durationBeats, PPQ)
        !== tickOf(targetNext.startBeat, PPQ)) continue;
    if (hostNext.glide.endPitch === targetNext.note) continue;
    out.set(host.id, normalizeGlide(
      { ...hostNext.glide, endPitch: targetNext.note }, hostNext.note));
  }
  return out;
}

// Compile a region window's notes into schedulable units. Notes without glide
// involvement come back as plain units (no `segments`); connected runs merge
// into ONE chain unit — the head attacks once, consumed members never emit
// their own events (true legato). Each chain member contributes one segment;
// by the edge criterion (target pitch === endPitch) every member's ARRIVAL
// pitch is simply its own `note`, so no running-pitch bookkeeping is needed.
// Pure — beats/ticks only, no Tone.
export function compileGlideChains(notes, PPQ) {
  const byStartTick = indexNotesByStartTick(notes, PPQ);

  // Edges host → target. A target can be consumed by only ONE host (two hosts
  // ending on the same tick+pitch race deterministically in array order; the
  // loser degrades to an unconnected glide).
  const nextOf = new Map();
  const consumed = new Set();
  for (const n of notes) {
    const target = resolveGlideTarget(n, byStartTick, PPQ, consumed);
    if (!target) continue;
    nextOf.set(n.id, target);
    consumed.add(target.id);
  }

  const units = [];
  for (const n of notes) {
    if (consumed.has(n.id)) continue; // plays inside its host's chain
    if (!n.glide && !nextOf.has(n.id)) {
      units.push({ startBeat: n.startBeat, note: n.note, velocity: n.velocity ?? 100,
                   totalBeats: n.durationBeats, segments: null });
      continue;
    }
    // Chain walk (head → tail). Time strictly increases per hop, so no cycle
    // guard is needed beyond durationBeats > 0 (guaranteed by the note model).
    const segments = [];
    let totalBeats = 0;
    let cur = n;
    while (cur) {
      const next = nextOf.get(cur.id) ?? null;
      const g = cur.glide;
      segments.push({
        durTicks:    Math.round(cur.durationBeats * PPQ),
        fromPitch:   cur.note,
        toPitch:     g ? g.endPitch : cur.note, // glide-less tail holds flat
        startOffset: g?.startOffset ?? 0,
        tension:     g?.tension ?? 0,
        fromVel:     cur.velocity ?? 100,
        // Crossfade only toward a connected next member; tails hold level.
        toVel:       next ? (next.velocity ?? 100) : (cur.velocity ?? 100),
      });
      totalBeats += cur.durationBeats;
      cur = next;
    }
    units.push({ startBeat: n.startBeat, note: n.note, velocity: n.velocity ?? 100,
                 totalBeats, segments });
  }
  return units;
}

// Clip a chain's segments to a truncated total (region-end clipping): keep
// whole segments that fit, truncate the straddling one. The truncated segment
// keeps its ORIGINAL span as `fullDurTicks` so the scheduler cuts the glide
// mid-flight at its original pace (u ends at durTicks/fullDurTicks) — the
// analogue of a plain note stopping early, not a compressed faster glide.
export function clipSegments(segments, clippedTicks) {
  const out = [];
  let acc = 0;
  for (const s of segments) {
    if (acc >= clippedTicks) break;
    const remain = clippedTicks - acc;
    out.push(s.durTicks <= remain ? s : { ...s, durTicks: remain, fullDurTicks: s.durTicks });
    acc += s.durTicks;
  }
  return out;
}

// A one-segment chain that lost its glide portion to clipping (or was inert)
// can be scheduled as a plain note — cheaper and behavior-identical.
export function segmentsAreInert(segments) {
  return segments.length === 1
    && segments[0].toPitch === segments[0].fromPitch
    && segments[0].toVel === segments[0].fromVel;
}

// Turn a chain event's segments into schedulable ops. All times are SECONDS
// OFFSETS FROM CHAIN START — live and offline schedulers just add their own
// absolute start. Cents are relative to the chain-head pitch (the voice
// attacks the head note once; detune/playbackRate carry every later pitch).
// `map` is a tempoMath.buildTempoMap — segment boundaries and curve sample
// positions are exact under tempo ramps (samples are uniform in seconds, so
// with anchors present each sample's musical position goes through
// measureAtSeconds; the constant-bpm fast path skips the inverse). A segment
// truncated by region clipping (fullDurTicks > durTicks) is cut MID-FLIGHT:
// u ends at played/full, never reaching toPitch — a plain note stopping early.
export function planGlideSegments({ headPitch, segments, startTicks, map, PPQ }) {
  const q  = PPQ * 4; // ticks per measure (4/4)
  const t0 = map.secondsAtMeasure(startTicks / q);
  const hasRamp = (map.anchors?.length ?? 0) > 0;
  const ops = [];
  let accTicks = 0;
  for (const seg of segments) {
    const mStart      = (startTicks + accTicks) / q;
    const mEndPlayed  = (startTicks + accTicks + seg.durTicks) / q;
    const mEndFull    = (startTicks + accTicks + (seg.fullDurTicks ?? seg.durTicks)) / q;
    const baseCents   = 100 * semitonesUp(headPitch, seg.fromPitch);
    const targetCents = 100 * semitonesUp(headPitch, seg.toPitch);
    const holdStartSec = map.secondsAtMeasure(mStart) - t0;
    const segEndSec    = map.secondsAtMeasure(mEndPlayed) - t0;
    const op = {
      baseCents, targetCents, holdStartSec, segEndSec,
      glideStartSec: holdStartSec, glideDurSec: 0, curve: null,
      fromVel: seg.fromVel, toVel: seg.toVel,
    };
    if (targetCents !== baseCents) {
      const glideStartM = mStart + seg.startOffset * (mEndFull - mStart);
      if (glideStartM < mEndPlayed) {
        const gsSecZ  = map.secondsAtMeasure(glideStartM);
        const durSec  = map.secondsAtMeasure(mEndPlayed) - gsSecZ;
        if (durSec > 1e-4) {
          const n = curveSampleCount(durSec);
          const fullSpanM = mEndFull - glideStartM;
          const uAt = hasRamp
            ? (i) => (map.measureAtSeconds(gsSecZ + (i / (n - 1)) * durSec) - glideStartM) / fullSpanM
            : (() => {
                const uEnd = (mEndPlayed - glideStartM) / fullSpanM; // < 1 only when clipped
                return (i) => uEnd * (i / (n - 1));
              })();
          op.glideStartSec = gsSecZ - t0;
          op.glideDurSec   = durSec;
          op.curve = sampleCentsCurve({ fromCents: baseCents, toCents: targetCents, tension: seg.tension, n, uAt });
        }
      }
    }
    ops.push(op);
    accTicks += seg.durTicks;
  }
  return { ops, totalDurSec: map.secondsAtMeasure((startTicks + accTicks) / q) - t0 };
}
