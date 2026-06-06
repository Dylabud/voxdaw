import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './MoogShell.module.css';
import MoogKnob from './MoogKnob';
import { MoogPatchProvider, useMoogPatch } from './MoogPatchContext';
import PatchCableOverlay from './PatchCableOverlay';
import useMoogAudio from './useMoogAudio';
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
const WAVE_TYPES   = ['sine', 'triangle', 'sawtooth', 'square'];
const WAVE_LABELS  = { sine: 'SIN', triangle: 'TRI', sawtooth: 'SAW', square: 'SQR' };
const RANGE_STEPS  = [-2, -1, 0, 1, 2];
const RANGE_LABELS = { '-2': "32'", '-1': "16'", '0': "8'", '1': "4'", '2': "2'" };

// number prop (1/2/3) drives the display label and jack ID prefixes.
// onParamUpdate(vcoId, { hz, detune, type }) is the audio update callback from useMoogAudio.
function VcoModule({ number, onParamUpdate }) {
  // VCO2/VCO3 start slightly detuned for classic analog thickness
  const defaultFine = number === 2 ? 0.52 : number === 3 ? 0.48 : 0.5;

  const [freqBase,    setFreqBase]    = useState(0.5);
  const [fineTune,    setFineTune]    = useState(defaultFine);
  const [waveType,    setWaveType]    = useState('sawtooth');
  const [rangeOctave, setRangeOctave] = useState(0);

  const vcoId = `vco${number}`;
  const p     = vcoId;

  useEffect(() => {
    if (!onParamUpdate) return;
    // Exponential Hz: freqBase 0→1 maps C1→C6
    const baseHz  = VCO_FREQ_MIN * Math.pow(VCO_FREQ_MAX / VCO_FREQ_MIN, freqBase);
    const finalHz = baseHz * Math.pow(2, rangeOctave);
    // Fine tune: 0–1 → ±100 cents
    const detune  = (fineTune - 0.5) * 200;
    onParamUpdate(vcoId, { hz: finalHz, detune, type: waveType });
  }, [freqBase, fineTune, waveType, rangeOctave, vcoId, onParamUpdate]);

  const cycleWave = () =>
    setWaveType(prev => WAVE_TYPES[(WAVE_TYPES.indexOf(prev) + 1) % WAVE_TYPES.length]);

  const cycleRange = () =>
    setRangeOctave(prev => RANGE_STEPS[(RANGE_STEPS.indexOf(prev) + 1) % RANGE_STEPS.length]);

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
            <MoogKnob label="FREQ" size="xl" value={freqBase} onChange={setFreqBase} defaultValue={0.5} />
            <MoogKnob label="FINE" size="sm" value={fineTune} onChange={setFineTune} defaultValue={defaultFine} />
          </div>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleWave} title="Click to cycle waveform">
              <span className={styles.selectorLabel}>WAVE</span>
              <span className={styles.selectorValue}>{WAVE_LABELS[waveType]}</span>
            </div>
            <div className={styles.selectorGroup} onClick={cycleRange} title="Click to cycle range">
              <span className={styles.selectorLabel}>RANGE</span>
              <span className={styles.selectorValue}>{RANGE_LABELS[String(rangeOctave)]}</span>
            </div>
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id={`${p}-cv`}  label="CV" />
            <Jack id={`${p}-fm`}  label="FM" />
            <Jack id={`${p}-sin`} label="SIN" />
            <Jack id={`${p}-tri`} label="TRI" />
            <Jack id={`${p}-saw`} label="SAW" />
            <Jack id={`${p}-sqr`} label="SQR" />
          </div>
        </div>
      </div>
    </div>
  );
}

function NoiseModule() {
  const [level, setLevel] = useState(0.7);
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
            <Jack id="noise-wht" label="WHT" />
            <Jack id="noise-pnk" label="PNK" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Cp3MixerModule() {
  const [ch1, setCh1]       = useState(0.5);
  const [ch2, setCh2]       = useState(0.5);
  const [ch3, setCh3]       = useState(0.5);
  const [ch4, setCh4]       = useState(0.5);
  const [master, setMaster] = useState(0.75);
  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>CP3</span>
            <span className={styles.plateSub}>MIXER — 4 CH · SIGNAL COMBINER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="CH 1"   size="sm" value={ch1}    onChange={setCh1}    defaultValue={0.5} />
            <MoogKnob label="CH 2"   size="sm" value={ch2}    onChange={setCh2}    defaultValue={0.5} />
            <MoogKnob label="CH 3"   size="sm" value={ch3}    onChange={setCh3}    defaultValue={0.5} />
            <MoogKnob label="CH 4"   size="sm" value={ch4}    onChange={setCh4}    defaultValue={0.5} />
            <MoogKnob label="MASTER" size="lg" value={master} onChange={setMaster} defaultValue={0.75} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="cp3-in1" label="IN 1" />
            <Jack id="cp3-in2" label="IN 2" />
            <Jack id="cp3-in3" label="IN 3" />
            <Jack id="cp3-in4" label="IN 4" />
            <Jack id="cp3-out" label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ cutoff, resonance }) is the audio update callback from useMoogAudio.
