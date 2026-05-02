import styles from './TelemetryHUD.module.css';

// Value spans are written to directly via refs in the rAF loop — zero re-renders.
export default function TelemetryHUD({ collapsed, pitchRef, reverbRef, velocityRef, filterRef, vibratoRef, chordRef, arpRef, arpVolRef }) {
  const metrics = [
    { key: 'pitch',    ref: pitchRef    },
    { key: 'arp',      ref: arpRef      },
    { key: 'arp vol',  ref: arpVolRef   },
    { key: 'chord',    ref: chordRef    },
    { key: 'filter',   ref: filterRef   },
    { key: 'reverb',   ref: reverbRef   },
    { key: 'vibrato',  ref: vibratoRef  },
    { key: 'velocity', ref: velocityRef },
  ];

  return (
    <div className={`${styles.hud}${collapsed ? ` ${styles.collapsed}` : ''}`}>
      {metrics.map(({ key, ref }) => (
        <div key={key} className={styles.metric}>
          <span className={styles.metricLabel}>{key}</span>
          <span ref={ref} className={styles.metricValue}>--</span>
        </div>
      ))}
    </div>
  );
}
