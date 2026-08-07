import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import styles from './MoogShell.module.css';
import MoogKnob from './MoogKnob';
import { MoogPatchProvider, useMoogPatch } from './MoogPatchContext';
import PatchCableOverlay from './PatchCableOverlay';
import useMoogAudio, { FFB_BANDS, VOC_BANDS, fftBinHz } from './useMoogAudio';
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

// `active` reflects a real on/off state (true → lever up toward labels[1]; false →
// down toward labels[0]); omit it for a purely decorative switch (Phase 65).
// Read-only MODE INDICATOR (Phase 70) — deliberately NOT a switch.
// It replaced a ToggleSwitch on the LFO that looked fully interactive but had no
// click handler: the free/sync mode is driven by whether a cable is patched into
// the SYNC jack, so the lever was a dead affordance that invited pointless clicks.
// Both words stay printed at all times (silkscreen doesn't move); the active one
// lights mint via .toggleLabelActive, shared with the genuine switches.
function ModeIndicator({ labels, active, title }) {
  return (
    <div className={styles.modeIndicator} title={title}>
      <span className={`${styles.modeWord} ${active === false ? styles.modeWordOn : ''}`}>{labels[0]}</span>
      <span className={`${styles.modeWord} ${active === true  ? styles.modeWordOn : ''}`}>{labels[1]}</span>
    </div>
  );
}

// Pass `onToggle` to make the lever a real control (cursor + click); omit it and
// the switch is a read-only state display. NEVER render one with an `active` state
// but no handler — that is the dead-affordance trap ModeIndicator exists to avoid.
function ToggleSwitch({ labels = ['OFF', 'ON'], active, title, onToggle }) {
  const on = active === true, off = active === false;
  return (
    <div
      className={`${styles.toggleGroup} ${onToggle ? styles.toggleGroupLive : ''}`}
      title={title}
      onClick={onToggle}
    >
      <span className={`${styles.toggleLabel} ${on ? styles.toggleLabelActive : ''}`}>{labels[1]}</span>
      <div className={`${styles.toggle} ${on ? styles.toggleOn : ''} ${off ? styles.toggleOff : ''}`}>
        <div className={styles.toggleLever} />
      </div>
      <span className={`${styles.toggleLabel} ${off ? styles.toggleLabelActive : ''}`}>{labels[0]}</span>
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

  const vcoId = `vco${number}`;
  const p     = vcoId;
  const saved = useSavedSettings(vcoId);
  const [freqBase,    setFreqBase]    = useState(saved.freqBase    ?? 0.5);
  const [fineTune,    setFineTune]    = useState(saved.fineTune    ?? defaultFine);
  const [rangeOctave, setRangeOctave] = useState(saved.rangeOctave ?? 0);
  const [syncOn,      setSyncOn]      = useState(saved.syncOn      ?? false);
  const [pulseWidth,  setPulseWidth]  = useState(saved.pulseWidth  ?? 0.5); // 0.5 = square (SQR out PWM)
  useModulePersist(vcoId, { freqBase, fineTune, rangeOctave, syncOn, pulseWidth });

  // Sync LED getter — ref-backed so the stable useCallback never stale-captures syncOn.
  const syncOnRef = useRef(false);
  useEffect(() => { syncOnRef.current = syncOn; }, [syncOn]);
  const getSyncLed = useCallback(() => syncOnRef.current ? 1 : 0, []);

  useEffect(() => {
    if (!onParamUpdate) return;
    const baseHz  = VCO_FREQ_MIN * Math.pow(VCO_FREQ_MAX / VCO_FREQ_MIN, freqBase);
    const finalHz = baseHz * Math.pow(2, rangeOctave);
    const detune  = (fineTune - 0.5) * 200;
    // SHAPE knob 0..1 → phase-warp midpoint 0.05..0.95 (0.5 = no warp). Warps all
    // four waveforms in the worklet core (pulse duty, tri/saw skew, sine lean).
    const width   = 0.05 + pulseWidth * 0.9;
    onParamUpdate(vcoId, { hz: finalHz, detune, width });
  }, [freqBase, fineTune, rangeOctave, pulseWidth, vcoId, onParamUpdate]);

  // Apply the HARD SYNC enable state to the engine on mount AND on change — not
  // just on user toggle. Without the mount application, a `syncOn` restored from
  // a saved setup (Phase 63) shows the switch ON but never engages the engine
  // (syncOut gain stays 0) → "hard sync not working" after a reload/load.
  useEffect(() => {
    onSyncChange?.(syncOn);
  }, [syncOn, onSyncChange]);

  // RANGE selector — hold and drag the cursor vertically to scrub through the
  // ranges (up → higher pitch / 2', down → lower / 32') instead of click-cycling,
  // so either direction is one gesture away. Window listeners bound on mousedown
  // (the knob drag pattern); stopPropagation keeps the drag off the camera pan.
  const RANGE_DRAG_PX = 16; // cursor travel per range step
  const handleRangeDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY   = e.clientY;
    const startIdx = RANGE_STEPS.indexOf(rangeOctave);
    const onMove = (ev) => {
      const steps = Math.round((startY - ev.clientY) / RANGE_DRAG_PX); // up = +
      const idx   = Math.max(0, Math.min(RANGE_STEPS.length - 1, startIdx + steps));
      setRangeOctave(RANGE_STEPS[idx]); // no-op re-render if unchanged (Object.is)
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleSyncToggle = () => setSyncOn(v => !v);

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
            <MoogKnob label="SHAPE" size="sm" value={pulseWidth} onChange={setPulseWidth} defaultValue={0.5} />
            <Led getValue={getLedValue} color="green" />
          </div>
          <div className={styles.vcoControlRow}>
            <div className={styles.selectorRow}>
              <div
                className={styles.selectorGroup}
                onMouseDown={handleRangeDragStart}
                style={{ cursor: 'ns-resize' }}
                title="Hold and drag up / down to change range"
              >
                <span className={styles.selectorLabel}>RANGE</span>
                <span className={`${styles.selectorValue} ${styles.selectorValueRange}`}>{RANGE_LABELS[String(rangeOctave)]}</span>
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
            <Jack id={`${p}-pw`}  label="SH" />
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

// Noise-colour jack suffixes + their on-screen tint and trace roughness (Phase 69).
// 'brn' is brown noise (Tone 'brown', −6 dB/oct) shown as RED (aka red noise).
// rough: how jagged the scope trace is — red is smooth (low freq), violet spiky.
const NOISE_KEYS = ['wht', 'pnk', 'brn', 'blu', 'vio', 'gry'];
const NOISE_VIZ = {
  wht: { color: '#e9e9e9', rough: 1.00 },
  pnk: { color: '#ff86b0', rough: 0.60 },
  brn: { color: '#ff4a35', rough: 0.28 }, // RED
  blu: { color: '#4aa3ff', rough: 1.35 },
  vio: { color: '#b26bff', rough: 1.70 },
  gry: { color: '#9aa0a8', rough: 0.90 },
};
const NOISE_SCOPE_W = 176, NOISE_SCOPE_H = 46;

// Retro phosphor oscilloscope for the noise module. Draws a live procedural
// noise trace (noise IS random, so a real analyser tap adds nothing visually) in
// the tint of the colour currently patched from this module — so patching RED
// glows red, VIOLET glows violet, etc. Idle (nothing patched) = a dim grey trace.
// activeKey = the patched colour suffix (or null); level scales amplitude.
// Phase-61 visibility gates + persistence trails give the CRT look.
function NoiseScope({ activeKey, level }) {
  const canvasRef = useRef(null);
  const stateRef  = useRef({ activeKey, level });
  stateRef.current = { activeKey, level };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = NOISE_SCOPE_W, H = NOISE_SCOPE_H, mid = H / 2;
    let raf, glow = 0, lp = 0, sweep = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (canvas.offsetParent === null) return;                                   // hidden page
      if (canvas.checkVisibility && !canvas.checkVisibility({ contentVisibilityAuto: true })) return; // culled
      const { activeKey, level } = stateRef.current;
      const meta  = NOISE_VIZ[activeKey] || null;
      const tint  = meta ? meta.color : 'rgba(150,160,175,0.6)';
      const rough = meta ? meta.rough : 0.9;
      const amp   = (meta ? 1 : 0.3) * Math.max(0.05, level) * (H * 0.42);
      glow += ((meta ? 1 : 0.22) - glow) * 0.08;

      // persistence — dark wash each frame leaves a faint phosphor trail
      ctx.fillStyle = 'rgba(4,7,6,0.34)';
      ctx.fillRect(0, 0, W, H);
      // centre baseline
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

      // noise trace — per-x random, low-passed by (1-rough) for smoother colours
      const smooth = Math.min(1, rough * 0.55 + 0.14);
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        lp += ((Math.random() * 2 - 1) - lp) * smooth;
        const y = mid - lp * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = tint;
      ctx.globalAlpha = 0.32 + glow * 0.58;
      ctx.lineWidth   = 1.4;
      ctx.shadowBlur  = 6 * glow;
      ctx.shadowColor = tint;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // a slow scanning dot rides the trace for extra retro motion
      sweep = (sweep + 1.5) % W;
      lp += ((Math.random() * 2 - 1) - lp) * smooth;
      ctx.fillStyle = tint;
      ctx.globalAlpha = 0.5 + glow * 0.5;
      ctx.beginPath(); ctx.arc(sweep, mid - lp * amp, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={styles.noiseScope}>
      <canvas ref={canvasRef} width={NOISE_SCOPE_W} height={NOISE_SCOPE_H} className={styles.noiseScopeCanvas} />
    </div>
  );
}

function NoiseModule({ number = 1, onParamUpdate }) {
  const prefix = number === 1 ? 'noise' : `noise${number}`;
  const saved = useSavedSettings(prefix);
  const [level, setLevel] = useState(saved.level ?? 0.7);
  useModulePersist(prefix, { level });

  // LEVEL → per-instance colour gains (Phase 69); 0.7 default = unity.
  useEffect(() => {
    onParamUpdate?.(prefix, { level });
  }, [level, prefix, onParamUpdate]);

  // Which of this module's colour outputs is patched (most-recent cable wins) —
  // drives the scope tint. Cables carry fromJackId/toJackId; an output can be the
  // source (fromJackId) or, if the user dragged into it, the toJackId.
  const { cables } = useMoogPatch();
  const activeKey = useMemo(() => {
    const jackToKey = new Map(NOISE_KEYS.map(k => [`${prefix}-${k}`, k]));
    let key = null;
    for (const c of cables) {
      if (jackToKey.has(c.fromJackId))      key = jackToKey.get(c.fromJackId);
      else if (jackToKey.has(c.toJackId))   key = jackToKey.get(c.toJackId);
    }
    return key;
  }, [cables, prefix]);

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
            {/* LEVEL CV in — patch an LFO here to modulate the noise level. */}
            <Jack id={`${prefix}-lvl-cv`} label="CV" />
          </div>
          <NoiseScope activeKey={activeKey} level={level} />
          <PlateDivider />
          {/* Six colours (Phase 69): white/pink/red sources + blue/violet/grey
              voiced off white (RED = brown noise). 3×2 grid, full colour names. */}
          <div className={styles.noiseJackGrid}>
            <Jack id={`${prefix}-wht`} label="WHITE" />
            <Jack id={`${prefix}-pnk`} label="PINK" />
            <Jack id={`${prefix}-brn`} label="RED" />
            <Jack id={`${prefix}-blu`} label="BLUE" />
            <Jack id={`${prefix}-vio`} label="VIOLET" />
            <Jack id={`${prefix}-gry`} label="GREY" />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ cutoff, resonance, envAmt }) is the audio update callback from
// useMoogAudio. ENV AMT attenuates the ENV jack's cutoff-modulation depth (Phase 70):
// knob 0 = the patched envelope moves nothing, knob 1 = it lifts the cutoff 5 octaves.
// There is deliberately NO keyboard-tracking knob: the real Moog 904A has only a
// fixed-control-voltage (cutoff) knob, regeneration (resonance) and attenuated CV
// inputs. KBD tracking is a Minimoog feature and was removed as inauthentic.
function VcfModule({ onParamUpdate, number = 1 }) {
  const p = number === 1 ? 'vcf' : `vcf${number}`;
  const saved = useSavedSettings(p);
  const [cutoff, setCutoff] = useState(saved.cutoff ?? 1.0);   // fully open — matches vcf init at 20kHz
  const [res, setRes]       = useState(saved.res    ?? 0.0);
  const [envAmt, setEnvAmt] = useState(saved.envAmt ?? 0.5);
  useModulePersist(p, { cutoff, res, envAmt });

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ cutoff, resonance: res, envAmt });
  }, [cutoff, res, envAmt, onParamUpdate]);

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
            <MoogKnob label="ENV AMT" size="md" value={envAmt} onChange={setEnvAmt} defaultValue={0.5} />
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

