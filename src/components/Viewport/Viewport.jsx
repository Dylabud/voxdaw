import styles from './Viewport.module.css';
import PianoRoll from '../PianoRoll/PianoRoll';
import VocoderTerminal from '../VocoderTerminal/VocoderTerminal';
import ArpTerminal from '../ArpTerminal/ArpTerminal';
import AutotuneTerminal from '../AutotuneTerminal/AutotuneTerminal';
import RecordModal from '../RecordModal/RecordModal';

export default function Viewport({
  videoRef, canvasRef, isActive, error,
  pianoRollRef,
  isVocoderActive, getAnalyserData, updateVocoderParams,
  isArpTerminalOpen, updateArpDelayTime, updateArpDelayMix, arpSpeedSnap, onArpSpeedSnapToggle,
  arpInstrument, onArpInstrumentChange, onArpDecayChange, onArpVolumeChange, onArpReverbChange,
  isAutotuneActive, setAutotuneWet, setAutotuneGlide, detectedNoteRef, correctedNoteRef, toggleTuneMode,
  isRecordTerminalOpen, onRecordTerminalClose, isRecording, recordedBlob, audioBuffer, startRecording, stopRecording, clearRecording,
}) {
  return (
    <div className={styles.viewport}>
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
          onArpReverbChange={onArpReverbChange}
        />
      )}
      {isAutotuneActive && (
        <AutotuneTerminal
          setAutotuneWet={setAutotuneWet}
          setAutotuneGlide={setAutotuneGlide}
          detectedNoteRef={detectedNoteRef}
          correctedNoteRef={correctedNoteRef}
          toggleTuneMode={toggleTuneMode}
        />
      )}
      {isRecordTerminalOpen && (
        <RecordModal
          onClose={onRecordTerminalClose}
          isRecording={isRecording}
          recordedBlob={recordedBlob}
          audioBuffer={audioBuffer}
          startRecording={startRecording}
          stopRecording={stopRecording}
          clearRecording={clearRecording}
        />
      )}
    </div>
  );
}
