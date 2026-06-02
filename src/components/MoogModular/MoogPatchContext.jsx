import { createContext, useContext, useRef, useState, useCallback } from 'react';

const MoogPatchContext = createContext(null);

const CABLE_COLORS = ['#e84040', '#4080e8', '#40b840', '#e8c040', '#e87830', '#d4d0b8'];

// MoogPatchProvider accepts optional audio bridge callbacks:
//   onCableAdded(fromJackId, toJackId)   — called after a cable is committed
//   onCableRemoved(fromJackId, toJackId) — called after a cable is removed
// These props are stored in refs so they never need to appear in useCallback deps.
export function MoogPatchProvider({ children, onCableAdded, onCableRemoved }) {
  const [cables, setCables_internal] = useState([]);

  // Synchronous mirrors and trackers — avoid side effects inside setState
  const cablesRef    = useRef([]);           // mirrors cables state for sync lookup
  const cableSetRef  = useRef(new Set());    // "fromId→toId" strings for O(1) duplicate check
  const onAddedRef   = useRef(onCableAdded);
  const onRemovedRef = useRef(onCableRemoved);
  onAddedRef.current   = onCableAdded;       // keep in sync without triggering effects
  onRemovedRef.current = onCableRemoved;

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
    setCables(prev => [...prev, { id: newId, fromJackId, toJackId, color }]);

    // Audio bridge — called AFTER state update, outside the updater fn
    onAddedRef.current?.(fromJackId, toJackId);
  }, [setCables]);

  const removeCable = useCallback((id) => {
    // Synchronous lookup via cablesRef (avoids side effects inside setState)
    const cable = cablesRef.current.find(c => c.id === id);
    if (!cable) return;

    cableSetRef.current.delete(`${cable.fromJackId}→${cable.toJackId}`);
    setCables(prev => prev.filter(c => c.id !== id));

    // Audio bridge — called AFTER state update
    onRemovedRef.current?.(cable.fromJackId, cable.toJackId);
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
