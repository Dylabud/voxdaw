import React, { useRef } from 'react';
import styles from './AutomationLane.module.css';
import { AUTO_LANE_H, automationValueAt, denorm } from './automationMath';

/**
 * One automation sub-lane — an SVG breakpoint-envelope editor rendered under
 * its track's lane in the timeline. x = musical time (measures * ppm, same
 * float unit as regions), y = normalized value (0–1, top = max).
 *
 * Zero-Re-render Rule: React renders from automation.points; during a drag the
 * polyline / circle attributes are mutated directly and the audio previews via
 * onLivePreview (imperative hook API) — ONE onCommitPoints(sorted) fires on
 * mouseup. Window listeners are attached per-drag (the startLeftColDrag
 * pattern), so closures capture fresh props with no stale-ref bookkeeping.
 *
 * Interactions:
 *  - click empty space        → new point at snapped x, value from click y
 *  - click ON the line        → new anchor at the line's value at that x (not
 *    the raw click y), with a 4px vertical deadzone before the value budges —
 *    a slightly-off click just plants an anchor without kinking the line
 *  - drag a point             → re-time (snapped) + re-value; existing points
 *    also get the 4px vertical deadzone (a sloppy grab doesn't nudge)
 *  - right-click / dbl-click  → delete point
 *
 * Selection: any place/move/click reports the point's committed index via
 * onSelectPoint (the shell highlights it and its central Delete/Backspace
 * handler removes it). A motionless grab of an existing point selects WITHOUT
 * committing — no state change, no no-op undo entry, and no live preview (the
 * preview only fires once the point actually changes, so the scheduled
 * automation is never left desynced by a bare click).
 *
 * Empty lane (0 points): dashed line at baselineValue01 — the target's CURRENT
 * manual value (pan dial, volume slider, fx knob) — so the first anchor starts
 * from where the sound actually is.
 */

const PAD = 6;               // px inset so points at 0/1 stay grabbable
const DEADZONE_PX = 4;       // matches startRegionDrag's drag threshold

