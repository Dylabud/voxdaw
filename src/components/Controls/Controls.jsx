import { useState } from 'react';
import styles from './Controls.module.css';
import { SCALE_LABELS, OSC_TYPES } from '../../utils/scales';

const INSTRUMENTS = [
  { key: 'analog',  label: 'Analog'  },
  { key: 'strings', label: 'Strings' },
];

export default function Controls({ isActive, onEngage, onDisengage, onOscTypeChange, onScaleChange, onInstrumentChange, onRecord, isRecording, isLooping }) {
  const [instrument, setInstrumentState] = useState('analog');
  const [oscType, setOscType] = useState('sine');
  const [scale, setScale] = useState('cMajor');

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

  return (
    <div className={styles.controls}>
      <div className={styles.selectGroup}>
        <div className={styles.selectWrap}>
          <span className={styles.selectLabel}>instrument</span>
          <select className={styles.select} value={instrument} onChange={handleInstrumentChange}>
            {INSTRUMENTS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        <div className={styles.selectWrap}>
          <span className={styles.selectLabel}>scale</span>
          <select className={styles.select} value={scale} onChange={handleScaleChange}>
            {Object.entries(SCALE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        {instrument === 'analog' && (
          <div className={styles.selectWrap}>
            <span className={styles.selectLabel}>oscillator</span>
            <select className={styles.select} value={oscType} onChange={handleOscChange}>
              {OSC_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className={styles.buttonGroup}>
        {isActive && (
          <button
            className={`${styles.recordBtn} ${isRecording ? styles.recordActive : ''}`}
            onClick={onRecord}
            disabled={isRecording}
          >
            {isRecording ? '● rec' : isLooping ? '[ re-record ]' : '[ record ]'}
          </button>
        )}
        <button
          className={isActive ? styles.disengageBtn : styles.engageBtn}
          onClick={isActive ? onDisengage : onEngage}
        >
          {isActive ? '[ disengage ]' : '[ engage ]'}
        </button>
      </div>
    </div>
  );
}
