import { useRef, useEffect } from 'react';
import styles from './Oscilloscope.module.css';

// Zero-re-render oscilloscope — all drawing is imperative via canvas API inside a rAF loop.
// getData() → Float32Array of 512 waveform samples in [-1, 1] (Tone.Analyser "waveform").
// When no data is available (pre-powerOn), draws a flat centre line.
export default function Oscilloscope({ getData }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function draw() {
      rafRef.current = requestAnimationFrame(draw);

      // Sync buffer width to CSS display width each frame so the waveform always
      // fills the full visualizer regardless of module/cabinet layout changes.
      // canvas.width assignment clears the buffer but we redraw every frame anyway.
      const cssW = canvas.offsetWidth;
      if (cssW && canvas.width !== cssW) canvas.width = cssW;

      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      const data = getData?.();

      // ── trace ──────────────────────────────────────────────────────────────
      ctx.beginPath();
      ctx.lineWidth   = 1.5;
      ctx.strokeStyle = '#5DCAA5';
      ctx.shadowBlur  = 6;
      ctx.shadowColor = '#5DCAA5';

      if (data && data.length > 0) {
        const step = W / (data.length - 1);
        for (let i = 0; i < data.length; i++) {
          const x = i * step;
          const y = ((1 - data[i]) / 2) * H;   // maps +1→top, -1→bottom, 0→centre
          if (i === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
      } else {
        // Flat centre line when audio engine not yet started
        ctx.moveTo(0,  H / 2);
        ctx.lineTo(W,  H / 2);
      }

      ctx.stroke();

      // Reset shadow so it doesn't bleed into subsequent draws
      ctx.shadowBlur  = 0;
      ctx.shadowColor = 'transparent';
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [getData]);

  return (
    <div className={styles.screen}>
      <canvas ref={canvasRef} width={200} height={64} className={styles.canvas} />
    </div>
  );
}
