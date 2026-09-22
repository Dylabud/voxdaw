import { useRef, useEffect } from 'react';
import styles from './Led.module.css';

// Zero-re-render analog level LED.
// getValue() → number in [0, 1] (from getMeterValue in useMoogAudio).
// opacity range: 0.12 (silence) → 1.0 (peak). will-change: opacity keeps the
// animation on the GPU compositing layer — no layout or paint cost per frame.
//
// clipAt (Phase 103, optional) turns this into a PEAK/CLIP lamp: `getValue` may
// then return values ABOVE 1, and any reading at or past `clipAt` latches the
// `.clipping` class for CLIP_HOLD_MS. The latch is the point — a clip is often a
// single sample, which at 60 fps you would otherwise never see.
const CLIP_HOLD_MS = 900;

export default function Led({ getValue, color = 'green', label, clipAt }) {
  const elRef  = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !getValue) return;
    let last = -1;
    let clipUntil = 0;
    let clipShown = false;

    function tick() {
      rafRef.current = requestAnimationFrame(tick);
      const raw = getValue() ?? 0;
      const safe = isFinite(raw) ? raw : 0;

      if (clipAt !== undefined) {
        const now = performance.now();
        if (safe >= clipAt) clipUntil = now + CLIP_HOLD_MS;
        const shouldClip = now < clipUntil;
        // Class writes are diffed for the same reason the opacity writes are:
        // an unchanged class never invalidates paint (Phase 61).
        if (shouldClip !== clipShown) {
          clipShown = shouldClip;
          el.classList.toggle(styles.clipping, shouldClip);
        }
      }

      const val = Math.max(0, Math.min(1, safe));
      // Phase 61: quantize to 1/64 steps (imperceptible) and skip identical
      // writes — an unchanged style string never invalidates paint, so a
      // steady or silent LED stops re-triggering compositor layerization.
      const q = Math.round((0.12 + val * 0.88) * 64) / 64;
      if (q === last) return;
      last = q;
      el.style.opacity = String(q);
    }

    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [getValue, clipAt]);

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