// envAmt and kbdTracking are visual-only in this phase (Phase 6 will wire them).
function VcfModule({ onParamUpdate }) {
  const [cutoff, setCutoff] = useState(1.0);   // fully open — matches vcf init at 20kHz
  const [res, setRes]       = useState(0.0);
  const [envAmt, setEnvAmt] = useState(0.5);   // visual only
  const [kbd, setKbd]       = useState(0.0);   // visual only

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
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>VCF</span>
            <span className={styles.plateSub}>VOLTAGE CONTROLLED FILTER — 24 dB/OCT LADDER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.knobRow}>
            <MoogKnob label="CUTOFF"    size="xl" value={cutoff} onChange={setCutoff} defaultValue={1.0} />
            <MoogKnob label="RESONANCE" size="lg" value={res}    onChange={setRes}    defaultValue={0.0} />
            <MoogKnob label="ENV AMT"   size="md" value={envAmt} onChange={setEnvAmt} defaultValue={0.5} />
            <MoogKnob label="KBD"       size="sm" value={kbd}    onChange={setKbd}    defaultValue={0.0} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="vcf-in"  label="IN" />
            <Jack id="vcf-cv1" label="CV 1" />
            <Jack id="vcf-cv2" label="CV 2" />
            <Jack id="vcf-env" label="ENV" />
            <Jack id="vcf-out" label="OUT" />
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
function LfoModule({ onParamUpdate, getLedValue }) {
  const [rate,     setRate]     = useState(0.3);
  const [depth,    setDepth]    = useState(0.5);
  const [waveType, setWaveType] = useState('sine');

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ rate, depth, type: waveType });
  }, [rate, depth, waveType, onParamUpdate]);

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
            <MoogKnob label="RATE"  size="lg" value={rate}  onChange={setRate}  defaultValue={0.3} />
            <MoogKnob label="DEPTH" size="md" value={depth} onChange={setDepth} defaultValue={0.5} />
          </div>
          <div className={styles.selectorRow}>
            <div className={styles.selectorGroup} onClick={cycleWave} title="Click to cycle waveform">
              <span className={styles.selectorLabel}>WAVE</span>
              <span className={styles.selectorValue}>{LFO_WAVE_LABELS[waveType]}</span>
            </div>
            <ToggleSwitch labels={['FREE', 'SYNC']} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="lfo-sync" label="SYNC" />
            <Jack id="lfo-sin"  label="SIN" />
            <Jack id="lfo-tri"  label="TRI" />
            <Jack id="lfo-sqr"  label="SQR" />
            <Jack id="lfo-saw"  label="SAW" />
          </div>
        </div>
      </div>
    </div>
  );
}

