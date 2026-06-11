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
// onSyncChange(enabled) — only provided for VCO2; enables/disables the hard sync slave output.
function VcoModule({ number, onParamUpdate, onSyncChange }) {
  // VCO2/VCO3 start slightly detuned for classic analog thickness
  const defaultFine = number === 2 ? 0.52 : number === 3 ? 0.48 : 0.5;

  const [freqBase,    setFreqBase]    = useState(0.5);
  const [fineTune,    setFineTune]    = useState(defaultFine);
  const [waveType,    setWaveType]    = useState('sawtooth');
  const [rangeOctave, setRangeOctave] = useState(0);
  const [syncOn,      setSyncOn]      = useState(false);

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
            {onSyncChange && (
              <div
                className={styles.selectorGroup}
                onClick={handleSyncToggle}
                title="Hard Sync: patch VCO1-SAW → SYNC↓ then enable. Slave phase resets each master cycle."
              >
                <span className={styles.selectorLabel}>HARD SYNC</span>
                <span className={styles.selectorValue} style={{ color: syncOn ? '#5DCAA5' : undefined }}>
                  {syncOn ? 'ON' : 'OFF'}
                </span>
              </div>
            )}
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
          {onSyncChange && (
            <div className={styles.jackRow}>
              <Jack id={`${p}-sync-in`}  label="SYNC↓" />
              <Jack id={`${p}-sync-out`} label="SYNC↑" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NoiseModule({ number = 1 }) {
  const [level, setLevel] = useState(0.7);
  const prefix = number === 1 ? 'noise' : `noise${number}`;
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
            <MoogKnob label="CUTOFF"    size="xl" value={cutoff} onChange={setCutoff} defaultValue={1.0} />
            <MoogKnob label="RESONANCE" size="lg" value={res}    onChange={setRes}    defaultValue={0.0} />
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
          {/* Input jacks: SYNC (deferred) + FM (rate modulation CV) */}
          <div className={styles.jackRow}>
            <Jack id={`${p}-sync`} label="SYNC" />
            <Jack id={`${p}-fm`}   label="FM" />
          </div>
          {/* Output jacks: waveform taps */}
          <div className={styles.jackRow}>
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

// onParamUpdate({ roomSize, wet }) wires ROOM and MIX knobs to n.reverb.
// wet=0 on mount so the module is transparent until the user raises MIX.
function ReverbModule({ onParamUpdate, number = 1 }) {
  const [roomSize, setRoomSize] = useState(0.7);
  const [wet,      setWet]      = useState(0.0);
  const p = number === 1 ? 'reverb' : `reverb${number}`;

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
            <Jack id={`${p}-in`}  label="IN" />
            <Jack id={`${p}-out`} label="OUT" />
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
          </div>
          <div className={styles.switchRow}>
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
          {[1, 2, 3, 4].map((ch, i) => (
            <div key={ch} className={styles.ioChRow}>
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
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="io-in" label="IN ✦" />
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
function QuantizerModule({ onParamUpdate, onSetCallback, getTransposeData, chordMapRef }) {
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
            <Jack id="qnt-cv-in"        label="CV IN" />
            <Jack id="qnt-cv-out"       label="OUT" />
            <Jack id="qnt-transpose-in" label="TRP" />
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

function ChordSeqModule({ onStepsChange, onDivisionChange, onSetCallback, onRootOctaveChange }) {
  const [steps, setSteps] = useState(() =>
    Array.from({ length: 8 }, (_, i) => ({
      rootClass: [9, 9, 5, 5, 0, 0, 4, 4][i],
      chordType: ['CMIN','CMIN','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ','CMAJ'][i],
    }))
  );
  const [division,   setDivision]   = useState('1m');
  const [rootOctave, setRootOctave] = useState(0);

  const ledRefs     = useRef([]);
  const prevStepRef = useRef(-1);

  useEffect(() => { onStepsChange?.(steps); },             [steps,       onStepsChange]);
  useEffect(() => { onDivisionChange?.(division); },       [division,    onDivisionChange]);
  useEffect(() => { onRootOctaveChange?.(rootOctave); },   [rootOctave,  onRootOctaveChange]);

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
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="chordseq-cv-in"   label="SEQ IN" />
            <Jack id="chordseq-cv-out"  label="OUT" />
            <Jack id="chordseq-root-out" label="ROOT" />
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
function SequencerModule({ onStepsChange, onTempoChange, onSetCallback, number = 1 }) {
  const p = number === 1 ? 'seq' : `seq${number}`;
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

// ──────────── BBD Chorus ────────────

// Rate LED pulses at the same frequency as the chorus LFO by reading rateHzRef
// in a stable getter closure — no React state writes in the rAF loop.
function ChorusModule({ onParamUpdate }) {
  const [rate,  setRate]  = useState(0.3);
  const [depth, setDepth] = useState(0.5);
  const [wet,   setWet]   = useState(0.0);

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
            <Jack id="chorus-in"  label="IN" />
            <Jack id="chorus-out" label="OUT" />
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

  useEffect(() => {
    const el = cabinetRef.current;
    if (!el) return;

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
      el.style.transform    = 'none';
      el.style.marginBottom = '0px';

      const natH = el.offsetHeight;
      if (!natH) return; // hidden (display:none) — ResizeObserver fires when it becomes visible

      // Available space (shell padding: 16px sides, 44px top + 16px bottom).
      const availW = window.innerWidth  - 32;
      const availH = window.innerHeight - 60;
      const scale  = Math.min(availH / natH, 1);

      el.style.transformOrigin = 'top center';

      if (scale < 1) {
        // Width compensation: widen the layout box so that after scale(), the visual
        // width equals availW — no blank side margins from transform shrinking the width.
        // Guard: only assign if the value differs to avoid unnecessary ResizeObserver triggers.
        const newW = `${Math.ceil(availW / scale)}px`;
        if (el.style.width !== newW) el.style.width = newW;
        el.style.transform    = `scale(${scale})`;
        el.style.marginBottom = `${Math.round(natH * (scale - 1))}px`;
      } else {
        if (el.style.width !== '') el.style.width = '';
      }
    };

    fit(); // immediate on mount
    document.fonts.ready.then(scheduleFit);

    // ResizeObserver catches: late font loads, page becoming visible after display:none
    // (navigation back to Moog page), and any content height changes at runtime.
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);

    window.addEventListener('resize', fit);
    return () => {
      clearTimeout(fitTimer);
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
            {/* Row 1: VCO bank + Noise source */}
            <div className={`${styles.tier} ${styles.tierRow1}`}>
              <VcoModule number={1} onParamUpdate={audio.updateVcoParams} />
              <VcoModule number={2} onParamUpdate={audio.updateVcoParams} onSyncChange={audio.setVco2SyncEnabled} />
              <VcoModule number={3} onParamUpdate={audio.updateVcoParams} />
              <VcoModule number={4} onParamUpdate={audio.updateVcoParams} />
              <NoiseModule number={1} />
              <NoiseModule number={2} />
              <NoiseModule number={3} />
            </div>

            {/* Row 2: Filter × 2 → LFO × 2 → Reverb × 2 → BBD Chorus */}
            <div className={`${styles.tier} ${styles.tierRow2}`}>
              <VcfModule    number={1} onParamUpdate={audio.updateVcfParams} />
              <VcfModule    number={2} onParamUpdate={audio.updateVcf2Params} />
              <LfoModule    number={1} onParamUpdate={audio.updateLfoParams}    getLedValue={getLfoInstant} />
              <LfoModule    number={2} onParamUpdate={audio.updateLfo2Params}   getLedValue={getLfo2Instant} />
              <ReverbModule number={1} onParamUpdate={audio.updateReverbParams} />
              <ReverbModule number={2} onParamUpdate={audio.updateReverb2Params} />
              <ChorusModule             onParamUpdate={audio.updateChorusParams} />
            </div>

            {/* Row 3: VCA × 3, Envelopes */}
            <div className={`${styles.tier} ${styles.tierRow3}`}>
              <VcaModule number={1} onParamUpdate={audio.updateVcaParams} />
              <VcaModule number={2} onParamUpdate={audio.updateVca2Params} />
              <VcaModule number={3} onParamUpdate={audio.updateVca3Params} />
              <EnvelopeModule label="ENV 1" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv1Level} />
              <EnvelopeModule label="ENV 2" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv2Level} />
              <EnvelopeModule label="ENV 3" onParamUpdate={audio.updateEnvParams} onGate={audio.triggerGate} getLedValue={getEnv3Level} />
            </div>

            {/* Row 4: 960 Sequencer (×2 stacked) + Chord Sequencer + Quantizer + I/O */}
            <div className={`${styles.tier} ${styles.tierRow4}`}>
              <div className={styles.seqStack}>
                <SequencerModule
                  number={1}
                  onStepsChange={audio.updateSequencerSteps}
                  onTempoChange={audio.setTempo}
                  onSetCallback={audio.setSeqStepCallback}
                />
                <SequencerModule
                  number={2}
                  onStepsChange={audio.updateSeq2Steps}
                  onTempoChange={audio.setTempo}
                  onSetCallback={audio.setSeq2StepCallback}
                />
              </div>
              <ChordSeqModule
                onStepsChange={audio.updateChordSeqSteps}
                onDivisionChange={audio.setChordSeqDivision}
                onSetCallback={audio.setChordSeqStepCallback}
                onRootOctaveChange={audio.setChordSeqRootOctave}
              />
              <QuantizerModule
                onParamUpdate={audio.updateQuantizerParams}
                onSetCallback={audio.setQuantizerCallback}
                getTransposeData={audio.getQntTransposeData}
                chordMapRef={chordMapRef}
              />
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

          {/* Wooden rail separating the module rack from the keyboard */}
          <div className={styles.kbdBarrier} />

          {/* 953 Keyboard Controller — sits below the rack, spans full cabinet width */}
          <KeyboardModule onUpdate={audio.updateKeyboard} />
        </div>
      </div>
    </MoogPatchProvider>
  );
}
