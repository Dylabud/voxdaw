import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './MoogShell.module.css';
import MoogKnob from './MoogKnob';
import { MoogPatchProvider, useMoogPatch } from './MoogPatchContext';
import PatchCableOverlay from './PatchCableOverlay';
import useMoogAudio, { FFB_BANDS, VOC_BANDS } from './useMoogAudio';
import Oscilloscope from './Oscilloscope';
import KeyboardModule from './KeyboardModule';
import Led from './Led';

// ──────────── Atomic hardware primitives ────────────

function Screw({ pos }) {
  return <div className={`${styles.screw} ${styles[pos]}`} />;
}

// Jack now registers itself in the patch context and initiates cable drags.
// id — unique string (e.g. "vco1-saw"). Jacks without id are purely decorative.
function Jack({ id, label }) {
  const { registerJack, unregisterJack, startDrag } = useMoogPatch();
  const elRef = useRef(null);

  useEffect(() => {
    if (!id) return;
    registerJack(id, elRef.current);
    return () => unregisterJack(id);
  }, [id, registerJack, unregisterJack]);

  return (
    <div className={styles.jackGroup}>
      <div
        ref={elRef}
        className={styles.jack}
        data-jack-id={id}
        style={id ? { cursor: 'crosshair' } : undefined}
        onMouseDown={id ? (e) => { e.preventDefault(); e.stopPropagation(); startDrag(id); } : undefined}
      />
      {label ? <span className={styles.jackLabel}>{label}</span> : <span className={styles.jackLabelEmpty} />}
    </div>
  );
}

function ToggleSwitch({ labels = ['OFF', 'ON'] }) {
  return (
    <div className={styles.toggleGroup}>
      <span className={styles.toggleLabel}>{labels[1]}</span>
      <div className={styles.toggle}>
        <div className={styles.toggleLever} />
      </div>
      <span className={styles.toggleLabel}>{labels[0]}</span>
    </div>
  );
}

function PlateDivider() {
  return <div className={styles.plateDivider} />;
}

function TierSep() {
  return <div className={styles.tierSep} />;
}

// Stateful power toggle — reuses existing toggle CSS, lever turns green when on.
function PowerSwitch({ isPowered, onToggle }) {
  return (
    <div
      className={styles.toggleGroup}
      onClick={onToggle}
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      <span className={styles.toggleLabel}>ON</span>
      <div className={styles.toggle}>
        <div
          className={styles.toggleLever}
          style={{
            marginTop: isPowered ? '0px' : '10px',
            background: isPowered
              ? 'radial-gradient(circle at 38% 28%, #70e870 0%, #228022 48%, #124012 100%)'
              : undefined,
            transition: 'margin-top 0.12s ease, background 0.18s ease',
          }}
        />
      </div>
      <span className={styles.toggleLabel}>OFF</span>
    </div>
  );
}

// ──────────── Module panels ────────────

// Exponential frequency mapping: C1 (32.703 Hz) → C6 (1046.502 Hz)
const VCO_FREQ_MIN = 32.703;
const VCO_FREQ_MAX = 1046.502;
const RANGE_STEPS  = [-2, -1, 0, 1, 2];
const RANGE_LABELS = { '-2': "32'", '-1': "16'", '0': "8'", '1': "4'", '2': "2'" };

// SVG waveform icons for VCO jack labels.
// stroke="currentColor" inherits the .jackLabel color so they match the text labels.
const WAVE_PATHS = {
  sine:     'M 0,5 C 2,2.4 4,0 6,0 C 8,0 10,2.4 12,5 C 14,7.6 16,10 18,10 C 20,10 22,7.6 24,5',
  triangle: 'M 0,5 L 6,0 L 18,10 L 24,5',
  sawtooth: 'M 0,9 L 11,1 L 11,9 L 22,1',
  square:   'M 0,2 H 10 V 8 H 22 V 2',
};

function WaveIcon({ type }) {
  return (
    <svg viewBox="0 0 24 10" width="31" height="13" fill="none"
      stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <path d={WAVE_PATHS[type]} />
    </svg>
  );
}

// Physical toggle switch for Hard Sync — lever moves up (ON) / down (OFF).
// Reuses the existing .toggle/.toggleLever CSS from the hardware aesthetic.
function HardSyncSwitch({ isOn, onToggle }) {
  return (
    <div
      className={styles.hardSyncSwitch}
      onClick={onToggle}
      title="Hard Sync: patch VCO1-SAW → SYNC↓ then enable. Slave phase resets each master cycle."
    >
      <span className={styles.toggleLabel}>ON</span>
      <div className={styles.toggle}>
        <div
          className={styles.toggleLever}
          style={{
            marginTop: isOn ? '0px' : '10px',
            transition: 'margin-top 0.12s ease',
          }}
        />
      </div>
      <span className={styles.toggleLabel}>OFF</span>
    </div>
  );
}

// number prop (1/2/3/4) drives the display label and jack ID prefixes.
// onParamUpdate(vcoId, { hz, detune }) is the audio update callback from useMoogAudio.
// onSyncChange(enabled) — only provided for VCO2; enables/disables the hard sync slave output.
// getLedValue() — stable getter for the VCO output-presence meter.
// quantized — true when the QNT module is snapping this VCO's FREQ knob (Phase 57);
//             lights the knob's mint indicator pulse.
function VcoModule({ number, onParamUpdate, onSyncChange, getLedValue, quantized = false }) {
  // VCO2/VCO3 start slightly detuned for classic analog thickness
  const defaultFine = number === 2 ? 0.52 : number === 3 ? 0.48 : number === 5 ? 0.51 : 0.5;

  const [freqBase,    setFreqBase]    = useState(0.5);
  const [fineTune,    setFineTune]    = useState(defaultFine);
  const [rangeOctave, setRangeOctave] = useState(0);
  const [syncOn,      setSyncOn]      = useState(false);

  // Sync LED getter — ref-backed so the stable useCallback never stale-captures syncOn.
  const syncOnRef = useRef(false);
  useEffect(() => { syncOnRef.current = syncOn; }, [syncOn]);
  const getSyncLed = useCallback(() => syncOnRef.current ? 1 : 0, []);

  const vcoId = `vco${number}`;
  const p     = vcoId;

  useEffect(() => {
    if (!onParamUpdate) return;
    const baseHz  = VCO_FREQ_MIN * Math.pow(VCO_FREQ_MAX / VCO_FREQ_MIN, freqBase);
    const finalHz = baseHz * Math.pow(2, rangeOctave);
    const detune  = (fineTune - 0.5) * 200;
    onParamUpdate(vcoId, { hz: finalHz, detune });
  }, [freqBase, fineTune, rangeOctave, vcoId, onParamUpdate]);

  const cycleRange = () =>
    setRangeOctave(prev => RANGE_STEPS[(RANGE_STEPS.indexOf(prev) + 1) % RANGE_STEPS.length]);

  const handleSyncToggle = () => {
    const next = !syncOn;
    setSyncOn(next);
    onSyncChange?.(next);
  };

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <span className={styles.plateNum}>{number}</span>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VCO</span>
            <span className={styles.plateSub}>VOLTAGE CONTROLLED OSCILLATOR</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="FREQ" size="xl" value={freqBase} onChange={setFreqBase} defaultValue={0.5} glow={quantized} />
            <MoogKnob label="FINE" size="sm" value={fineTune} onChange={setFineTune} defaultValue={defaultFine} />
            <Led getValue={getLedValue} color="green" />
          </div>
          <div className={styles.vcoControlRow}>
            <div className={styles.selectorRow}>
              <div className={styles.selectorGroup} onClick={cycleRange} title="Click to cycle range">
                <span className={styles.selectorLabel}>RANGE</span>
                <span className={styles.selectorValue}>{RANGE_LABELS[String(rangeOctave)]}</span>
              </div>
            </div>
            {onSyncChange && (
              <div className={styles.vcoSyncRow}>
                <HardSyncSwitch isOn={syncOn} onToggle={handleSyncToggle} />
                <div className={styles.vcoSyncLed}>
                  <Led getValue={getSyncLed} color="blue" />
                  <span className={styles.toggleLabel}>SYNC</span>
                </div>
                {/* Sync patch points live beside the switch — a dedicated jack row
                    below cost a full row of tier-1 height (fit() is height-bound) */}
                <Jack id={`${p}-sync-in`}  label="SYNC↓" />
                <Jack id={`${p}-sync-out`} label="SYNC↑" />
              </div>
            )}
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-cv`}  label="CV" />
            <Jack id={`${p}-fm`}  label="FM" />
            <Jack id={`${p}-sin`} label={<WaveIcon type="sine" />} />
            <Jack id={`${p}-tri`} label={<WaveIcon type="triangle" />} />
            <Jack id={`${p}-saw`} label={<WaveIcon type="sawtooth" />} />
            <Jack id={`${p}-sqr`} label={<WaveIcon type="square" />} />
          </div>
        </div>
      </div>
    </div>
  );
}

function NoiseModule({ number = 1, onParamUpdate }) {
  const [level, setLevel] = useState(0.7);
  const prefix = number === 1 ? 'noise' : `noise${number}`;

  // LEVEL → per-instance W/P gain pair (Phase 8b); 0.7 default = unity.
  useEffect(() => {
    onParamUpdate?.(prefix, { level });
  }, [level, prefix, onParamUpdate]);
  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>NOISE</span>
            <span className={styles.plateSub}>RANDOM SIGNAL GENERATOR</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="LEVEL" size="md" value={level} onChange={setLevel} defaultValue={0.7} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${prefix}-wht`} label="WHT" />
            <Jack id={`${prefix}-pnk`} label="PNK" />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ cutoff, resonance }) is the audio update callback from useMoogAudio.
// envAmt and kbdTracking are visual-only in this phase (Phase 6 will wire them).
function VcfModule({ onParamUpdate, number = 1 }) {
  const [cutoff, setCutoff] = useState(1.0);   // fully open — matches vcf init at 20kHz
  const [res, setRes]       = useState(0.0);
  const [envAmt, setEnvAmt] = useState(0.5);   // visual only
  const [kbd, setKbd]       = useState(0.0);   // visual only

  const p = number === 1 ? 'vcf' : `vcf${number}`;

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ cutoff, resonance: res });
  }, [cutoff, res, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <span className={styles.plateNum}>{number}</span>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VCF</span>
            <span className={styles.plateSub}>VOLTAGE CONTROLLED FILTER — 24 dB/OCT LADDER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            {/* "RES" not "RESONANCE": the full word at the 16px type scale wraps this
                row when fit()'s width compensation narrows, oscillating the layout */}
            <MoogKnob label="CUTOFF" size="xl" value={cutoff} onChange={setCutoff} defaultValue={1.0} />
            <MoogKnob label="RES"    size="lg" value={res}    onChange={setRes}    defaultValue={0.0} />
            <MoogKnob label="ENV AMT"   size="md" value={envAmt} onChange={setEnvAmt} defaultValue={0.5} />
            <MoogKnob label="KBD"       size="sm" value={kbd}    onChange={setKbd}    defaultValue={0.0} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}  label="IN" />
            <Jack id={`${p}-cv1`} label="CV 1" />
            <Jack id={`${p}-cv2`} label="CV 2" />
            <Jack id={`${p}-env`} label="ENV" />
            <Jack id={`${p}-out`} label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// LFO waveform options — same cycling pattern as VcoModule (Phase 4).
// Patching a specific output jack (lfo-sin, lfo-tri, etc.) overrides the type
// at cable-connect time via the jackMap waveform field. The UI selector sets
// the default type for the currently-running LFO signal.
const LFO_WAVE_TYPES  = ['sine', 'triangle', 'square', 'sawtooth'];
const LFO_WAVE_LABELS = { sine: 'SIN', triangle: 'TRI', square: 'SQR', sawtooth: 'SAW' };

// onParamUpdate({ rate, depth, type }) wires knobs and wave selector to useMoogAudio.
// getLedValue() — stable getter (pre-bound in MoogShell) for the LFO level meter.
function LfoModule({ onParamUpdate, getLedValue, number = 1 }) {
  const [rate,     setRate]     = useState(0.3);
  const [depth,    setDepth]    = useState(0.5);
  const [modDepth, setModDepth] = useState(0.0);
  const [waveType, setWaveType] = useState('sine');
  const p = number === 1 ? 'lfo' : `lfo${number}`;

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ rate, depth, modDepth, type: waveType });
  }, [rate, depth, modDepth, waveType, onParamUpdate]);

  const cycleWave = () =>
    setWaveType(prev => LFO_WAVE_TYPES[(LFO_WAVE_TYPES.indexOf(prev) + 1) % LFO_WAVE_TYPES.length]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>LFO</span>
            <span className={styles.plateSub}>LOW FREQUENCY OSCILLATOR</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <Led getValue={getLedValue} color="yellow" />
            <MoogKnob label="RATE"  size="lg" value={rate}     onChange={setRate}     defaultValue={0.3} />
            <MoogKnob label="DEPTH" size="md" value={depth}    onChange={setDepth}    defaultValue={0.5} />
            <MoogKnob label="MOD"   size="sm" value={modDepth} onChange={setModDepth} defaultValue={0.0} />
          </div>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleWave} title="Click to cycle waveform">
              <span className={styles.selectorLabel}>WAVE</span>
              <span className={styles.selectorValue}>{LFO_WAVE_LABELS[waveType]}</span>
            </div>
            <ToggleSwitch labels={['FREE', 'SYNC']} />
          </div>
          <PlateDivider />
          {/* Inputs (SYNC deferred, FM rate-mod CV) + waveform tap outputs on one row */}
          <div className={styles.jackRow}>
            <Jack id={`${p}-sync`} label="SYNC" />
            <Jack id={`${p}-fm`}   label="FM" />
            <Jack id={`${p}-sin`}  label="SIN" />
            <Jack id={`${p}-tri`}  label="TRI" />
            <Jack id={`${p}-sqr`}  label="SQR" />
            <Jack id={`${p}-saw`}  label="SAW" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Reverb "Aura" display (Phase 56) ───
