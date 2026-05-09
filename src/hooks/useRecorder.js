import { useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';

export default function useRecorder(masterMixRef) {
  const recorderRef = useRef(null);

  const [isRecording,   setIsRecording]   = useState(false);
  const [recordedBlob,  setRecordedBlob]  = useState(null);
  const [audioBuffer,   setAudioBuffer]   = useState(null);

  const startRecording = useCallback(async () => {
    if (recorderRef.current || !masterMixRef.current) return;

    setRecordedBlob(null);
    setAudioBuffer(null);

    const recorder = new Tone.Recorder();
    masterMixRef.current.connect(recorder);
    await recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
  }, [masterMixRef]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    const blob = await recorder.stop();
    recorder.dispose();
    recorderRef.current = null;
    setIsRecording(false);
    setRecordedBlob(blob);

    try {
      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer);
      setAudioBuffer(decoded);
    } catch (err) {
      console.warn('useRecorder: decodeAudioData failed', err);
    }
  }, []);

  const clearRecording = useCallback(() => {
    setRecordedBlob(null);
    setAudioBuffer(null);
  }, []);

  const dispose = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.stop().catch(() => {});
      recorder.dispose();
      recorderRef.current = null;
    }
    setIsRecording(false);
    setRecordedBlob(null);
    setAudioBuffer(null);
  }, []);

  return { isRecording, recordedBlob, audioBuffer, startRecording, stopRecording, clearRecording, dispose };
}
