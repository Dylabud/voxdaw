import { useRef, useEffect, useState, useCallback } from 'react';
import styles from './AutotuneTerminal.module.css';

export default function AutotuneTerminal({ setAutotuneWet, setAutotuneGlide, detectedNoteRef, correctedNoteRef, toggleTuneMode }) {
  const [wet, setWet]       = useState(1);
  const [glide, setGlide]   = useState(0);
  const [tuneMode, setTuneMode] = useState('SCALE');

  // Drag state — identical pattern to VocoderTerminal and ArpTerminal
  const [pos, setPos]  = useState({ x: 0, y: 0 });
  const isDragging     = useRef(false);
  const dragOffset     = useRef({ x: 0, y: 0 });
  const posRef         = useRef({ x: 0, y: 0 });

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

  const handleWet = useCallback((e) => {
    const value = parseFloat(e.target.value);
    setWet(value);
    setAutotuneWet(value);
  }, [setAutotuneWet]);

  const handleGlide = useCallback((e) => {
    const value = parseFloat(e.target.value);
    setGlide(value);
    setAutotuneGlide(value);
  }, [setAutotuneGlide]);

  return (
    <div
      className={styles.terminal}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <div className={styles.terminalHeader} onMouseDown={handleMouseDown}>
        ·· autotune
      </div>

      {/* Pitch detection readout — updated imperatively by the hook's rAF loop */}
      <div className={styles.readouts}>
        <div className={styles.readoutRow}>
          <span className={styles.readoutLabel}>in</span>
          <span ref={detectedNoteRef} className={styles.readoutValue}>--</span>
        </div>
        <span className={styles.readoutArrow}>→</span>
        <div className={styles.readoutRow}>
          <span className={styles.readoutLabel}>out</span>
          <span ref={correctedNoteRef} className={styles.readoutValue}>--</span>
        </div>
      </div>

      {/* Two-fader row: wet and glide */}
      <div className={styles.faderSection}>
        <div className={styles.sliderRow}>
          <div className={styles.sliderMeta}>
            <span className={styles.sliderValue}>{Math.round(wet * 100)}%</span>
            <span className={styles.sliderLabel}>wet</span>
          </div>
          <div className={styles.faderTrack}>
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={1}
              step={0.01}
              value={wet}
              onChange={handleWet}
            />
          </div>
        </div>

        <div className={styles.sliderRow}>
          <div className={styles.sliderMeta}>
            <span className={styles.sliderValue}>
              {glide < 0.005 ? 'off' : `${Math.round(glide * 1000)}ms`}
            </span>
            <span className={styles.sliderLabel}>glide</span>
          </div>
          <div className={styles.faderTrack}>
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={0.2}
              step={0.005}
              value={glide}
              onChange={handleGlide}
            />
          </div>
        </div>
      </div>

      <button
        className={`${styles.modeBtn} ${tuneMode === 'HAND' ? styles.modeBtnActive : ''}`}
        onClick={() => {
          toggleTuneMode();
          setTuneMode(m => m === 'SCALE' ? 'HAND' : 'SCALE');
        }}
      >
        {tuneMode === 'SCALE' ? '[ mode: scale ]' : '● mode: hand'}
      </button>
    </div>
  );
}
