import styles from './WelcomeModal.module.css';

export default function WelcomeModal({ onEnter }) {
  return (
    <div className={styles.overlay}>
      <div className={styles.box}>
        <h2 className={styles.heading}>WELCOME TO VOXDAW (ALPHA)</h2>
        <p className={styles.body}>
          VOXDAW is an experimental, browser-based gestural synthesizer. Because this is an
          early Alpha build, you might experience audio glitches, performance drops, or UI bugs.
        </p>
        <div className={styles.privacyBlock}>
          <span className={styles.privacyLabel}>A Note on Privacy</span>
          <p className={styles.body}>
            VOXDAW requires camera access to track your hand gestures. Your privacy is absolute.
            All video processing happens locally on your machine. No video or personal data is
            ever recorded, saved, or sent to any server.
          </p>
        </div>
        <button className={styles.enterBtn} onClick={onEnter}>
          [ ENTER STUDIO ]
        </button>
      </div>
    </div>
  );
}
