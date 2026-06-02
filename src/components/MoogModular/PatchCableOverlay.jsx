import { useRef, useEffect, useReducer } from 'react';
import { useMoogPatch } from './MoogPatchContext';
import styles from './PatchCableOverlay.module.css';

// Convert a jack DOM element's center to SVG coordinate space.
// getBoundingClientRect() includes the cabinet's transform:scale() — the
// result is in screen-space (scaled). Dividing by the apparent scale
// (screenWidth / layoutWidth) converts back to SVG/layout-pixel space.
// Note: SVGElement has no offsetWidth; use the parent HTMLElement instead.
const getSvgCoords = (jackId, jackRefs, svgEl) => {
  const jackEl = jackRefs.current.get(jackId);
  if (!jackEl || !svgEl) return null;
  const jr     = jackEl.getBoundingClientRect();
  const sr     = svgEl.getBoundingClientRect();
  if (!sr.width || !sr.height) return null;
  const parent = svgEl.parentElement;                 // .cabinet — an HTMLElement
  const natW   = parent ? parent.offsetWidth  : sr.width;
  const natH   = parent ? parent.offsetHeight : sr.height;
  if (!natW || !natH) return null;
  const sx = sr.width  / natW;
  const sy = sr.height / natH;
  return {
    x: (jr.left + jr.width  / 2 - sr.left) / sx,
    y: (jr.top  + jr.height / 2 - sr.top)  / sy,
  };
};

// Cubic bezier that droops downward — simulates cable hanging under gravity.
const cablePath = (x1, y1, x2, y2) => {
  const drop = Math.max(50, Math.min(Math.abs(y2 - y1) * 0.4 + 65, 180));
  return `M ${x1} ${y1} C ${x1} ${y1 + drop}, ${x2} ${y2 + drop}, ${x2} ${y2}`;
};

// Walk up the DOM from element, returning the first data-jack-id found.
const findJackId = (el) => {
  let cur = el;
  while (cur) {
    if (cur.dataset?.jackId) return cur.dataset.jackId;
    cur = cur.parentElement;
  }
  return null;
};

export default function PatchCableOverlay() {
  const {
    cables, jackRefs, dragRef,
    completeDrag, cancelDrag, removeCable,
  } = useMoogPatch();

  const svgRef         = useRef(null);
  const activePathRef  = useRef(null);
  const justEndedRef   = useRef(false); // guard: prevent cable click on drag release
  const [, forceUpdate] = useReducer(n => n + 1, 0);

  // Recompute committed cable paths on resize (layout/scale changes)
  useEffect(() => {
    window.addEventListener('resize', forceUpdate);
    return () => window.removeEventListener('resize', forceUpdate);
  }, []);

  // Window-level drag tracking — always attached, early-exits when idle
  useEffect(() => {
    const svgEl = svgRef.current;

    const onMove = (e) => {
      const { active, fromJackId, color } = dragRef.current;
      if (!active || !svgEl || !activePathRef.current) return;

      const fromCoords = getSvgCoords(fromJackId, jackRefs, svgEl);
      if (!fromCoords) return;

      const sr     = svgEl.getBoundingClientRect();
      const parent = svgEl.parentElement;
      const natW   = parent ? parent.offsetWidth  : sr.width;
      const natH   = parent ? parent.offsetHeight : sr.height;
      const sx     = sr.width  / natW;
      const sy     = sr.height / natH;
      const mx     = (e.clientX - sr.left) / sx;
      const my     = (e.clientY - sr.top)  / sy;

      activePathRef.current.setAttribute('d', cablePath(fromCoords.x, fromCoords.y, mx, my));
      activePathRef.current.setAttribute('stroke', color ?? '#d4d0b8');
    };

    const onUp = (e) => {
      if (!dragRef.current.active) return;

      // Mark drag-just-ended so cable onClick can suppress accidental removal
      justEndedRef.current = true;
      setTimeout(() => { justEndedRef.current = false; }, 150);

      // Clear the active drag path immediately
      if (activePathRef.current) activePathRef.current.setAttribute('d', '');

      const toJackId = findJackId(document.elementFromPoint(e.clientX, e.clientY));
      if (toJackId && toJackId !== dragRef.current.fromJackId) {
        completeDrag(toJackId);
      } else {
        cancelDrag();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [dragRef, jackRefs, completeDrag, cancelDrag]);

  return (
    <svg ref={svgRef} className={styles.overlay}>
      <defs>
        <filter id="moogCableShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="rgba(0,0,0,0.75)" />
        </filter>
      </defs>

      {/* Committed cables */}
      {cables.map(cable => {
        const svgEl = svgRef.current;
        const a = getSvgCoords(cable.fromJackId, jackRefs, svgEl);
        const b = getSvgCoords(cable.toJackId,   jackRefs, svgEl);
        if (!a || !b) return null;
        return (
          <path
            key={cable.id}
            d={cablePath(a.x, a.y, b.x, b.y)}
            stroke={cable.color}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
            filter="url(#moogCableShadow)"
            pointerEvents="stroke"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              if (justEndedRef.current) return;
              removeCable(cable.id);
            }}
          />
        );
      })}

      {/* Active drag path — updated imperatively, no React re-renders during drag */}
      <path
        ref={activePathRef}
        d=""
        stroke="#d4d0b8"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray="10 5"
        fill="none"
        opacity={0.8}
        pointerEvents="none"
      />
    </svg>
  );
}