// Rectangular OLED screen beside the IN/OUT jacks: a rotating ice-blue
// wireframe (gridded) sphere. Sphere radius tracks the MIX (wet) knob;
// rotation speed and per-vertex shimmer track ROOM size + live FFT energy
// from the reverb-OUTPUT analyser (so it keeps moving through the tail).
// All animation is canvas-writes inside rAF — Zero-Re-render Rule; the loop
// skips all work while the Moog page is display:none.
const AURA_W = 200, AURA_H = 120; // canvas backing px (100×60 CSS @2x for zoom crispness)
const SPH_MERIDIANS = 6;   // vertical great circles
const SPH_PARALLELS = 5;   // horizontal rings
const SPH_SEGS      = 28;  // segments per circle

function AuraDisplay({ getData, wetRef, roomRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cx = AURA_W / 2, cy = AURA_H / 2;
    let raf;
    let energySm = 0; // smoothed FFT energy so the sphere breathes instead of flickering
    let angle    = 0; // integrated spin angle — rad. Accumulated per frame so a MIX
    let lastT    = performance.now() * 0.001; // change alters speed smoothly (t×speed would snap)

    const lerp = (a, b, k) => a + (b - a) * k;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = performance.now() * 0.001;
      if (canvas.offsetParent === null) { lastT = t; return; } // Root keeps hidden pages mounted
      const dt = Math.min(0.1, t - lastT); // clamp long-gap deltas (tab return)
      lastT = t;
      const data = getData?.(); // Float32Array of dB values, or null when unpowered

      let energy = 0;
      if (data && data.length) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.max(0, (data[i] + 80) / 80);
        energy = Math.min(1, (sum / data.length) * 2.2);
      }
      energySm += (energy - energySm) * 0.15;

      const wet  = wetRef.current;
      const room = roomRef.current;
      const R      = (AURA_H / 2) * (0.34 + room * 0.56);           // ROOM → sphere radius
      const jitter = 0.02 + energySm * 0.16;                        // signal → vertex shiver
      angle += dt * (0.25 + wet * 2.2 + energySm * 1.2);            // MIX + signal → spin rate
      const act    = Math.min(1, wet * 0.35 + energySm * 0.75);     // color activity

      // Dim deep blue idle → vibrant sky blue → toward white when hot
      const cr = Math.round(lerp(46,  150, act));
      const cg = Math.round(lerp(80,  205, act));
      const cb = Math.round(lerp(190, 255, act));

      // Rotation: spin around Y, then a fixed axis tilt so the pole is visible
      const sy = Math.sin(angle), cyr = Math.cos(angle);
      const st = Math.sin(0.42), ct = Math.cos(0.42);

      // Unit-sphere point → [screenX, screenY, depth]. binIdx picks an FFT bin
      // for radial vertex jitter (shimmer follows the actual spectrum).
      const project = (x, y, z, binIdx) => {
        let r = 1;
        if (data && data.length) {
          const b = Math.max(0, (data[binIdx % data.length] + 80) / 80);
          r = 1 + jitter * (b * 1.6 - 0.4);
        } else {
          r = 1 + jitter * 0.4 * Math.sin(t * 2.4 + binIdx * 0.9);
        }
        x *= r; y *= r; z *= r;
        const x1 = x * cyr - z * sy;
        const z1 = x * sy + z * cyr;
        const y1 = y * ct - z1 * st;
        const z2 = y * st + z1 * ct;
        const s = 1 / (1 + z2 * 0.28); // mild perspective
        return [cx + x1 * R * s, cy + y1 * R * s, z2];
      };

      ctx.clearRect(0, 0, AURA_W, AURA_H);

      // Interior haze — frosted glow behind the wireframe
      const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
      haze.addColorStop(0,    `rgba(${cr},${cg},${cb},${0.14 + act * 0.20})`);
      haze.addColorStop(0.72, `rgba(${cr},${cg},${cb},${0.04 + act * 0.09})`);
      haze.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, AURA_W, AURA_H);

      // Per-segment stroke with depth-based alpha: back-side lines fade so the
      // grid reads as a 3D sphere, front lines glow bright.
      ctx.lineCap = 'round';
      const seg = (p0, p1) => {
        const depth = (p0[2] + p1[2]) / 2;              // [-1 front … +1 back]
        const front = Math.max(0, Math.min(1, 0.5 - depth * 0.5));
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.06 + front * (0.28 + act * 0.55)})`;
        ctx.lineWidth = 1 + front * 1.4;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
      };

      // Meridians — great circles through the poles
      for (let j = 0; j < SPH_MERIDIANS; j++) {
        const phi = (j / SPH_MERIDIANS) * Math.PI;
        const cp = Math.cos(phi), sp = Math.sin(phi);
        let prev = null;
        for (let i = 0; i <= SPH_SEGS; i++) {
          const u = (i / SPH_SEGS) * Math.PI * 2;
          const su = Math.sin(u);
          const p = project(su * cp, Math.cos(u), su * sp, j * SPH_SEGS + i);
          if (prev) seg(prev, p);
          prev = p;
        }
      }
      // Parallels — latitude rings
      for (let k = 1; k <= SPH_PARALLELS; k++) {
        const th = (k / (SPH_PARALLELS + 1)) * Math.PI;
        const sth = Math.sin(th), cth = Math.cos(th);
        let prev = null;
        for (let i = 0; i <= SPH_SEGS; i++) {
          const u = (i / SPH_SEGS) * Math.PI * 2;
          const p = project(sth * Math.cos(u), cth, sth * Math.sin(u), (k + 7) * SPH_SEGS + i);
          if (prev) seg(prev, p);
          prev = p;
        }
      }
    };

    tick();
    return () => cancelAnimationFrame(raf);
  }, [getData, wetRef, roomRef]);

  return (
    <div className={styles.auraScreen}>
      <canvas ref={canvasRef} width={AURA_W} height={AURA_H} className={styles.auraCanvas} />
    </div>
  );
}

// onParamUpdate({ roomSize, wet }) wires ROOM and MIX knobs to n.reverb.
// wet=0 on mount so the module is transparent until the user raises MIX.
// getAuraData() — stable FFT getter (pre-bound in MoogShell) for the Aura display.
function ReverbModule({ onParamUpdate, getAuraData, number = 1 }) {
  const [roomSize, setRoomSize] = useState(0.7);
  const [wet,      setWet]      = useState(0.0);
  const p = number === 1 ? 'reverb' : `reverb${number}`;

  // Ref mirrors for the Aura rAF loop — the loop reads these each frame so it
  // never stale-captures knob state and never restarts on knob changes.
  const wetRef  = useRef(wet);
  const roomRef = useRef(roomSize);
  useEffect(() => { wetRef.current = wet; roomRef.current = roomSize; }, [wet, roomSize]);

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ roomSize, wet });
  }, [roomSize, wet, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>REV</span>
            <span className={styles.plateSub}>STUDIO REVERB — FREEVERB DIFFUSION</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="ROOM" size="md" value={roomSize} onChange={setRoomSize} defaultValue={0.7} />
            <MoogKnob label="MIX"  size="md" value={wet}      onChange={setWet}      defaultValue={0.0} />
          </div>
          <PlateDivider />
          {/* Bottom row: jacks left, Aura screen filling the empty space to their
              right — screen bottom-aligns with the jack sockets */}
          <div className={styles.revBottomRow}>
            <div className={styles.jackRow}>
              <Jack id={`${p}-in`}  label="IN" />
              <Jack id={`${p}-out`} label="OUT" />
            </div>
            <AuraDisplay getData={getAuraData} wetRef={wetRef} roomRef={roomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ gain }) wires the GAIN knob to n.vca.gain.
// GAIN is the initial/bias level (0=closed, 1=fully open).
// Set GAIN=0 and patch an envelope to vca-cv for full gating behavior.
// ENV AMT knob is visual-only this phase.
function VcaModule({ onParamUpdate, number = 1 }) {
  const [gain, setGain]     = useState(0.5);
  const [envAmt, setEnvAmt] = useState(1.0); // visual only
  const p = number === 1 ? 'vca' : `vca${number}`;

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ gain });
  }, [gain, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VCA</span>
            <span className={styles.plateSub}>VOLTAGE CONTROLLED AMP</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="GAIN"    size="lg" value={gain}   onChange={setGain}   defaultValue={0.5} />
            <MoogKnob label="ENV AMT" size="md" value={envAmt} onChange={setEnvAmt} defaultValue={1.0} />
            <ToggleSwitch labels={['LOG', 'LIN']} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}  label="IN" />
            <Jack id={`${p}-cv`}  label="CV" />
            <Jack id={`${p}-out`} label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// label ("ENV 1" / "ENV 2") drives the title and jack IDs.
// onParamUpdate(envId, { attack, decay, sustain, release }) wires knobs to the audio engine.
// onGate(envId, isDown) fires triggerAttack / triggerRelease on the Tone.Envelope.
// getLedValue() — stable getter (pre-bound in MoogShell) for this envelope's level meter.
// All knob values are normalized 0–1; useMoogAudio applies the exponential time mapping.
function EnvelopeModule({ label, onParamUpdate, onGate, getLedValue }) {
  const [attack,  setAttack]  = useState(0.1);
  const [decay,   setDecay]   = useState(0.3);
  const [sustain, setSustain] = useState(0.7);
  const [release, setRelease] = useState(0.4);

  const envId = label.toLowerCase().replace(/\s+/g, ''); // "env1" or "env2"

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate(envId, { attack, decay, sustain, release });
  }, [attack, decay, sustain, release, envId, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>{label}</span>
            <span className={styles.plateSub}>ATTACK · DECAY · SUSTAIN · RELEASE</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="A" size="md" value={attack}  onChange={setAttack}  defaultValue={0.1} />
            <MoogKnob label="D" size="md" value={decay}   onChange={setDecay}   defaultValue={0.3} />
            <MoogKnob label="S" size="md" value={sustain} onChange={setSustain} defaultValue={0.7} />
            <MoogKnob label="R" size="md" value={release} onChange={setRelease} defaultValue={0.4} />
          </div>
          <div className={styles.gateBtnRow}>
            <Led getValue={getLedValue} color="green" />
            <span className={styles.gateBtnLabel}>GATE</span>
            <button
              className={styles.gateBtn}
              onMouseDown={() => onGate?.(envId, true)}
              onMouseUp={() => onGate?.(envId, false)}
              onMouseLeave={() => onGate?.(envId, false)}
            />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${envId}-gate`} label="GATE" />
            <Jack id={`${envId}-trig`} label="TRIG" />
            <Jack id={`${envId}-out`}  label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}


// Stable zero-value getter used as a fallback for LEDs when no meter is wired.
// Module-level constant so its reference never changes — Led's useEffect won't restart.
const ZERO_GETTER = () => 0;

