import { useCallback, useRef } from 'react';
import styles from './MoogKnob.module.css';

const TICK_COUNT = 11;
const MIN_DEG = -135;
const MAX_DEG =  135;

const BODY_PX = { xl: 64, lg: 50, md: 38, sm: 30, xs: 22 };
const WRAP_PX = { xl: 104, lg: 86, md: 66, sm: 52, xs: 26 };

function KnobScale({ size }) {
  if (size === 'xs') return null; // ultra-compact: no tick ring (keeps the wrap tight)
  const showNums = size === 'xl' || size === 'lg';
  return (
    <div className={styles.knobScale}>
      {Array.from({ length: TICK_COUNT }, (_, i) => {
        const angle   = MIN_DEG + (i / (TICK_COUNT - 1)) * (MAX_DEG - MIN_DEG);
        const isMajor = i === 0 || i === 5 || i === 10;
        return (
          <div
            key={i}
            className={styles.tickArm}
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <div className={`${styles.tickLine} ${isMajor ? styles.tickMajor : ''}`} />
            {showNums && isMajor && (
              <span
                className={styles.tickNum}
                style={{ transform: `translateX(-50%) rotate(${-angle}deg)` }}
              >
                {i}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// glow — mint pulse on the indicator line (knob-stepper / quantized mode).
export default function MoogKnob({ value = 0.5, onChange, label, size = 'md', defaultValue = 0.5, variant = 'black', glow = false }) {
  const bodyPx = BODY_PX[size] ?? 26;
  const wrapPx = WRAP_PX[size] ?? 48;
  const rotateDeg = MIN_DEG + value * (MAX_DEG - MIN_DEG);

  // Unused but kept to avoid stale-closure lint warnings — drag captures via closure
  const valueRef = useRef(value);
  valueRef.current = value;

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    const startY     = e.clientY;
    const startValue = valueRef.current;
    // Phase 61d: knobs no longer carry a permanent `will-change: transform`
    // (layer promotion lives on `.module` for cheap panning). Promote ONLY the
    // knob being dragged so its rotation composites on its own layer instead of
    // re-rastering the whole module every frame; released on mouseup.
    const knobEl = e.currentTarget;
    knobEl.style.willChange = 'transform';

    const onMove = (ev) => {
      const dy    = startY - ev.clientY; // up = positive
      const range = ev.shiftKey ? 400 : 100; // shift = 4× slower (fine mode)
      onChange(Math.max(0, Math.min(1, startValue + dy / range)));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      knobEl.style.willChange = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
  }, [onChange]);

  const handleDoubleClick = useCallback(() => {
    onChange(defaultValue);
  }, [onChange, defaultValue]);

  // Native hover tooltip (Phase 12) — label + 0–10 dial reading (matches the
  // tick numerals). Shift = fine mode, double-click = reset, documented here
  // since there is no other in-UI affordance for either.
  const tooltip = `${label ? label + ': ' : ''}${(value * 10).toFixed(1)} / 10 · shift = fine · double-click = reset`;

  return (
    <div className={`${styles.knobGroup} ${size === 'xs' ? styles.groupXs : ''}`} title={tooltip}>
      <div className={styles.knobWrap} style={{ width: wrapPx, height: wrapPx }}>
        <KnobScale size={size} />
        <div
          className={`${styles.knob} ${styles[`knob_${size}`]} ${variant === 'cream' ? styles.knobCream : ''} ${glow ? styles.knobGlow : ''}`}
          style={{ transform: `rotate(${rotateDeg}deg)` }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          onDragStart={(e) => e.preventDefault()}
        >
          {/* Counter-rotates so the specular highlight stays fixed on the lamp regardless of knob position */}
          <div className={styles.knobShading} style={{ transform: `rotate(${-rotateDeg}deg)` }} />
          <div className={styles.knobCap} />
        </div>
      </div>
      {label && <span className={styles.knobLabel}>{label}</span>}
    </div>
  );
}
