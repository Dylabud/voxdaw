// "Still recording" pill shown on every page EXCEPT the Workstation while a Vox
// take runs (Vox Phase 134) — so you can go to the Vox Modular, tweak it while
// the take records, and stop it from there. Reads voxRecStatus directly; its
// own once-a-second tick re-renders only this pill.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getVoxRecStatus, subscribeVoxRecStatus, pressVoxRecord } from './voxRecStatus';
import styles from './VoxRecIndicator.module.css';

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function VoxRecIndicator({ onGoToWorkstation }) {
  const status = useSyncExternalStore(subscribeVoxRecStatus, getVoxRecStatus);
  const [now, setNow] = useState(() => Date.now());
  const recording = status?.phase === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recording]);
  if (!status) return null;

  const audio = status.mode === 'audio';
  let text;
  let action = null;
  if (status.phase === 'countin') {
    text = 'Count-in…';
    action = 'cancel';
  } else if (recording) {
    text = `REC ${fmt((now - status.startedAt) / 1000)} · ${audio
      ? 'audio take: every knob move is being recorded'
      : 'notes take: what you play is being recorded'}`;
    action = '■ stop';
  } else if (status.phase === 'saving') {
    text = 'Saving the recording…';
  } else {
    text = `Photographing your patch ${status.done ?? 0}/${status.total ?? 0}. Hands off the Vox until it's done.`;
    action = 'cancel';
  }

  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <span className={recording ? styles.dotLive : styles.dot} aria-hidden="true">●</span>
      <span className={styles.text}>{text}</span>
      {action && <button className={styles.btn} onClick={pressVoxRecord}>{action}</button>}
      <button className={styles.btn} onClick={onGoToWorkstation} title="Go to the Workstation">workstation ↗</button>
    </div>
  );
}
