import styles from './LoopProgress.module.css';

export default function LoopProgress({ progressRef, isRecording, isLooping }) {
  if (!isRecording && !isLooping) return null;
  return (
    <div className={styles.track}>
      <div
        ref={progressRef}
        className={`${styles.bar} ${isRecording ? styles.recording : styles.looping}`}
      />
      {Array.from({ length: 16 }, (_, i) => (
        <div key={i} className={styles.tick} style={{ left: `${(i / 16) * 100}%` }} />
      ))}
    </div>
  );
}