// LFO waveform is chosen by WHICH OUTPUT JACK you patch (Phase 70) — the click-to-
// cycle WAVE selector was removed. `connect()` sets the oscillator type from the
// jack's `waveform` field AND keeps `lfoWaveRefs` in step, so both free and sync
// modes follow the cable. This is how the real module works (four simultaneous
// shape outputs, no shape switch), and it removes a UI writer of the same state,
// so the cable is now the single source of truth for shape. Cable restore re-fires
// connect() on load, so the shape survives a reload without being persisted.
//
// Mirror of useMoogAudio's LFO_SYNC_DIVS labels — RATE knob (0..1) → division shown
// when a clock is patched into SYNC (Phase 65). Keep in step with lfoDivForRate.
const LFO_SYNC_LABELS = ['4 BAR', '2 BAR', '1 BAR', '1/2', '1/4', '1/8'];
const lfoSyncLabelForRate = (rate) =>
  LFO_SYNC_LABELS[Math.min(LFO_SYNC_LABELS.length - 1, Math.max(0, Math.floor((rate ?? 0.3) * LFO_SYNC_LABELS.length)))];

// onParamUpdate({ rate, depth, modDepth }) wires the knobs to useMoogAudio. Waveform
// is deliberately NOT passed — the patched output jack owns it (see above).
// getLedValue() — stable getter (pre-bound in MoogShell) for the LFO level meter.
function LfoModule({ onParamUpdate, getLedValue, number = 1 }) {
  const p = number === 1 ? 'lfo' : `lfo${number}`;
  const saved = useSavedSettings(p);
  const [rate,     setRate]     = useState(saved.rate     ?? 0.3);
  const [depth,    setDepth]    = useState(saved.depth    ?? 0.5);
  const [modDepth, setModDepth] = useState(saved.modDepth ?? 0.0);
  useModulePersist(p, { rate, depth, modDepth });

  // Tempo-sync engages when a clock is patched into this LFO's SYNC jack (Phase
  // 65). In sync mode RATE selects a musical division and MOD becomes the OFFSET
  // (start phase). The audio side keys off the cable in connect()/disconnect().
  const { cables } = useMoogPatch();
  const syncJack = `${p}-sync`;
  const synced = cables.some(c => c.toJackId === syncJack || c.fromJackId === syncJack);

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ rate, depth, modDepth });
  }, [rate, depth, modDepth, onParamUpdate]);

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
            {/* Labels are FIXED (Phase 70). They used to swap to DIV/OFFSET while
                synced, but a real faceplate is silkscreened — it never relabels
                itself. The knobs keep their jobs; sync only changes what RATE's
                position means, which the engraved readout below reports. */}
            <MoogKnob label="RATE"  size="lg" value={rate}     onChange={setRate}     defaultValue={0.3} />
            <MoogKnob label="DEPTH" size="md" value={depth}    onChange={setDepth}    defaultValue={0.5} />
            <MoogKnob label="MOD"   size="sm" value={modDepth} onChange={setModDepth} defaultValue={0.0} />
          </div>
          {/* selectorRowEmissive: this row holds only lit hardware, so it is exempt
              from the lights-out fade that silences the printed selector rows. */}
          <div className={`${styles.selectorRow} ${styles.selectorRowEmissive}`}>
            {/* Division screen — a permanent piece of hardware (the panel never gains
                or loses parts), DARK while free-running and lit only once a clock is
                patched into SYNC. Read-only: the RATE knob picks the division. */}
            <div className={`${styles.lfoDivScreen} ${synced ? styles.lfoDivScreenOn : ''}`}
              title={synced
                ? 'LFO cycle length — the RATE knob selects it while synced'
                : 'Patch a clock into SYNC to lock the LFO to tempo'}>
              <span className={styles.lfoDivScreenText}>{synced ? lfoSyncLabelForRate(rate) : ''}</span>
            </div>
            <ModeIndicator labels={['FREE', 'SYNC']} active={synced}
              title={synced
                ? 'Locked to Transport tempo — unpatch SYNC to free-run'
                : 'Patch a clock (e.g. SEQ) into SYNC to lock the LFO to tempo'} />
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
      // Phase 61: skip while the module's contents are content-visibility
      // skipped — the buffer isn't composited and the projection math is wasted.
      if (canvas.checkVisibility && !canvas.checkVisibility({ contentVisibilityAuto: true })) { lastT = t; return; }
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
  const p = number === 1 ? 'reverb' : `reverb${number}`;
  const saved = useSavedSettings(p);
  const [roomSize, setRoomSize] = useState(saved.roomSize ?? 0.7);
  const [wet,      setWet]      = useState(saved.wet      ?? 0.0);
  // DAMP default 0.5 maps to exactly 3000 Hz — the value dampening was hardcoded to
  // before this knob existed, so an untouched reverb is unchanged. (Phase 70)
  const [damp,     setDamp]     = useState(saved.damp     ?? 0.5);
  useModulePersist(p, { roomSize, wet, damp });

  // Ref mirrors for the Aura rAF loop — the loop reads these each frame so it
  // never stale-captures knob state and never restarts on knob changes.
  const wetRef  = useRef(wet);
  const roomRef = useRef(roomSize);
  useEffect(() => { wetRef.current = wet; roomRef.current = roomSize; }, [wet, roomSize]);

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ roomSize, wet, damp });
  }, [roomSize, wet, damp, onParamUpdate]);

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
            <MoogKnob label="DAMP" size="md" value={damp}     onChange={setDamp}     defaultValue={0.5} />
            <MoogKnob label="MIX"  size="md" value={wet}      onChange={setWet}      defaultValue={0.0} />
          </div>
          <PlateDivider />
          {/* Jack cluster left, Aura screen to its right (Phase 70 layout):
              IN / OUT paired on top, MIX CV centred beneath them. */}
          <div className={styles.revBottomRow}>
            <div className={styles.revJackBlock}>
              <div className={styles.revJackPair}>
                <Jack id={`${p}-in`}  label="IN" />
                <Jack id={`${p}-out`} label="OUT" />
              </div>
              <Jack id={`${p}-mix-cv`} label="MIX CV" />
            </div>
            <AuraDisplay getData={getAuraData} wetRef={wetRef} roomRef={roomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ gain, envAmt, cv2Amt, lin }) — all live (Phase 71, CV 2 Phase 77).
