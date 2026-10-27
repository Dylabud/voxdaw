// Vox take status, shared across pages (Vox Phase 134).
//
// A take keeps recording when you leave the Workstation for the Vox Modular
// (every page stays mounted), so the other pages need to see it and stop it.
// A tiny external store instead of Root state: a Root re-render re-renders every
// mounted page, and the photograph's progress ticks once per note.
//   status: null | { phase: 'countin' | 'recording' | 'saving' | 'photo',
//                    mode: 'notes' | 'audio', startedAt?, done?, total? }
// The Workstation is the only writer; VoxRecIndicator reads it.

let status = null;
let control = null; // the Workstation's record button handler (start / stop / cancel)
const listeners = new Set();

export const getVoxRecStatus = () => status;
export function setVoxRecStatus(next) {
  status = next;
  for (const cb of listeners) cb();
}
export function subscribeVoxRecStatus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export const setVoxRecControl = (fn) => { control = fn; };
export const pressVoxRecord = () => control?.();
