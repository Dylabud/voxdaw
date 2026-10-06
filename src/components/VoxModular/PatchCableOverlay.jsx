import { useRef, useEffect, useReducer } from 'react';
import { useVoxPatch } from './VoxPatchContext';
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
  // Zero-size = detached or unrendered jack (e.g. mid content-visibility
  // promotion, Phase 61) — treat as unavailable so the caller's last-good
  // cache takes over instead of drawing a corner-collapsed cable.
  if (!jr.width && !jr.height) return null;
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

// ── Edge auto-scroll while a cable end is in the hand (Vox Phase 126) ──
// Within EDGE_PX of the rack viewport's edge the camera pans toward that edge, faster
// the closer the cursor (full speed at or past the edge — the pointer can leave the
// window and keep scrolling). The viewport is the shell's content box: 16 px sides,
// 44 px top (toolbar), 16 px bottom — the same insets fit() uses.
const EDGE_PX   = 56;
const EDGE_MAX  = 18;   // screen px per frame at full speed (~1000 px/s)
const edgeSpeed = (pos, lo, hi) => {
  if (pos < lo + EDGE_PX) return  EDGE_MAX * Math.min(1, (lo + EDGE_PX - pos) / EDGE_PX);
  if (pos > hi - EDGE_PX) return -EDGE_MAX * Math.min(1, (pos - (hi - EDGE_PX)) / EDGE_PX);
  return 0;
};
// The grab handle: the plug's rubber boot plus the first stretch of cable hanging below
// the jack (endpoint tangents are vertical by construction). It starts BELOW the jack's
// centre, so the jack's upper half still starts a NEW cable — fan-out from a jack that
// already carries one keeps working. Carries data-jack-id so the camera's isInteractive
// guard never treats a grab as a pan, and so a drop onto it lands on that jack.
const GRAB_W = 16, GRAB_TOP = 3, GRAB_H = 30;