//   GAIN    initial/bias level (0 = closed, 1 = fully open). CV sums on top, so
//           set GAIN = 0 and patch an envelope to CV 1 for full gating.
//   CV 1/2  independent attenuators on the two control inputs, which sum into one
//           response curve. Two inputs exist so an envelope and an LFO can be
//           balanced against each other — with one shared attenuator, softening the
//           envelope also killed the tremolo.
//   LOG/LIN response curve for the summed CV — the 902's LIN/EXP switch. The lever
//           had no click handler and no state at all before Phase 71.
// getLedValue() — stable getter (pre-bound in MoogShell) for the output meter.
function VcaModule({ onParamUpdate, getLedValue, number = 1 }) {
  const p = number === 1 ? 'vca' : `vca${number}`;
  const saved = useSavedSettings(p);
  const [gain, setGain]     = useState(saved.gain   ?? 0.5);
  // `envAmt` is the CV 1 attenuator. Legacy key name kept deliberately — the knob was
  // labelled ENV AMT until Phase 77, and renaming the key would silently reset it to
  // 1.0 in every rack where it had been dialled in.
  const [envAmt, setEnvAmt] = useState(saved.envAmt ?? 1.0);
  // Defaults to full, matching CV 1: a patched cable that does nothing until you find
  // a second knob is the dead-control trap in reverse.
  const [cv2Amt, setCv2Amt] = useState(saved.cv2Amt ?? 1.0);
  // Default LIN = the pre-Phase-71 response, so saved racks sound unchanged.
  const [lin, setLin]       = useState(saved.lin    ?? true);
  useModulePersist(p, { gain, envAmt, cv2Amt, lin });

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ gain, envAmt, cv2Amt, lin });
  }, [gain, envAmt, cv2Amt, lin, onParamUpdate]);

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
            <MoogKnob label="GAIN"    size="lg" value={gain}   onChange={setGain}   defaultValue={0.5}
              hint="Initial gain — the level that passes with no CV patched. Set to 0 for full envelope gating." />
            {/* Both attenuators are `sm` so they read as a matched pair, and so the added
                knob costs ~48px rather than ~76px of row width. .knobRow wraps, so a
                narrow column degrades to two lines instead of overflowing. */}
            <MoogKnob label="CV 1" size="sm" value={envAmt} onChange={setEnvAmt} defaultValue={1.0}
              hint="Attenuator on the CV 1 input — how far that control voltage opens the amp." />
            <MoogKnob label="CV 2" size="sm" value={cv2Amt} onChange={setCv2Amt} defaultValue={1.0}
              hint="Attenuator on the CV 2 input. Sums with CV 1 before the LOG/LIN curve, so an envelope and an LFO can be balanced independently." />
            <ToggleSwitch labels={['LOG', 'LIN']} active={lin} onToggle={() => setLin(v => !v)}
              title="CV response: LIN = voltage-proportional; LOG = decibel-proportional, the natural-sounding decay." />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}   label="IN" />
            <Jack id={`${p}-cv`}   label="CV 1" />
            <Jack id={`${p}-cv2`}  label="CV 2" />
            <Jack id={`${p}-out`}  label="OUT" />
            {/* Output lamp — deliberately in the JACK row, not the knob row or the
                header. Both flex rows wrap, so their min-content is their widest
                single child; a 17px lamp added to the narrower row (jacks ≈ 134px
                vs knobs ≈ 210px) changes neither the module's min-content nor its
                line count, so rack layout and fit() are untouched (Phase 55 trap).
                It also lands where it belongs — beside the OUT jack. */}
            <div className={styles.vcaOutLed}>
              <Led getValue={getLedValue ?? ZERO_GETTER} color="green" />
            </div>
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
  const envId = label.toLowerCase().replace(/\s+/g, ''); // "env1" or "env2"
  const saved = useSavedSettings(envId);
  const [attack,  setAttack]  = useState(saved.attack  ?? 0.1);
  const [decay,   setDecay]   = useState(saved.decay   ?? 0.3);
  const [sustain, setSustain] = useState(saved.sustain ?? 0.7);
  const [release, setRelease] = useState(saved.release ?? 0.4);
  useModulePersist(envId, { attack, decay, sustain, release });

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate(envId, { attack, decay, sustain, release });
  }, [attack, decay, sustain, release, envId, onParamUpdate]);

  // The manual GATE button must only RELEASE what it itself opened. Firing release on
  // any mouseup/mouseleave meant that merely dragging the pointer across the button —
  // or releasing a click that began somewhere else — cut a note a patched sequencer or
  // keyboard gate was holding open. Ref, not state: this is pointer bookkeeping and has
  // no business re-rendering the module.
  const gateHeldRef = useRef(false);
  const gateDown = () => { gateHeldRef.current = true;  onGate?.(envId, true); };
  const gateUp   = () => { if (!gateHeldRef.current) return; gateHeldRef.current = false; onGate?.(envId, false); };

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
              onMouseDown={gateDown}
              onMouseUp={gateUp}
              onMouseLeave={gateUp}
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
  { type: 'vowel', label: '+ VOWEL',  max: 4,  width: 360 },
  { type: 'panner', label: '+ PAN',   max: 8,  width: 300 },
  { type: 'chronos', label: '+ DELAY', max: 4, width: 420 },
  { type: 'folder', label: '+ FOLD',  max: 8, width: 300 },
];
const DYN_WIDTH = Object.fromEntries(DYN_TYPES.map(t => [t.type, t.width]));

// ── Rack store (Phase 60f) ── one localStorage record for the whole custom
// rack: { modules: [{ id, type, num }], cables: [{ from, to, color }],
//         settings: { [instanceId]: {knob/switch values} } }.
// `settings` (Phase 63) persists every module's knob/switch positions keyed by
// canonical instance id (the jack prefix — `vco1`, `vcf`, `seq2`…). Writes
// happen ONLY from user event handlers / user-driven provider callbacks (the
// Phase 60c StrictMode wipe lesson — `useModulePersist` enforces this by only
// writing when a value differs from what's stored). v1 (types only, no cables)
// migrates transparently on read.
const RACK_STORE_KEY = 'moog-rack-v2';

// Phase 61b: the content-visibility culling manager only engages above this
// cabinet layout height. Below it (default rack 1799 px, modest customs), the
// rack idles fine uncalled and scrolls smoothest fully rendered — culling
// there only churns Layerize passes and makes scrolling choppy. Between the
// default 1799 and a genuinely large rack's 3415; layout px, zoom-independent.
const CULL_MIN_NATH = 2500;
function readRackStore() {
  try {
    const v2 = JSON.parse(localStorage.getItem(RACK_STORE_KEY) ?? 'null');
    if (v2) return { modules: v2.modules ?? [], cables: v2.cables ?? [], settings: v2.settings ?? {} };
    const v1 = JSON.parse(localStorage.getItem('moog-rack-dyn-v1') ?? 'null');
    if (v1) return { modules: v1.modules ?? [], cables: [], settings: {} }; // v1: types only → ids re-mint
  } catch (_) {}
  return { modules: [], cables: [], settings: {} };
}
function updateRackStore(patch) {
  try {
    localStorage.setItem(RACK_STORE_KEY, JSON.stringify({ ...readRackStore(), ...patch }));
  } catch (_) {}
}

// ── Per-module settings persistence (Phase 63) ────────────────────────────
// Every module keeps its knob/switch positions in local useState. These helpers
// let a module (1) seed that state from the store on mount and (2) persist
// changes back, so a reload / .moog load restores the exact patch — not just
// which modules and cables exist (Phase 60f) but every control position too.
function readModuleSettings(id) {
  return readRackStore().settings?.[id] ?? {};
}
function writeModuleSettings(id, values) {
  updateRackStore({ settings: { ...(readRackStore().settings ?? {}), [id]: values } });
}
// Read a module's saved settings ONCE at mount (lazy) — used to seed useState
// defaults. Returns {} for a never-touched module → each field falls back to
// its own default via `?? default`.
function useSavedSettings(id) {
  return useState(() => readModuleSettings(id))[0];
}
// Persist `values` (the module's full current control snapshot) whenever it
// changes, debounced 200 ms to coalesce a knob drag into one write. Writes ONLY
// when the snapshot differs from what's stored — so mount-time seeding (and
// StrictMode's double-effect) never writes, honoring the "user events only"
// rule (Phase 60c). JSON-string dep covers nested arrays (seq steps, FFB bands).
function useModulePersist(id, values) {
  const json = JSON.stringify(values);
  useEffect(() => {
    const t = setTimeout(() => {
      if (JSON.stringify(readModuleSettings(id)) !== json) writeModuleSettings(id, JSON.parse(json));
    }, 200);
    return () => clearTimeout(t);
  }, [id, json]);
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
  const saved = useSavedSettings('io'); // singleton
  const [masterVol, setMasterVol] = useState(saved.masterVol ?? 0.7);
  const [chVols, setChVols] = useState(saved.chVols ?? [0.8, 0.8, 0.8, 0.8]);
  useModulePersist('io', { masterVol, chVols });

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
  const saved = useSavedSettings(p);
  const [scale,    setScale]    = useState(saved.scale    ?? 'MAJ');
  const [root,     setRoot]     = useState(saved.root     ?? 0);   // 0 = C
  const [octShift, setOctShift] = useState(saved.octShift ?? 0);   // −3 to +3 octaves
  const [bypass,   setBypass]   = useState(saved.bypass   ?? false);
  useModulePersist(p, { scale, root, octShift, bypass });

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
  const saved = useSavedSettings(p);
  const [steps, setSteps] = useState(() => saved.steps ??
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i],
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }))
  );
  const [division,   setDivision]   = useState(saved.division   ?? '1m');
  const [rootOctave, setRootOctave] = useState(saved.rootOctave ?? 0);
  const [glide,      setGlide]      = useState(saved.glide      ?? 0); // glide time in seconds (0–1.5)
  useModulePersist(p, { steps, division, rootOctave, glide });

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
  const saved = useSavedSettings(p);
  const [steps, setSteps] = useState(() => saved.steps ??
    Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true, prob: 1 }))
  );
  const [tempo, setTempoState] = useState(saved.tempo ?? 120);
  const [glide, setGlide]       = useState(saved.glide ?? 0);
  useModulePersist(p, { steps, tempo, glide });
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
function ChorusModule({ onParamUpdate, isPowered = false, number = 1 }) {
  const p = number === 1 ? 'chorus' : `chorus${number}`;
  const saved = useSavedSettings(p);
  const [rate,  setRate]  = useState(saved.rate  ?? 0.3);
  const [depth, setDepth] = useState(saved.depth ?? 0.5);
  const [wet,   setWet]   = useState(saved.wet   ?? 0.0);
  // Phase 70. FBK default 0 = no feedback, so the module still starts as a plain
  // chorus; DELAY default 0.25 ≈ 3.56 ms, matching the value it was fixed at.
  const [feedback, setFeedback] = useState(saved.feedback ?? 0.0);
  const [delay,    setDelay]    = useState(saved.delay    ?? 0.25);
  const [tone,     setTone]     = useState(saved.tone     ?? 0.75);
  useModulePersist(p, { rate, depth, wet, feedback, delay, tone });

  // Seed from the RESTORED rate, not a hardcoded 0.3 — a saved rack whose BBD was
  // parked at a different rate flashed its LED at the wrong speed until the first
  // param effect ran.
  const rateHzRef = useRef(0.1 * Math.pow(50, saved.rate ?? 0.3));

  useEffect(() => {
    rateHzRef.current = 0.1 * Math.pow(50, rate);
    onParamUpdate?.({ rate, depth, wet, feedback, delay, tone });
  }, [rate, depth, wet, feedback, delay, tone, onParamUpdate]);

  // This LED is SYNTHETIC (driven by Date.now(), not by signal), so unlike every
  // meter-fed LED on the rack it does not go dark by itself when the power is off —
  // it has to be gated explicitly, or it keeps pulsing on a dead rack.
  const poweredRef = useRef(isPowered);
  useEffect(() => { poweredRef.current = isPowered; }, [isPowered]);

  // Stable getter — reads refs each frame, never changes reference so Led's rAF never restarts.
  const getRateFlash = useCallback(() =>
    poweredRef.current
      ? (Math.sin(Date.now() * 0.001 * rateHzRef.current * Math.PI * 2) + 1) / 2
      : 0
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
          {/* Second row (Phase 70) — sm knobs so six controls still fit the BBD's
              280px slot without the row wrapping. */}
          <div className={styles.knobRow}>
            <MoogKnob label="FBK"   size="sm" value={feedback} onChange={setFeedback} defaultValue={0.0} />
            <MoogKnob label="DELAY" size="sm" value={delay}    onChange={setDelay}    defaultValue={0.25} />
            <MoogKnob label="TONE"  size="sm" value={tone}     onChange={setTone}     defaultValue={0.75} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}      label="IN" />
            <Jack id={`${p}-rate-cv`} label="RATE CV" />
            <Jack id={`${p}-out`}     label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Vowel / Formant filter bank (Phase 64) ────────────

const VOWEL_LETTERS = ['A', 'E', 'I', 'O', 'U'];

// Formant "Space Display" — log-frequency spectrum of the module output, drawn
// on the Aura-style OLED screen. The bandpass resonances appear as the formant
// bumps, so the display literally shows the vowel shape being produced. Same
// zero-re-render canvas-in-rAF pattern as AuraDisplay (skips while hidden /
// content-visibility-culled).
const VOW_W = 208, VOW_H = 92;
const VOW_FMIN = 150, VOW_FMAX = 5000;
function FormantDisplay({ getData }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (canvas.offsetParent === null) return;
      if (canvas.checkVisibility && !canvas.checkVisibility({ contentVisibilityAuto: true })) return;
      ctx.clearRect(0, 0, VOW_W, VOW_H);
      // faint baseline grid
      ctx.strokeStyle = 'rgba(93,202,165,0.10)';
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= 4; gx++) { const x = (gx / 4) * VOW_W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, VOW_H); ctx.stroke(); }

      const data = getData?.(); // Float32Array of FFT dB values, or null (unpowered)
      if (!data || !data.length) return;
      const nyquist = 22050;
      const hzPerBin = nyquist / data.length;
      ctx.beginPath();
      ctx.moveTo(0, VOW_H);
      for (let px = 0; px < VOW_W; px++) {
        const frac = px / (VOW_W - 1);
        const freq = VOW_FMIN * Math.pow(VOW_FMAX / VOW_FMIN, frac); // log-frequency x
        const bin  = Math.min(data.length - 1, Math.round(freq / hzPerBin));
        const v    = Math.max(0, Math.min(1, (data[bin] + 90) / 78)); // dB → 0..1
        ctx.lineTo(px, VOW_H - v * (VOW_H - 4));
      }
      ctx.lineTo(VOW_W, VOW_H);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, VOW_H);
      grad.addColorStop(0, 'rgba(93,202,165,0.42)');
      grad.addColorStop(1, 'rgba(93,202,165,0.04)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,230,190,0.95)';
      ctx.lineWidth = 1.4;
      ctx.shadowBlur = 5;
      ctx.shadowColor = 'rgba(93,202,165,0.8)';
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [getData]);
  return (
    <div className={styles.auraScreen}>
      <canvas ref={canvasRef} width={VOW_W} height={VOW_H} className={styles.auraCanvas} />
    </div>
  );
}

