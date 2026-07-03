import React, { useRef } from 'react';
import styles from './RotaryKnob.module.css';

/**
 * Hardware-style rotary knob for the effects rack — controlled + normalized.
 *
 * The knob is scale-agnostic: it works purely on 0..1 (`value01`); the parent
 * owns min/max/log conversion (toSlider/fromSlider in EffectsRack.jsx) and
 * value formatting (`display`). No React state — drag values flow out through
 * onChange into the existing updateEffectSettings merge path, and the parent
 * re-render drives the visuals (same continuous-commit model as the old
 * sliders; history burst coalescing folds a drag into one undo entry).
 *
 * Interaction: vertical pointer drag (capture — keeps tracking outside the
 * window), 150px = full range, Shift = fine (×0.2), double-click = reset to
 * defaultValue01. Deltas accumulate incrementally against a drag ref so
 * toggling Shift mid-drag never jumps.
 */

const SWEEP_DEG = 270;          // −135° … +135°, gap at the bottom
const START_DEG = -SWEEP_DEG / 2;
const DRAG_RANGE_PX = 150;
const FINE_SCALE = 0.2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 0° = 12 o'clock, clockwise-positive (SVG y-down).
function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export default function RotaryKnob({ value01, onChange, label, display, defaultValue01 = 0, size = 44 }) {
  const dragRef = useRef(null); // { lastY, v } while dragging, else null

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // NotFoundError on an already-inactive pointerId (possible when the OS
    // retracts the pointer between down and capture) must not kill the drag —
    // move/up handlers still work uncaptured within the element.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    dragRef.current = { lastY: e.clientY, v: clamp01(value01) };
    document.body.style.cursor = 'ns-resize';
  };

  // Single exit point for every way a drag can end. Besides pointerup/cancel,
  // pointer capture can be lost without either (alt-tab, OS gestures, a
  // context menu mid-drag) — without cleanup the armed dragRef turns later
  // hovers into value changes with no button held ("sticky knob").
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = '';
  };

  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.buttons === 0) { endDrag(); return; } // release happened elsewhere
    const scale = e.shiftKey ? FINE_SCALE : 1;
    d.v = clamp01(d.v + ((d.lastY - e.clientY) / DRAG_RANGE_PX) * scale);
    d.lastY = e.clientY;
    onChange?.(d.v);
  };

  const v = clamp01(value01);
  const half = size / 2;
  const r = half - 4;          // arc radius (leaves room for the 3px stroke)
  const dialR = r * 0.62;
  const angle = START_DEG + SWEEP_DEG * v;
  const [ix0, iy0] = polar(half, half, dialR * 0.25, angle);
  const [ix1, iy1] = polar(half, half, dialR * 0.9, angle);

  return (
    <div className={styles.knob}>
      <svg
        className={styles.dial}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onChange?.(clamp01(defaultValue01))}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={+v.toFixed(3)}
        aria-valuetext={display}
      >
        <path className={styles.track} d={arcPath(half, half, r, START_DEG, START_DEG + SWEEP_DEG)} />
        {v > 0.001 && (
          <path className={styles.fill} d={arcPath(half, half, r, START_DEG, angle)} />
        )}
        <circle className={styles.face} cx={half} cy={half} r={dialR} />
        <line className={styles.indicator} x1={ix0} y1={iy0} x2={ix1} y2={iy1} />
      </svg>
      <span className={styles.value}>{display}</span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
