import { useCallback, useRef } from 'react';
import styles from './MoogKnob.module.css';

const TICK_COUNT = 11;
const MIN_DEG = -135;
const MAX_DEG =  135;

const BODY_PX = { xl: 54, lg: 42, md: 32, sm: 25 };
const WRAP_PX = { xl: 94, lg: 76, md: 58, sm: 46 };

function KnobScale({ size }) {
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

export default function MoogKnob({ value = 0.5, onChange, label, size = 'md', defaultValue = 0.5 }) {
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

    const onMove = (ev) => {
      const dy    = startY - ev.clientY; // up = positive
      const range = ev.shiftKey ? 400 : 100; // shift = 4× slower (fine mode)
      onChange(Math.max(0, Math.min(1, startValue + dy / range)));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
  }, [onChange]);

  const handleDoubleClick = useCallback(() => {
    onChange(defaultValue);
  }, [onChange, defaultValue]);

  return (
    <div className={styles.knobGroup}>
      <div className={styles.knobWrap} style={{ width: wrapPx, height: wrapPx }}>
        <KnobScale size={size} />
        <div
          className={`${styles.knob} ${styles[`knob_${size}`]}`}
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