// ──────────── Module library (Phase 59) ────────────
// Fixed inventory: every module's audio nodes exist statically in useMoogAudio;
// "removing" a module hides its faceplate behind a blank panel (grid templates
// untouched — no reflow) and strips its patch cables. jacks = jack-id prefixes
// owned by the module (used for cable cleanup; chosen so e.g. 'vca-' cannot
// match 'vca2-…'). I/O (power) and the 953 keyboard are not removable.
const MODULE_REGISTRY = [
  { key: 'vco1',     label: 'VCO 1',    group: 'VOICE CASE', jacks: ['vco1-'] },
  { key: 'vco2',     label: 'VCO 2',    group: 'VOICE CASE', jacks: ['vco2-'] },
  { key: 'vco3',     label: 'VCO 3',    group: 'VOICE CASE', jacks: ['vco3-'] },
  { key: 'vco4',     label: 'VCO 4',    group: 'VOICE CASE', jacks: ['vco4-'] },
  { key: 'vco5',     label: 'VCO 5',    group: 'VOICE CASE', jacks: ['vco5-'] },
  { key: 'noise1',   label: 'NOISE 1',  group: 'VOICE CASE', jacks: ['noise-'] },
  { key: 'noise2',   label: 'NOISE 2',  group: 'VOICE CASE', jacks: ['noise2-'] },
  { key: 'noise3',   label: 'NOISE 3',  group: 'VOICE CASE', jacks: ['noise3-'] },
  { key: 'vcf1',     label: 'VCF 1',    group: 'VOICE CASE', jacks: ['vcf-'] },
  { key: 'vcf2',     label: 'VCF 2',    group: 'VOICE CASE', jacks: ['vcf2-'] },
  { key: 'lfo1',     label: 'LFO 1',    group: 'VOICE CASE', jacks: ['lfo-'] },
  { key: 'lfo2',     label: 'LFO 2',    group: 'VOICE CASE', jacks: ['lfo2-'] },
  { key: 'rev1',     label: 'REV 1',    group: 'VOICE CASE', jacks: ['reverb-'] },
  { key: 'rev2',     label: 'REV 2',    group: 'VOICE CASE', jacks: ['reverb2-'] },
  { key: 'bbd',      label: 'BBD',      group: 'VOICE CASE', jacks: ['chorus-'] },
  { key: 'ffb',      label: '914 FFB',  group: 'VOICE CASE', jacks: ['ffb-'] },
  { key: 'vca1',     label: 'VCA 1',    group: 'PERCUSSION & FX CASE', jacks: ['vca-'] },
  { key: 'vca2',     label: 'VCA 2',    group: 'PERCUSSION & FX CASE', jacks: ['vca2-'] },
  { key: 'vca3',     label: 'VCA 3',    group: 'PERCUSSION & FX CASE', jacks: ['vca3-'] },
  { key: 'env1',     label: 'ENV 1',    group: 'PERCUSSION & FX CASE', jacks: ['env1-'] },
  { key: 'env2',     label: 'ENV 2',    group: 'PERCUSSION & FX CASE', jacks: ['env2-'] },
  { key: 'env3',     label: 'ENV 3',    group: 'PERCUSSION & FX CASE', jacks: ['env3-'] },
  { key: 'kick',     label: 'KICK',     group: 'PERCUSSION & FX CASE', jacks: ['kick-'] },
  { key: 'vocoder',  label: 'VOCODER',  group: 'PERCUSSION & FX CASE', jacks: ['voc-'] },
  { key: 'seq1',     label: '960 SEQ 1', group: 'SEQUENCER CASE', jacks: ['seq-'] },
  { key: 'seq2',     label: '960 SEQ 2', group: 'SEQUENCER CASE', jacks: ['seq2-'] },
  { key: 'chordseq', label: 'CHORD SEQ', group: 'SEQUENCER CASE', jacks: ['chordseq-'] },
  { key: 'qnt',      label: 'QNT',       group: 'SEQUENCER CASE', jacks: ['qnt-'] },
];
const REGISTRY_GROUPS = ['VOICE CASE', 'PERCUSSION & FX CASE', 'SEQUENCER CASE'];

// Blank panel — rendered in a hidden module's grid cell so tier templates and
// row heights stay untouched (no fit() reflow; see Phase 55 oscillation trap).
function BlankPanel() {
  return (
    <div className={`${styles.module} ${styles.moduleBlank}`}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.blankContent}>
          <span className={styles.blankLabel}>MOOG</span>
          <span className={styles.blankSub}>BLANK PANEL</span>
        </div>
      </div>
    </div>
  );
}

// Dynamic instance types available from the bank (Phase 60b/60c).
// width = expansion-row slot px, matched to each type's static tier column at
// FLOOR_LAYOUT_W so added modules render the same size as their static siblings.
const DYN_TYPES = [
  { type: 'vco',   label: '+ VCO',    max: 10, width: 435 },
  { type: 'noise', label: '+ NOISE',  max: 8,  width: 262 },
  { type: 'vcf',   label: '+ VCF',    max: 8,  width: 460 },
  { type: 'lfo',   label: '+ LFO',    max: 8,  width: 370 },
  { type: 'vca',   label: '+ VCA',    max: 8,  width: 300 },
  { type: 'env',   label: '+ ENV',    max: 8,  width: 360 },
  { type: 'rev',   label: '+ REV',    max: 8,  width: 260 },
  { type: 'bbd',   label: '+ BBD',    max: 8,  width: 280 },
  { type: 'kick',  label: '+ KICK',   max: 8,  width: 360 },
  { type: 'ffb',   label: '+ 914',    max: 4,  width: 526 },
  { type: 'seq',   label: '+ 960',    max: 4,  width: 737 },
  { type: 'chordseq', label: '+ CHORD', max: 4, width: 491 },
  { type: 'voc',   label: '+ VOCODER', max: 2,  width: 586 },
  { type: 'qnt',   label: '+ QNT',    max: 4,  width: 442 },
];
const DYN_WIDTH = Object.fromEntries(DYN_TYPES.map(t => [t.type, t.width]));

// ── Rack store (Phase 60f) ── one localStorage record for the whole custom
// rack: { modules: [{ id, type, num }], cables: [{ from, to, color }] }.
// Writes happen ONLY from user event handlers / user-driven provider callbacks
// (the Phase 60c StrictMode wipe lesson). v1 (types only, no cables) migrates
// transparently on read.
const RACK_STORE_KEY = 'moog-rack-v2';
function readRackStore() {
  try {
    const v2 = JSON.parse(localStorage.getItem(RACK_STORE_KEY) ?? 'null');
    if (v2) return { modules: v2.modules ?? [], cables: v2.cables ?? [] };
    const v1 = JSON.parse(localStorage.getItem('moog-rack-dyn-v1') ?? 'null');
    if (v1) return { modules: v1.modules ?? [], cables: [] }; // v1: types only → ids re-mint
  } catch (_) {}
  return { modules: [], cables: [] };
}
function updateRackStore(patch) {
  try {
    localStorage.setItem(RACK_STORE_KEY, JSON.stringify({ ...readRackStore(), ...patch }));
  } catch (_) {}
}

