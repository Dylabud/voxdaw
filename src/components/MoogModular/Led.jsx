import { useRef, useEffect } from 'react';
import styles from './Led.module.css';

// Zero-re-render analog level LED.
// getValue() → number in [0, 1] (from getMeterValue in useMoogAudio).
// opacity range: 0.12 (silence) → 1.0 (peak). will-change: opacity keeps the
// animation on the GPU compositing layer — no layout or paint cost per frame.
export default function Led({ getValue, color = 'green', label }) {
  const elRef  = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !getValue) return;

    function tick() {
      rafRef.current = requestAnimationFrame(tick);
      const raw = getValue() ?? 0;
      const val = isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      el.style.opacity = String(0.12 + val * 0.88);
    }

    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [getValue]);

  return (
    <div className={styles.ledWrap}>
      {/* Bezel is a separate element so the chrome ring stays at full
          opacity while the rAF fades only the lamp glass inside it */}
      <div className={styles.ledBezel}>
        <div
          ref={elRef}
          className={`${styles.led} ${styles[color]}`}
          style={{ opacity: 0.12 }}
        />
      </div>
      {label && <span className={styles.ledLabel}>{label}</span>}
    </div>
  );
}
