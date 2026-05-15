import styles from './HomePage.module.css';

export default function HomePage({ onNavigate }) {
  return (
    <div className={styles.page}>
      <div className={styles.center}>

        <div className={styles.wordmark}>
          <span className={styles.dots}>··</span> VoxDAW
        </div>
        <p className={styles.tagline}>gestural synthesis studio</p>

        <div className={styles.alphaBlock}>
          <span className={styles.alphaLabel}>ALPHA BUILD</span>
          <p className={styles.alphaBody}>
            All video processing happens locally on your machine.
            No video or personal data is ever recorded, saved, or sent to any server.
          </p>
        </div>

        <div className={styles.nav}>
          <button
            className={styles.primaryBtn}
            onClick={() => onNavigate('voxtool')}
          >
            [ VoxTool ]
          </button>
          <button
            className={styles.ghostBtn}
            onClick={() => onNavigate('workstation')}
          >
            [ New Project ]
          </button>
        </div>

      </div>
    </div>
  );
}
