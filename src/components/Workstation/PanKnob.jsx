import { useRef } from 'react';
import styles from './PanKnob.module.css';

/**
 * Rotary pan knob.
 *
 *   value: -1..+1   (−1 = hard left, 0 = center, +1 = hard right)
 *   onChange(v)
 *   size:  px, default 28
 *
 * Drag horizontal — 100 px = full range. Hold Shift for 4× fine-tune.
 * Double-click to recenter.
 *
 * Visual: SVG dial. Rotation maps value → −135°..+135° (270° arc, mimics
 * a physical mixing-desk knob with end stops at the bottom-left / bottom-right).
 */
export default function PanKnob({ value, onChange, size = 28, disabled = false }) {
  const dragRef = useRef(null);

  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const rotation = clamp(value ?? 0) * 135; // degrees

  const handleMouseDown = (e) => {
    if (e.button !== 0 || disabled) return;
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startValue: clamp(value ?? 0),
    };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const sensitivity = ev.shiftKey ? 400 : 100; // 100 px → full range
      const next = clamp(d.startValue + (ev.clientX - d.startX) / sensitivity);
      onChange(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (disabled) return;
    onChange(0);
  };

  // SVG geometry
  const r        = size / 2;
  const knobR    = r - 2;        // outer body radius (leave 2px for stroke)
  const trackR   = knobR - 1;    // arc radius
  // Indicator line: from center to a point near the rim. Rotation handled via SVG transform.
  const indLen   = knobR * 0.7;

  // 270° arc path from −135° to +135° (the knob's travel range)
  const arcStart = polar(r, r, trackR, -135);
  const arcEnd   = polar(r, r, trackR,  135);
  const arcPath  = `M ${arcStart.x} ${arcStart.y} A ${trackR} ${trackR} 0 1 1 ${arcEnd.x} ${arcEnd.y}`;

  return (
    <div
      className={styles.knob}
      style={{ width: size, height: size, ...(disabled ? { opacity: 0.35 } : {}) }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onClick={(e) => e.stopPropagation()}
      title={disabled
        ? 'pan is automated — delete the automation lane to regain manual control'
        : `pan ${(value ?? 0).toFixed(2)} (drag horizontal; double-click to center; hold Shift for fine)`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Travel arc */}
        <path d={arcPath} className={styles.arc} fill="none" />
        {/* Knob body */}
        <circle cx={r} cy={r} r={knobR} className={styles.body} />
        {/* Indicator (rotated) */}
        <g transform={`rotate(${rotation} ${r} ${r})`}>
          <line
            x1={r} y1={r}
            x2={r} y2={r - indLen}
            className={styles.indicator}
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}

function polar(cx, cy, radius, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}