// onParamUpdate({ vowel, shape }) — VOWEL morphs A→E→I→O→U (0..1), SHAPE scales
// the whole formant set (vocal-tract length). getAnalyserData() feeds the display.
function VowelModule({ number = 1, onParamUpdate, getAnalyserData }) {
  const p = `vowel${number}`; // dynamic-only; id = jack prefix
  const saved = useSavedSettings(p);
  const [vowel, setVowel] = useState(saved.vowel ?? 0.5); // 0.5 → 'I'
  const [shape, setShape] = useState(saved.shape ?? 0.5); // 0.5 → tract scale 1.0
  // DIRECT mode (Phase 75). Defaults to CHAIN so a saved rack that predates this is
  // completely unchanged — the whole feature is inert until MODE is clicked.
  const [direct, setDirect] = useState(saved.direct ?? false);
  const [from, setFrom]     = useState(saved.from ?? 4);  // U
  const [to,   setTo]       = useState(saved.to   ?? 0);  // A
  useModulePersist(p, { vowel, shape, direct, from, to });

  useEffect(() => {
    onParamUpdate?.({ vowel, shape, direct, from, to });
  }, [vowel, shape, direct, from, to, onParamUpdate]);

  // In DIRECT the knob is the position along the FROM→TO line, so the readout has to
  // report that blend rather than a position on the A..U chain.
  const letter = direct
    ? (vowel <= 0.01 ? VOWEL_LETTERS[from]
      : vowel >= 0.99 ? VOWEL_LETTERS[to]
      : `${VOWEL_LETTERS[from]}\u2009\u2192\u2009${VOWEL_LETTERS[to]}`)
    : VOWEL_LETTERS[Math.max(0, Math.min(4, Math.round(vowel * 4)))];
  const cycleFrom = () => setFrom(v => (v + 1) % 5);
  const cycleTo   = () => setTo(v => (v + 1) % 5);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VOWEL</span>
            <span className={styles.plateSub}>FORMANT FILTER BANK</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label={`VOWEL · ${letter}`} size="lg" value={vowel} onChange={setVowel} defaultValue={0.5}
              hint={direct
                ? 'Manual position along the FROM → TO line. A CV patched into FORM CV rides on top of it.'
                : 'Position along the A-E-I-O-U chain. A CV patched into FORM CV rides on top of it.'} />
            <MoogKnob label="SHAPE" size="md" value={shape} onChange={setShape} defaultValue={0.5}
              hint="Vocal-tract scale — shifts all three formants together. Smaller = smaller head." />
          </div>
          {/* MODE + FROM/TO. FROM and TO are dimmed in CHAIN rather than hidden: they
              are real hardware that simply isn't in circuit yet, the same treatment the
              LFO's division screen gets before a clock is patched (Phase 70). Hiding
              them would also change the module's height between modes. */}
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={() => setDirect(v => !v)}
              title={direct
                ? 'DIRECT: the sweep travels straight between FROM and TO, touching no other vowel. Click for CHAIN.'
                : 'CHAIN: the sweep walks the whole A-E-I-O-U road. Click for DIRECT (pick two vowels and go straight between them).'}>
              <span className={styles.selectorLabel}>MODE</span>
              <span className={styles.selectorValue}>{direct ? 'DIRECT' : 'CHAIN'}</span>
            </div>
            <div className={`${styles.selectorGroup} ${direct ? '' : styles.selectorGroupIdle}`}
              onClick={direct ? cycleFrom : undefined}
              title={direct ? 'Vowel the sweep starts from' : 'Only active in DIRECT mode'}>
              <span className={styles.selectorLabel}>FROM</span>
              <span className={styles.selectorValue}>{VOWEL_LETTERS[from]}</span>
            </div>
            <div className={`${styles.selectorGroup} ${direct ? '' : styles.selectorGroupIdle}`}
              onClick={direct ? cycleTo : undefined}
              title={direct ? 'Vowel the sweep travels to' : 'Only active in DIRECT mode'}>
              <span className={styles.selectorLabel}>TO</span>
              <span className={styles.selectorValue}>{VOWEL_LETTERS[to]}</span>
            </div>
          </div>
          <FormantDisplay getData={getAnalyserData} />
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}     label="IN" />
            <Jack id={`${p}-cv-in`}  label="FORM CV" />
            <Jack id={`${p}-out`}    label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Voltage-Controlled Panner (Phase 67) ────────────
// onParamUpdate({ pan, depth }) — PAN positions the source -1..+1 (0..1 knob,
// 0.5 = centre); CV DEPTH scales an external LFO/CV patched to PAN CV. getL/getR
// feed the two equal-power stereo LEDs. Dynamic-only.
function PanningModule({ number = 1, onParamUpdate, getL, getR }) {
  const p = `panner${number}`; // dynamic-only; id = jack prefix
  const saved = useSavedSettings(p);
  const [pan, setPan]     = useState(saved.pan ?? 0.5);   // 0.5 → centre
  const [depth, setDepth] = useState(saved.depth ?? 0.5); // CV attenuator
  useModulePersist(p, { pan, depth });

  useEffect(() => { onParamUpdate?.({ pan, depth }); }, [pan, depth, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>PANNER</span>
            <span className={styles.plateSub}>VC STEREO PANNER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="PAN" size="lg" value={pan} onChange={setPan} defaultValue={0.5} />
            <MoogKnob label="CV DEPTH" size="md" value={depth} onChange={setDepth} defaultValue={0.5} />
          </div>
          <div className={styles.knobRow}>
            <Led getValue={getL} color="green" label="L" />
            <Led getValue={getR} color="green" label="R" />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}    label="IN" />
            <Jack id={`${p}-cv-in`} label="PAN CV" />
            <Jack id={`${p}-out`}   label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Chronos Multi-Zone Delay (Phase 68) ────────────
const CHR_ZONES = ['micro', 'mini', 'macro'];
const CHR_ZONE_LABELS = { micro: 'MICRO', mini: 'MINI', macro: 'MACRO' };
const CHR_W = 208, CHR_H = 92; // canvas backing px (matches FormantDisplay)

// Echo-ring visualizer: rings pulse outward, ring gap tracks delay time (log),
// brightness/line-weight track feedback energy. Same rAF + Phase-61 visibility
// gates as AuraDisplay. getData() → { energy 0..1, delaySec }.
function ChronosDisplay({ getData }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cx = CHR_W / 2, cy = CHR_H / 2;
    let raf, energySm = 0, phase = 0, lastT = performance.now() * 0.001;
    const L0 = Math.log(0.003), LSPAN = Math.log(3) - Math.log(0.003);
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = performance.now() * 0.001;
      if (canvas.offsetParent === null) { lastT = t; return; }
      if (canvas.checkVisibility && !canvas.checkVisibility({ contentVisibilityAuto: true })) { lastT = t; return; }
      const dt = Math.min(0.1, t - lastT); lastT = t;
      const d = getData?.();
      const energy = d ? Math.min(1, d.energy) : 0;
      energySm += (energy - energySm) * 0.2;
      const delaySec = d ? d.delaySec : 0.2;
      phase = (phase + dt * (0.3 + energySm * 1.4)) % 1;
      ctx.clearRect(0, 0, CHR_W, CHR_H);
      const norm = Math.max(0, Math.min(1, (Math.log(Math.max(0.003, delaySec)) - L0) / LSPAN));
      const ringGap = 7 + norm * 22;
      const maxR = CHR_W * 0.52;
      for (let r = ringGap * phase; r < maxR; r += ringGap) {
        const a = (1 - r / maxR) * (0.10 + energySm * 0.6);
        ctx.strokeStyle = `rgba(93,202,165,${a})`;
        ctx.lineWidth = 1 + energySm * 1.3;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(120,230,190,${0.35 + energySm * 0.6})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4 + energySm * 3.2, 0, Math.PI * 2);
      ctx.fill();
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [getData]);
  return (
    <div className={styles.auraScreen}>
      <canvas ref={canvasRef} width={CHR_W} height={CHR_H} className={styles.auraCanvas} />
    </div>
  );
}

// onParamUpdate({ zone, time, repeats, halo, color, mix }) — full state every
// change (the engine derives all node values from the complete set). Dynamic-only.
function ChronosDelayModule({ number = 1, onParamUpdate, getDisplay }) {
  const p = `chronos${number}`; // dynamic-only; id = jack prefix
  const saved = useSavedSettings(p);
  const [zone, setZone]       = useState(saved.zone ?? 'mini');
  const [time, setTime]       = useState(saved.time ?? 0.5);
  const [repeats, setRepeats] = useState(saved.repeats ?? 0.45);
  const [halo, setHalo]       = useState(saved.halo ?? 0.3);
  const [color, setColor]     = useState(saved.color ?? 0.6);
  const [mix, setMix]         = useState(saved.mix ?? 0.5);
  useModulePersist(p, { zone, time, repeats, halo, color, mix });

  useEffect(() => {
    onParamUpdate?.({ zone, time, repeats, halo, color, mix });
  }, [zone, time, repeats, halo, color, mix, onParamUpdate]);

  const cycleZone = () => setZone(z => CHR_ZONES[(CHR_ZONES.indexOf(z) + 1) % CHR_ZONES.length]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>CHRONOS</span>
            <span className={styles.plateSub}>MULTI-ZONE DELAY</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleZone} title="Click to cycle delay zone (Micro comb / Mini / Macro echo)">
              <span className={styles.selectorLabel}>ZONE</span>
              <span className={styles.selectorValue}>{CHR_ZONE_LABELS[zone]}</span>
            </div>
          </div>
          <div className={styles.knobRow}>
            <MoogKnob label="TIME"    size="lg" value={time}    onChange={setTime}    defaultValue={0.5} />
            <MoogKnob label="REPEATS" size="md" value={repeats} onChange={setRepeats} defaultValue={0.45} />
            <MoogKnob label="HALO"    size="md" value={halo}    onChange={setHalo}    defaultValue={0.3} />
          </div>
          <div className={styles.knobRow}>
            <MoogKnob label="COLOR" size="md" value={color} onChange={setColor} defaultValue={0.6} />
            <MoogKnob label="MIX"   size="md" value={mix}   onChange={setMix}   defaultValue={0.5} />
          </div>
          <ChronosDisplay getData={getDisplay} />
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}      label="IN" />
            <Jack id={`${p}-time-cv`} label="TIME CV" />
            <Jack id={`${p}-rep-cv`}  label="REP CV" />
            <Jack id={`${p}-out`}     label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Wavefolder (Phase 68c) ────────────
const FLD_W = 208, FLD_H = 92;

// STILL shape preview — draws one cycle of a reference sine pushed through the
// EXACT fold math the engine uses (`sin((drive·x + bias)·π·FOLDS)`), computed
// straight from the FOLD / SYM knobs. No live audio, so nothing scrolls: it just
// shows the shape the folder is imposing and morphs only when you turn a knob.
const FLD_FOLDS = 4; // must match the engine's folder factory
function FolderScope({ fold, symmetry }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, FLD_W, FLD_H);
    const drive = 0.2 + fold * 0.8;   // matches updateDynModuleParams 'folder'
    const bias  = symmetry - 0.5;
    // faint zero line for reference
    ctx.strokeStyle = 'rgba(93,202,165,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, FLD_H / 2); ctx.lineTo(FLD_W, FLD_H / 2); ctx.stroke();
    // the folded shape
    ctx.beginPath();
    for (let i = 0; i < FLD_W; i++) {
      const inp    = Math.sin((i / (FLD_W - 1)) * 2 * Math.PI); // one cycle of a sine input
      const folded = Math.sin((inp * drive + bias) * Math.PI * FLD_FOLDS);
      const y = FLD_H / 2 - folded * (FLD_H / 2 - 5);
      if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.strokeStyle = 'rgba(120,230,190,0.95)';
    ctx.lineWidth = 1.6;
    ctx.shadowBlur = 5;
    ctx.shadowColor = 'rgba(93,202,165,0.8)';
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [fold, symmetry]);
  return (
    <div className={styles.auraScreen}>
      <canvas ref={canvasRef} width={FLD_W} height={FLD_H} className={styles.auraCanvas} />
    </div>
  );
}

