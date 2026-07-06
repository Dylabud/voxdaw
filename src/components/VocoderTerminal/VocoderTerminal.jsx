import { useRef, useEffect, useState, useCallback } from 'react';
import styles from './VocoderTerminal.module.css';

const NUM_BARS = 40;
const FFT_BINS = 256; // fftSize 512 → 256 bins

const SLIDERS = [
  { key: 'mix',     label: 'wet',  min: 0,   max: 1,   step: 0.01, init: 0.32, fmt: v => `${Math.round(v * 100)}%` },
  { key: 'q',       label: 'q',    min: 0.5, max: 10,  step: 0.1,  init: 10.0, fmt: v => v.toFixed(1)              },
  { key: 'envHz',   label: 'env',  min: 1,   max: 50,  step: 1,    init: 50,   fmt: v => `${v}hz`                  },
  { key: 'modGain', label: 'mic',  min: 1,   max: 30,  step: 1,    init: 17,   fmt: v => `×${v}`                   },
  { key: 'outGain', label: 'out',  min: 1,   max: 20,  step: 1,    init: 13,   fmt: v => `×${v}`                   },
];

export default function VocoderTerminal({ getAnalyserData, updateVocoderParams }) {
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const dataArray  = useRef(new Uint8Array(FFT_BINS));

  // Drag state
  const [pos, setPos]   = useState({ x: 0, y: 0 });
  const isDragging      = useRef(false);
  const dragOffset      = useRef({ x: 0, y: 0 });
  const posRef          = useRef({ x: 0, y: 0 });

  const [params, setParams] = useState(() =>
    Object.fromEntries(SLIDERS.map(s => [s.key, s.init]))
  );

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    dragOffset.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y };
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current) return;
      const x = e.clientX - dragOffset.current.x;
      const y = e.clientY - dragOffset.current.y;
      posRef.current = { x, y };
      setPos({ x, y });
    };
    const onUp = () => { isDragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleSlider = useCallback((key, rawValue) => {
    const value = parseFloat(rawValue);
    setParams(prev => ({ ...prev, [key]: value }));
    updateVocoderParams({ [key]: value });
  }, [updateVocoderParams]);

  // Visualizer rAF loop — only touches canvas APIs, never React state
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const barW   = (W - NUM_BARS - 1) / NUM_BARS;
    const binStep = Math.floor(FFT_BINS / NUM_BARS);

    const draw = () => {
      // Root keeps pages mounted display:none — skip the analyser read +
      // canvas paint while the VoxTool page is hidden (purely visual loop).
      if (canvas.offsetParent === null) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      getAnalyserData(dataArray.current);

      ctx.fillStyle = '#0a0a0c';
      ctx.fillRect(0, 0, W, H);

      for (let i = 0; i < NUM_BARS; i++) {
        let peak = 0;
        const start = i * binStep;
        for (let j = 0; j < binStep; j++) {
          if (dataArray.current[start + j] > peak) peak = dataArray.current[start + j];
        }
        const barH = (peak / 255) * H;
        const x    = i * (barW + 1);
        const alpha = 0.35 + 0.65 * (peak / 255);
        ctx.fillStyle = `rgba(93, 202, 165, ${alpha.toFixed(2)})`;
        ctx.fillRect(x, H - barH, barW, barH);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getAnalyserData]);

  return (
    <div
      className={styles.terminal}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <div className={styles.terminalHeader} onMouseDown={handleMouseDown}>
        ·· vocoder
      </div>

      <canvas
        ref={canvasRef}
        className={styles.visualizer}
        width={250}
        height={60}
      />

      <div className={styles.sliders}>
        {SLIDERS.map(({ key, label, min, max, step, fmt }) => (
          <div key={key} className={styles.sliderRow}>
            <div className={styles.sliderMeta}>
              <span className={styles.sliderValue}>{fmt(params[key])}</span>
              <span className={styles.sliderLabel}>{label}</span>
            </div>
            <div className={styles.faderTrack}>
              <input
                type="range"
                className={styles.slider}
                min={min}
                max={max}
                step={step}
                value={params[key]}
                onChange={e => handleSlider(key, e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
