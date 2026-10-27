// Waveform of an audio region on the timeline (Vox Phase 134). Drawn from the
// clip's stored peak overview (voxClipStore) through the region's window —
// audioRegionSegments, the same Bottle/Window math playback uses — so a trimmed,
// split or looped region shows exactly what it plays. Subscribes to the clip
// store itself: a clip finishing its load re-renders only this waveform.
import { memo, useMemo, useSyncExternalStore } from 'react';
import { audioRegionSegments } from './audioClipMath';
import { getClip, subscribeClips } from './voxClipStore';

const MAX_COLS = 3000; // a very long region at deep zoom still draws in one pass

function AudioRegionWave({ clipId, secPerMeasure, durationMeasures, clipOffset, loopInterval, loopPhase, pixelsPerMeasure }) {
  const clip = useSyncExternalStore(subscribeClips, () => getClip(clipId));
  const width = durationMeasures * pixelsPerMeasure;

  const path = useMemo(() => {
    if (!clip || !(width > 0)) return '';
    const { peaks, binSec } = clip;
    const step = Math.max(1, width / MAX_COLS);
    const top = [];
    const segs = audioRegionSegments({ durationMeasures, clipOffset, loopInterval, loopPhase });
    for (const { x0, x1, b0 } of segs) {
      const px0 = x0 * pixelsPerMeasure;
      const px1 = x1 * pixelsPerMeasure;
      for (let px = px0; px < px1; px += step) {
        const pxEnd = Math.min(px1, px + step);
        const s0 = (b0 + (px - px0) / pixelsPerMeasure) * secPerMeasure;
        const s1 = (b0 + (pxEnd - px0) / pixelsPerMeasure) * secPerMeasure;
        let p = 0;
        for (let i = Math.max(0, Math.floor(s0 / binSec)), e = Math.min(peaks.length, Math.ceil(s1 / binSec)); i < e; i++) {
          if (peaks[i] > p) p = peaks[i];
        }
        top.push([px, Math.min(1, p)]);
      }
    }
    if (!top.length) return '';
    let d = `M${top[0][0].toFixed(1)},50`;
    for (const [x, p] of top) d += `L${x.toFixed(1)},${(50 - p * 48).toFixed(1)}`;
    for (let i = top.length - 1; i >= 0; i--) d += `L${top[i][0].toFixed(1)},${(50 + top[i][1] * 48).toFixed(1)}`;
    return `${d}Z`;
  }, [clip, width, durationMeasures, clipOffset, loopInterval, loopPhase, pixelsPerMeasure, secPerMeasure]);

  if (!path) return null;
  return (
    <svg
      width={width} height="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none"
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
      aria-hidden="true"
    >
      <path d={path} fill="var(--track-color, var(--accent-color))" fillOpacity="0.55" />
    </svg>
  );
}

export default memo(AudioRegionWave);