// onParamUpdate({ fold, symmetry, output }) — a sine wavefolder. FOLD drives the
// signal into the fold curve (more folds = more harmonics); SYM offsets for
// asymmetric folding; LEVEL is output makeup. Processes ANY audio in. Dynamic-only.
function WavefolderModule({ number = 1, onParamUpdate }) {
  const p = `folder${number}`; // dynamic-only; id = jack prefix
  const saved = useSavedSettings(p);
  const [fold, setFold]         = useState(saved.fold ?? 0.35);
  const [symmetry, setSymmetry] = useState(saved.symmetry ?? 0.5);
  const [output, setOutput]     = useState(saved.output ?? 0.5);
  useModulePersist(p, { fold, symmetry, output });

  useEffect(() => { onParamUpdate?.({ fold, symmetry, output }); }, [fold, symmetry, output, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          {number > 1 && <span className={styles.plateNum}>{number}</span>}
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>FOLD</span>
            <span className={styles.plateSub}>WAVEFOLDER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="FOLD"  size="lg" value={fold}     onChange={setFold}     defaultValue={0.35} />
            <MoogKnob label="SYM"   size="md" value={symmetry} onChange={setSymmetry} defaultValue={0.5} />
            <MoogKnob label="LEVEL" size="md" value={output}   onChange={setOutput}   defaultValue={0.5} />
          </div>
          <FolderScope fold={fold} symmetry={symmetry} />
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}      label="IN" />
            <Jack id={`${p}-fold-cv`} label="FOLD CV" />
            <Jack id={`${p}-out`}     label="OUT" />
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
  const p = number === 1 ? 'kick' : `kick${number}`; // jack prefix = engine instance id
  const saved = useSavedSettings(p);
  const [tune,     setTune]     = useState(saved.tune     ?? 0.2);  // 0–1 → 40–200 Hz
  const [pitchEnv, setPitchEnv] = useState(saved.pitchEnv ?? 0.7);  // 0–1 → 0–5 octaves drop
  const [decay,    setDecay]    = useState(saved.decay    ?? 0.35); // 0–1 → 0.05–2 s
  const [click,    setClick]    = useState(saved.click    ?? 0.3);  // 0–1 gain
  // Centre = exactly the 2 kHz the click highpass used to be hardcoded at, so saved
  // racks are unchanged until the knob is touched.
  const [clickTone, setClickTone] = useState(saved.clickTone ?? 0.5);
  useModulePersist(p, { tune, pitchEnv, decay, click, clickTone });

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
      clickTone,
    });
  }, [tune, pitchEnv, decay, click, clickTone, onParamUpdate]);

  // Clear a pending flash-off on unmount so a removed instance can't touch a detached
  // node 80 ms later. Harmless today (the callback guards on ledRef) but free to do right.
  useEffect(() => () => clearTimeout(flashTimer.current), []);

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
            <MoogKnob label="TUNE"  size="md" value={tune}     onChange={setTune}     defaultValue={0.2}
              hint="Fundamental pitch, 40–200 Hz. With a cable in TUNE CV this becomes a TRANSPOSE around the incoming pitch instead (centre = unchanged)." />
            <MoogKnob label="P.ENV" size="md" value={pitchEnv} onChange={setPitchEnv} defaultValue={0.7}  />
            <MoogKnob label="DECAY" size="md" value={decay}    onChange={setDecay}    defaultValue={0.35} />
          </div>
          <div className={styles.gateBtnRow}>
            <div ref={ledRef} className={styles.kickLed} style={{ opacity: 0.12 }} />
            <span className={styles.gateBtnLabel}>TRIG</span>
            <button
              className={styles.gateBtn}
              onMouseDown={() => onTrigger?.(flash)}
            />
            {/* Beater pair lives in the TRIG row, not the knob row (Phase 80a).
                Five knobs wrapped .knobRow onto a second line and made the module
                taller; this row had spare width and its height was set by the 26px
                button, so two sm knobs land here nearly for free. CLICK (level) and
                TONE (highpass) shape the same transient, so they sit adjacent, with
                the trigger controls to their left. .gateBtnRow is align-items:center,
                so both centre against the lamp and button with no CSS change. */}
            <MoogKnob label="CLICK" size="sm" value={click}     onChange={setClick}     defaultValue={0.3}
              hint="Level of the beater transient." />
            <MoogKnob label="TONE"  size="sm" value={clickTone} onChange={setClickTone} defaultValue={0.5}
              hint="Beater tone — highpass on the click, 333 Hz (soft mallet thud) to 12 kHz (sharp tick). Centre is the original 2 kHz." />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-gate-in`}  label="GATE" />
            <Jack id={`${p}-click-in`} label="ACCT" />
            <Jack id={`${p}-tune-cv`}  label="TUNE CV" />
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
  const p = number === 1 ? 'ffb' : `ffb${number}`; // jack prefix = engine instance id
  const saved = useSavedSettings(p);
  const [bands,  setBands]  = useState(() => saved.bands ?? Array(FFB_BANDS.length).fill(0.75));
  const [master, setMaster] = useState(saved.master ?? 1.0);
  useModulePersist(p, { bands, master });

  // DOM refs for per-band LEDs — written by rAF loop (Zero-Re-render Rule)
  const ledRefs = useRef([]);
  const rafRef  = useRef(null);

  useEffect(() => {
    onParamUpdate?.({ bands, master });
  }, [bands, master, onParamUpdate]);

  // rAF loop: reads FFT from the POST-BANK analyser, computes per-band peak, writes
  // LED opacity — so pulling a band's knob down visibly darkens its LED.
  useEffect(() => {
    if (!getAnalyserData) return;
    // Tone.Analyser('fft', 512) → 512 bins over fftSize 1024, so a bin is
    // sampleRate/1024 wide. The old `44100 / 512` was double that AND ignored the
    // device rate, so every band LED read roughly an octave low.
    const BIN_HZ = fftBinHz(512);
    const lastVals    = new Array(FFB_BANDS.length).fill(-1); // Phase 61 dedupe

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
        // Phase 61: quantize + skip-if-unchanged — idle bands stop invalidating paint
        const q = Math.round((0.08 + brightness * 0.92) * 64) / 64;
        if (q !== lastVals[i]) { lastVals[i] = q; el.style.opacity = String(q); }
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
              {/* FLAT — 14 knobs is a lot to reset by hand; returns every band to unity. */}
              <button
                type="button"
                className={styles.ffbFlatBtn}
                onClick={() => setBands(Array(FFB_BANDS.length).fill(0.75))}
                title="Reset all bands to flat (unity)"
              >FLAT</button>
            </div>
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-in`}        label="IN" />
            <Jack id={`${p}-master-cv`} label="MSTR CV" />
            <Jack id={`${p}-sweep-cv`}  label="SWEEP CV" />
            <Jack id={`${p}-out`}       label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── 16-Band Vocoder ────────────