export default function AutomationLane({
  automation,
  meta,
  baselineValue01,
  pixelsPerMeasure,
  totalMeasures,
  snapIncrement,
  snapEnabledRef,
  onCommitPoints,
  onLivePreview,
  selectedPointIndex,
  onSelectPoint,
}) {
  const svgRef    = useRef(null);
  const lineRef   = useRef(null);
  const hitRef    = useRef(null);
  const ghostRef  = useRef(null);  // circle for an in-flight NEW point (not in React DOM yet)
  const labelRef  = useRef(null);  // floating value readout during drag
  const points    = automation.points ?? [];

  const yOf = (v01) => PAD + (1 - Math.max(0, Math.min(1, v01))) * (AUTO_LANE_H - 2 * PAD);
  const vOf = (y)   => Math.max(0, Math.min(1, 1 - (y - PAD) / (AUTO_LANE_H - 2 * PAD)));

  const buildLinePoints = (pts) => {
    if (!pts.length) {
      const y = yOf(baselineValue01 ?? 0.5);
      return `0,${y} ${totalMeasures * pixelsPerMeasure},${y}`;
    }
    const sorted = [...pts].sort((a, b) => a.time - b.time);
    const coords = [`0,${yOf(sorted[0].value)}`];
    for (const p of sorted) coords.push(`${p.time * pixelsPerMeasure},${yOf(p.value)}`);
    coords.push(`${totalMeasures * pixelsPerMeasure},${yOf(sorted[sorted.length - 1].value)}`);
    return coords.join(' ');
  };

  const fmt = (v01) => {
    const v = denorm(v01, meta);
    if (meta.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v < 10 ? v.toFixed(1) : Math.round(v)}hz`;
    if (meta.unit === 's')  return v < 0.1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
    if (meta.unit === 'db') return `${v > 0 ? '+' : ''}${v.toFixed(1)}db`;
    if (meta.step >= 1)     return `${Math.round(v)}`;
    return v.toFixed(2);
  };

  // Mouse position → { time (measures, unsnapped), v01 } in lane content space.
  const eventPos = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      time: Math.max(0, Math.min(totalMeasures, x / pixelsPerMeasure)),
      v01:  vOf(y),
    };
  };
  const snapT = (t) => {
    if (!snapEnabledRef?.current) return t;
    return Math.max(0, Math.round(t / snapIncrement) * snapIncrement);
  };

  // One drag session. `working` is a mutable copy of the points; `idx` is the
  // dragged entry's index within it; `circleEl` is the DOM circle being moved.
  const startDrag = (e, working, idx, circleEl, { deadzone, isNew }) => {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    let valueUnlocked = !deadzone;
    const label = labelRef.current;
    // Dirty latch: a new point is a change by existence; an existing point only
    // once time/value actually diverge. Gates both commit and live preview.
    const initTime = working[idx].time;
    const initValue = working[idx].value;
    let dirty = !!isNew;

    const writeDom = () => {
      const p = working[idx];
      const linePts = buildLinePoints(working);
      if (lineRef.current) {
        lineRef.current.setAttribute('points', linePts);
        lineRef.current.classList.remove(styles.lineEmpty);
      }
      if (hitRef.current) hitRef.current.setAttribute('points', linePts);
      if (circleEl) {
        circleEl.setAttribute('cx', p.time * pixelsPerMeasure);
        circleEl.setAttribute('cy', yOf(p.value));
      }
      if (label) {
        label.textContent = fmt(p.value);
        label.setAttribute('x', p.time * pixelsPerMeasure + 8);
        label.setAttribute('y', Math.max(10, yOf(p.value) - 8));
        label.style.display = '';
      }
    };
    writeDom();
    if (dirty) onLivePreview?.(working[idx].value);

    const onMove = (ev) => {
      const pos = eventPos(ev);
      working[idx].time = snapT(pos.time);
      if (!valueUnlocked && Math.abs(ev.clientY - startY) >= DEADZONE_PX) valueUnlocked = true;
      if (valueUnlocked) working[idx].value = pos.v01;
      if (working[idx].time !== initTime || working[idx].value !== initValue) dirty = true;
      writeDom();
      if (dirty) onLivePreview?.(working[idx].value);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      if (label) label.style.display = 'none';
      if (ghostRef.current) ghostRef.current.style.display = 'none';
      const sorted = [...working].sort((a, b) => a.time - b.time);
      if (dirty) onCommitPoints(sorted);
      onSelectPoint?.(sorted.indexOf(working[idx]));
    };
    document.body.style.cursor = 'grabbing';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // New point (background or on-line click) rides the always-mounted ghost circle.
  const startAddDrag = (e, point, { deadzone }) => {
    const working = [...points.map(p => ({ ...p })), point];
    const ghost = ghostRef.current;
    if (ghost) ghost.style.display = '';
    startDrag(e, working, working.length - 1, ghost, { deadzone, isNew: true });
  };

  const handleBackgroundDown = (e) => {
    // Stop ALL buttons: the timeline's handleMouseDown (seek) and marquee
    // arming must never fire from inside a lane — same contract as trackLane.
    e.stopPropagation();
    if (e.button !== 0) return;
    const pos = eventPos(e);
    startAddDrag(e, { time: snapT(pos.time), value: pos.v01 }, { deadzone: false });
  };

  const handleLineDown = (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const pos = eventPos(e);
    // Anchor ON the line: inherit the envelope's value at this x, not the raw
    // click y — the deadzone then guards against accidental vertical nudges.
    const lineValue = automationValueAt(points, pos.time) ?? baselineValue01 ?? 0.5;
    startAddDrag(e, { time: snapT(pos.time), value: lineValue }, { deadzone: true });
  };

  const handlePointDown = (e, i) => {
    if (e.button !== 0) return;
    const working = points.map(p => ({ ...p }));
    startDrag(e, working, i, e.currentTarget, { deadzone: true, isNew: false });
  };

  const deletePoint = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    onCommitPoints(points.filter((_, k) => k !== i));
    onSelectPoint?.(null);
  };

  return (
    <svg ref={svgRef} className={styles.svg} onMouseDown={handleBackgroundDown}
         onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <polyline
        ref={lineRef}
        className={`${styles.line}${points.length === 0 ? ` ${styles.lineEmpty}` : ''}`}
        points={buildLinePoints(points)}
      />
      <polyline
        ref={hitRef}
        className={styles.hit}
        points={buildLinePoints(points)}
        onMouseDown={handleLineDown}
      />
      {points.map((p, i) => (
        <circle
          key={i}
          className={`${styles.point}${i === selectedPointIndex ? ` ${styles.pointSelected}` : ''}`}
          cx={p.time * pixelsPerMeasure}
          cy={yOf(p.value)}
          r={4}
          onMouseDown={(e) => handlePointDown(e, i)}
          onContextMenu={(e) => deletePoint(e, i)}
          onDoubleClick={(e) => deletePoint(e, i)}
        />
      ))}
      <circle ref={ghostRef} className={styles.point} r={4} style={{ display: 'none' }} />
      <text ref={labelRef} className={styles.valueLabel} style={{ display: 'none' }} />
    </svg>
  );
}