// Restores persisted cables once the dynamic instances are live (Phase 60f),
// then re-fires the audio bridge on a short retry schedule. The retries are
// idempotent (connect() dedupes committed keys) and cover two gaps:
// 1. worklet-deferred jacks (qnt cv-in) whose dest is null until the async
//    worklet module loads;
// 2. the StrictMode double-mount, where this child's effect re-runs BEFORE the
//    parent's engine-rebuild effect — the immediate pass no-ops against the
//    disposed engine and the retries land on the fresh one.
function CableRestorer({ ready, audioConnect }) {
  const { cables, restoreCables } = useMoogPatch();
  const cablesLiveRef = useRef(cables);
  cablesLiveRef.current = cables;

  useEffect(() => {
    if (!ready) return;
    const rebridge = () =>
      cablesLiveRef.current.forEach(c => audioConnect(c.fromJackId, c.toJackId));
    if (cablesLiveRef.current.length === 0) {
      restoreCables(readRackStore().cables); // validates jacks, draws, bridges
    } else {
      rebridge(); // StrictMode remount: visuals survived, the rebuilt engine didn't
    }
    const t1 = setTimeout(rebridge, 800);
    const t2 = setTimeout(rebridge, 2500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ready, audioConnect, restoreCables]);

  return null;
}

// Library modal — browse the fixed inventory, install/remove modules, and add
// new dynamic instances (Phase 60b). Lives inside MoogPatchProvider so removal
// can strip the module's cables (removeCable fires the audio-bridge disconnect).
function LibraryModal({ open, onClose, hidden, onToggle, dynModules, onAddInstance, onRemoveInstance }) {
  const { cables, removeCable } = useMoogPatch();
  if (!open) return null;

  const stripCables = (prefixes) => {
    cables
      .filter(c => prefixes.some(p => c.fromJackId.startsWith(p) || c.toJackId.startsWith(p)))
      .forEach(c => removeCable(c.id));
  };

  const handleToggle = (mod) => {
    if (!hidden.has(mod.key)) stripCables(mod.jacks);
    onToggle(mod.key);
  };

  const handleRemoveDyn = (inst) => {
    stripCables([`${inst.id}-`]); // strip first — never dispose a patched node
    onRemoveInstance(inst.id);
  };

  return (
    <div className={styles.libOverlay} onClick={onClose}>
      <div className={styles.libPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.libHeader}>
          <span className={styles.libTitle}>MODULE LIBRARY</span>
          <button className={styles.libClose} onClick={onClose}>✕</button>
        </div>
        {REGISTRY_GROUPS.map(group => (
          <div key={group} className={styles.libGroup}>
            <span className={styles.libGroupLabel}>{group}</span>
            <div className={styles.libGrid}>
              {MODULE_REGISTRY.filter(m => m.group === group).map(mod => {
                const installed = !hidden.has(mod.key);
                return (
                  <button
                    key={mod.key}
                    className={`${styles.libItem} ${installed ? styles.libItemOn : ''}`}
                    onClick={() => handleToggle(mod)}
                    title={installed ? 'Remove — cables to this module are unpatched' : 'Install'}
                  >
                    <span className={styles.libItemDot} />
                    {mod.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className={styles.libGroup}>
          <span className={styles.libGroupLabel}>EXPANSION — ADD INSTANCES</span>
          <div className={styles.libGrid}>
            {DYN_TYPES.map(t => {
              const count = dynModules.filter(m => m.type === t.type).length;
              const full  = count >= t.max;
              return (
                <button
                  key={t.type}
                  className={`${styles.libItem} ${styles.libItemAdd}`}
                  disabled={full}
                  onClick={() => onAddInstance(t.type)}
                  title={full ? `Instance cap reached (${t.max})` : 'Add a new instance to the expansion row'}
                >
                  {t.label}{full ? ' — FULL' : ''}
                </button>
              );
            })}
            {dynModules.map(inst => (
              <button
                key={inst.id}
                className={`${styles.libItem} ${styles.libItemOn}`}
                onClick={() => handleRemoveDyn(inst)}
                title="Remove this instance — cables are unpatched, audio nodes disposed"
              >
                <span className={styles.libItemDot} />
                {inst.type.toUpperCase()} {inst.num} ✕
              </button>
            ))}
          </div>
        </div>
        <div className={styles.libFootnote}>
          removed modules leave a blank panel · their cables are unpatched · I/O and keyboard are fixed
        </div>
      </div>
    </div>
  );
}

// I/O module — oscilloscope, POWER, MASTER VOL, 4-channel mixer input, and legacy io-in.
// getOscData()    — stable getter for oscilloscope waveform data.
// getLedValue()   — stable getter for master level meter (PEAK LED).
// getChLevels     — array of 4 stable getters for per-channel activity LEDs.
// onChannelVolChange(channelIndex, value) — single writer for ioCh1–ioCh4.gain.
function IoModule({ isPowered, onPower, onParamUpdate, getOscData, getLedValue, getChLevels, onChannelVolChange }) {
  const [masterVol, setMasterVol] = useState(0.7);
  const [chVols, setChVols] = useState([0.8, 0.8, 0.8, 0.8]);

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ volume: masterVol });
  }, [masterVol, onParamUpdate]);

  useEffect(() => {
    if (!onChannelVolChange) return;
    chVols.forEach((v, i) => onChannelVolChange(i + 1, v));
  }, [chVols, onChannelVolChange]);

  const handleChVol = (i, v) =>
    setChVols(prev => { const next = [...prev]; next[i] = v; return next; });

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>I/O</span>
            <span className={styles.plateSub}>4-CH MIXER · OUTPUT · POWER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <Oscilloscope getData={getOscData} />
          {/* Power + master share one row; channels sit 4-across with the legacy
              jack as a 5th column — halves the module height vs stacked rows
              (Phase 54: I/O was the row-4 height driver after the seq de-stack). */}
          <div className={styles.knobRow}>
            <PowerSwitch isPowered={isPowered} onToggle={onPower} />
            <div className={`${styles.powerLamp} ${isPowered ? styles.powerLampOn : ''}`} />
            <MoogKnob
              label="MASTER"
              size="lg"
              value={masterVol}
              onChange={setMasterVol}
              defaultValue={0.7}
            />
            <Led getValue={getLedValue} color="red" label="PEAK" />
          </div>
          <PlateDivider />
          <div className={styles.ioChGrid}>
            {[1, 2, 3, 4].map((ch, i) => (
              <div key={ch} className={styles.ioChCol}>
                <Led getValue={getChLevels?.[i] ?? ZERO_GETTER} color="green" />
                <MoogKnob
                  label={`CH ${ch}`}
                  size="sm"
                  value={chVols[i]}
                  onChange={v => handleChVol(i, v)}
                  defaultValue={0.8}
                />
                <Jack id={`io-in${ch}`} label={`IN ${ch}`} />
              </div>
            ))}
            <div className={styles.ioChCol}>
              <div className={styles.ioChColSpacer} />
              <Jack id="io-in" label="IN ✦" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Musical CV Quantizer ────────────

const SCALE_KEYS   = ['CHR', 'MAJ', 'MIN', 'PMAJ', 'PMIN'];
const SCALE_LABELS = { CHR: 'CHROMATIC', MAJ: 'MAJOR', MIN: 'MINOR', PMAJ: 'PENT MAJ', PMIN: 'PENT MIN' };
const ROOT_NAMES   = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// true = chromatic black key (accidental) — used for LED coloring
const IS_BLACK_KEY = [false,true,false,true,false,false,true,false,true,false,true,false];
const OCT_STEPS    = [-3, -2, -1, 0, 1, 2, 3];

// onParamUpdate({ scale, root, octShift, bypass }) — sends config to the AudioWorklet.
// onSetCallback(fn|null)   — registers/deregisters the note-class LED callback.
// getTransposeData()       — returns Float32Array from the TRANSPOSE CV analyser.
//                            avgAbsValue > 10 → cable connected; value → note class.
//                            When active, overrides the ROOT knob in the worklet.
// chordMapRef              — React ref owned by MoogShell; points to the chord type span
//                            in the EXT row. The chord callback writes the type label here.
// LED array is 12 DOM nodes mutated directly (Zero-Re-render Rule).
function QuantizerModule({ number = 1, onParamUpdate, onSetCallback, getTransposeData, chordMapRef }) {
  const p = number === 1 ? 'qnt' : `qnt${number}`; // jack prefix = engine instance id
  const [scale,    setScale]    = useState('MAJ');
  const [root,     setRoot]     = useState(0);   // 0 = C
  const [octShift, setOctShift] = useState(0);   // −3 to +3 octaves
  const [bypass,   setBypass]   = useState(false);

  const ledRefs    = useRef([]);   // 12 LED DOM elements
  const activeLed  = useRef(-1);   // currently lit LED index
  const displayRef = useRef(null); // note name + Hz text element
  const inLedRef   = useRef(null); // IN presence LED

  // Transposition CV state
  const transposeActiveRef   = useRef(false); // true when EXT cable is detected
  const rootRef              = useRef(0);     // always-current knob root for rAF closure
  const lastExtNoteClassRef  = useRef(-1);    // delta check — avoids spamming worklet
  const extLedRef            = useRef(null);
  const extRootRef           = useRef(null);  // EXT ROOT note name text
  const extRowRef            = useRef(null);  // EXT status row (show/hide)

  // Keep rootRef in sync with knob state (safe for rAF closure reads)
  useEffect(() => { rootRef.current = root; }, [root]);

  // Send worklet params. When EXT transpose is active, skip root so the rAF loop owns it.
  useEffect(() => {
    if (!onParamUpdate) return;
    if (transposeActiveRef.current) {
      onParamUpdate({ scale, octShift, bypass });
    } else {
      onParamUpdate({ scale, root, octShift, bypass });
    }
  }, [scale, root, octShift, bypass, onParamUpdate]);

  // rAF loop: reads TRANSPOSE CV analyser, derives note class, overrides worklet root.
  // avgAbsValue of waveform samples = DC level = Hz from the patched chordSeqPitchOut.
  // Threshold 10 Hz cleanly separates "no cable" (0) from "connected" (32+ Hz minimum).
  useEffect(() => {
    if (!getTransposeData) return;
    let rafId;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const data = getTransposeData();
      if (!data || !data.length) return;

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
      const avgHz   = sum / data.length;
      const isActive = avgHz > 10;
      const wasActive = transposeActiveRef.current;

      if (wasActive && !isActive) {
        // Cable removed — restore knob root, hide EXT row
        transposeActiveRef.current = false;
        lastExtNoteClassRef.current = -1;
        if (extRowRef.current)  extRowRef.current.style.display  = 'none';
        if (extLedRef.current) {
          extLedRef.current.style.background = 'rgba(93,202,165,0.12)';
          extLedRef.current.style.boxShadow  = 'none';
        }
        onParamUpdate?.({ root: rootRef.current });
      }

      if (!wasActive && isActive) {
        // Cable connected — show EXT row
        transposeActiveRef.current = true;
        if (extRowRef.current) extRowRef.current.style.display = 'flex';
        if (extLedRef.current) {
          extLedRef.current.style.background = '#5DCAA5';
          extLedRef.current.style.boxShadow  = '0 0 4px #5DCAA5';
        }
      }

      if (isActive) {
        const midi      = 69 + 12 * Math.log2(Math.max(0.001, avgHz) / 440);
        const noteClass = ((Math.round(midi) % 12) + 12) % 12;
        if (noteClass !== lastExtNoteClassRef.current) {
          lastExtNoteClassRef.current = noteClass;
          onParamUpdate?.({ root: noteClass });
          if (extRootRef.current) extRootRef.current.textContent = ROOT_NAMES[noteClass];
        }
      }
    };
    tick();
    return () => cancelAnimationFrame(rafId);
  }, [getTransposeData, onParamUpdate]);

  useEffect(() => {
    // Callback signature: (noteClass: 0–11 | null, midiNote: int | null, hasSignal: bool | undefined)
    // noteClass===null → signal-state-only message; skip LED/display updates.
    onSetCallback?.((noteClass, midiNote, hasSignal) => {
      // IN LED: lights when a cable is connected and the source is active.
      if (hasSignal !== undefined && inLedRef.current) {
        inLedRef.current.style.background = hasSignal
          ? '#5DCAA5' : 'rgba(93,202,165,0.15)';
        inLedRef.current.style.boxShadow  = hasSignal
          ? '0 0 4px #5DCAA5' : 'none';
      }
      if (noteClass === null) return; // signal-state-only — nothing else to update

      // Dim the previously active note LED
      if (activeLed.current >= 0 && ledRefs.current[activeLed.current]) {
        const prev = ledRefs.current[activeLed.current];
        prev.style.background = IS_BLACK_KEY[activeLed.current]
          ? 'rgba(93,202,165,0.07)'
          : 'rgba(93,202,165,0.12)';
        prev.style.boxShadow = 'none';
      }
      // Light the new note LED
      if (noteClass >= 0 && noteClass < 12 && ledRefs.current[noteClass]) {
        const el = ledRefs.current[noteClass];
        el.style.background = '#5DCAA5';
        el.style.boxShadow  = '0 0 5px #5DCAA5, 0 0 2px rgba(93,202,165,0.9)';
        activeLed.current = noteClass;
      }
      // Update Hz/note display. In BYPASS mode the display reflects the raw input pitch.
      if (displayRef.current && midiNote !== undefined) {
        const hz     = (440 * Math.pow(2, (midiNote - 69) / 12)).toFixed(1);
        const octave = Math.floor(midiNote / 12) - 1;
        displayRef.current.textContent = `${ROOT_NAMES[noteClass]}${octave}  ${hz} Hz`;
      }
    });
    return () => onSetCallback?.(null);
  }, [onSetCallback]);

  const cycleScale  = () =>
    setScale(prev => SCALE_KEYS[(SCALE_KEYS.indexOf(prev) + 1) % SCALE_KEYS.length]);
  const cycleRoot   = () =>
    setRoot(prev => (prev + 1) % 12);
  const cycleOct    = () =>
    setOctShift(prev => OCT_STEPS[(OCT_STEPS.indexOf(prev) + 1) % OCT_STEPS.length]);
  const toggleBypass = () =>
    setBypass(prev => !prev);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>QNT</span>
            <span className={styles.plateSub}>CV QUANTIZER · SCALE LOCK</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          {/* 12-LED chromatic display — one per semitone, lit on note output */}
          <div className={styles.qntLeds}>
            {ROOT_NAMES.map((name, i) => (
              <div key={i} className={styles.qntLedGroup}>
                <div
                  ref={el => { ledRefs.current[i] = el; }}
                  className={`${styles.qntLed} ${IS_BLACK_KEY[i] ? styles.qntLedBlack : ''}`}
                />
                <span className={styles.qntLedLabel}>{name}</span>
              </div>
            ))}
          </div>
          {/* IN/OUT signal monitor row */}
          <div className={styles.qntMonitorRow}>
            <div className={styles.qntMonitorItem}>
              <div ref={inLedRef} className={styles.qntInLed} />
              <span className={styles.qntMonitorLabel}>IN</span>
            </div>
            {/* Note name + Hz display — written directly via DOM ref (no React state) */}
            <div ref={displayRef} className={styles.qntDisplay}>--</div>
          </div>
          {/* EXT transpose status — DOM-mutated by rAF (root) and chord callback (type) */}
          <div ref={extRowRef} className={styles.qntExtRow}>
            <div ref={extLedRef} className={styles.qntExtLed} />
            <span className={styles.qntExtLabel}>EXT</span>
            <span ref={extRootRef} className={styles.qntExtDisplay} />
            <span ref={chordMapRef} className={styles.qntExtChordType} />
          </div>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleScale} title="Click to cycle scale">
              <span className={styles.selectorLabel}>SCALE</span>
              <span className={styles.selectorValue}>{SCALE_LABELS[scale]}</span>
            </div>
            <div className={styles.selectorGroup} onClick={cycleRoot} title="Click to cycle root note">
              <span className={styles.selectorLabel}>ROOT</span>
              <span className={styles.selectorValue}>{ROOT_NAMES[root]}</span>
            </div>
            <div className={styles.selectorGroup} onClick={cycleOct} title="Click to shift output by ±1 octave">
              <span className={styles.selectorLabel}>OCT</span>
              <span className={styles.selectorValue}>{octShift > 0 ? `+${octShift}` : String(octShift)}</span>
            </div>
          </div>
          <div className={styles.selectorRow}>
            <div
              className={styles.selectorGroup}
              onClick={toggleBypass}
              title="BYPASS: passes CV input directly to output — use to confirm cables without quantizing"
            >
              <span className={styles.selectorLabel}>BYPASS</span>
              <span className={styles.selectorValue} style={{ color: bypass ? '#ff9040' : undefined }}>
                {bypass ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-cv-in`}        label="CV IN" />
            <Jack id={`${p}-cv-out`}       label="OUT" />
            <Jack id={`${p}-transpose-in`} label="TRP" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Chord Sequencer ────────────

const CHORD_DIVS   = ['2n', '1m', '2m', '4m'];
const CHORD_LABELS = { '2n': '½ BAR', '1m': '1 BAR', '2m': '2 BAR', '4m': '4 BAR' };

// Chord types mirror the CHORD_* entries added to SCALE_DEFS in useMoogAudio.js.
// When a step fires, its chordType is sent to updateQuantizerParams({ scale: chordType })
// so the quantizer snaps melody notes to chord tones instead of a diatonic scale.
const CHORD_TYPES = ['CMAJ', 'CMIN', 'CDOM', 'CMAJ7', 'CMIN7', 'CSUS4', 'CDIM'];
const CHORD_TYPE_LABELS = {
  CMAJ: 'MAJ', CMIN: 'min', CDOM: 'dom7',
  CMAJ7: 'maj7', CMIN7: 'min7', CSUS4: 'sus4', CDIM: 'dim',
};

// 8-step chord sequencer — each step stores { rootClass, chordType }.
// rootClass cycles through the 12 chromatic notes; chordType selects the chord quality.
// On step fire: chordseq-cv-out outputs root Hz AND chordSeqChordCallback syncs the quantizer.
const ROOT_OCT_STEPS  = [-3, -2, -1, 0, 1, 2, 3];
const ROOT_OCT_LABELS = { '-3': '-3', '-2': '-2', '-1': '-1', '0': '0', '1': '+1', '2': '+2', '3': '+3' };

function ChordSeqModule({ number = 1, onStepsChange, onDivisionChange, onSetCallback, onRootOctaveChange, onGlideChange }) {
  const p = number === 1 ? 'chordseq' : `chordseq${number}`; // jack prefix = engine instance id
  const [steps, setSteps] = useState(() =>
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i],
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }))
  );
  const [division,   setDivision]   = useState('1m');
  const [rootOctave, setRootOctave] = useState(0);
  const [glide,      setGlide]      = useState(0); // glide time in seconds (0–1.5)

  const ledRefs     = useRef([]);
  const prevStepRef = useRef(-1);

  useEffect(() => { onStepsChange?.(steps); },             [steps,       onStepsChange]);
  useEffect(() => { onDivisionChange?.(division); },       [division,    onDivisionChange]);
  useEffect(() => { onRootOctaveChange?.(rootOctave); },   [rootOctave,  onRootOctaveChange]);
  useEffect(() => { onGlideChange?.(glide); },             [glide,       onGlideChange]);

  // Map knob 0–1 to 0–1.5 s glide time (matches the 960/953 glide convention)
  const handleGlideKnob = (v) => setGlide(v * 1.5);

  useEffect(() => {
    onSetCallback?.((idx) => {
      const prev = prevStepRef.current;
      if (prev >= 0 && ledRefs.current[prev]) {
        ledRefs.current[prev].classList.remove(styles.seqLedActive);
      }
      if (idx >= 0) {
        if (ledRefs.current[idx]) ledRefs.current[idx].classList.add(styles.seqLedActive);
        prevStepRef.current = idx;
      } else {
        prevStepRef.current = -1;
      }
    });
    return () => {
      onSetCallback?.(null);
      const prev = prevStepRef.current;
      if (prev >= 0 && ledRefs.current[prev]) {
        ledRefs.current[prev].classList.remove(styles.seqLedActive);
      }
    };
  }, [onSetCallback]);

  const cycleDiv     = () =>
    setDivision(prev => CHORD_DIVS[(CHORD_DIVS.indexOf(prev) + 1) % CHORD_DIVS.length]);
  const cycleRootOct = () =>
    setRootOctave(prev => ROOT_OCT_STEPS[(ROOT_OCT_STEPS.indexOf(prev) + 1) % ROOT_OCT_STEPS.length]);

  const cycleRoot = (i) =>
    setSteps(prev => {
      const next = [...prev];
      next[i] = { ...next[i], rootClass: (next[i].rootClass + 1) % 12 };
      return next;
    });

  const cycleType = (i) =>
    setSteps(prev => {
      const next = [...prev];
      next[i] = {
        ...next[i],
        chordType: CHORD_TYPES[(CHORD_TYPES.indexOf(next[i].chordType) + 1) % CHORD_TYPES.length],
      };
      return next;
    });

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>CHORD</span>
            <span className={styles.plateSub}>CHORD SEQUENCER · 8-STEP EDITOR</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.chordSeqGrid}>
            {steps.map((step, i) => (
              <div key={i} className={styles.chordSeqStep}>
                <div
                  ref={el => { ledRefs.current[i] = el; }}
                  className={styles.seqLed}
                />
                <button
                  className={styles.chordSeqRoot}
                  onClick={() => cycleRoot(i)}
                  title="Click to cycle root note"
                >
                  {ROOT_NAMES[step.rootClass]}
                </button>
                <button
                  className={styles.chordSeqType}
                  onClick={() => cycleType(i)}
                  title="Click to cycle chord type"
                >
                  {CHORD_TYPE_LABELS[step.chordType]}
                </button>
              </div>
            ))}
          </div>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleDiv} title="Click to cycle clock division">
              <span className={styles.selectorLabel}>CLOCK DIV</span>
              <span className={styles.selectorValue}>{CHORD_LABELS[division]}</span>
            </div>
            <div className={styles.selectorGroup} onClick={cycleRootOct} title="Root note octave offset">
              <span className={styles.selectorLabel}>ROOT OCT</span>
              <span className={styles.selectorValue}>{ROOT_OCT_LABELS[String(rootOctave)]}</span>
            </div>
            <MoogKnob
              label="GLIDE"
              size="sm"
              value={glide / 1.5}
              onChange={handleGlideKnob}
              defaultValue={0}
            />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-cv-in`}    label="SEQ IN" />
            <Jack id={`${p}-cv-out`}   label="OUT" />
            <Jack id={`${p}-root-out`} label="ROOT" />
            <Jack id={`${p}-3rd-out`}  label="3RD" />
            <Jack id={`${p}-5th-out`}  label="5TH" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── 960 Sequential Controller ────────────
// onStepsChange(steps[]) — pushes step data to the audio engine ref (no re-render path).
// onTempoChange(bpm)     — ramps Tone.Transport.bpm.
// onSetCallback(fn|null) — registers/deregisters the step-advance LED callback.
// LEDs are driven by direct DOM classList mutation from inside Tone.Loop — zero React
// state writes in the audio hot path, consistent with the Zero-Re-render Rule.
function SequencerModule({ onStepsChange, onTempoChange, onSetCallback, onGlideChange, number = 1 }) {
  const p = number === 1 ? 'seq' : `seq${number}`;
  const [steps, setSteps] = useState(() =>
    Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 }))
  );
  const [tempo, setTempoState] = useState(120);
  const [glide, setGlide]       = useState(0);
  const ledRefs    = useRef([]);
  const prevStepRef = useRef(-1);

  useEffect(() => { onStepsChange?.(steps); }, [steps,  onStepsChange]);
  useEffect(() => { onTempoChange?.(tempo);  }, [tempo,  onTempoChange]);
  useEffect(() => { onGlideChange?.(glide);  }, [glide,  onGlideChange]);

  // Register DOM-mutation callback for LED animation.
  // The callback receives stepIndex (0–15) or -1 to clear all.
  useEffect(() => {
    onSetCallback?.((idx) => {
      const prev = prevStepRef.current;
      if (prev >= 0 && ledRefs.current[prev]) {
        ledRefs.current[prev].classList.remove(styles.seqLedActive);
      }
      if (idx >= 0) {
        if (ledRefs.current[idx]) ledRefs.current[idx].classList.add(styles.seqLedActive);
        prevStepRef.current = idx;
      } else {
        prevStepRef.current = -1;
      }
    });
    return () => {
      onSetCallback?.(null);
      // Clear active LED on unmount
      const prev = prevStepRef.current;
      if (prev >= 0 && ledRefs.current[prev]) {
        ledRefs.current[prev].classList.remove(styles.seqLedActive);
      }
    };
  }, [onSetCallback]);

  const updateStep = (i, field, value) =>
    setSteps(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });

  // Map knob 0–1 to BPM 20–300
  const handleTempoKnob = (v) => setTempoState(Math.round(20 + v * 280));
  // Map knob 0–1 to 0–1.5 s glide time
  const handleGlideKnob = (v) => setGlide(v * 1.5);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>960</span>
            <span className={styles.plateSub}>SEQUENTIAL CONTROLLER · 8-STEP PROGRAMMABLE SEQUENCER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.seqLayout}>

            {/* Left: tempo + glide knobs, BPM readout, patch jacks */}
            <div className={styles.seqCtrl}>
              <div className={styles.knobRow}>
                <MoogKnob
                  label="TEMPO"
                  size="lg"
                  value={(tempo - 20) / 280}
                  onChange={handleTempoKnob}
                  defaultValue={(120 - 20) / 280}
                />
                <MoogKnob
                  label="GLIDE"
                  size="sm"
                  value={glide / 1.5}
                  onChange={handleGlideKnob}
                  defaultValue={0}
                />
              </div>
              <div className={styles.seqBpmDisplay}>
                <span className={styles.selectorValue}>{tempo}</span>
              </div>
              <PlateDivider />
              <div className={styles.jackRow}>
                <Jack id={`${p}-pitch-out`} label="PITCH" />
                <Jack id={`${p}-gate-out`}  label="GATE" />
                <Jack id={`${p}-clk-in`}    label="CLK↓" />
                <Jack id={`${p}-clk-out`}   label="CLK↑" />
              </div>
            </div>

            {/* Right: 8 step columns */}
            <div className={styles.seqSteps}>
              {steps.map((step, i) => (
                <div key={i} className={styles.seqStep}>
                  <div
                    ref={el => { ledRefs.current[i] = el; }}
                    className={styles.seqLed}
                  />
                  <MoogKnob
                    label={String(i + 1)}
                    size="sm"
                    variant="cream"
                    value={step.voltage}
                    onChange={v => updateStep(i, 'voltage', v)}
                    defaultValue={0.5}
                  />
                  <button
                    className={`${styles.seqGateBtn} ${step.gate ? styles.seqGateOn : ''}`}
                    onClick={() => setSteps(prev => {
                      const next = [...prev];
                      next[i] = { ...next[i], gate: !next[i].gate };
                      return next;
                    })}
                  />
                  <input
                    type="range"
                    min="0" max="1" step="0.01"
                    value={step.prob}
                    className={styles.seqProbSlider}
                    onChange={e => updateStep(i, 'prob', parseFloat(e.target.value))}
                    title={`Step ${i + 1} probability: ${Math.round(step.prob * 100)}%`}
                  />
                </div>
              ))}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── BBD Chorus ────────────

// Rate LED pulses at the same frequency as the chorus LFO by reading rateHzRef
// in a stable getter closure — no React state writes in the rAF loop.
function ChorusModule({ onParamUpdate, number = 1 }) {
  const [rate,  setRate]  = useState(0.3);
  const [depth, setDepth] = useState(0.5);
  const [wet,   setWet]   = useState(0.0);
  const p = number === 1 ? 'chorus' : `chorus${number}`;

  const rateHzRef = useRef(0.1 * Math.pow(50, 0.3));

  useEffect(() => {
    rateHzRef.current = 0.1 * Math.pow(50, rate);
    onParamUpdate?.({ rate, depth, wet });
  }, [rate, depth, wet, onParamUpdate]);

  // Stable getter — reads ref each frame, never changes reference so Led's rAF never restarts.
  const getRateFlash = useCallback(() =>
    (Math.sin(Date.now() * 0.001 * rateHzRef.current * Math.PI * 2) + 1) / 2
  , []);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>BBD</span>
            <span className={styles.plateSub}>BUCKET BRIGADE CHORUS</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <Led getValue={getRateFlash} color="yellow" />
            <MoogKnob label="RATE"  size="md" value={rate}  onChange={setRate}  defaultValue={0.3} />
            <MoogKnob label="DEPTH" size="md" value={depth} onChange={setDepth} defaultValue={0.5} />
            <MoogKnob label="MIX"   size="md" value={wet}   onChange={setWet}   defaultValue={0.0} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}  label="IN" />
            <Jack id={`${p}-out`} label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Kick Drum ────────────

// onParamUpdate({ tune, pitchEnv, decay, click }) — wires knobs to useMoogAudio.
// onTrigger(onFlash) — fires the kick manually; onFlash() pulses the LED.
// onSetTrigCallback(fn) — registers the LED flash so the sequencer gate also pulses it.
function KickModule({ number = 1, onParamUpdate, onTrigger, onSetTrigCallback }) {
  const [tune,     setTune]     = useState(0.2);  // 0–1 → 40–200 Hz
  const [pitchEnv, setPitchEnv] = useState(0.7);  // 0–1 → 0–5 octaves drop
  const [decay,    setDecay]    = useState(0.35); // 0–1 → 0.05–2 s
  const [click,    setClick]    = useState(0.3);  // 0–1 gain

  const p = number === 1 ? 'kick' : `kick${number}`; // jack prefix = engine instance id

  const ledRef     = useRef(null);
  const flashTimer = useRef(null);

  // Register flash as the sequencer-gate LED callback so patching seq-gate-out →
  // kick-gate-in pulses the LED in sync with the sequencer clock.
  useEffect(() => {
    onSetTrigCallback?.(flash);
    return () => onSetTrigCallback?.(null);
  // flash is stable (refs only, no state captures) — eslint-disable-next-line
  }, [onSetTrigCallback]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onParamUpdate?.({
      tune:     40 * Math.pow(5, tune),        // 40 Hz → 200 Hz exponential
      pitchEnv: pitchEnv * 5,
      decay:    0.05 + decay * 1.95,
      click,
    });
  }, [tune, pitchEnv, decay, click, onParamUpdate]);

  const flash = () => {
    const el = ledRef.current;
    if (!el) return;
    el.style.opacity    = '1';
    el.style.boxShadow  = '0 0 8px rgba(220,40,20,0.95), 0 0 20px rgba(200,20,10,0.60)';
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      if (!ledRef.current) return;
      ledRef.current.style.opacity   = '0.12';
      ledRef.current.style.boxShadow = '';
    }, 80);
  };

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>KICK</span>
            <span className={styles.plateSub}>MEMBRANE DRUM SYNTHESIZER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="TUNE"  size="md" value={tune}     onChange={setTune}     defaultValue={0.2}  />
            <MoogKnob label="P.ENV" size="md" value={pitchEnv} onChange={setPitchEnv} defaultValue={0.7}  />
            <MoogKnob label="DECAY" size="md" value={decay}    onChange={setDecay}    defaultValue={0.35} />
            <MoogKnob label="CLICK" size="sm" value={click}    onChange={setClick}    defaultValue={0.3}  />
          </div>
          <div className={styles.gateBtnRow}>
            <div ref={ledRef} className={styles.kickLed} style={{ opacity: 0.12 }} />
            <span className={styles.gateBtnLabel}>TRIG</span>
            <button
              className={styles.gateBtn}
              onMouseDown={() => onTrigger?.(flash)}
            />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-gate-in`}  label="GATE" />
            <Jack id={`${p}-click-in`} label="ACCT" />
            <Jack id={`${p}-out`}      label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── 914 Fixed Filter Bank ────────────

// onParamUpdate({ bands: number[], master: number }) — wires sliders to useMoogAudio.
// getAnalyserData() — stable getter for the FFT input analyser; used to drive LEDs.
function FFBModule({ number = 1, onParamUpdate, getAnalyserData }) {
  const [bands,  setBands]  = useState(() => Array(FFB_BANDS.length).fill(0.75));
  const [master, setMaster] = useState(1.0);

  const p = number === 1 ? 'ffb' : `ffb${number}`; // jack prefix = engine instance id

  // DOM refs for per-band LEDs — written by rAF loop (Zero-Re-render Rule)
  const ledRefs = useRef([]);
  const rafRef  = useRef(null);

  useEffect(() => {
    onParamUpdate?.({ bands, master });
  }, [bands, master, onParamUpdate]);

  // rAF loop: reads FFT from input analyser, computes per-band peak, writes LED opacity.
  // FFT buffer is 512 → 256 bins, sampleRate/512 ≈ 86 Hz/bin. Maps dB (−∞ to 0) → 0–1.
  useEffect(() => {
    if (!getAnalyserData) return;
    const SAMPLE_RATE = 44100;
    const FFT_SIZE    = 512;
    const BIN_HZ      = SAMPLE_RATE / FFT_SIZE;

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      // Root keeps pages mounted display:none — purely visual loop, so skip
      // the analyser read + LED writes while the Moog page is hidden.
      if (ledRefs.current[0]?.offsetParent === null) return;
      const data = getAnalyserData();
      if (!data || !data.length) return;
      FFB_BANDS.forEach((band, i) => {
        const el = ledRefs.current[i];
        if (!el) return;
        // Bin range: one half-octave around center frequency
        const lo = Math.max(0, Math.floor(band.freq / (Math.SQRT2 * BIN_HZ)));
        const hi = Math.min(data.length - 1, Math.ceil(band.freq * Math.SQRT2 / BIN_HZ));
        let peak = -100;
        for (let b = lo; b <= hi; b++) if (data[b] > peak) peak = data[b];
        // Map −80 dB→0 to 0 dB→1; most musical material stays in −60 to −6 range
        const brightness = Math.max(0, Math.min(1, (peak + 80) / 80));
        el.style.opacity = String(0.08 + brightness * 0.92);
      });
    };
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [getAnalyserData]);

  const handleBand = (i, v) =>
    setBands(prev => { const next = [...prev]; next[i] = v; return next; });

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>914</span>
            <span className={styles.plateSub}>FIXED FILTER BANK</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.ffbBands}>
            {FFB_BANDS.map((band, i) => (
              <div key={i} className={styles.ffbBand}>
                <div ref={el => { ledRefs.current[i] = el; }} className={styles.ffbLed} />
                <MoogKnob
                  label={band.label}
                  size="sm"
                  value={bands[i]}
                  onChange={v => handleBand(i, v)}
                  defaultValue={0.75}
                />
              </div>
            ))}
            <div className={styles.ffbMasterDivider} />
            <div className={styles.ffbMasterCol}>
              <MoogKnob label="MSTR" size="sm" value={master / 1.5} onChange={v => setMaster(v * 1.5)} defaultValue={1 / 1.5} />
            </div>
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}  label="IN" />
            <Jack id={`${p}-out`} label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── 16-Band Vocoder ────────────

// onParamUpdate({ mix }) — wires the MIX knob to useMoogAudio.
// getAnalyserData() — stable getter for the modulator FFT analyser; drives the 16-seg meter.
// Patch MOD (modulator: voice/drum/sequence) + CARR (carrier: VCOs) in, take OUT to the mixer.
function VocoderModule({ number = 1, onParamUpdate, getAnalyserData, onMicEnable, onMicDisable, onMicGainChange, getMicLevel }) {
  const p = number === 1 ? 'voc' : `voc${number}`; // jack prefix = engine instance id
  const [micGain, setMicGain]       = useState(0.5);  // built-in mic input level
  const [micStatus, setMicStatus]   = useState('off'); // 'off' | 'connecting' | 'on' | 'error'
  const [mix, setMix]               = useState(1.0);
  const [volume, setVolume]         = useState(0.5);  // 0.5 = nominal (×3 internal makeup → 3×)
  const [carrierMix, setCarrierMix] = useState(0.0);  // 0 = external carrier only
  const [pwidth, setPwidth]         = useState(0.5);  // 0.5 = square
  const [shift, setShift]           = useState(0.5);  // 0.5 = no shift
  const [res, setRes]               = useState(0.5);  // 0.5 ≈ base Q
  const [shiftRate, setShiftRate]   = useState(0.5);
  const [shiftAmp, setShiftAmp]     = useState(0.0);
  const [decay, setDecay]           = useState(0.5);  // 0.5 ≈ base env speed
  const [presence, setPresence]     = useState(0.0);  // 2.7 kHz cut-through boost
  const [clarity, setClarity]       = useState(0.0);
  const [hiss, setHiss]             = useState(0.0);
  const [buzz, setBuzz]             = useState(0.0);

  // DOM refs for the 16 spectrum LEDs — written by rAF loop (Zero-Re-render Rule).
  const ledRefs = useRef([]);
  const rafRef  = useRef(null);

  useEffect(() => {
    onParamUpdate?.({ mix, volume, carrierMix, pwidth, shift, res,
                     shiftRate, shiftAmp, decay, presence, clarity, hiss, buzz });
  }, [mix, volume, carrierMix, pwidth, shift, res,
      shiftRate, shiftAmp, decay, presence, clarity, hiss, buzz, onParamUpdate]);

  // Built-in mic — INPUT level (knob 0–1 → 0–2×, 0.5 = unity) and enable/disable toggle.
  useEffect(() => {
    onMicGainChange?.({ gain: micGain * 2 });
  }, [micGain, onMicGainChange]);

  const toggleMic = async () => {
    if (micStatus === 'connecting') return;
    if (micStatus === 'on') { onMicDisable?.(); setMicStatus('off'); return; }
    setMicStatus('connecting');
    const ok = await onMicEnable?.();
    setMicStatus(ok ? 'on' : 'error');
  };
  const micBtnText = micStatus === 'on'         ? '● LIVE'
                   : micStatus === 'connecting' ? '○ …'
                   : micStatus === 'error'      ? '○ DENIED'
                   :                              '○ MIC';

  // rAF loop: per-band peak from the modulator FFT → LED opacity. Same pattern as FFBModule
  // (FFT 512 → 256 bins, ~86 Hz/bin, dB → 0–1 over a half-octave window per band center).
  useEffect(() => {
    if (!getAnalyserData) return;
    const BIN_HZ = 44100 / 512;

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      // Root keeps pages mounted display:none — purely visual loop, so skip
      // the analyser read + LED writes while the Moog page is hidden.
      if (ledRefs.current[0]?.offsetParent === null) return;
      const data = getAnalyserData();
      if (!data || !data.length) return;
      VOC_BANDS.forEach((band, i) => {
        const el = ledRefs.current[i];
        if (!el) return;
        const lo = Math.max(0, Math.floor(band.freq / (Math.SQRT2 * BIN_HZ)));
        const hi = Math.min(data.length - 1, Math.ceil(band.freq * Math.SQRT2 / BIN_HZ));
        let peak = -100;
        for (let b = lo; b <= hi; b++) if (data[b] > peak) peak = data[b];
        const brightness = Math.max(0, Math.min(1, (peak + 80) / 80));
        el.style.opacity = String(0.08 + brightness * 0.92);
      });
    };
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [getAnalyserData]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VOCODER</span>
            <span className={styles.plateSub}>16-BAND SPECTRAL VOCODER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.vocLayout}>
            {/* Left column — MIC knob with SIG LED + ENABLE button to its right, jacks beneath */}
            <div className={styles.vocLeft}>
              <div className={styles.vocMicTop}>
                <MoogKnob label="MIX" size="md" value={mix}     onChange={setMix}     defaultValue={1.0} />
                <MoogKnob label="MIC" size="md" value={micGain} onChange={setMicGain} defaultValue={0.5} />
              </div>
              <div className={styles.vocMicCtrls}>
                <button
                  type="button"
                  className={`${styles.micBtn} ${micStatus === 'on' ? styles.micBtnOn : ''} ${micStatus === 'error' ? styles.micBtnErr : ''}`}
                  onClick={toggleMic}
                >
                  {micBtnText}
                </button>
                <Led getValue={getMicLevel ?? ZERO_GETTER} color="green" label="SIG" />
              </div>
              <div className={styles.vocLeftJacks}>
                <Jack id={`${p}-mod-in`}  label="MOD" />
                <Jack id={`${p}-carr-in`} label="CARR" />
                <Jack id={`${p}-out`}     label="OUT" />
              </div>
            </div>
            {/* Right column — 4×3 grid of the remaining controls (MIX/MIC live on the left) */}
            <div className={styles.vocRight}>
              <div className={styles.vocKnobGrid}>
                <MoogKnob label="VOL"   size="sm" value={volume}     onChange={setVolume}     defaultValue={0.5} />
                <MoogKnob label="C.MIX" size="sm" value={carrierMix} onChange={setCarrierMix} defaultValue={0.0} />
                <MoogKnob label="PWID"  size="sm" value={pwidth}     onChange={setPwidth}     defaultValue={0.5} />
                <MoogKnob label="SHIFT" size="sm" value={shift}      onChange={setShift}      defaultValue={0.5} />
                <MoogKnob label="RES"   size="sm" value={res}        onChange={setRes}        defaultValue={0.5} />
                <MoogKnob label="S.RT"  size="sm" value={shiftRate}  onChange={setShiftRate}  defaultValue={0.5} />
                <MoogKnob label="S.AMP" size="sm" value={shiftAmp}   onChange={setShiftAmp}   defaultValue={0.0} />
                <MoogKnob label="DECAY" size="sm" value={decay}      onChange={setDecay}      defaultValue={0.5} />
                <MoogKnob label="PRES"  size="sm" value={presence}   onChange={setPresence}   defaultValue={0.0} />
                <MoogKnob label="CLAR"  size="sm" value={clarity}    onChange={setClarity}    defaultValue={0.0} />
                <MoogKnob label="HISS"  size="sm" value={hiss}       onChange={setHiss}       defaultValue={0.0} />
                <MoogKnob label="BUZZ"  size="sm" value={buzz}       onChange={setBuzz}       defaultValue={0.0} />
              </div>
            </div>
          </div>
          {/* Spectrum meter — full width along the bottom of the module */}
          <div className={styles.vocMeter}>
            {VOC_BANDS.map((_, i) => (
              <div key={i} ref={el => { ledRefs.current[i] = el; }} className={styles.vocLed} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Main shell ────────────

// onBusReady(getter) — called once on mount to hand the Workstation a function
// that returns the live Tone.Gain moogBus node for recording.
export default function MoogShell({ onNavigateHome, onBusReady }) {
  const audio      = useMoogAudio();
  const cabinetRef = useRef(null);
  const [lightsOut, setLightsOut] = useState(false);
  // VCOs whose FREQ knob is in quantized/note-stepper mode (Phase 57). Updated
  // by useMoogAudio on patch/bypass changes — event-driven, not per-frame, so
  // React state is fine here (Zero-Re-render applies to rAF loops).
  const [quantizedVcos, setQuantizedVcos] = useState([]);

  // Module library (Phase 59): hidden module keys render as BlankPanel.
  // Session-only (not persisted) — audio nodes for hidden modules idle silently.
  const [hiddenModules, setHiddenModules] = useState(() => new Set());
  const [libraryOpen, setLibraryOpen]     = useState(false);

  const toggleModule = useCallback((key) => {
    setHiddenModules(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Render helper: a hidden module keeps its grid cell as a blank panel.
  const mod = (key, el) => hiddenModules.has(key) ? <BlankPanel key={key} /> : el;

  // Dynamic instances (Phase 60b/60c): [{ id, type, num }] — rendered in the
  // expansion row of the Voice Case. Persisted with cables in the v2 rack
  // store (Phase 60f); instance NUMBERS persist so jack ids — and therefore
  // cables — stay valid across reloads.
  const [dynModules, setDynModules] = useState([]);
  // Flips true once the restore effect has re-added instances — gates the
  // CableRestorer so cables only restore against live jacks.
  const [dynRestored, setDynRestored] = useState(false);
  // Synchronous mirror — updated in the same tick as every change so the
  // StrictMode remount's restore effect never races the async setState.
  const dynModulesRef = useRef([]);

  // Rebuild engine instances on (re)mount: prefer the live mirror (StrictMode
  // remount disposed the previous engine's nodes), else restore from the rack
  // store. Persisted instance numbers are honored (addModule desiredNum) so
  // restored jack ids match the persisted cables.
  useEffect(() => {
    const source = dynModulesRef.current.length
      ? dynModulesRef.current
      : readRackStore().modules;
    const restored = [];
    for (const m of source) {
      const res = audio.addModule(m.type, m.num);
      if (res) restored.push({ id: res.id, type: m.type, num: res.num });
    }
    dynModulesRef.current = restored;
    setDynModules(restored);
    setDynRestored(true);
  }, [audio.addModule]);

  const handleAddInstance = useCallback((type) => {
    const res = audio.addModule(type);
    if (!res) return;
    const next = [...dynModulesRef.current, { id: res.id, type, num: res.num }];
    dynModulesRef.current = next;
    updateRackStore({ modules: next.map(({ id, type: t, num }) => ({ id, type: t, num })) });
    setDynModules(next);
  }, [audio.addModule]);

  // Cables were already stripped by LibraryModal (it owns the patch context),
  // each strip firing onCablesChanged → the cable list is already persisted.
  const handleRemoveInstance = useCallback((id) => {
    audio.removeModule(id);
    const next = dynModulesRef.current.filter(m => m.id !== id);
    dynModulesRef.current = next;
    updateRackStore({ modules: next.map(({ id: i, type: t, num }) => ({ id: i, type: t, num })) });
    setDynModules(next);
  }, [audio.removeModule]);

  // Persist the cable list on every USER cable change (drag-commit, click-off,
  // library strip). Fired by the patch provider outside setState updaters and
  // NEVER during restoreCables — mount-phase writes are the 60c wipe bug.
  const handleCablesChanged = useCallback((cables) => {
    updateRackStore({ cables: cables.map(c => ({ from: c.fromJackId, to: c.toJackId, color: c.color })) });
  }, []);

  // Drag-to-reorder for expansion modules (Phase 60f-2). The dragged id lives
  // in a ref (Zero-Re-render during the drag); drop moves it before the target
  // slot, persists the new order, and forces a cable-overlay reposition —
  // committed cables read jack rects at render time, so without the resize
  // nudge they would keep pointing at the modules' OLD positions.
  const dragDynIdRef = useRef(null);
  const handleDynReorder = useCallback((draggedId, targetId) => {
    if (!draggedId || draggedId === targetId) return;
    const list    = [...dynModulesRef.current];
    const fromIdx = list.findIndex(m => m.id === draggedId);
    const toIdx   = list.findIndex(m => m.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    dynModulesRef.current = list;
    updateRackStore({ modules: list.map(({ id, type, num }) => ({ id, type, num })) });
    setDynModules(list);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, []);

  // Stable per-instance closures — created once per id so module effects and
  // Led rAF loops never restart on shell re-renders (the audio fns are stable).
  const dynBindingsRef = useRef({});
  const bindingsFor = (id) => (dynBindingsRef.current[id] ??= {
    meter:      () => audio.getMeterValue(id),
    lfoLed:     () => audio.getLfoInstantById(id),
    aura:       () => audio.getReverbAuraData(id),
    params:     (p) => audio.updateDynModuleParams(id, p),
    sync:       (en) => audio.setVcoSyncEnabledById(id, en),
    kickTrig:   (onFlash) => audio.triggerKickById(id, onFlash),
    kickTrigCb: (fn) => audio.setKickTrigCallbackById(id, fn),
    ffbData:    () => audio.getFFBAnalyserData(id),
    seqSteps:   (steps) => audio.updateSeqStepsById(id, steps),
    seqStepCb:  (fn) => audio.setSeqStepCallbackById(id, fn),
    seqGlide:   (v) => audio.setSeqGlideById(id, v),
    chordSteps:   (steps) => audio.updateChordSeqStepsById(id, steps),
    chordStepCb:  (fn) => audio.setChordSeqStepCallbackById(id, fn),
    chordDiv:     (interval) => audio.setChordSeqDivisionById(id, interval),
    chordRootOct: (oct) => audio.setChordSeqRootOctaveById(id, oct),
    chordGlide:   (v) => audio.setChordSeqGlideById(id, v),
    vocData:      () => audio.getVocAnalyserData(id),
    qntCb:        (fn) => audio.setQuantizerCallbackById(id, fn),
    qntTrp:       () => audio.getQntTransposeData(id),
  });

  useEffect(() => {
    audio.setVcoQuantizedCallback(setQuantizedVcos);
    return () => audio.setVcoQuantizedCallback(null);
  }, [audio.setVcoQuantizedCallback]);

  // Register the bus getter with Root.js so the Workstation can tap Moog audio.
  // audio.getMoogBusNode is a stable useCallback ref — effect fires once.
  useEffect(() => {
    onBusReady?.(() => audio.getMoogBusNode());
  }, [onBusReady, audio.getMoogBusNode]);

  // Chord map ref — DOM ref to the chord type span inside QuantizerModule's EXT row.
  // The chord callback writes here directly (no React re-render).
  const chordMapRef = useRef(null);

  // Chord callback: fires on each chord sequencer step advance.
  // 1. Syncs quantizer scale to chord intervals (chord-aware melody snapping).
  // 2. Updates the chord type display in the quantizer's EXT row.
  useEffect(() => {
    audio.setChordSeqChordCallback((rootClass, chordType) => {
      if (chordMapRef.current) {
        chordMapRef.current.textContent = CHORD_TYPE_LABELS[chordType] ?? chordType;
      }
    });
    return () => audio.setChordSeqChordCallback(null);
  }, [audio.setChordSeqChordCallback]);

  // Stable getValue closures — created once (audio.getMeterValue has empty-dep useCallback,
  // so its reference never changes). Passing pre-bound getters prevents Led's useEffect
  // from restarting on every re-render of the parent module component.
  const getVco1Level   = useCallback(() => audio.getMeterValue('vco1'),   [audio.getMeterValue]);
  const getVco2Level   = useCallback(() => audio.getMeterValue('vco2'),   [audio.getMeterValue]);
  const getVco3Level   = useCallback(() => audio.getMeterValue('vco3'),   [audio.getMeterValue]);
  const getVco4Level   = useCallback(() => audio.getMeterValue('vco4'),   [audio.getMeterValue]);
  const getVco5Level   = useCallback(() => audio.getMeterValue('vco5'),   [audio.getMeterValue]);
  const getFFBData     = useCallback(() => audio.getFFBAnalyserData?.(),  [audio.getFFBAnalyserData]);
  const getRev1Aura    = useCallback(() => audio.getReverbAuraData?.(1),  [audio.getReverbAuraData]);
  const getRev2Aura    = useCallback(() => audio.getReverbAuraData?.(2),  [audio.getReverbAuraData]);
  const getVocData     = useCallback(() => audio.getVocAnalyserData?.(),  [audio.getVocAnalyserData]);
  const getExtMicLevel = useCallback(() => audio.getMeterValue('extMic'), [audio.getMeterValue]);
  const getLfoLevel    = useCallback(() => audio.getMeterValue('lfo'),    [audio.getMeterValue]);
  const getLfo2Level   = useCallback(() => audio.getMeterValue('lfo2'),   [audio.getMeterValue]);
  // Instantaneous LFO phase for rate LEDs — pulses at the actual modulated rate
  // rather than an averaged RMS level. Reads waveform analyser last sample.
  const getLfoInstant  = useCallback(() => audio.getLfoInstant?.()  ?? 0, [audio.getLfoInstant]);
  const getLfo2Instant = useCallback(() => audio.getLfo2Instant?.() ?? 0, [audio.getLfo2Instant]);
  const getEnv1Level   = useCallback(() => audio.getMeterValue('env1'),   [audio.getMeterValue]);
  const getEnv2Level   = useCallback(() => audio.getMeterValue('env2'),   [audio.getMeterValue]);
  const getEnv3Level   = useCallback(() => audio.getMeterValue('env3'),   [audio.getMeterValue]);
  const getMasterLevel = useCallback(() => audio.getMeterValue('master'), [audio.getMeterValue]);
  const getIoCh1Level  = useCallback(() => audio.getMeterValue('ioCh1'),  [audio.getMeterValue]);
  const getIoCh2Level  = useCallback(() => audio.getMeterValue('ioCh2'),  [audio.getMeterValue]);
  const getIoCh3Level  = useCallback(() => audio.getMeterValue('ioCh3'),  [audio.getMeterValue]);
  const getIoCh4Level  = useCallback(() => audio.getMeterValue('ioCh4'),  [audio.getMeterValue]);

  // Toggle: powerOn when off, powerOff when on. Both functions guard internally via
  // isPoweredRef so rapid double-clicks are safe even before the async powerOn resolves.
  const handlePowerToggle = useCallback(() => {
    if (audio.isPowered) audio.powerOff();
    else audio.powerOn();
  }, [audio.isPowered, audio.powerOff, audio.powerOn]);

  // ── Viewport camera: fit-to-screen base + wheel-zoom / drag-pan (Phase 53) ──
  // The fitted full-rack view is the home state (z = 1); wheel/pinch zooms toward
  // the cursor up to 8×, dragging empty faceplate pans, Esc / double-click on
  // empty faceplate animates back. transform = translate(tx,ty) scale(s0·z) with
  // origin 0 0 (cabinet is align-self:flex-start so its layout origin is the
  // viewport content corner — translate math needs no centering compensation).
  // ALL view state lives in this closure — zero React state, direct style writes.
  useEffect(() => {
    const el = cabinetRef.current;
    if (!el) return;

    // s0 = fit scale · z = user zoom · tx/ty = pan (screen px) · ox/oy = layout origin
    const view = { s0: 1, z: 1, tx: 0, ty: 0, natW: 0, natH: 0, availW: 0, availH: 0, ox: 16, oy: 44 };
    el.style.transformOrigin = '0 0';

    // Fit-width floor (Phase 60a): auto-shrink never goes below the scale that
    // renders a FLOOR_LAYOUT_W-wide layout at exactly screen width — the Phase 55
    // typography readability floor. Chosen just under the default rack's layout
    // width (availW/0.4919 ≈ 3009 at 1512×945) so today's rack is untouched;
    // any added case pushes height-fit below the floor and the rack becomes
    // vertically pannable instead of shrinking further.
    const FLOOR_LAYOUT_W = 3010;

    // True when the scaled rack is taller than the viewport (floored or zoomed) —
    // vertical panning is then available even at z = 1.
    const overflowsV = () => view.natH * view.s0 * view.z > view.availH + 1;

    // Transient layer promotion — promote the cabinet only while the camera is
    // moving, release ~0.5s after it settles. A permanent will-change layer this
    // large blew GPU tile budgets: any small repaint (gate button :active) or a
    // tab-return re-raster flashed modules black while tiles rebuilt. Releasing
    // also re-rasters the rack at the current zoom scale (crisper when zoomed).
    let wcTimer = null;
    const touchWillChange = () => {
      el.style.willChange = 'transform';
      clearTimeout(wcTimer);
      wcTimer = setTimeout(() => { el.style.willChange = ''; }, 500);
    };

    const apply = () => {
      el.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s0 * view.z})`;
      // Pannable affordance — cursor is inherited, so interactive children
      // (knobs ns-resize, jacks/keys/buttons pointer) still show their own.
      el.style.cursor = (view.z > 1.001 || overflowsV()) ? 'grab' : '';
    };

    // Keep the rack glued to the viewport: no gaps on the pannable axes,
    // centered/top-anchored when the scaled content is smaller than the viewport.
    const clampPan = () => {
      const S = view.s0 * view.z;
      const w = view.natW * S, h = view.natH * S;
      view.tx = w > view.availW ? Math.max(view.availW - w, Math.min(0, view.tx)) : (view.availW - w) / 2;
      view.ty = h > view.availH ? Math.max(view.availH - h, Math.min(0, view.ty)) : 0;
    };

    // scheduleFit debounce — multiple rapid ResizeObserver callbacks (e.g. from fit()'s
    // own DOM writes) are collapsed into a single deferred fit() call, preventing loops.
    let fitTimer = null;
    const scheduleFit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fit, 0);
    };

    const fit = () => {
      // Clear transform so offsetHeight reflects the true layout height (transform is
      // visual-only and doesn't affect layout, but clearing ensures a clean measurement).
      el.style.transition   = 'none';
      el.style.transform    = 'none';
      el.style.marginBottom = '0px';

      const natH = el.offsetHeight;
      if (!natH) return; // hidden (display:none) — ResizeObserver fires when it becomes visible

      // Available space (shell padding: 16px sides, 44px top + 16px bottom).
      view.availW = window.innerWidth  - 32;
      view.availH = window.innerHeight - 60;
      // Height-fit, floored at fit-width (Phase 60a), capped at 1.
      const sFloor = Math.min(view.availW / FLOOR_LAYOUT_W, 1);
      const s0 = Math.min(Math.max(view.availH / natH, sFloor), 1);

      if (s0 < 1) {
        // Width compensation: widen the layout box so that after scale(), the visual
        // width equals availW — no blank side margins from transform shrinking the width.
        // Guard: only assign if the value differs to avoid unnecessary ResizeObserver triggers.
        const newW = `${Math.ceil(view.availW / s0)}px`;
        if (el.style.width !== newW) el.style.width = newW;
        el.style.marginBottom = `${Math.round(natH * (s0 - 1))}px`;
      } else {
        if (el.style.width !== '') el.style.width = '';
      }

      view.s0   = s0;
      view.natW = el.offsetWidth;   // re-measure after the width write
      view.natH = el.offsetHeight;
      view.ox   = el.offsetLeft;
      view.oy   = el.offsetTop;
      clampPan();
      apply();
    };

    // ── Wheel / pinch zoom toward the cursor ──
    // Keeps the world point under the pointer fixed: w = (p − t)/S ⇒ t' = p − w·S'.
    // ctrlKey marks trackpad pinch (small deltas → larger factor).
    const onWheel = (e) => {
      e.preventDefault();
      // Floored-rack scroll (Phase 60a): at rest (z=1) with the rack taller than
      // the viewport, plain wheel pans vertically — the natural "scroll the rack"
      // gesture. Ctrl/pinch still zooms. Once zoomed, wheel zooms as always, so
      // the default rack's behavior is unchanged (it never overflows at z=1).
      if (!e.ctrlKey && view.z === 1 && overflowsV()) {
        touchWillChange();
        view.ty -= e.deltaY;
        el.style.transition = 'none';
        clampPan();
        apply();
        return;
      }
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022));
      const zNew = Math.min(8, Math.max(1, view.z * factor));
      if (zNew === view.z) return;
      const S  = view.s0 * view.z;
      const Sn = view.s0 * zNew;
      const px = e.clientX - view.ox;
      const py = e.clientY - view.oy;
      view.tx = px - ((px - view.tx) / S) * Sn;
      view.ty = py - ((py - view.ty) / S) * Sn;
      view.z  = zNew;
      el.style.transition = 'none';
      touchWillChange();
      clampPan();
      apply();
    };

    // ── Drag-pan on non-interactive surfaces while zoomed ──
    // cursor is an inherited CSS property: every control in the rack resolves to
    // pointer/ns-resize (knobs, jacks, keys, selectors, cables), bare faceplate
    // resolves to auto — one computed-style check covers all components with
    // zero per-component markup.
    const isInteractive = (t) => {
      if (!(t instanceof Element)) return false;
      if (t.closest('button, input, select, [data-jack-id]')) return true;
      const cur = getComputedStyle(t).cursor;
      return cur === 'pointer' || cur === 'ns-resize' || cur === 'ew-resize' || cur === 'crosshair';
    };

    let panning = false, lastX = 0, lastY = 0;
    const onMouseDown = (e) => {
      if ((view.z <= 1.001 && !overflowsV()) || e.button !== 0 || isInteractive(e.target)) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.style.transition = 'none';
      el.style.cursor = 'grabbing';
      touchWillChange();
      e.preventDefault();
    };
    const onMouseMove = (e) => {
      if (!panning) return;
      touchWillChange();
      view.tx += e.clientX - lastX;
      view.ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      clampPan();
      apply();
    };
    const onMouseUp = () => {
      if (!panning) return;
      panning = false;
      apply(); // restores 'grab' cursor
    };

    // ── Reset to full-rack view (Esc / double-click empty faceplate) ──
    // With the fit-width floor a rack can be scrolled at z=1 — reset also
    // returns a scrolled rack to the top.
    const reset = () => {
      if (view.z === 1 && view.tx === 0 && view.ty === 0) return;
      touchWillChange(); // covers the 0.35s transition; released 0.5s after
      el.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.25, 1)';
      view.z = 1;
      view.tx = 0;
      view.ty = 0;
      clampPan();
      apply();
      setTimeout(() => { el.style.transition = 'none'; }, 400);
    };
    const onDblClick = (e) => { if (!isInteractive(e.target)) reset(); };
    const onKeyDown  = (e) => { if (e.key === 'Escape') reset(); };

    fit(); // immediate on mount
    document.fonts.ready.then(scheduleFit);

    // ResizeObserver catches: late font loads, page becoming visible after display:none
    // (navigation back to Moog page), and any content height changes at runtime.
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);

    const shell = el.parentElement; // .shell — wheel anywhere on the page zooms
    shell.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('dblclick', onDblClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', fit);
    return () => {
      clearTimeout(fitTimer);
      clearTimeout(wcTimer);
      ro.disconnect();
      shell.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', fit);
    };
  }, []);

  return (
    <MoogPatchProvider onCableAdded={audio.connect} onCableRemoved={audio.disconnect} onCablesChanged={handleCablesChanged}>
      <div className={styles.shell}>
        <button className={styles.homeBtn} onClick={onNavigateHome}>← home</button>
        <button
          className={`${styles.lightsOutBtn} ${lightsOut ? styles.lightsOutActive : ''}`}
          onClick={() => setLightsOut(v => !v)}
        >
          {lightsOut ? '○ lights on' : '● lights out'}
        </button>
        <button className={styles.libraryBtn} onClick={() => setLibraryOpen(true)}>
          ⊞ library
        </button>
        <LibraryModal
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          hidden={hiddenModules}
          onToggle={toggleModule}
          dynModules={dynModules}
          onAddInstance={handleAddInstance}
          onRemoveInstance={handleRemoveInstance}
        />

        <div className={styles.cabinet} ref={cabinetRef} data-lights-out={lightsOut ? 'true' : undefined}>
          {/* SVG patch cable overlay — position:absolute, inset:0, z-index:50 */}
          <PatchCableOverlay />
          {/* Unified studio lamp — single radial gradient covering the whole rack.
              mix-blend-mode:screen brightens modules proportionally to their position
              under the lamp; z-index:49 keeps it above module content, below cables. */}
          <div className={styles.lightOverlay} />

          <div className={styles.nameplate}>
            <span className={styles.nameplateModel}>MODEL 55</span>
            <span className={styles.nameplateBrand}>MOOG MODULAR SYNTHESIZER</span>
            <span className={styles.nameplateSerial}>SER. No. 0001-A</span>
          </div>

          <div className={styles.rack}>
            {/* Case 1: oscillators + filters/modulation/fx (rows 1–2) */}
            <section className={styles.case}>
              <span className={styles.caseLabel}>Voice Case</span>
              <div className={styles.caseInterior}>
                <div className={`${styles.tier} ${styles.tierRow1}`}>
                  {mod('vco1', <VcoModule key="vco1" number={1} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco1SyncEnabled} getLedValue={getVco1Level} quantized={quantizedVcos.includes('vco1')} />)}
                  {mod('vco2', <VcoModule key="vco2" number={2} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco2SyncEnabled} getLedValue={getVco2Level} quantized={quantizedVcos.includes('vco2')} />)}
                  {mod('vco3', <VcoModule key="vco3" number={3} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco3SyncEnabled} getLedValue={getVco3Level} quantized={quantizedVcos.includes('vco3')} />)}
                  {mod('vco4', <VcoModule key="vco4" number={4} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco4SyncEnabled} getLedValue={getVco4Level} quantized={quantizedVcos.includes('vco4')} />)}
                  {mod('vco5', <VcoModule key="vco5" number={5} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco5SyncEnabled} getLedValue={getVco5Level} quantized={quantizedVcos.includes('vco5')} />)}
                  {mod('noise1', <NoiseModule key="noise1" number={1} onParamUpdate={audio.updateNoiseParams} />)}
                  {mod('noise2', <NoiseModule key="noise2" number={2} onParamUpdate={audio.updateNoiseParams} />)}
                  {mod('noise3', <NoiseModule key="noise3" number={3} onParamUpdate={audio.updateNoiseParams} />)}
                </div>
                <div className={`${styles.tier} ${styles.tierRow2}`}>
                  {mod('vcf1', <VcfModule key="vcf1" number={1} onParamUpdate={audio.updateVcfParams} />)}
                  {mod('vcf2', <VcfModule key="vcf2" number={2} onParamUpdate={audio.updateVcf2Params} />)}
                  {mod('lfo1', <LfoModule key="lfo1" number={1} onParamUpdate={audio.updateLfoParams}  getLedValue={getLfoInstant} />)}
                  {mod('lfo2', <LfoModule key="lfo2" number={2} onParamUpdate={audio.updateLfo2Params} getLedValue={getLfo2Instant} />)}
                  {mod('rev1', <ReverbModule key="rev1" number={1} onParamUpdate={audio.updateReverbParams}  getAuraData={getRev1Aura} />)}
                  {mod('rev2', <ReverbModule key="rev2" number={2} onParamUpdate={audio.updateReverb2Params} getAuraData={getRev2Aura} />)}
                  {mod('bbd', <ChorusModule key="bbd" onParamUpdate={audio.updateChorusParams} />)}
                  {mod('ffb', <FFBModule key="ffb" onParamUpdate={audio.updateFFBParams} getAnalyserData={getFFBData} />)}
                </div>
                {/* Expansion row (Phase 60b/60c) — dynamic instances added from
                    the library. Fixed per-type widths + wrap: extra rows grow
                    the rack downward into the 60a fit-width floor + scroll. */}
                {dynModules.length > 0 && (
                  <div className={styles.tierDyn}>
                    {dynModules.map(m => {
                      const b = bindingsFor(m.id);
                      const inner =
                        m.type === 'vco'   ? <VcoModule number={m.num} onParamUpdate={audio.updateVcoParams} onSyncChange={b.sync} getLedValue={b.meter} quantized={quantizedVcos.includes(m.id)} />
                      : m.type === 'noise' ? <NoiseModule number={m.num} onParamUpdate={audio.updateNoiseParams} />
                      : m.type === 'vcf'   ? <VcfModule number={m.num} onParamUpdate={b.params} />
                      : m.type === 'lfo'   ? <LfoModule number={m.num} onParamUpdate={b.params} getLedValue={b.lfoLed} />
                      : m.type === 'vca'   ? <VcaModule number={m.num} onParamUpdate={b.params} />
                      : m.type === 'env'   ? <EnvelopeModule label={`ENV ${m.num}`} onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={b.meter} />
                      : m.type === 'rev'   ? <ReverbModule number={m.num} onParamUpdate={b.params} getAuraData={b.aura} />
                      : m.type === 'bbd'   ? <ChorusModule number={m.num} onParamUpdate={b.params} />
                      : m.type === 'kick'  ? <KickModule number={m.num} onParamUpdate={b.params} onTrigger={b.kickTrig} onSetTrigCallback={b.kickTrigCb} />
                      : m.type === 'ffb'   ? <FFBModule number={m.num} onParamUpdate={b.params} getAnalyserData={b.ffbData} />
                      : m.type === 'seq'   ? <SequencerModule number={m.num} onStepsChange={b.seqSteps} onTempoChange={audio.setTempo} onSetCallback={b.seqStepCb} onGlideChange={b.seqGlide} />
                      : m.type === 'chordseq' ? <ChordSeqModule number={m.num} onStepsChange={b.chordSteps} onDivisionChange={b.chordDiv} onSetCallback={b.chordStepCb} onRootOctaveChange={b.chordRootOct} onGlideChange={b.chordGlide} />
                      : m.type === 'voc'   ? <VocoderModule number={m.num} onParamUpdate={b.params} getAnalyserData={b.vocData} onMicEnable={audio.enableMic} onMicDisable={audio.disableMic} onMicGainChange={audio.updateExtMicParams} getMicLevel={getExtMicLevel} />
                      : m.type === 'qnt'   ? <QuantizerModule number={m.num} onParamUpdate={b.params} onSetCallback={b.qntCb} getTransposeData={b.qntTrp} />
                      : null;
                      return (
                        <div
                          key={m.id}
                          className={styles.dynSlot}
                          style={{ flex: `0 0 ${DYN_WIDTH[m.type]}px` }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.currentTarget.classList.add(styles.dynSlotDropTarget);
                          }}
                          onDragLeave={(e) => e.currentTarget.classList.remove(styles.dynSlotDropTarget)}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.currentTarget.classList.remove(styles.dynSlotDropTarget);
                            handleDynReorder(dragDynIdRef.current, m.id);
                            dragDynIdRef.current = null;
                          }}
                        >
                          <div
                            className={styles.dynGrip}
                            draggable
                            title="Drag to reorder"
                            onDragStart={(e) => {
                              dragDynIdRef.current = m.id;
                              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                            }}
                            onDragEnd={() => { dragDynIdRef.current = null; }}
                          >⠿</div>
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Case 2: amps, envelopes, drums, vocoder (row 3) */}
            <section className={styles.case}>
              <span className={styles.caseLabel}>Percussion & FX Case</span>
              <div className={styles.caseInterior}>
                <div className={`${styles.tier} ${styles.tierRow3}`}>
                  {mod('vca1', <VcaModule key="vca1" number={1} onParamUpdate={audio.updateVcaParams} />)}
                  {mod('vca2', <VcaModule key="vca2" number={2} onParamUpdate={audio.updateVca2Params} />)}
                  {mod('vca3', <VcaModule key="vca3" number={3} onParamUpdate={audio.updateVca3Params} />)}
                  {mod('env1', <EnvelopeModule key="env1" label="ENV 1" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv1Level} />)}
                  {mod('env2', <EnvelopeModule key="env2" label="ENV 2" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv2Level} />)}
                  {mod('env3', <EnvelopeModule key="env3" label="ENV 3" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv3Level} />)}
                  {mod('kick', <KickModule key="kick" onParamUpdate={audio.updateKickParams} onTrigger={audio.triggerKick} onSetTrigCallback={audio.setKickTrigCallback} />)}
                  {mod('vocoder', <VocoderModule
                    key="vocoder"
                    onParamUpdate={audio.updateVocoderParams}
                    getAnalyserData={getVocData}
                    onMicEnable={audio.enableMic}
                    onMicDisable={audio.disableMic}
                    onMicGainChange={audio.updateExtMicParams}
                    getMicLevel={getExtMicLevel}
                  />)}
                </div>
              </div>
            </section>

            {/* Case 3: sequencers + quantizer + I/O (row 4).
                Sequencers stay side by side (Phase 54): stacking them made this
                tier 616px (⅓ of the rack) and halved the global fit() scale. */}
            <section className={styles.case}>
              <span className={styles.caseLabel}>Sequencer Case</span>
              <div className={styles.caseInterior}>
                <div className={`${styles.tier} ${styles.tierRow4}`}>
                  {mod('seq1', <SequencerModule
                    key="seq1"
                    number={1}
                    onStepsChange={audio.updateSequencerSteps}
                    onTempoChange={audio.setTempo}
                    onSetCallback={audio.setSeqStepCallback}
                    onGlideChange={audio.setSeqGlide}
                  />)}
                  {mod('seq2', <SequencerModule
                    key="seq2"
                    number={2}
                    onStepsChange={audio.updateSeq2Steps}
                    onTempoChange={audio.setTempo}
                    onSetCallback={audio.setSeq2StepCallback}
                    onGlideChange={audio.setSeq2Glide}
                  />)}
                  {mod('chordseq', <ChordSeqModule
                    key="chordseq"
                    onStepsChange={audio.updateChordSeqSteps}
                    onDivisionChange={audio.setChordSeqDivision}
                    onSetCallback={audio.setChordSeqStepCallback}
                    onRootOctaveChange={audio.setChordSeqRootOctave}
                    onGlideChange={audio.setChordSeqGlide}
                  />)}
                  {mod('qnt', <QuantizerModule
                    key="qnt"
                    onParamUpdate={audio.updateQuantizerParams}
                    onSetCallback={audio.setQuantizerCallback}
                    getTransposeData={audio.getQntTransposeData}
                    chordMapRef={chordMapRef}
                  />)}
                  <IoModule
                    isPowered={audio.isPowered}
                    onPower={handlePowerToggle}
                    onParamUpdate={audio.updateIoParams}
                    getOscData={audio.getOscilloscopeData}
                    getLedValue={getMasterLevel}
                    getChLevels={[getIoCh1Level, getIoCh2Level, getIoCh3Level, getIoCh4Level]}
                    onChannelVolChange={audio.updateIoChannelVol}
                  />
                </div>
              </div>
            </section>
          </div>

          {/* Wooden rail separating the module rack from the keyboard */}
          <div className={styles.kbdBarrier} />

          {/* 953 Keyboard Controller — sits below the rack, spans full cabinet width */}
          <KeyboardModule onUpdate={audio.updateKeyboard} onGlideChange={audio.setKbdGlide} onVibratoChange={audio.setKbdVibrato} />
        </div>
      </div>
      {/* LAST child on purpose: sibling effects run in tree order, so the
          restorer's effect fires AFTER the (just-restored) dynamic modules'
          Jack registration effects in the same commit (Phase 60f). */}
      <CableRestorer ready={dynRestored} audioConnect={audio.connect} />
    </MoogPatchProvider>
  );
}