// PROGRAM presets (Phase 72). Each is a set of VOICING knob positions recalled in one
// click — the module has fourteen knobs, and finding a usable robot voice by hand is a
// long afternoon. Clicking a program WRITES the knobs (they visibly move and persist
// normally), rather than applying a hidden offset underneath them: the knobs stay the
// single source of truth, so you can tweak straight from a preset and nothing fights.
//
// Programs deliberately touch VOICE character only. MIX / VOL / MIC / C.MIX / GATE are
// left alone — those are your level, your carrier routing and your room, and a preset
// that reset them would be actively annoying.
const VOC_PROGRAMS = [
  {
    key: 'NUVO',
    title: 'NUVO — crisp, high-intelligibility robot voice: fast tracking, seamless band coverage, real consonants blended in',
    // RES 0.78 = Q ≈ 11, i.e. the VOWEL module's formant resonance. Phase 73 set this to
    // 0.408 (Q 3.45) on the theory that adjacent bands' skirts should exactly meet — that
    // was the wrong target. Contiguous coverage passes the carrier through largely intact,
    // which IS the "loose synth" sound; VOWEL has three filters with big gaps between them
    // and reads as clean and strongly vocal precisely because everything between the
    // formants is discarded. Sparse and resonant, not flat and continuous.
    values: { shift: 0.5, res: 0.78, decay: 0.25, presence: 0.45, clarity: 0.35, hiss: 0.18, buzz: 0.0, shiftRate: 0.5, shiftAmp: 0.0 },
  },
  {
    key: 'TALKBOX',
    title: 'TALK BOX — resonant mid-forward honk with low-end body; consonants deliberately poor, like the real thing',
    // A physical talk box is a driver and a plastic tube: very resonant, mid-heavy,
    // slightly darker formants, and you genuinely cannot say "S" through one — hence
    // CLAR low and HISS off. BUZZ adds the moving-air thump.
    // RES 0.92 = Q ≈ 15.6, past VOWEL's sharpest formant — a tube has a few very strong
    // resonances and almost nothing between them, which is the whole character.
    values: { shift: 0.46, res: 0.92, decay: 0.55, presence: 0.2, clarity: 0.1, hiss: 0.0, buzz: 0.35, shiftRate: 0.5, shiftAmp: 0.0 },
  },
  {
    key: 'ALIEN',
    title: 'ALIEN — formants shifted up into a smaller "head", with a slow drift so the voice never sits still',
    // SHIFT scales the carrier band centres, i.e. it resizes the vocal tract rather
    // than transposing pitch — the classic "not-human" cue. S.AMP adds slow drift.
    values: { shift: 0.78, res: 0.86, decay: 0.35, presence: 0.35, clarity: 0.15, hiss: 0.15, buzz: 0.0, shiftRate: 0.28, shiftAmp: 0.22 },
  },
];

// GATE positions (Phase 72). Discrete rather than continuous on purpose: a noise gate
// is a set-once-for-your-room control, and the vocoder has no spare panel width for
// another knob. Values are normalized 0–1 like every other param, so the engine keeps
// one continuous threshold mapping and this could become a knob later with no change.
const VOC_GATE_STEPS = [
  { key: 'OFF',  value: 0.0,  title: 'GATE OFF — modulator passes at all times (the pre-Phase-72 behaviour)' },
  { key: 'LOW',  value: 0.5,  title: 'GATE LOW — trims a quiet room' },
  { key: 'MID',  value: 0.75, title: 'GATE MID — typical desk/laptop mic' },
  { key: 'HIGH', value: 1.0,  title: 'GATE HIGH — noisy room; may clip quiet singing' },
];

