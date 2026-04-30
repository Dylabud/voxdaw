import { useRef, useCallback, useState } from 'react';
import * as Tone from 'tone';

const LOOP_DURATION_MS = 8000;

export default function useLoopStation(volumeRef) {
  const recorderRef  = useRef(null);
  const playerRef    = useRef(null);
  const timerRef     = useRef(null);
  const progressRef  = useRef(null);
  const rafRef       = useRef(null);
  const startTimeRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isLooping,   setIsLooping]   = useState(false);

  const stopLoop = useCallback(() => {
    playerRef.current?.stop();
    playerRef.current?.dispose();
    playerRef.current = null;
    setIsLooping(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    cancelAnimationFrame(rafRef.current);
    stopLoop();

    if (!recorderRef.current) {
      recorderRef.current = new Tone.Recorder();
      volumeRef.current.connect(recorderRef.current);
    }

    await recorderRef.current.start();
    setIsRecording(true);
    startTimeRef.current = performance.now();

    const animateProgress = () => {
      const elapsed = performance.now() - startTimeRef.current;
      const t = Math.min(elapsed / LOOP_DURATION_MS, 1);
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${t})`;
      if (t < 1) rafRef.current = requestAnimationFrame(animateProgress);
    };
    rafRef.current = requestAnimationFrame(animateProgress);

    timerRef.current = setTimeout(async () => {
      const blob = await recorderRef.current.stop();
      setIsRecording(false);
      cancelAnimationFrame(rafRef.current);
      if (progressRef.current) progressRef.current.style.transform = 'scaleX(1)';

      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer);

      const player = new Tone.Player({ loop: true }).toDestination();
      player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
      player.start();
      playerRef.current = player;
      setIsLooping(true);
    }, LOOP_DURATION_MS);
  }, [volumeRef, stopLoop]);

  const dispose = useCallback(() => {
    clearTimeout(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    recorderRef.current?.stop().catch(() => {});
    recorderRef.current?.dispose();
    recorderRef.current = null;
    stopLoop();
    setIsRecording(false);
  }, [stopLoop]);

  return { isRecording, isLooping, startRecording, stopLoop, dispose, progressRef };
}
