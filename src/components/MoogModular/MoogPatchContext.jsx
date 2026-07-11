import { createContext, useContext, useRef, useState, useCallback } from 'react';

const MoogPatchContext = createContext(null);

const CABLE_COLORS = ['#e84040', '#4080e8', '#40b840', '#e8c040', '#e87830', '#d4d0b8'];

// MoogPatchProvider accepts optional audio bridge callbacks:
//   onCableAdded(fromJackId, toJackId)   — called after a cable is committed
//   onCableRemoved(fromJackId, toJackId) — called after a cable is removed
//   onCablesChanged(cables)              — called after a USER add/remove with the
//     full new cable list (Phase 60f persistence hook). Deliberately NOT fired by
//     restoreCables: persistence writes must never originate from mount-phase
//     restores (the Phase 60c StrictMode wipe lesson).
// These props are stored in refs so they never need to appear in useCallback deps.
export function MoogPatchProvider({ children, onCableAdded, onCableRemoved, onCablesChanged }) {
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

  const cancelDrag = useCallback(() => {
    dragRef.current = { active: false, fromJackId: null, color: null };
  }, []);

  const completeDrag = useCallback((toJackId) => {
    const { fromJackId, color } = dragRef.current;
    dragRef.current = { active: false, fromJackId: null, color: null };
    if (!fromJackId || fromJackId === toJackId) return;

    // Synchronous duplicate check via cableSetRef (no setState read needed)
    const keyFwd = `${fromJackId}→${toJackId}`;
    const keyRev = `${toJackId}→${fromJackId}`;
    if (cableSetRef.current.has(keyFwd) || cableSetRef.current.has(keyRev)) return;

    cableSetRef.current.add(keyFwd);
    colorIdxRef.current = (colorIdxRef.current + 1) % CABLE_COLORS.length;

    const newId = `cable-${++cableIdRef.current}`;
    const next  = [...cablesRef.current, { id: newId, fromJackId, toJackId, color }];
    cablesRef.current = next; // eager mirror — same-tick sync reads (strip loops) must see it
    setCables(next);

    // Audio bridge + persistence — called AFTER state update, outside the updater fn
    onAddedRef.current?.(fromJackId, toJackId);
    onChangedRef.current?.(next);
  }, [setCables]);

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

  return (
    <MoogPatchContext.Provider value={{
      cables,
      jackRefs,
      dragRef,
      registerJack,
      unregisterJack,
      startDrag,
      cancelDrag,
      completeDrag,
      removeCable,
      restoreCables,
    }}>
      {children}
    </MoogPatchContext.Provider>
  );
}

export function useMoogPatch() {
  const ctx = useContext(MoogPatchContext);
  if (!ctx) throw new Error('useMoogPatch must be used inside MoogPatchProvider');
  return ctx;
}
