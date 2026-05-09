import { useState } from 'react';
import styles from './Controls.module.css';
import { SCALE_LABELS, OSC_TYPES } from '../../utils/scales';

const INSTRUMENTS = [
  { key: 'analog',  label: 'Analog'  },
  { key: 'strings', label: 'Strings' },
];

export default function Controls({
  collapsed,
  isActive,
  onOscTypeChange, onScaleChange, onInstrumentChange, onTempoChange,
  isMidiEnabled, onToggleMidi,
  isVocoderActive, onToggleVocoder,
  isAutotuneActive, onToggleAutotune,
  globalOctave, onGlobalOctaveChange,
  arpOctaveShift, onArpOctaveShiftToggle,
  arpFxEnabled, onArpFxToggle,
  isArpTerminalOpen, onArpTerminalToggle,
  onOpenRecordModal, isRecording,
  onGestureSettingsOpen,
  isDarkMode, onThemeToggle,
  onCollapseToggle,
}) {
  const [instrument, setInstrumentState] = useState('analog');
  const [oscType, setOscType]            = useState('sine');
  const [scale, setScale]                = useState('cMajor');
  const [bpm, setBpm]                    = useState(120);

  const handleInstrumentChange = (e) => {
    setInstrumentState(e.target.value);
    onInstrumentChange?.(e.target.value);
  };

  const handleOscChange = (e) => {
    setOscType(e.target.value);
    onOscTypeChange?.(e.target.value);
  };

  const handleScaleChange = (e) => {
    setScale(e.target.value);
    onScaleChange?.(e.target.value);
  };

  const handleBpmChange = (e) => {
    const val = Math.min(300, Math.max(40, Number(e.target.value)));
    setBpm(val);
    onTempoChange?.(val);
  };

  return (
    <div className={`${styles.controls}${collapsed ? ` ${styles.collapsed}` : ''}`}>

      <button
        className={styles.collapseTab}
        onClick={onCollapseToggle}
        title={collapsed ? 'Expand panel' : 'Collapse panel'}
      >
        {collapsed ? '›' : '‹'}
      </button>

      {/* ── Header ── */}
      <div className={styles.header}>
        <button
          className={styles.themeBtn}
          onClick={onThemeToggle}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDarkMode ? '◑' : '○'}
        </button>
        ·· voxdaw
      </div>

      {/* ── Group 1: Master Engine ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>master engine</div>

        <div className={styles.field}>
          <span className={styles.label}>tempo</span>
          <input
            type="number"
            className={styles.bpmInput}
            value={bpm}
            min={40}
            max={300}
            onChange={handleBpmChange}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>octave</span>
          <div className={styles.octaveGroup}>
            <button
              className={styles.octaveBtn}
              onClick={() => onGlobalOctaveChange?.(Math.max(-2, globalOctave - 1))}
            >−</button>
            <span className={styles.octaveValue}>
              {globalOctave > 0 ? `+${globalOctave}` : globalOctave}
            </span>
            <button
              className={styles.octaveBtn}
              onClick={() => onGlobalOctaveChange?.(Math.min(2, globalOctave + 1))}
            >+</button>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>scale</span>
          <select className={styles.select} value={scale} onChange={handleScaleChange}>
            {Object.entries(SCALE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Group 2: Synth Voice ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>synth voice</div>

        <div className={styles.field}>
          <span className={styles.label}>instrument</span>
          <select className={styles.select} value={instrument} onChange={handleInstrumentChange}>
            {INSTRUMENTS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        {instrument === 'analog' && (
          <div className={styles.field}>
            <span className={styles.label}>oscillator</span>
            <select className={styles.select} value={oscType} onChange={handleOscChange}>
              {OSC_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Group 3: Arpeggiator ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>arpeggiator</div>

        <button
          className={arpOctaveShift ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={() => onArpOctaveShiftToggle?.(!arpOctaveShift)}
        >
          {arpOctaveShift ? '● arp +1 oct' : '[ arp +1 oct ]'}
        </button>

        <button
          className={arpFxEnabled ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={() => onArpFxToggle?.(!arpFxEnabled)}
        >
          {arpFxEnabled ? '● arp thru fx' : '[ arp thru fx ]'}
        </button>

        <button
          className={isArpTerminalOpen ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={() => onArpTerminalToggle?.(!isArpTerminalOpen)}
        >
          {isArpTerminalOpen ? '● arp controls' : '[ arp controls ]'}
        </button>
      </div>

      {/* ── Group 4: Gesture Routing ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>gesture routing</div>
        <button className={styles.toggleBtn} onClick={onGestureSettingsOpen}>
          [ configure routing ]
        </button>
      </div>

      {/* ── Group 5: Output ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>output</div>

        <button
          className={isMidiEnabled ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={onToggleMidi}
        >
          {isMidiEnabled ? '● midi' : '[ midi ]'}
        </button>

        <button
          className={isVocoderActive ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={onToggleVocoder}
        >
          {isVocoderActive ? '● vocoder' : '[ vocoder ]'}
        </button>

        <button
          className={isAutotuneActive ? styles.toggleBtnActive : styles.toggleBtn}
          onClick={onToggleAutotune}
        >
          {isAutotuneActive ? '● autotune' : '[ autotune ]'}
        </button>

        {isActive && (
          <button
            className={`${styles.recordBtn} ${isRecording ? styles.recordActive : ''}`}
            onClick={onOpenRecordModal}
          >
            {isRecording ? '● rec' : '[ record ]'}
          </button>
        )}
      </div>

    </div>
  );
}
