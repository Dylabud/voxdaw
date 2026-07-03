import React from 'react';
import styles from './EffectsRack.module.css';

/**
 * Per-effect SVG visualizer for the rack modules. Pure function of the
 * effect's params — static types re-render only when a param changes (normal
 * React commit, outside the rAF hot path). The two LFO effects (autofilter /
 * phaser) animate via a CSS keyframe translate on a <g> — compositor-only,
 * zero JS per frame; `animation-duration = 1/rate` so one visual cycle tracks
 * one LFO cycle exactly.
 *
 * All shapes live in a fixed W×H user space stretched to the module width
 * with preserveAspectRatio="none". VIZ_W must match the translate distance in
 * the .vizAnim keyframes (EffectsRack.module.css) — one period per cycle.
 */

export const VIZ_W = 160;
export const VIZ_H = 56;

const FMIN = 20;
const FMAX = 20000;
const SAMPLE_RATE = 44100;

// Log-frequency → x position.
const fx = (f) => (VIZ_W * Math.log(f / FMIN)) / Math.log(FMAX / FMIN);

// dB → y position over a fixed display window.
const dbY = (db, minDb, maxDb) =>
  VIZ_H * (1 - Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb))));

const pathFrom = (pts) =>
  pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Wet/mix → drawing intensity, for types whose curve shape doesn't otherwise
// involve the mix knob (doubler / autofilter / autowah / phaser / distortion).
// Floor of 0.25 keeps the shape legible at mix 0.
const wetOpacity = (wet) => 0.25 + 0.75 * clamp01(wet ?? 0.5);

// RBJ biquad magnitude response (Tone.Filter default rolloff is −12 dB/oct =
// one biquad). Returns |H| in dB at frequency f for the given type/f0/Q.
function biquadDb(type, f0, Q, f) {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos0;
  const a2 = 1 - alpha;
  if (type === 'highpass') {
    b0 = (1 + cos0) / 2; b1 = -(1 + cos0); b2 = b0;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha; // constant 0 dB peak gain form
  } else {
    b0 = (1 - cos0) / 2; b1 = 1 - cos0; b2 = b0; // lowpass
  }
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nRe = b0 + b1 * c1 + b2 * c2, nIm = -(b1 * s1 + b2 * s2);
  const dRe = a0 + a1 * c1 + a2 * c2, dIm = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
  return 20 * Math.log10(Math.max(mag, 1e-6));
}

// 64 log-spaced sample frequencies, shared by the response curves.
const FREQS = Array.from({ length: 64 }, (_, i) =>
  FMIN * Math.pow(FMAX / FMIN, i / 63),
);

function FilterViz({ params }) {
  const type = params.type ?? 'lowpass';
  const f0 = params.frequency ?? 5000;
  const q = params.q ?? 1;
  const pts = FREQS.map((f) => [fx(f), dbY(biquadDb(type, f0, q, f), -30, 18)]);
  const zeroY = dbY(0, -30, 18);
  return (
    <>
      <line className={styles.vizGrid} x1={0} y1={zeroY} x2={VIZ_W} y2={zeroY} />
      <path className={styles.vizFillShape} d={`${pathFrom(pts)} L ${VIZ_W} ${VIZ_H} L 0 ${VIZ_H} Z`} />
      <path className={styles.vizStroke} d={pathFrom(pts)} />
    </>
  );
}

function EqViz({ params }) {
  const low = params.low ?? 0, mid = params.mid ?? 0, high = params.high ?? 0;
  // Smooth crossover blend approximating EQ3's band split (400 / 2500 Hz).
  const pts = FREQS.map((f) => {
    const s1 = 1 / (1 + Math.pow(400 / f, 4));
    const s2 = 1 / (1 + Math.pow(2500 / f, 4));
    const db = low * (1 - s1) + mid * s1 * (1 - s2) + high * s1 * s2;
    return [fx(f), dbY(db, -15, 15)];
  });
  const zeroY = dbY(0, -15, 15);
  return (
    <>
      <line className={styles.vizGrid} x1={0} y1={zeroY} x2={VIZ_W} y2={zeroY} />
      <line className={styles.vizGrid} x1={fx(400)} y1={0} x2={fx(400)} y2={VIZ_H} />
      <line className={styles.vizGrid} x1={fx(2500)} y1={0} x2={fx(2500)} y2={VIZ_H} />
      <path className={styles.vizStroke} d={pathFrom(pts)} />
    </>
  );
}

