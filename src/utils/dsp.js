export function calculateDistance2D(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calculateDistance(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dz = p2.z - p1.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Maps value from [inMin, inMax] → [outMin, outMax], clamped to output range
export function mapRange(value, inMin, inMax, outMin, outMax) {
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

// Returns true when a finger tip is above its MCP knuckle in Y (finger is extended).
// tipIndex/mcpIndex pairs: middle=12/9, ring=16/13, pinky=20/17
export function isFingerExtended(hand, tipIndex, mcpIndex) {
  return hand[tipIndex].y < hand[mcpIndex].y;
}

// Converts Tone.js note names to sharp notation (Tone may return flats).
const FLAT_TO_SHARP = { Bb: 'A#', Eb: 'D#', Ab: 'G#', Db: 'C#', Gb: 'F#' };
export function normalizeNote(note) {
  const pitch = note.slice(0, -1);
  const oct   = note.slice(-1);
  return (FLAT_TO_SHARP[pitch] ?? pitch) + oct;
}

// Binary search: returns the nearest value in a sorted Float32Array. O(log n).
export function snapToNearest(hz, sortedFreqs) {
  if (sortedFreqs.length === 0) return hz;
  let lo = 0, hi = sortedFreqs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedFreqs[mid] < hz) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && hz - sortedFreqs[lo - 1] < sortedFreqs[lo] - hz) return sortedFreqs[lo - 1];
  return sortedFreqs[lo];
}
