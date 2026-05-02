import styles from './MidiModal.module.css';

export default function MidiModal({ onClose }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.box} onClick={e => e.stopPropagation()}>
        <h2 className={styles.heading}>MIDI Bridge Required</h2>
        <p className={styles.body}>
          To send zero-latency MIDI to your DAW, you need to run the local
          VoxDaw Bridge. Download it, unzip, and run{' '}
          <code className={styles.code}>node server.js</code> before enabling
          MIDI.
        </p>
        <div className={styles.actions}>
          <a
            className={styles.downloadBtn}
            href="/VoxDaw-MIDI-Bridge.zip"
            download
          >
            [ download bridge ]
          </a>
          <button className={styles.closeBtn} onClick={onClose}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