export default function PatchCableOverlay({ cameraApiRef }) {
  const {
    cables, jackRefs, dragRef,
    completeDrag, cancelDrag, removeCable, grabCableEnd,
  } = useVoxPatch();

  const svgRef         = useRef(null);
  const activePathRef  = useRef(null);
  const justEndedRef   = useRef(false); // guard: prevent cable click on drag release
  const lastCoordsRef  = useRef(new Map()); // cable.id → last good {a, b} endpoints
  const [, forceUpdate] = useReducer(n => n + 1, 0);

  // Recompute committed cable paths on resize (layout/scale changes)
  useEffect(() => {
    window.addEventListener('resize', forceUpdate);
    return () => window.removeEventListener('resize', forceUpdate);
  }, []);

  // Window-level drag tracking — always attached, early-exits when idle
  useEffect(() => {
    const svgEl = svgRef.current;

    let lastX = 0, lastY = 0, edgeRaf = null;
    // Pan the rack while the cursor sits in an edge zone, redrawing the in-hand cable each
    // frame (the anchor jack moves with the rack; the cursor does not).
    const edgeTick = () => {
      edgeRaf = null;
      if (!dragRef.current.active) return;
      const dx = edgeSpeed(lastX, 16, window.innerWidth - 16);
      const dy = edgeSpeed(lastY, 44, window.innerHeight - 16);
      if ((dx || dy) && cameraApiRef?.current?.panBy(dx, dy)) draw(lastX, lastY);
      edgeRaf = requestAnimationFrame(edgeTick);
    };

    const draw = (clientX, clientY) => {
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
      const mx     = (clientX - sr.left) / sx;
      const my     = (clientY - sr.top)  / sy;

      activePathRef.current.setAttribute('d', cablePath(fromCoords.x, fromCoords.y, mx, my));
      activePathRef.current.setAttribute('stroke', color ?? '#d4d0b8');
    };

    const onMove = (e) => {
      if (!dragRef.current.active) return;
      lastX = e.clientX; lastY = e.clientY;
      draw(lastX, lastY);
      if (edgeRaf === null) edgeRaf = requestAnimationFrame(edgeTick);
    };

    const onUp = (e) => {
      if (edgeRaf !== null) { cancelAnimationFrame(edgeRaf); edgeRaf = null; }
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
      if (edgeRaf !== null) cancelAnimationFrame(edgeRaf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [dragRef, jackRefs, completeDrag, cancelDrag, cameraApiRef]);

  return (
    <svg ref={svgRef} className={styles.overlay}>
      <defs>
        {/* Soft blur for the cast shadow path — the shadow is a separate
            offset path (lamp upper-right → shadow falls down-left) so it
            visibly drapes across the faceplates below the cable */}
        <filter id="voxCableBlur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        {/* Nickel plug barrel — horizontal cylinder shading */}
        <linearGradient id="voxPlugMetal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0"    stopColor="#5a564e" />
          <stop offset="0.35" stopColor="#d8d4ca" />
          <stop offset="0.55" stopColor="#a8a49a" />
          <stop offset="1"    stopColor="#3e3a34" />
        </linearGradient>
        {/* Rubber boot — same cylinder shading as a dark overlay on the cable color */}
        <linearGradient id="voxBootShade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0"    stopColor="rgba(0,0,0,0.55)" />
          <stop offset="0.35" stopColor="rgba(255,255,255,0.22)" />
          <stop offset="0.55" stopColor="rgba(0,0,0,0.05)" />
          <stop offset="1"    stopColor="rgba(0,0,0,0.6)" />
        </linearGradient>
      </defs>

      {/* Committed cables — each is a group: cast shadow, base stroke,
          braid-texture dashes, cylindrical sheen, and plug hardware at
          both ends. Only the base stroke is interactive. */}
      {cables.map(cable => {
        const svgEl = svgRef.current;
        let a = getSvgCoords(cable.fromJackId, jackRefs, svgEl);
        let b = getSvgCoords(cable.toJackId,   jackRefs, svgEl);
        // Phase 61 resilience: a redraw can catch a jack while its module's
        // contents are content-visibility skipped or mid-promotion — reuse
        // the last good endpoints instead of dropping the cable; the next
        // healthy redraw refreshes them.
        const cached = lastCoordsRef.current.get(cable.id);
        if (!a && cached) a = cached.a;
        if (!b && cached) b = cached.b;
        if (!a || !b) return null;
        lastCoordsRef.current.set(cable.id, { a, b });
        const d = cablePath(a.x, a.y, b.x, b.y);
        return (
          <g key={cable.id}>
            {/* Cast shadow draping over the modules */}
            <path
              d={d}
              transform="translate(-3, 6)"
              stroke="rgba(0,0,0,0.42)"
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
              filter="url(#voxCableBlur)"
              pointerEvents="none"
            />
            {/* Cable body */}
            <path
              d={d}
              stroke={cable.color}
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
              pointerEvents="stroke"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                if (justEndedRef.current) return;
                removeCable(cable.id);
              }}
            />
            {/* Matte rubber jacket — broad, dull sheen (no braid: vintage
                Moog cables were smooth rubber, not woven) */}
            <path
              d={d}
              transform="translate(1.2, -1.4)"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={2.6}
              strokeLinecap="round"
              fill="none"
              pointerEvents="none"
            />
            {/* Plug hardware — cable tangent at both endpoints is vertical
                (control points sit directly below the jacks), so the barrel
                and boot are axis-aligned rects */}
            {[a, b].map((p, i) => (
              <g key={i} pointerEvents="none">
                {/* rubber strain-relief boot, cable color */}
                <rect x={p.x - 4} y={p.y + 1} width={8} height={13} rx={3.2} fill={cable.color} />
                <rect x={p.x - 4} y={p.y + 1} width={8} height={13} rx={3.2} fill="url(#voxBootShade)" />
                {/* nickel collar seated on the jack */}
                <rect x={p.x - 5} y={p.y - 4} width={10} height={6.5} rx={1.8} fill="url(#voxPlugMetal)" />
                <rect x={p.x - 5} y={p.y - 4} width={10} height={1.6} rx={0.8} fill="rgba(255,255,255,0.35)" />
              </g>
            ))}
            {/* Grab handles (Phase 126) — invisible, above the body path, so pressing the
                plug's boot picks up THIS end; the cable body still deletes on click. */}
            {[[a, cable.fromJackId], [b, cable.toJackId]].map(([p, jackId]) => (
              <rect
                key={jackId}
                data-jack-id={jackId}
                x={p.x - GRAB_W / 2} y={p.y + GRAB_TOP} width={GRAB_W} height={GRAB_H}
                fill="transparent"
                pointerEvents="all"
                style={{ cursor: 'grab' }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault(); e.stopPropagation();
                  grabCableEnd(cable.id, jackId);
                }}
              />
            ))}
          </g>
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
