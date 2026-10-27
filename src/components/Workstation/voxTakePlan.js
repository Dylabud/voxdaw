// Vox take planning (Vox Phase 132) — pure, Tone-free, unit-tested.
//
// A take records notes per VOICE GROUP (the VCOs that share one CV source jack:
// 'kbd-pitch-out', 'seq2-pitch-out', 'qnt-cv-out', 'chordseq-root-out', …). The
// photograph's probe then measures which I/O input channel(s) each group reaches.
// Dylan's rule: every I/O input is ONE Workstation track — whatever is mixed into
// one input before it gets there (three chord voices through one VCF) is one
// sound. So:
//   • a track per reached channel, holding the notes of every group reaching it;
//   • each channel is photographed through ONE group (the one that played the
//     most notes) with every other VCO muted, so its instrument is one voice of
//     that sound and a chord plays as separate notes of it;
//   • channels are photographed in parallel when their groups can't hear each
//     other, in extra passes only when they can.

// Frequency → nearest piano-roll note, plus how far off it was (cents).
export function hzToMidi(hz) {
  const f = 69 + 12 * Math.log2(Math.max(1e-6, hz) / 440);
  const midi = Math.max(0, Math.min(127, Math.round(f)));
  return { midi, cents: (f - midi) * 100 };
}

const KBD = 'kbd-pitch-out';

// The I/O panel's name for a channel ('io-in' is IN 5 — its jack id is older).
export const channelLabel = (ch) => `IN ${ch}`;
// Tie-break for "most notes": the keyboard first (what you played by hand), then a
// chord's ROOT before its other voices, then jack id — stable and predictable.
const rankKey = (g) => (g === KBD ? '0' : /-root-out$/.test(g) ? '1' : '2') + g;

// counts: Map(group → note count); routes: { group: [ch…] }.
// → [{ ch, groups: [group…], selected }] sorted by channel, only reached channels.
export function assignChannels(counts, routes) {
  const byCh = new Map();
  for (const [group, chs] of Object.entries(routes)) {
    if (!(counts.get(group) > 0)) continue;
    for (const ch of chs) {
      if (!byCh.has(ch)) byCh.set(ch, []);
      byCh.get(ch).push(group);
    }
  }
  return [...byCh.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ch, groups]) => {
      const sorted = [...groups].sort((a, b) =>
        (counts.get(b) - counts.get(a)) || rankKey(a).localeCompare(rankKey(b)));
      return { ch, groups: sorted, selected: sorted[0] };
    });
}

// channels: [{ ch, selected }] that need a photograph. A pass plays some groups at
// once and records some channels; channel c is clean in a pass only if no OTHER
// playing group reaches c. Greedy first-fit keeps it to one pass for every patch
// whose parts reach separate inputs (the normal case).
// → [{ play: [group…], record: [ch…] }]
export function planPhotoPasses(channels, routes) {
  const reaches = (g, ch) => (routes[g] ?? []).includes(ch);
  const passes = [];
  for (const { ch, selected } of channels) {
    let pass = passes.find(p => p.entries.every(e =>
      e.group === selected || (!reaches(e.group, ch) && !reaches(selected, e.ch))));
    if (!pass) { pass = { entries: [] }; passes.push(pass); }
    pass.entries.push({ ch, group: selected });
  }
  return passes.map(p => ({
    play: [...new Set(p.entries.map(e => e.group))],
    record: p.entries.map(e => e.ch),
  }));
}

// The notes of one track: every group reaching the channel, de-duplicated (two
// groups playing the same note at the same tick — e.g. one VCO direct and one
// through a quantizer that left it alone — are one note), in time order.
export function trackNotes(groups, notesByGroup) {
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    for (const n of notesByGroup.get(g) ?? []) {
      const k = `${n.midi}|${n.on}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
  }
  return out.sort((a, b) => a.on - b.on || a.midi - b.midi);
}

// Where a REST-GATED sequencer note really ends (Phase 133). On a patch whose VCA
// rests open the gate doesn't end the sound — it rings until that sequencer's NEXT
// step (a following played step changes the pitch, a REST mutes the VCO), so the
// note runs to the first step tick after its start. Works for internal AND external
// clocks (the steps are the ones the sequencer actually took). No later step in the
// take (the last note) → `fallback` (one step length at the internal clock).
// stepTicks must be sorted ascending.
export function nextStepOff(on, stepTicks, fallback) {
  let lo = 0;
  let hi = stepTicks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stepTicks[mid] <= on) lo = mid + 1; else hi = mid;
  }
  return lo < stepTicks.length ? stepTicks[lo] : fallback;
}