// Shared by autofilter + phaser: sine spanning two periods, CSS-translated
// left by one period (VIZ_W) per LFO cycle. Amplitude tracks depth, drawing
// intensity tracks wet.
function LfoSineViz({ rate, depth, maxDepth, wet }) {
  const amp = VIZ_H * 0.32 * Math.min(1, (depth ?? 1) / maxDepth);
  const mid = VIZ_H / 2;
  const pts = Array.from({ length: 65 }, (_, i) => {
    const x = (i / 64) * 2 * VIZ_W;
    return [x, mid + amp * Math.sin((2 * Math.PI * x) / VIZ_W)];
  });
  return (
    <>
      <line className={styles.vizGrid} x1={0} y1={mid} x2={VIZ_W} y2={mid} />
      <g
        className={styles.vizAnim}
        opacity={wetOpacity(wet)}
        style={{ animationDuration: `${(1 / (rate || 1)).toFixed(3)}s` }}
      >
        <path className={styles.vizStroke} d={pathFrom(pts)} />
      </g>
    </>
  );
}

function AutoWahViz({ params }) {
  // Static sweep range: base 100 Hz up `depth` octaves; Q scales the peak.
  const depth = params.depth ?? 4;
  const q = params.q ?? 2;
  const x0 = fx(100);
  const x1 = fx(Math.min(FMAX, 100 * Math.pow(2, depth)));
  const peakY = VIZ_H * (0.42 - 0.32 * Math.min(1, q / 10));
  const baseY = VIZ_H * 0.82;
  const d = `M 0 ${baseY} L ${x0} ${baseY} C ${(x0 + x1) / 2} ${baseY}, ${x1 - 14} ${peakY}, ${x1} ${peakY} C ${x1 + 8} ${peakY}, ${x1 + 10} ${baseY}, ${Math.min(VIZ_W, x1 + 22)} ${baseY} L ${VIZ_W} ${baseY}`;
  return (
    <g opacity={wetOpacity(params.wet)}>
      <rect className={styles.vizFillShape} x={x0} y={peakY} width={Math.max(2, x1 - x0)} height={baseY - peakY} />
      <path className={styles.vizStroke} d={d} />
    </g>
  );
}

function DoublerViz({ params }) {
  // Venn separation — circles pull apart as depth rises; the doubled (right)
  // voice fades with mix while the dry (left) circle stays put.
  const depth = params.depth ?? 0.7;
  const r = VIZ_H * 0.32;
  const off = 3 + depth * VIZ_W * 0.12;
  const cy = VIZ_H / 2;
  return (
    <>
      <circle className={styles.vizCircle} cx={VIZ_W / 2 - off} cy={cy} r={r} />
      <circle className={styles.vizCircle} opacity={wetOpacity(params.wet)} cx={VIZ_W / 2 + off} cy={cy} r={r} />
    </>
  );
}

function DistortionViz({ params }) {
  // Waveshaper transfer curve: y = tanh(kx)/tanh(k), bending with drive.
  const k = 0.6 + (params.drive ?? 0.4) * 9;
  const pts = Array.from({ length: 41 }, (_, i) => {
    const xN = (i / 40) * 2 - 1; // −1 … 1
    const yN = Math.tanh(k * xN) / Math.tanh(k);
    return [((xN + 1) / 2) * VIZ_W, VIZ_H * (0.5 - 0.42 * yN)];
  });
  return (
    <>
      <line className={styles.vizGrid} x1={0} y1={VIZ_H * 0.92} x2={VIZ_W} y2={VIZ_H * 0.08} />
      <path className={styles.vizStroke} opacity={wetOpacity(params.wet)} d={pathFrom(pts)} />
    </>
  );
}

