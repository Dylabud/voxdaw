import { createContext, useContext, useRef, useState, useCallback } from 'react';

const VoxPatchContext = createContext(null);

const CABLE_COLORS = ['#e84040', '#4080e8', '#40b840', '#e8c040', '#e87830', '#d4d0b8'];

// VoxPatchProvider accepts optional audio bridge callbacks:
//   onCableAdded(fromJackId, toJackId)   — called after a cable is committed
//   onCableRemoved(fromJackId, toJackId) — called after a cable is removed
//   onCablesChanged(cables)              — called after a USER add/remove with the
//     full new cable list (Phase 60f persistence hook). Deliberately NOT fired by
//     restoreCables: persistence writes must never originate from mount-phase
//     restores (the Phase 60c StrictMode wipe lesson).
// These props are stored in refs so they never need to appear in useCallback deps.
export function VoxPatchProvider({ children, onCableAdded, onCableRemoved, onCablesChanged }) {
  const [cables, setCables_internal] = useState([]);

  // Synchronous mirrors and trackers — avoid side effects inside setState
  const cablesRef    = useRef([]);           // mirrors cables state for sync lookup
  const cableSetRef  = useRef(new Set());    // "fromId→toId" strings for O(1) duplicate check
  const onAddedRef   = useRef(onCableAdded);
  const onRemovedRef = useRef(onCableRemoved);
  const onChangedRef = useRef(onCablesChanged);
  onAddedRef.current   = onCableAdded;       // keep in sync without triggering effects
  onRemovedRef.current = onCableRemoved;
  onChangedRef.current = onCablesChanged;

  const jackRefs    = useRef(new Map());
  const dragRef     = useRef({ active: false, fromJackId: null, color: null });
  const colorIdxRef = useRef(0);
  const cableIdRef  = useRef(0);

  // Wrapper that keeps cablesRef in sync with state
  const setCables = useCallback((updater) => {
    setCables_internal(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      cablesRef.current = next;
      return next;
    });
  }, []);

  const registerJack = useCallback((id, el) => {
    jackRefs.current.set(id, el);
  }, []);

  const unregisterJack = useCallback((id) => {
    jackRefs.current.delete(id);
  }, []);

  const startDrag = useCallback((fromJackId) => {
    const color = CABLE_COLORS[colorIdxRef.current % CABLE_COLORS.length];
    dragRef.current = { active: true, fromJackId, color };
  }, []);

  // ── Repatch: pick up one END of a seated cable (Vox Phase 126) ──
  // Grabbing a plug pulls it: the cable leaves the list and its audio disconnects at
  // once (real hardware — the sound changes the moment the plug is out), but NOTHING is
  // persisted yet. The drag then runs from the end still seated (`fromJackId` = the
  // anchor) with the cable's own colour. Dropped on a jack → one new cable anchor→jack
  // and ONE persistence write, so a move is a single undo step. Dropped anywhere else
  // (or back where it came from, or onto a duplicate) → the original cable goes back
  // exactly as it was, silently — a slip of the mouse can never lose a cable.
  const putBack = useCallback((cable) => {
    if (!cable) return;
    cableSetRef.current.add(`${cable.fromJackId}→${cable.toJackId}`);
    const next = [...cablesRef.current, cable];
    cablesRef.current = next;
    setCables(next);
    onAddedRef.current?.(cable.fromJackId, cable.toJackId);   // audio back; no persistence write
  }, [setCables]);

  const grabCableEnd = useCallback((id, endJackId) => {
    if (dragRef.current.active) return;
    const cable = cablesRef.current.find(c => c.id === id);
    if (!cable) return;
    const anchor = cable.fromJackId === endJackId ? cable.toJackId : cable.fromJackId;
    cableSetRef.current.delete(`${cable.fromJackId}→${cable.toJackId}`);
    const next = cablesRef.current.filter(c => c.id !== id);
    cablesRef.current = next;
    setCables(next);
    onRemovedRef.current?.(cable.fromJackId, cable.toJackId);  // audio out; no persistence write
    dragRef.current = { active: true, fromJackId: anchor, color: cable.color, repatch: cable, movedEnd: endJackId };
  }, [setCables]);

  const cancelDrag = useCallback(() => {
    const { repatch } = dragRef.current;
    dragRef.current = { active: false, fromJackId: null, color: null };
    putBack(repatch);
  }, [putBack]);

  const completeDrag = useCallback((toJackId) => {
    const { fromJackId, color, repatch, movedEnd } = dragRef.current;
    dragRef.current = { active: false, fromJackId: null, color: null };
    if (!fromJackId || fromJackId === toJackId || (repatch && toJackId === movedEnd)) { putBack(repatch); return; }

    // Synchronous duplicate check via cableSetRef (no setState read needed)
    const keyFwd = `${fromJackId}→${toJackId}`;
    const keyRev = `${toJackId}→${fromJackId}`;
    if (cableSetRef.current.has(keyFwd) || cableSetRef.current.has(keyRev)) { putBack(repatch); return; }

    cableSetRef.current.add(keyFwd);
    // A moved cable keeps its colour, so the palette rotation is for NEW cables only.
    if (!repatch) colorIdxRef.current = (colorIdxRef.current + 1) % CABLE_COLORS.length;

    const newId = `cable-${++cableIdRef.current}`;
    const next  = [...cablesRef.current, { id: newId, fromJackId, toJackId, color }];
    cablesRef.current = next; // eager mirror — same-tick sync reads (strip loops) must see it
    setCables(next);

    // Audio bridge + persistence — called AFTER state update, outside the updater fn
    onAddedRef.current?.(fromJackId, toJackId);
    onChangedRef.current?.(next);
  }, [setCables, putBack]);

  const removeCable = useCallback((id) => {
    // Synchronous lookup via cablesRef (avoids side effects inside setState)
    const cable = cablesRef.current.find(c => c.id === id);
    if (!cable) return;

    cableSetRef.current.delete(`${cable.fromJackId}→${cable.toJackId}`);
    const next = cablesRef.current.filter(c => c.id !== id);
    cablesRef.current = next; // eager mirror — same-tick sync reads (strip loops) must see it
    setCables(next);

    // Audio bridge + persistence — called AFTER state update
    onRemovedRef.current?.(cable.fromJackId, cable.toJackId);
    onChangedRef.current?.(next);
  }, [setCables]);

  // Restore persisted cables in one pass (Phase 60f). Validates both endpoints
  // against the live jack registry (repair: cables whose module no longer
  // exists are dropped), dedupes, fires the audio bridge per cable, and does
  // NOT fire onCablesChanged (restores never write persistence). Returns the
  // number of cables restored.
  const restoreCables = useCallback((stored = []) => {
    const valid = [];
    for (const c of stored) {
      const fromJackId = c.fromJackId ?? c.from;
      const toJackId   = c.toJackId   ?? c.to;
      if (!fromJackId || !toJackId) continue;
      if (!jackRefs.current.has(fromJackId) || !jackRefs.current.has(toJackId)) continue;
      const keyFwd = `${fromJackId}→${toJackId}`;
      if (cableSetRef.current.has(keyFwd) || cableSetRef.current.has(`${toJackId}→${fromJackId}`)) continue;
      cableSetRef.current.add(keyFwd);
      valid.push({
        id: `cable-${++cableIdRef.current}`,
        fromJackId, toJackId,
        color: c.color ?? CABLE_COLORS[colorIdxRef.current++ % CABLE_COLORS.length],
      });
    }
    if (!valid.length) return 0;
    const next = [...cablesRef.current, ...valid];
    cablesRef.current = next;
    setCables(next);
    valid.forEach(c => onAddedRef.current?.(c.fromJackId, c.toJackId));
    return valid.length;
  }, [setCables]);

  // Undo/redo (Phase 107): remove every cable NOT in `stored` (a persisted cable
  // list), firing the audio bridge per cable but — like restoreCables — never
  // onCablesChanged: the undo engine writes the store itself. restoreCables then
  // adds the missing ones once the target modules' jacks exist.
  const removeCablesNotIn = useCallback((stored = []) => {
    const keep = new Set();
    for (const c of stored) {
      const a = c.fromJackId ?? c.from, b = c.toJackId ?? c.to;
      if (a && b) { keep.add(`${a}→${b}`); keep.add(`${b}→${a}`); }
    }
    const gone = cablesRef.current.filter(c => !keep.has(`${c.fromJackId}→${c.toJackId}`));
    if (!gone.length) return;
    for (const c of gone) cableSetRef.current.delete(`${c.fromJackId}→${c.toJackId}`);
    const next = cablesRef.current.filter(c => keep.has(`${c.fromJackId}→${c.toJackId}`));
    cablesRef.current = next;
    setCables(next);
    gone.forEach(c => onRemovedRef.current?.(c.fromJackId, c.toJackId));
  }, [setCables]);

  return (
    <VoxPatchContext.Provider value={{
      cables,
      jackRefs,
      dragRef,
      registerJack,
      unregisterJack,
      startDrag,
      grabCableEnd,
      cancelDrag,
      completeDrag,
      removeCable,
      restoreCables,
      removeCablesNotIn,
    }}>
      {children}
    </VoxPatchContext.Provider>
  );
}

export function useVoxPatch() {
  const ctx = useContext(VoxPatchContext);
  if (!ctx) throw new Error('useVoxPatch must be used inside VoxPatchProvider');
  return ctx;
}
