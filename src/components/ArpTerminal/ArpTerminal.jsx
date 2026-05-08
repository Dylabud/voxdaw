import { useRef, useEffect, useState, useCallback } from 'react';
import styles from './ArpTerminal.module.css';

const DELAY_STOPS       = ['0', '4n', '8n', '16n', '32n'];
const DELAY_STOP_LABELS = ['0', '1/4', '1/8', '1/16', '1/32'];

const ARP_INSTRUMENTS = [
  { value: 'analog', label: 'analog' },
  { value: 'fm',     label: 'fm synth' },
  { value: 'am',     label: 'am synth' },
  { value: 'pluck',  label: 'pluck' },
];

const FADERS = [
  {
    key: 'delayIdx',
    label: 'dly',
    min: 0, max: 4, step: 1, init: 2,
    fmt: v => DELAY_STOP_LABELS[Math.round(v)],
  },
  {
    key: 'mix',
    label: 'wet',
    min: 0, max: 1, step: 0.01, init: 0,
    fmt: v => `${Math.round(v * 100)}%`,
  },
  {
    key: 'decay',
    label: 'dcay',
    min: 0.1, max: 2.0, step: 0.01, init: 0.12,
    fmt: v => `${parseFloat(v).toFixed(2)}s`,
  },
];

export default function ArpTerminal({ updateArpDelayTime, updateArpDelayMix, speedSnap, onSpeedSnapToggle, arpInstrument, onArpInstrumentChange, onArpDecayChange }) {
  const [pos, setPos]   = useState({ x: 0, y: 0 });
  const isDragging      = useRef(false);
  const dragOffset      = useRef({ x: 0, y: 0 });
  const posRef          = useRef({ x: 0, y: 0 });

  const [params, setParams] = useState(() =>
    Object.fromEntries(FADERS.map(f => [f.key, f.init]))
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

  const handleFader = useCallback((key, rawValue) => {
    const value = parseFloat(rawValue);
    setParams(prev => ({ ...prev, [key]: value }));
    if (key === 'delayIdx') updateArpDelayTime?.(DELAY_STOPS[Math.round(value)]);
    if (key === 'mix')      updateArpDelayMix?.(value);
    if (key === 'decay')    onArpDecayChange?.(value);
  }, [updateArpDelayTime, updateArpDelayMix, onArpDecayChange]);

  return (
    <div
      className={styles.terminal}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <div className={styles.terminalHeader} onMouseDown={handleMouseDown}>
        ·· arp controls
      </div>

      <select
        className={styles.instrumentSelect}
        value={arpInstrument}
        onChange={e => onArpInstrumentChange?.(e.target.value)}
      >
        {ARP_INSTRUMENTS.map(({ value, label }) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>

      <div className={styles.sliders}>
        {FADERS.map(({ key, label, min, max, step, fmt }) => (
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
                onChange={e => handleFader(key, e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      <button
        className={speedSnap ? styles.toggleBtnActive : styles.toggleBtn}
        onClick={() => onSpeedSnapToggle?.(!speedSnap)}
      >
        {speedSnap ? '● speed snap' : '[ speed snap ]'}
      </button>
    </div>
  );
}
