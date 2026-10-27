// Progress banner for the Vox take photograph (Vox Phase 131) — the sweep is
// silent now, so this is the only sign it is running: a bar, the note counter,
// a time-left estimate and a Cancel. The once-a-second tick lives HERE, so it
// re-renders this banner only, never the shell.
import { useEffect, useState } from 'react';
import styles from './VoxPhotoBanner.module.css';

// Before the first step finishes there is nothing measured yet: a photo note is a
// 4 s hold plus a typical release + settle; a routing probe ~1 s + tail + baseline.
const DEFAULT_SEC_PER_STEP = { photo: 6.5, probe: 2.5 };

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function VoxPhotoBanner({ progress, onCancel }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // phase 'probe' (Phase 132): one short test note per recorded part, to learn which
  // I/O input each reaches; then 'photo'. The time-left estimate is per phase.
  const { phase = 'photo', done, total, startedAt, name } = progress;
  const elapsed = (now - startedAt) / 1000;
  const perStep = done > 0 ? elapsed / done : DEFAULT_SEC_PER_STEP[phase] ?? 6.5;
  const left = Math.max(1, perStep * total - elapsed);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const title = phase === 'probe'
    ? `Finding which I/O input each part plays through… ${done}/${total}`
    : `Photographing ${name ?? 'the Vox patch'}… ${done}/${total}`;

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <div className={styles.row}>
        <span className={styles.title}>{title}</span>
        <span className={styles.eta}>{phase === 'probe' ? 'a few seconds' : `about ${fmt(left)} left`}</span>
        <button className={styles.cancel} onClick={onCancel}>cancel</button>
      </div>
      <div className={styles.track} aria-hidden="true">
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.hint}>Silent — your notes are safe. Hands off the Vox synth until it finishes.</div>
    </div>
  );
}