function CompressorViz({ params }) {
  // Gain curve: unity below threshold, slope 1/ratio above. Axes −60…0 dB.
  const t = params.threshold ?? -24;
  const ratio = params.ratio ?? 4;
  const toXY = (inDb, outDb) => [
    ((inDb + 60) / 60) * VIZ_W,
    VIZ_H * (1 - 0.92 * ((outDb + 60) / 60)) ,
  ];
  const knee = toXY(t, t);
  const end = toXY(0, t + (0 - t) / ratio);
  const d = `M ${toXY(-60, -60).join(' ')} L ${knee.join(' ')} L ${end.join(' ')}`;
  return (
    <>
      <line className={styles.vizGrid} x1={0} y1={VIZ_H} x2={VIZ_W} y2={VIZ_H * 0.08} />
      <path className={styles.vizStroke} d={d} />
      <circle className={styles.vizDot} cx={knee[0]} cy={knee[1]} r={2.5} />
    </>
  );
}

function DelayViz({ params }) {
  // Echo bars: dry hit (dim) then repeats at `time` spacing decaying by
  // `feedback`, first-echo height scaled by wet. The in-loop cut filters dim
  // each successive repeat by the passband fraction (echoes pass through the
  // filters once per loop cycle — the bars "darken" like the audio does).
  const time = params.time ?? 0.25;
  const fb = params.feedback ?? 0.3;
  const wet = params.wet ?? 0.3;
  const passband = clamp01(
    Math.log((params.highCut ?? 18000) / Math.max(params.lowCut ?? 20, 20)) /
    Math.log(18000 / 20),
  );
  const dx = 14 + time * (VIZ_W - 40);
  const bars = [];
  let h = VIZ_H * 0.85 * Math.max(0.06, wet);
  let dim = passband; // first echo has passed the filters once
  for (let x = 8 + dx, n = 0; x < VIZ_W - 2 && h >= 1 && n < 12; x += dx, n++) {
    bars.push(
      <rect key={n} className={styles.vizBar} opacity={Math.max(0.08, dim)} x={x} y={VIZ_H - h} width={4} height={h} />,
    );
    h *= fb;
    dim *= passband;
  }
  return (
    <>
      <rect className={styles.vizBarDim} x={8} y={VIZ_H * 0.15} width={4} height={VIZ_H * 0.85} />
      {bars}
    </>
  );
}

function ReverbViz({ params }) {
  // Exponential decay envelope — longer tail with roomSize, top edge sagging
  // toward the right as dampening pulls highs out of the tail.
  const room = params.roomSize ?? 0.7;
  const damp = params.dampening ?? 3000;
  const wet = params.wet ?? 0.3;
  const h0 = VIZ_H * 0.9 * (0.25 + 0.75 * wet);
  const tau = VIZ_W * (0.12 + 0.7 * room);
  const sag = 1 - 0.5 * (1 - Math.log(damp / 500) / Math.log(15000 / 500));
  const pts = Array.from({ length: 33 }, (_, i) => {
    const x = (i / 32) * VIZ_W;
    const env = h0 * Math.exp(-x / tau) * Math.pow(sag, (x / VIZ_W) * 4);
    return [x, VIZ_H - env];
  });
  return (
    <>
      <path className={styles.vizFillShape} d={`${pathFrom(pts)} L ${VIZ_W} ${VIZ_H} L 0 ${VIZ_H} Z`} />
      <path className={styles.vizStroke} d={pathFrom(pts)} />
    </>
  );
}

const RENDERERS = {
  filter: (p) => <FilterViz params={p} />,
  eq: (p) => <EqViz params={p} />,
  autofilter: (p) => <LfoSineViz rate={p.rate ?? 2} depth={p.depth ?? 4} maxDepth={6} wet={p.wet} />,
  phaser: (p) => <LfoSineViz rate={p.rate ?? 0.5} depth={p.depth ?? 3} maxDepth={6} wet={p.wet} />,
  autowah: (p) => <AutoWahViz params={p} />,
  doubler: (p) => <DoublerViz params={p} />,
  distortion: (p) => <DistortionViz params={p} />,
  compressor: (p) => <CompressorViz params={p} />,
  delay: (p) => <DelayViz params={p} />,
  reverb: (p) => <ReverbViz params={p} />,
};

export default function FxVisualizer({ type, params = {} }) {
  const render = RENDERERS[type];
  if (!render) return null;
  return (
    <svg
      className={styles.viz}
      viewBox={`0 0 ${VIZ_W} ${VIZ_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {render(params)}
    </svg>
  );
}
