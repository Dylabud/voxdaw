import { useCallback, useRef } from 'react';
import './App.css';
import useCameraStream from './hooks/useCameraStream';
import useHandTracking from './hooks/useHandTracking';
import useAudioEngine from './hooks/useAudioEngine';
import useLoopStation from './hooks/useLoopStation';
import Viewport from './components/Viewport/Viewport';
import TelemetryHUD from './components/TelemetryHUD/TelemetryHUD';
import Controls from './components/Controls/Controls';

export default function App() {
  const pitchRef     = useRef(null);
  const reverbRef    = useRef(null);
  const velocityRef  = useRef(null);
  const filterRef    = useRef(null);
  const vibratoRef   = useRef(null);
  const chordRef     = useRef(null);
  const arpRef       = useRef(null);
  const arpVolRef    = useRef(null);
  const pianoRollRef = useRef(null);
  const hudRefs = { pitch: pitchRef, reverb: reverbRef, velocity: velocityRef, filter: filterRef, vibrato: vibratoRef, chord: chordRef, arp: arpRef, arpVol: arpVolRef, pianoRoll: pianoRollRef };

  const { videoRef, isActive, error, engage, disengage } = useCameraStream();
  const { startAudio, stopAudio, updateParams, setOscType, setScale, setInstrument, volumeRef } = useAudioEngine(hudRefs);
  const { isRecording, isLooping, startRecording, dispose, progressRef } = useLoopStation(volumeRef);
  const canvasRef = useHandTracking(videoRef, isActive, updateParams);

  const handleEngage = useCallback(async () => {
    await startAudio();
    await engage();
  }, [startAudio, engage]);

  const handleDisengage = useCallback(() => {
    disengage();
    stopAudio();
    dispose();
  }, [disengage, stopAudio, dispose]);

  return (
    <div className="app">
      <div className="mainStage">
        <Viewport
          videoRef={videoRef}
          canvasRef={canvasRef}
          isActive={isActive}
          error={error}
          progressRef={progressRef}
          isRecording={isRecording}
          isLooping={isLooping}
          pianoRollRef={pianoRollRef}
        />
        <TelemetryHUD
          pitchRef={pitchRef}
          reverbRef={reverbRef}
          velocityRef={velocityRef}
          filterRef={filterRef}
          vibratoRef={vibratoRef}
          chordRef={chordRef}
          arpRef={arpRef}
          arpVolRef={arpVolRef}
        />
      </div>
      <Controls
        isActive={isActive}
        onEngage={handleEngage}
        onDisengage={handleDisengage}
        onOscTypeChange={setOscType}
        onScaleChange={setScale}
        onInstrumentChange={setInstrument}
        onRecord={startRecording}
        isRecording={isRecording}
        isLooping={isLooping}
      />
    </div>
  );
}
