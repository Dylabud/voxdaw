import styles from './Viewport.module.css';
import LoopProgress from '../LoopProgress/LoopProgress';
import PianoRoll from '../PianoRoll/PianoRoll';

export default function Viewport({ videoRef, canvasRef, isActive, error, progressRef, isRecording, isLooping, pianoRollRef }) {
  return (
    <div className={styles.viewport}>
      <LoopProgress progressRef={progressRef} isRecording={isRecording} isLooping={isLooping} />
      <PianoRoll ref={pianoRollRef} />
      <video
        ref={videoRef}
        className={styles.video}
        style={{ display: isActive ? 'block' : 'none' }}
        autoPlay
        playsInline
        muted
      />
      <canvas ref={canvasRef} className={styles.canvas} />
      {!isActive && !error && (
        <span className={styles.label}>[ camera feed ]</span>
      )}
      {error && (
        <span className={styles.errorLabel}>[ err: {error} ]</span>
      )}
    </div>
  );
}