// onParamUpdate({ roomSize, wet }) wires ROOM and MIX knobs to n.reverb.
// wet=0 on mount so the module is transparent until the user raises MIX.
function ReverbModule({ onParamUpdate }) {
  const [roomSize, setRoomSize] = useState(0.7);
  const [wet,      setWet]      = useState(0.0);

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
          <div className={styles.jackRow}>
            <Jack id="reverb-in"  label="IN" />
            <Jack id="reverb-out" label="OUT" />
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
function VcaModule({ onParamUpdate }) {
  const [gain, setGain]     = useState(0.5);
  const [envAmt, setEnvAmt] = useState(1.0); // visual only

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
          </div>
          <div className={styles.switchRow}>
            <ToggleSwitch labels={['LOG', 'LIN']} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="vca-in"  label="IN" />
            <Jack id="vca-cv"  label="CV" />
            <Jack id="vca-out" label="OUT" />
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

function MultiplesModule() {
  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>MULT</span>
            <span className={styles.plateSub}>PASSIVE MULTIPLES — 2 × 4</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.multiplesGrid}>
            <div className={styles.multBank}>
              <span className={styles.multBankLabel}>A</span>
              <Jack id="mult-a1" label="A1" />
              <Jack id="mult-a2" label="A2" />
              <Jack id="mult-a3" label="A3" />
              <Jack id="mult-a4" label="A4" />
            </div>
            <div className={styles.multBank}>
              <span className={styles.multBankLabel}>B</span>
              <Jack id="mult-b1" label="B1" />
              <Jack id="mult-b2" label="B2" />
              <Jack id="mult-b3" label="B3" />
              <Jack id="mult-b4" label="B4" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// I/O module — oscilloscope display, POWER switch, MASTER VOL knob, and the "io-in" patch jack.
// getOscData() — passed down from MoogShell → useMoogAudio.getOscilloscopeData.
// getLedValue() — stable getter (pre-bound in MoogShell) for the master level meter.
function IoModule({ isPowered, onPower, onParamUpdate, getOscData, getLedValue }) {
  const [masterVol, setMasterVol] = useState(0.7);

  useEffect(() => {
    if (!onParamUpdate) return;
    onParamUpdate({ volume: masterVol });
  }, [masterVol, onParamUpdate]);

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>I/O</span>
            <span className={styles.plateSub}>INPUT · OUTPUT · POWER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <Oscilloscope getData={getOscData} />
          <div className={styles.switchRow}>
            <PowerSwitch isPowered={isPowered} onToggle={onPower} />
            <div className={`${styles.powerLamp} ${isPowered ? styles.powerLampOn : ''}`} />
          </div>
          <div className={styles.knobRow}>
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
          <div className={styles.jackRow}>
            <Jack id="io-in" label="IN" />
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
function SequencerModule({ onStepsChange, onTempoChange, onSetCallback }) {
  const [steps, setSteps] = useState(() =>
    Array.from({ length: 16 }, () => ({ voltage: 0.5, gate: true }))
  );
  const [tempo, setTempoState] = useState(120);
  const ledRefs    = useRef([]);
  const prevStepRef = useRef(-1);

  useEffect(() => { onStepsChange?.(steps); }, [steps, onStepsChange]);
  useEffect(() => { onTempoChange?.(tempo);  }, [tempo,  onTempoChange]);

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

  return (
    <div className={styles.module}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.plateHeader}>
          <div className={styles.plateTitles}>
            <span className={styles.plateTitle}>960</span>
            <span className={styles.plateSub}>SEQUENTIAL CONTROLLER · 8-STEP PROGRAMMABLE SEQUENCER</span>
          </div>
        </div>
        <div className={styles.plateBody}>
          <div className={styles.seqLayout}>

            {/* Left: tempo knob + BPM readout + patch jacks */}
            <div className={styles.seqCtrl}>
              <MoogKnob
                label="TEMPO"
                size="lg"
                value={(tempo - 20) / 280}
                onChange={handleTempoKnob}
                defaultValue={(120 - 20) / 280}
              />
              <div className={styles.seqBpmDisplay}>
                <span className={styles.selectorValue}>{tempo}</span>
              </div>
              <PlateDivider />
              <div className={styles.jackRow}>
                <Jack id="seq-pitch-out" label="PITCH" />
                <Jack id="seq-gate-out"  label="GATE" />
                <Jack id="seq-clk-in"    label="CLK↓" />
                <Jack id="seq-clk-out"   label="CLK↑" />
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
                </div>
              ))}
            </div>

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

  // Register the bus getter with Root.js so the Workstation can tap Moog audio.
  // audio.getMoogBusNode is a stable useCallback ref — effect fires once.
  useEffect(() => {
    onBusReady?.(() => audio.getMoogBusNode());
  }, [onBusReady, audio.getMoogBusNode]);

  // Stable getValue closures — created once (audio.getMeterValue has empty-dep useCallback,
  // so its reference never changes). Passing pre-bound getters prevents Led's useEffect
  // from restarting on every re-render of the parent module component.
  const getLfoLevel    = useCallback(() => audio.getMeterValue('lfo'),    [audio.getMeterValue]);
  const getEnv1Level   = useCallback(() => audio.getMeterValue('env1'),   [audio.getMeterValue]);
  const getEnv2Level   = useCallback(() => audio.getMeterValue('env2'),   [audio.getMeterValue]);
  const getMasterLevel = useCallback(() => audio.getMeterValue('master'), [audio.getMeterValue]);

  // Toggle: powerOn when off, powerOff when on. Both functions guard internally via
  // isPoweredRef so rapid double-clicks are safe even before the async powerOn resolves.
  const handlePowerToggle = useCallback(() => {
    if (audio.isPowered) audio.powerOff();
    else audio.powerOn();
  }, [audio.isPowered, audio.powerOff, audio.powerOn]);

  useEffect(() => {
    const el = cabinetRef.current;
    if (!el) return;

    const fit = () => {
      // Reset to natural size so we can measure it accurately
      el.style.transform    = 'none';
      el.style.marginBottom = '0px';

      const natW = el.offsetWidth;
      const natH = el.offsetHeight;
      if (!natW || !natH) return;

      // Available space inside the shell's padding (16px sides, 44px top, 16px bottom)
      const availW = window.innerWidth  - 32;
      const availH = window.innerHeight - 60;
      const scale  = Math.min(availW / natW, availH / natH, 1);

      el.style.transformOrigin = 'top center';

      if (scale < 1) {
        el.style.transform    = `scale(${scale})`;
        // transform: scale() is visual-only — the layout footprint stays at natH.
        // A negative marginBottom collapses the unused layout space so the flex
        // container never overflows its 100vh boundary.
        el.style.marginBottom = `${Math.round(natH * (scale - 1))}px`;
      } else {
        el.style.transform    = 'none';
        el.style.marginBottom = '0px';
      }
    };

    fit();

    // Re-fit if the cabinet's own content height ever changes (e.g. after fonts load)
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  return (
    <MoogPatchProvider onCableAdded={audio.connect} onCableRemoved={audio.disconnect}>
      <div className={styles.shell}>
        <button className={styles.homeBtn} onClick={onNavigateHome}>← home</button>

        <div className={styles.cabinet} ref={cabinetRef}>
          {/* SVG patch cable overlay — position:absolute, inset:0, z-index:50 */}
          <PatchCableOverlay />

          <div className={styles.nameplate}>
            <span className={styles.nameplateModel}>MODEL 55</span>
            <span className={styles.nameplateBrand}>MOOG MODULAR SYNTHESIZER</span>
            <span className={styles.nameplateSerial}>SER. No. 0001-A</span>
          </div>

          <div className={styles.rack}>
            {/* Row 1: VCO bank + Noise source */}
            <div className={`${styles.tier} ${styles.tierRow1}`}>
              <VcoModule number={1} onParamUpdate={audio.updateVcoParams} />
              <VcoModule number={2} onParamUpdate={audio.updateVcoParams} />
              <VcoModule number={3} onParamUpdate={audio.updateVcoParams} />
              <NoiseModule />
            </div>

            {/* Row 2: Mixer → Filter → LFO → Reverb */}
            <div className={`${styles.tier} ${styles.tierRow2}`}>
              <Cp3MixerModule />
              <VcfModule onParamUpdate={audio.updateVcfParams} />
              <LfoModule onParamUpdate={audio.updateLfoParams} getLedValue={getLfoLevel} />
              <ReverbModule onParamUpdate={audio.updateReverbParams} />
            </div>

            {/* Row 3: VCA, Envelopes, Multiples */}
            <div className={`${styles.tier} ${styles.tierRow3}`}>
              <VcaModule onParamUpdate={audio.updateVcaParams} />
              <EnvelopeModule label="ENV 1" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv1Level} />
              <EnvelopeModule label="ENV 2" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv2Level} />
              <MultiplesModule />
            </div>

            {/* Row 4: 960 Sequencer + I/O */}
            <div className={`${styles.tier} ${styles.tierRow4}`}>
              <SequencerModule
                onStepsChange={audio.updateSequencerSteps}
                onTempoChange={audio.setTempo}
                onSetCallback={audio.setSeqStepCallback}
              />
              <IoModule
                isPowered={audio.isPowered}
                onPower={handlePowerToggle}
                onParamUpdate={audio.updateIoParams}
                getOscData={audio.getOscilloscopeData}
                getLedValue={getMasterLevel}
              />
            </div>
          </div>

          {/* 953 Keyboard Controller — sits below the rack, spans full cabinet width */}
          <KeyboardModule onUpdate={audio.updateKeyboard} />
        </div>
      </div>
    </MoogPatchProvider>
  );
}
