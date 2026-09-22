import { memo, useMemo } from 'react';

// Tiny waveform for a dashboard project row: mirrored bars around the vertical
// center, built once from the stored peaks (no audio decode). Colors via
// currentColor so the parent's `color` themes it (accent = fresh, muted = stale).
const H = 32;
const MID = H / 2;
const MIN_BAR = 0.6; // silent buckets still draw a hairline center

function PreviewWave({ peaks }) {
  const { path, width } = useMemo(() => {
    const n = peaks?.length ?? 0;
    let d = '';
    for (let i = 0; i < n; i++) {
      const h = Math.max(MIN_BAR, Math.min(1, peaks[i]) * (MID - 1));
      d += `M${i + 0.5} ${MID - h}V${MID + h}`;
    }
    return { path: d, width: n };
  }, [peaks]);

  if (!width) return null;
  return (
    <svg
      viewBox={`0 0 ${width} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      aria-hidden="true"
    >
      <path d={path} stroke="currentColor" strokeWidth="0.6" fill="none" />
    </svg>
  );
}

export default memo(PreviewWave);
