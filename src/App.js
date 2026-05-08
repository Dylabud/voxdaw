import { useCallback, useRef, useState } from 'react';
import './App.css';
import useCameraStream from './hooks/useCameraStream';
import useHandTracking from './hooks/useHandTracking';
import useAudioEngine from './hooks/useAudioEngine';
import useLoopStation from './hooks/useLoopStation';
import useMidi from './hooks/useMidi';
import useVocoder from './hooks/useVocoder';
import Viewport from './components/Viewport/Viewport';
import TelemetryHUD from './components/TelemetryHUD/TelemetryHUD';
import Controls from './components/Controls/Controls';
import MidiModal from './components/MidiModal/MidiModal';
import GestureSettings from './components/GestureSettings/GestureSettings';
import WelcomeModal from './components/WelcomeModal/WelcomeModal';
import { DEFAULT_MAPPINGS, DEFAULT_TRIGGER_MAPPINGS } from './utils/gestureMappings';

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
  const [globalOctave,   setGlobalOctaveState]   = useState(0);
  const [arpOctaveShift, setArpOctaveShiftState] = useState(false);
  const [arpFxEnabled,      setArpFxEnabledState]   = useState(false);
  const [isArpTerminalOpen, setIsArpTerminalOpen]   = useState(false);
  const [arpSpeedSnap,      setArpSpeedSnapState]   = useState(true);
  const [isDarkMode,        setIsDarkMode]          = useState(true);
  const [showControls,      setShowControls]        = useState(true);
  const [showAnalytics,  setShowAnalytics]        = useState(true);
  const [showWelcome,          setShowWelcome]          = useState(true);
  const [showMidiModal,        setShowMidiModal]        = useState(false);
  const [showGestureSettings,  setShowGestureSettings]  = useState(false);
  const [mappings,             setMappings]             = useState(DEFAULT_MAPPINGS);

  // Keep mappingsRef in sync with state — same pattern as hudRefsRef in useAudioEngine.
  // The rAF loop reads mappingsRef.current so it always sees the latest without re-render.
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;

  const [triggerMappings, setTriggerMappings] = useState(DEFAULT_TRIGGER_MAPPINGS);
  const triggerMappingsRef = useRef(triggerMappings);
  triggerMappingsRef.current = triggerMappings;

  const { isMidiEnabled, toggleMidi, sendMidi, panicAllNotes } = useMidi(() => setShowMidiModal(true));
  const { startVocoder, stopVocoder, updateNotes: updateVocoderNotes, updateVocoderParams, getAnalyserData, isVocoderActive } = useVocoder();
  const { startAudio, stopAudio, updateParams, setOscType, setScale, setInstrument, setTempo, setGlobalOctave, setArpOctaveShift, setArpFx, setArpDelayTime, setArpDelayMix, setArpSpeedSnap, volumeRef } = useAudioEngine(hudRefs, sendMidi, updateVocoderNotes, mappingsRef, triggerMappingsRef);

  const handleToggleVocoder = useCallback(async () => {
    if (isVocoderActive) {
      stopVocoder();
    } else {
      await startVocoder();
    }
  }, [isVocoderActive, startVocoder, stopVocoder]);

  const handleGlobalOctave = useCallback((val) => {
    setGlobalOctaveState(val);
    setGlobalOctave(val);
  }, [setGlobalOctave]);

  const handleArpOctaveShift = useCallback((bool) => {
    setArpOctaveShiftState(bool);
    setArpOctaveShift(bool);
  }, [setArpOctaveShift]);

  const handleArpFx = useCallback((bool) => {
    setArpFxEnabledState(bool);
    setArpFx(bool);
  }, [setArpFx]);

  const handleArpSpeedSnap = useCallback((bool) => {
    setArpSpeedSnapState(bool);
    setArpSpeedSnap(bool);
  }, [setArpSpeedSnap]);

  const { isRecording, isLooping, startRecording, dispose, progressRef } = useLoopStation(volumeRef);
  const canvasRef = useHandTracking(videoRef, isActive, updateParams);

  const handleEngage = useCallback(async () => {
    await startAudio();
    await engage();
  }, [startAudio, engage]);

  const handleDisengage = useCallback(() => {
    panicAllNotes();
    disengage();
    stopAudio();
    dispose();
  }, [panicAllNotes, disengage, stopAudio, dispose]);

  return (
    <div className="app" data-theme={isDarkMode ? undefined : 'light'}>
      {showWelcome && <WelcomeModal onEnter={() => setShowWelcome(false)} />}

      <button className="rightToggleBtn" onClick={() => setShowAnalytics(v => !v)}>
        {showAnalytics ? '›' : '‹'}
      </button>

      <Controls
        collapsed={!showControls}
        isActive={isActive}
        onOscTypeChange={setOscType}
        onScaleChange={setScale}
        onInstrumentChange={setInstrument}
        onTempoChange={setTempo}
        isMidiEnabled={isMidiEnabled}
        onToggleMidi={toggleMidi}
        isVocoderActive={isVocoderActive}
        onToggleVocoder={handleToggleVocoder}
        globalOctave={globalOctave}
        onGlobalOctaveChange={handleGlobalOctave}
        arpOctaveShift={arpOctaveShift}
        onArpOctaveShiftToggle={handleArpOctaveShift}
        arpFxEnabled={arpFxEnabled}
        onArpFxToggle={handleArpFx}
        isArpTerminalOpen={isArpTerminalOpen}
        onArpTerminalToggle={setIsArpTerminalOpen}
        onRecord={startRecording}
        isRecording={isRecording}
        isLooping={isLooping}
        onGestureSettingsOpen={() => setShowGestureSettings(true)}
        isDarkMode={isDarkMode}
        onThemeToggle={() => setIsDarkMode(v => !v)}
        onCollapseToggle={() => setShowControls(v => !v)}
      />

      <div className="stage">
        <Viewport
          videoRef={videoRef}
          canvasRef={canvasRef}
          isActive={isActive}
          error={error}
          progressRef={progressRef}
          isRecording={isRecording}
          isLooping={isLooping}
          pianoRollRef={pianoRollRef}
          isVocoderActive={isVocoderActive}
          getAnalyserData={getAnalyserData}
          updateVocoderParams={updateVocoderParams}
          isArpTerminalOpen={isArpTerminalOpen}
          updateArpDelayTime={setArpDelayTime}
          updateArpDelayMix={setArpDelayMix}
          arpSpeedSnap={arpSpeedSnap}
          onArpSpeedSnapToggle={handleArpSpeedSnap}
        />
        <button
          className={isActive ? 'disengageBtn' : 'engageBtn'}
          onClick={isActive ? handleDisengage : handleEngage}
        >
          {isActive ? '[ disengage ]' : '[ engage ]'}
        </button>
      </div>

      <TelemetryHUD
        collapsed={!showAnalytics}
        pitchRef={pitchRef}
        reverbRef={reverbRef}
        velocityRef={velocityRef}
        filterRef={filterRef}
        vibratoRef={vibratoRef}
        chordRef={chordRef}
        arpRef={arpRef}
        arpVolRef={arpVolRef}
      />

      {showMidiModal && <MidiModal onClose={() => setShowMidiModal(false)} />}

      {showGestureSettings && (
        <GestureSettings
          mappings={mappings}
          setMappings={setMappings}
          triggerMappings={triggerMappings}
          setTriggerMappings={setTriggerMappings}
          onClose={() => setShowGestureSettings(false)}
        />
      )}
    </div>
  );
}
