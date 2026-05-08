import styles from './Viewport.module.css';
import LoopProgress from '../LoopProgress/LoopProgress';
import PianoRoll from '../PianoRoll/PianoRoll';
import VocoderTerminal from '../VocoderTerminal/VocoderTerminal';
import ArpTerminal from '../ArpTerminal/ArpTerminal';

export default function Viewport({
  videoRef, canvasRef, isActive, error,
  progressRef, isRecording, isLooping, pianoRollRef,
  isVocoderActive, getAnalyserData, updateVocoderParams,
  isArpTerminalOpen, updateArpDelayTime, updateArpDelayMix, arpSpeedSnap, onArpSpeedSnapToggle,
  arpInstrument, onArpInstrumentChange, onArpDecayChange, onArpVolumeChange,
}) {
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
      {isVocoderActive && (
        <VocoderTerminal
          getAnalyserData={getAnalyserData}
          updateVocoderParams={updateVocoderParams}
        />
      )}
      {isArpTerminalOpen && (
        <ArpTerminal
          updateArpDelayTime={updateArpDelayTime}
          updateArpDelayMix={updateArpDelayMix}
          speedSnap={arpSpeedSnap}
          onSpeedSnapToggle={onArpSpeedSnapToggle}
          arpInstrument={arpInstrument}
          onArpInstrumentChange={onArpInstrumentChange}
          onArpDecayChange={onArpDecayChange}
          onArpVolumeChange={onArpVolumeChange}
        />
      )}
    </div>
  );
}