// onParamUpdate({ mix }) — wires the MIX knob to useMoogAudio.
// getAnalyserData() — stable getter for the modulator FFT analyser; drives the 16-seg meter.
// Patch MOD (modulator: voice/drum/sequence) + CARR (carrier: VCOs) in, take OUT to the mixer.
// micStatus is OWNED BY THE SHELL, not by this module (Phase 81). The Tone.UserMedia is
// a singleton shared by every vocoder instance, so per-instance status state let one
// instance read "● LIVE" while the other still read "○ MIC" for the same live mic.
function VocoderModule({ number = 1, onParamUpdate, getAnalyserData, onMicEnable, onMicDisable, onMicGainChange, getMicLevel, micStatus = 'off' }) {
  const p = number === 1 ? 'voc' : `voc${number}`; // jack prefix = engine instance id
  const saved = useSavedSettings(p);
  const [micGain, setMicGain]       = useState(saved.micGain    ?? 0.5);  // built-in mic input level
  const [mix, setMix]               = useState(saved.mix        ?? 1.0);
  const [volume, setVolume]         = useState(saved.volume     ?? 0.5);  // 0.5 = nominal (×3 internal makeup → 3×)
  const [carrierMix, setCarrierMix] = useState(saved.carrierMix ?? 0.0);  // 0 = external carrier only
  const [pwidth, setPwidth]         = useState(saved.pwidth     ?? 0.5);  // 0.5 = square
  const [shift, setShift]           = useState(saved.shift      ?? 0.5);  // 0.5 = no shift
  const [res, setRes]               = useState(saved.res        ?? 0.5);  // 0.5 ≈ base Q
  const [shiftRate, setShiftRate]   = useState(saved.shiftRate  ?? 0.5);
  const [shiftAmp, setShiftAmp]     = useState(saved.shiftAmp   ?? 0.0);
  const [decay, setDecay]           = useState(saved.decay      ?? 0.5);  // 0.5 ≈ base env speed
  const [presence, setPresence]     = useState(saved.presence   ?? 0.0);  // 2.7 kHz cut-through boost
  const [clarity, setClarity]       = useState(saved.clarity    ?? 0.0);
  const [hiss, setHiss]             = useState(saved.hiss       ?? 0.0);
  const [buzz, setBuzz]             = useState(saved.buzz       ?? 0.0);
  const [gate, setGate]             = useState(saved.gate       ?? 0.0);  // 0 = OFF, the pre-Phase-72 behaviour
  // Centre = the drive value hardcoded from Phase 42 to 82, so saved racks are unchanged.
  // Deliberately NOT touched by PROGRAM — it is the control you tune by ear for your own
  // voice and carrier, and a preset stomping it mid-hunt would be maddening.
  const [drive, setDrive]           = useState(saved.drive      ?? 0.5);
  // Last PROGRAM recalled. Purely a readout of what you last pressed — it is NOT
  // re-applied on mount, or every reload would stomp the knobs you tuned afterwards
  // (the Phase 60c "write on user events only" rule).
  const [program, setProgram]       = useState(saved.program    ?? null);
  useModulePersist(p, { micGain, mix, volume, carrierMix, pwidth, shift, res, shiftRate, shiftAmp, decay, presence, clarity, hiss, buzz, gate, drive, program });

  // DOM refs for the 16 spectrum LEDs — written by rAF loop (Zero-Re-render Rule).
  const ledRefs = useRef([]);
  const rafRef  = useRef(null);

  useEffect(() => {
    onParamUpdate?.({ mix, volume, carrierMix, pwidth, shift, res,
                     shiftRate, shiftAmp, decay, presence, clarity, hiss, buzz, gate, drive });
  }, [mix, volume, carrierMix, pwidth, shift, res,
      shiftRate, shiftAmp, decay, presence, clarity, hiss, buzz, gate, drive, onParamUpdate]);

  // PROGRAM / GATE cycling. Both write React state only — the existing param effect
  // above carries the change to the engine, so there is no second writer.
  const KNOB_SETTERS = { shift: setShift, res: setRes, decay: setDecay, presence: setPresence,
                         clarity: setClarity, hiss: setHiss, buzz: setBuzz,
                         shiftRate: setShiftRate, shiftAmp: setShiftAmp };
  const cycleProgram = () => {
    const i = VOC_PROGRAMS.findIndex(pr => pr.key === program);
    const next = VOC_PROGRAMS[(i + 1) % VOC_PROGRAMS.length];
    Object.entries(next.values).forEach(([k, v]) => KNOB_SETTERS[k]?.(v));
    setProgram(next.key);
  };
  const gateIdx  = Math.max(0, VOC_GATE_STEPS.findIndex(g => g.value === gate));
  const gateStep = VOC_GATE_STEPS[gateIdx];
  const cycleGate = () => setGate(VOC_GATE_STEPS[(gateIdx + 1) % VOC_GATE_STEPS.length].value);

  // Built-in mic — INPUT level (knob 0–1 → 0–2×, 0.5 = unity) and enable/disable toggle.
  useEffect(() => {
    onMicGainChange?.(p, { gain: micGain * 2 });   // id-scoped: each instance owns its own gain node
  }, [p, micGain, onMicGainChange]);

  const toggleMic = () => {
    if (micStatus === 'connecting') return;
    if (micStatus === 'on') onMicDisable?.();
    else                    onMicEnable?.();
  };
  const micBtnText = micStatus === 'on'         ? '● LIVE'
                   : micStatus === 'connecting' ? '○ …'
                   : micStatus === 'error'      ? '○ DENIED'
                   :                              '○ MIC';

  // rAF loop: per-band peak from the modulator FFT → LED opacity. Same pattern as FFBModule
  // (FFT 512 → 256 bins, ~86 Hz/bin, dB → 0–1 over a half-octave window per band center).
  useEffect(() => {
    if (!getAnalyserData) return;
    const BIN_HZ   = fftBinHz(512);   // same fix as the FFB meter — see its note
    const lastVals = new Array(VOC_BANDS.length).fill(-1); // Phase 61 dedupe

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
        // Phase 61: quantize + skip-if-unchanged — idle bands stop invalidating paint
        const q = Math.round((0.08 + brightness * 0.92) * 64) / 64;
        if (q !== lastVals[i]) { lastVals[i] = q; el.style.opacity = String(q); }
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
          {/* PROGRAM + GATE live in the HEADER, in the empty space beside the title.
              This module is the `max-content` column of tier row 3, so it sets the
              rack's floor width — and Phase 49 spent real effort trading its height
              down (4×3 knob grid → 6×2). Both axes are therefore expensive: a 7th
              grid column widens the whole rack, a 3rd grid row undoes Phase 49.
              The header is the one place that costs neither — the title block is
              ~215px inside a ~484px module, and these two selectors are shorter
              than the two-line title, so the header box doesn't grow either way.
              Compact (.vocHeadSel) for exactly that reason. */}
          <div className={styles.vocHeadCtrls}>
            <div className={`${styles.selectorGroup} ${styles.vocHeadSel}`} onClick={cycleProgram}
              title={VOC_PROGRAMS.find(pr => pr.key === program)?.title
                ?? 'PROGRAM — click to recall a voicing (NuVo / Talk Box / Alien). Writes the voice knobs; MIX, VOL, MIC and GATE are left alone.'}>
              <span className={styles.selectorLabel}>PROGRAM</span>
              <span className={styles.selectorValue}>{program ?? '--'}</span>
            </div>
            <div className={`${styles.selectorGroup} ${styles.vocHeadSel}`} onClick={cycleGate} title={gateStep.title}>
              <span className={styles.selectorLabel}>GATE</span>
              <span className={styles.selectorValue}>{gateStep.key}</span>
            </div>
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
                <MoogKnob label="RES"   size="sm" value={res}        onChange={setRes}        defaultValue={0.5}
                  hint="Carrier band resonance, Q 1–20. This is the control that decides whether it sounds like a synth or like a voice — high Q cuts sharp formant peaks (VOWEL runs 11–15); low Q passes the carrier through nearly intact." />
                <MoogKnob label="S.RT"  size="sm" value={shiftRate}  onChange={setShiftRate}  defaultValue={0.5} />
                <MoogKnob label="S.AMP" size="sm" value={shiftAmp}   onChange={setShiftAmp}   defaultValue={0.0} />
                <MoogKnob label="DRIVE" size="sm" value={drive}      onChange={setDrive}      defaultValue={0.5}
                  hint="How hard the voice gates the carrier. Too high and every band pins open, so you hear the raw synth with vague vocal colour; too low and it goes thin. Centre is the value this was fixed at until now." />
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

// onBusReady(api) — called once on mount to hand the Workstation a small control
// surface: { getBusNode, resetSequencers, isPowered } (Phase 66 widened it from a
// bare bus getter). recordingActiveRef — a shared ref the Workstation flips true
// while recording the Moog; KeyboardModule reads it to let QWERTY through the
// hidden-page guard so the user can play the Moog live into the take.
export default function MoogShell({ onNavigateHome, onBusReady, recordingActiveRef }) {
  const audio      = useMoogAudio();
  const cabinetRef = useRef(null);
  // Phase 61: the camera closure's live view object (mutated in place) and the
  // module visibility manager — wired ref-to-ref so neither effect depends on
  // the other's lifecycle.
  const cameraViewRef = useRef(null);
  const moduleVisRef  = useRef(null);
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

  // ── Workspace persistence (Phase 63): .moog file export/import + reset ──
  // SAVE/LOAD/RESET all reuse the Phase 60f restore path: the store already
  // holds the entire setup (modules + cables + per-module settings), so SAVE
  // serializes it, LOAD writes it + reloads (the mount-time restore rebuilds
  // everything, seeding each module from `settings`), and RESET clears it +
  // reloads to the pristine default rack. The reload is deliberate — it reuses
  // the proven, StrictMode-safe restore path instead of an error-prone in-place
  // teardown/rebuild, and gives the "fresh instrument start" the reset needs.
  const fileInputRef = useRef(null);
  const saveSetup = useCallback(() => {
    const blob = new Blob([JSON.stringify(readRackStore(), null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `moog-setup-${new Date().toISOString().slice(0, 10)}.moog`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);
  const loadSetup = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.modules)) throw new Error('not a valid .moog setup file');
        localStorage.setItem(RACK_STORE_KEY, JSON.stringify({
          modules:  parsed.modules  ?? [],
          cables:   parsed.cables   ?? [],
          settings: parsed.settings ?? {},
        }));
        try { sessionStorage.setItem('voxdaw-return-page', 'moogmodular'); } catch (_) {}
        window.location.reload();
      } catch (err) {
        window.alert(`Could not load setup: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, []);
  const resetWorkspace = useCallback(() => {
    if (!window.confirm('Reset the workspace? This clears all modules, patch cables and knob positions and returns the rack to its default startup state.')) return;
    localStorage.removeItem(RACK_STORE_KEY);
    localStorage.removeItem('moog-rack-dyn-v1');
    try { sessionStorage.setItem('voxdaw-return-page', 'moogmodular'); } catch (_) {}
    window.location.reload();
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
    vowelData:    () => audio.getVowelAnalyserData(id),
    panL:         () => audio.getPanMeterData(id)?.l ?? 0,
    panR:         () => audio.getPanMeterData(id)?.r ?? 0,
    chronosDisp:  () => audio.getChronosDisplay(id),
    folderScope:  () => audio.getFolderScope(id),
  });

  useEffect(() => {
    audio.setVcoQuantizedCallback(setQuantizedVcos);
    return () => audio.setVcoQuantizedCallback(null);
  }, [audio.setVcoQuantizedCallback]);

  // Register the Moog control surface with Root.js so the Workstation can tap
  // audio, restart the sequence, and check power. All three are stable useCallback
  // refs, so this effect fires once.
  useEffect(() => {
    onBusReady?.({
      getBusNode:      () => audio.getMoogBusNode(),
      resetSequencers: audio.resetSequencers,
      isPowered:       audio.getIsPowered,
    });
  }, [onBusReady, audio.getMoogBusNode, audio.resetSequencers, audio.getIsPowered]);

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
  // The mic is ONE Tone.UserMedia shared by every vocoder instance, so its status lives
  // here rather than in each module — otherwise two instances disagree about whether the
  // same mic is live. 'off' | 'connecting' | 'on' | 'error'; runtime only, never persisted.
  const [micStatus, setMicStatus] = useState('off');
  const handleMicEnable = useCallback(async () => {
    setMicStatus('connecting');
    const ok = await audio.enableMic();
    setMicStatus(ok ? 'on' : 'error');
    return ok;
  }, [audio.enableMic]);
  const handleMicDisable = useCallback(() => { audio.disableMic(); setMicStatus('off'); }, [audio.disableMic]);
  const getLfoLevel    = useCallback(() => audio.getMeterValue('lfo'),    [audio.getMeterValue]);
  const getLfo2Level   = useCallback(() => audio.getMeterValue('lfo2'),   [audio.getMeterValue]);
  // Instantaneous LFO phase for rate LEDs — pulses at the actual modulated rate
  // rather than an averaged RMS level. Reads waveform analyser last sample.
  const getLfoInstant  = useCallback(() => audio.getLfoInstant?.()  ?? 0, [audio.getLfoInstant]);
  const getLfo2Instant = useCallback(() => audio.getLfo2Instant?.() ?? 0, [audio.getLfo2Instant]);
  const getEnv1Level   = useCallback(() => audio.getMeterValue('env1'),   [audio.getMeterValue]);
  const getEnv2Level   = useCallback(() => audio.getMeterValue('env2'),   [audio.getMeterValue]);
  const getEnv3Level   = useCallback(() => audio.getMeterValue('env3'),   [audio.getMeterValue]);
  const getVca1Level   = useCallback(() => audio.getMeterValue('vca'),    [audio.getMeterValue]);
  const getVca2Level   = useCallback(() => audio.getMeterValue('vca2'),   [audio.getMeterValue]);
  const getVca3Level   = useCallback(() => audio.getMeterValue('vca3'),   [audio.getMeterValue]);
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
    cameraViewRef.current = view; // Phase 61: visibility manager reads this live object
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
    // Smooth Retina scrolling is handled structurally by per-MODULE layer
    // promotion (`.module { will-change: transform }`, Phase 61d) — a pan
    // translates ~30 cached module textures instead of blending 130 knob
    // layers, so every component stays visible, full-res and animating with no
    // lag. This transient cabinet promotion just covers the pan itself.
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
      moduleVisRef.current?.update(); // Phase 61: every camera move re-bands visibility
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
      cameraViewRef.current = null; // Phase 61: a remount mints a fresh view object
      shell.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', fit);
    };
  }, []);

  // ── Phase 61: camera-driven module visibility (content-visibility) ──
  // On a VERY LARGE custom rack, per-frame visual writes (LED opacity, meter
  // segments, canvas draws) re-run compositor layerization at a cost that
  // scales with the rack's total paint complexity (~31 ms at 31 added modules
  // — the page locks near 30 fps while powered, even idle). content-visibility
  // removes off-viewport module CONTENTS from the paint artifact, collapsing
  // that per-run cost. The camera owns the promote/demote boundary: modules
  // within ~0.5 viewport of the visible band are pinned 'visible' (promoted
  // ≤2/frame, a screen ahead), returning to 'auto' past 1.0 viewport; after
  // 1.2 s idle a tight 0.05-viewport sweep maximizes skipping. Far state is
  // 'auto' not 'hidden' — a banding miss degrades to browser-rendered content,
  // never a visual hole. contain-intrinsic-size is stamped from each module's
  // measured box so skipping changes NOTHING about layout (fit() natural
  // height byte-identical, jack rects stay valid, ResizeObserver can't feed
  // back). All state in-closure; every write direct (Zero-Re-render Rule).
  //
  // **Phase 61b — SIZE GATE (Dylan-reported scroll regression):** toggling a
  // module's content-visibility invalidates the layer tree → one Layerize pass
  // per toggle. During a scroll the band moves every frame, so the manager
  // churns toggles → a Layerize every frame → the main thread saturates and
  // (because the wheel handler is non-passive main-thread) wheel input lags —
  // choppy scrolling. On a small rack this is PURE COST: it idles fine (~8 ms)
  // without culling, and force-rendering every module scrolls perfectly smooth
  // (matches the "lights out is smooth" observation). Measured: default rack
  // (1799 px / 29 modules) scroll p95 83 ms with the manager vs 16 ms with it
  // off. So the manager engages only when the rack is tall enough that idle
  // culling actually pays — default rack stays fully rendered and smooth.
  // (NOTE: `will-change: transform` on knobs is CORRECT and stays — removing
  // it forces repaint-on-pan and made large-rack scroll *worse*, p95 58→117 ms.)
  useEffect(() => {
    const cab = cabinetRef.current;
    if (!cab) return;
    const clearAll = () => {
      for (const el of cab.querySelectorAll(`.${styles.module}`)) el.style.contentVisibility = '';
    };
    // Layerization pressure only exists while POWERED — that's when the LED /
    // meter / canvas loops write every frame. Unpowered racks pay nothing at
    // idle and scroll best with everything rendered, so the manager engages
    // only with the power on (and clears any leftover skipping on power-off).
    if (!audio.isPowered) { clearAll(); return; }
    // Size gate: small/modest racks scroll smoothest fully rendered (see above).
    // offsetHeight is the true layout height (transform is visual-only) and is
    // zoom/viewport-independent, so the gate is stable across window sizes.
    if (cab.offsetHeight <= CULL_MIN_NATH) { clearAll(); return; }
    let entries  = [];
    let rafId    = null;
    let disposed = false;

    const measure = () => {
      const cabRect = cab.getBoundingClientRect();
      const natW    = cab.offsetWidth;
      if (!cabRect.width || !natW) return; // page hidden (display:none)
      const scale = cabRect.width / natW;  // screen→layout, the getSvgCoords trick
      entries = [...cab.querySelectorAll(`.${styles.module}`)].map(el => {
        const r   = el.getBoundingClientRect();
        const top = (r.top - cabRect.top) / scale;
        const h   = r.height / scale;
        // Exact intrinsic size — a skipped module keeps its rendered box
        // (skipped boxes report the intrinsic size, so re-measures are stable).
        el.style.containIntrinsicSize = `${(r.width / scale).toFixed(1)}px ${h.toFixed(1)}px`;
        return { el, top, bottom: top + h, on: el.style.contentVisibility !== 'auto' };
      });
    };

    // First-render of a module's contents is a main-thread paint burst;
    // slicing to ≤2 promotions per frame bounds each burst, and the 1-viewport
    // lead means it always lands before the module can scroll into view.
    // Demotions are discards — all processed immediately.
    const step = () => {
      rafId = null;
      let promoted = 0, pending = false;
      for (const e of entries) {
        if (e.want === undefined) continue;
        if (e.want === e.on) { e.want = undefined; continue; }
        if (!e.want) {
          e.el.style.contentVisibility = 'auto';
          e.on = false; e.want = undefined;
        } else if (promoted < 2) {
          e.el.style.contentVisibility = 'visible';
          e.on = true; e.want = undefined; promoted++;
        } else pending = true;
      }
      if (pending) rafId = requestAnimationFrame(step);
    };

    // Activity-adaptive bands. At the fit-width floor one viewport is ~1800
    // layout px — half the default-plus rack — so a fixed generous margin
    // would keep everything rendered and win nothing. Instead: while the
    // camera moves, promote 0.5 viewports ahead (scroll protection) and only
    // demote past 1.0 (hysteresis); once the camera has been still for 1.2 s,
    // sweep to a deep 0.15-viewport band — idle racks reach maximum skipping.
    // The far state is 'auto', so even a fling that outruns re-promotion gets
    // browser-rendered content, never a hole.
    const MOVE_PROMOTE = 0.5;
    const MOVE_DEMOTE  = 1.0;
    const IDLE_BAND    = 0.05;
    const IDLE_MS      = 1200;
    let idleTimer = null;

    const band = (promoteM, demoteM) => {
      const view = cameraViewRef.current;
      if (!view || !entries.length) return;
      const S = view.s0 * view.z;
      if (!S || !view.availH) return;
      const topL = -view.ty / S;               // visible band in layout px
      const botL = (view.availH - view.ty) / S;
      const vh   = view.availH / S;            // one viewport height
      let queued = false;
      for (const e of entries) {
        const near = e.bottom > topL - vh * promoteM && e.top < botL + vh * promoteM;
        const far  = e.bottom < topL - vh * demoteM  || e.top  > botL + vh * demoteM;
        if (!e.on && near)    { e.want = true;  queued = true; }
        else if (e.on && far) { e.want = false; queued = true; }
      }
      if (queued && rafId === null) rafId = requestAnimationFrame(step);
    };

    const update = () => {
      band(MOVE_PROMOTE, MOVE_DEMOTE);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => band(IDLE_BAND, IDLE_BAND), IDLE_MS);
    };

    measure();
    update();
    // Late font loads can shift module heights — re-stamp intrinsic sizes.
    document.fonts.ready.then(() => { if (!disposed) { measure(); update(); } });

    // Cabinet size changes (fit()'s width compensation on window resize)
    // rewrap the expansion row and move modules — re-measure. Intrinsic-size
    // writes never change a rendered box, so this cannot loop the observer.
    let roTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(() => { if (!disposed) { measure(); update(); } }, 60);
    });
    ro.observe(cab);

    moduleVisRef.current = { update };
    return () => {
      disposed = true;
      clearTimeout(roTimer);
      clearTimeout(idleTimer);
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      moduleVisRef.current = null;
    };
  }, [dynModules, hiddenModules, audio.isPowered]);

  // Expansion row (Phase 60b/60c) — dynamic instances added from the library.
  // Fixed per-type widths + wrap: extra rows grow the rack downward into the
  // 60a fit-width floor + scroll. Rendered at the BOTTOM of the rack, below
  // Row 4 (the Sequencer section) as of 2026-07-22.
  const dynExpansionRow = dynModules.length > 0 && (
    <div className={styles.tierDyn}>
      {dynModules.map(m => {
        const b = bindingsFor(m.id);
        const inner =
          m.type === 'vco'   ? <VcoModule number={m.num} onParamUpdate={audio.updateVcoParams} onSyncChange={b.sync} getLedValue={b.meter} quantized={quantizedVcos.includes(m.id)} />
        : m.type === 'noise' ? <NoiseModule number={m.num} onParamUpdate={audio.updateNoiseParams} />
        : m.type === 'vcf'   ? <VcfModule number={m.num} onParamUpdate={b.params} />
        : m.type === 'lfo'   ? <LfoModule number={m.num} onParamUpdate={b.params} getLedValue={b.lfoLed} />
        : m.type === 'vca'   ? <VcaModule number={m.num} onParamUpdate={b.params} getLedValue={b.meter} />
        : m.type === 'env'   ? <EnvelopeModule label={`ENV ${m.num}`} onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={b.meter} />
        : m.type === 'rev'   ? <ReverbModule number={m.num} onParamUpdate={b.params} getAuraData={b.aura} />
        : m.type === 'bbd'   ? <ChorusModule number={m.num} onParamUpdate={b.params} isPowered={audio.isPowered} />
        : m.type === 'kick'  ? <KickModule number={m.num} onParamUpdate={b.params} onTrigger={b.kickTrig} onSetTrigCallback={b.kickTrigCb} />
        : m.type === 'ffb'   ? <FFBModule number={m.num} onParamUpdate={b.params} getAnalyserData={b.ffbData} />
        : m.type === 'seq'   ? <SequencerModule number={m.num} onStepsChange={b.seqSteps} onTempoChange={audio.setTempo} onSetCallback={b.seqStepCb} onGlideChange={b.seqGlide} />
        : m.type === 'chordseq' ? <ChordSeqModule number={m.num} onStepsChange={b.chordSteps} onDivisionChange={b.chordDiv} onSetCallback={b.chordStepCb} onRootOctaveChange={b.chordRootOct} onGlideChange={b.chordGlide} />
        : m.type === 'voc'   ? <VocoderModule number={m.num} onParamUpdate={b.params} getAnalyserData={b.vocData} onMicEnable={handleMicEnable} onMicDisable={handleMicDisable} onMicGainChange={audio.updateVocMicGain} getMicLevel={getExtMicLevel} micStatus={micStatus} />
        : m.type === 'qnt'   ? <QuantizerModule number={m.num} onParamUpdate={b.params} onSetCallback={b.qntCb} getTransposeData={b.qntTrp} />
        : m.type === 'vowel' ? <VowelModule number={m.num} onParamUpdate={b.params} getAnalyserData={b.vowelData} />
        : m.type === 'panner' ? <PanningModule number={m.num} onParamUpdate={b.params} getL={b.panL} getR={b.panR} />
        : m.type === 'chronos' ? <ChronosDelayModule number={m.num} onParamUpdate={b.params} getDisplay={b.chronosDisp} />
        : m.type === 'folder' ? <WavefolderModule number={m.num} onParamUpdate={b.params} />
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
  );

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
        {/* Workspace toolbar (Phase 63) — save / load the whole rack as a .moog
            file, or reset to the default startup rack. */}
        <div className={styles.workspaceBar}>
          <button className={styles.wsBtn} onClick={resetWorkspace} title="Clear all modules, cables and knob positions; return to the default rack">⟲ reset</button>
          <button className={styles.wsBtn} onClick={saveSetup} title="Download the entire rack (modules, cables, all knob positions) as a .moog file">▼ save setup</button>
          <button className={styles.wsBtn} onClick={() => fileInputRef.current?.click()} title="Load a .moog setup file, replacing the current rack">▲ load setup</button>
          <input ref={fileInputRef} type="file" accept=".moog,application/json" onChange={loadSetup} style={{ display: 'none' }} />
        </div>
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
                  {mod('bbd', <ChorusModule key="bbd" onParamUpdate={audio.updateChorusParams} isPowered={audio.isPowered} />)}
                  {mod('ffb', <FFBModule key="ffb" onParamUpdate={audio.updateFFBParams} getAnalyserData={getFFBData} />)}
                </div>
              </div>
            </section>

            {/* Case 2: amps, envelopes, drums, vocoder (row 3) */}
            <section className={styles.case}>
              <div className={styles.caseInterior}>
                <div className={`${styles.tier} ${styles.tierRow3}`}>
                  {mod('vca1', <VcaModule key="vca1" number={1} onParamUpdate={audio.updateVcaParams} getLedValue={getVca1Level} />)}
                  {mod('vca2', <VcaModule key="vca2" number={2} onParamUpdate={audio.updateVca2Params} getLedValue={getVca2Level} />)}
                  {mod('vca3', <VcaModule key="vca3" number={3} onParamUpdate={audio.updateVca3Params} getLedValue={getVca3Level} />)}
                  {mod('env1', <EnvelopeModule key="env1" label="ENV 1" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv1Level} />)}
                  {mod('env2', <EnvelopeModule key="env2" label="ENV 2" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv2Level} />)}
                  {mod('env3', <EnvelopeModule key="env3" label="ENV 3" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv3Level} />)}
                  {mod('kick', <KickModule key="kick" onParamUpdate={audio.updateKickParams} onTrigger={audio.triggerKick} onSetTrigCallback={audio.setKickTrigCallback} />)}
                  {mod('vocoder', <VocoderModule
                    key="vocoder"
                    onParamUpdate={audio.updateVocoderParams}
                    getAnalyserData={getVocData}
                    onMicEnable={handleMicEnable}
                    onMicDisable={handleMicDisable}
                    onMicGainChange={audio.updateVocMicGain}
                    micStatus={micStatus}
                    getMicLevel={getExtMicLevel}
                  />)}
                </div>
              </div>
            </section>

            {/* Case 3: sequencers + quantizer + I/O (row 4).
                Sequencers stay side by side (Phase 54): stacking them made this
                tier 616px (⅓ of the rack) and halved the global fit() scale. */}
            <section className={styles.case}>
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
                {/* Row 5 (2026-07-22): library-added modules land here, below the
                    sequencers, and wrap/scroll downward as more are added. */}
                {dynExpansionRow}
              </div>
            </section>
          </div>

          {/* Wooden rail separating the module rack from the keyboard */}
          <div className={styles.kbdBarrier} />

          {/* 953 Keyboard Controller — sits below the rack, spans full cabinet width */}
          <KeyboardModule onUpdate={audio.updateKeyboard} onGlideChange={audio.setKbdGlide} onVibratoChange={audio.setKbdVibrato} externalActiveRef={recordingActiveRef} />
        </div>
      </div>
      {/* LAST child on purpose: sibling effects run in tree order, so the
          restorer's effect fires AFTER the (just-restored) dynamic modules'
          Jack registration effects in the same commit (Phase 60f). */}
      <CableRestorer ready={dynRestored} audioConnect={audio.connect} />
    </MoogPatchProvider>
  );
}
