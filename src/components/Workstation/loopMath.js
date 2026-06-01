// Shared loop-phase math for the Workstation. Single source of truth for how a
// looped region's content tiles across its visible duration, so the audio unroll
// (useWorkstationAudio.buildRegionEvents), the arrangement visuals (loop
// segments / dividers / mini-notes), and the piano-roll note ghosts all agree.
//
// "loopPhase" is the offset (in measures) into the home cycle at the region's
// LEFT edge. It is 0 for every region except the right half produced by splitting
// a looped region mid-cycle. At phase 0 these helpers reduce algebraically to the
// pre-phase behavior, so existing regions are unaffected.

// Smallest non-negative measure offset from the region's left edge at which a
// note whose home-local position is `homeLocal` first occurs.
//   occurrences are at: firstLoopOffset + j*li   (j = 0,1,2,…)
// At phase 0 this is just `homeLocal` (which lies in [0, li)).
export function firstLoopOffsetMeasures(homeLocal, phase, li) {
  return (((homeLocal - phase) % li) + li) % li;
}

// Ascending cycle-boundary offsets (in measures, relative to the region's left
// edge) that fall strictly inside (0, durationMeasures). These are where a new
// home cycle begins — used to draw loop segment edges and dividers.
//   phase 0 ⇒ [li, 2li, 3li, …]   (matches the pre-phase rendering)
//   phase f ⇒ [li-f, 2li-f, …]    (first segment is the partial remainder)
export function loopBoundaries(phase, li, durationMeasures) {
  const out = [];
  if (!(li > 0)) return out;
  // Distance from the left edge to the first cycle boundary. When phase is 0 the
  // left edge sits on a boundary, so the first interior boundary is a full li away.
  let x = ((li - phase) % li + li) % li;
  if (x === 0) x = li;
  const EPS = 1e-6;
  for (; x < durationMeasures - EPS; x += li) out.push(x);
  return out;
}
