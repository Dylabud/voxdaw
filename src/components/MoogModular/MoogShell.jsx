import { useState, useRef, useEffect } from 'react';
import styles from './MoogShell.module.css';
import MoogKnob from './MoogKnob';
import { MoogPatchProvider, useMoogPatch } from './MoogPatchContext';
import PatchCableOverlay from './PatchCableOverlay';
import useMoogAudio from './useMoogAudio';

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

// number prop (1/2/3) drives both the display label and jack ID prefixes.
function VcoModule({ number }) {
  const [freq, setFreq] = useState(0.5);
  const [fine, setFine] = useState(0.5);
  const [wave, setWave] = useState(0.0);
  const p = `vco${number}`;
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
            <MoogKnob label="FREQ" size="xl" value={freq} onChange={setFreq} defaultValue={0.5} />
            <MoogKnob label="FINE" size="sm" value={fine} onChange={setFine} defaultValue={0.5} />
            <MoogKnob label="WAVE" size="sm" value={wave} onChange={setWave} defaultValue={0.0} />
          </div>
          <div className={styles.switchRow}>
            <ToggleSwitch labels={['HI', 'LO']} />
            <ToggleSwitch labels={['SAW', 'SQR']} />
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

function VcfModule() {
  const [cutoff, setCutoff] = useState(0.8);
  const [res, setRes]       = useState(0.1);
  const [envAmt, setEnvAmt] = useState(0.5);
  const [kbd, setKbd]       = useState(0.5);
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
            <MoogKnob label="CUTOFF"    size="xl" value={cutoff} onChange={setCutoff} defaultValue={0.8} />
            <MoogKnob label="RESONANCE" size="lg" value={res}    onChange={setRes}    defaultValue={0.1} />
            <MoogKnob label="ENV AMT"   size="md" value={envAmt} onChange={setEnvAmt} defaultValue={0.5} />
            <MoogKnob label="KBD"       size="sm" value={kbd}    onChange={setKbd}    defaultValue={0.5} />
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

function LfoModule() {
  const [rate, setRate]   = useState(0.3);
  const [level, setLevel] = useState(0.5);
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
            <MoogKnob label="RATE"  size="lg" value={rate}  onChange={setRate}  defaultValue={0.3} />
            <MoogKnob label="LEVEL" size="md" value={level} onChange={setLevel} defaultValue={0.5} />
          </div>
          <div className={styles.switchRow}>
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

function VcaModule() {
  const [gain, setGain]     = useState(0.5);
  const [envAmt, setEnvAmt] = useState(1.0);
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

// label ("ENV 1" / "ENV 2") is used both as the displayed title and to derive jack IDs.
function EnvelopeModule({ label }) {
  const [attack,  setAttack]  = useState(0.1);
  const [decay,   setDecay]   = useState(0.3);
  const [sustain, setSustain] = useState(0.7);
  const [release, setRelease] = useState(0.4);
  const envId = label.toLowerCase().replace(/\s+/g, ''); // "env1" or "env2"
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

// I/O module — houses the Power switch and Master Volume knob.
// VCA → Master → Destination is hardwired by useMoogAudio on powerOn;
// the SPKR jack is decorative in Phase 3.
function IoModule({ isPowered, onPower }) {
  const [masterVol, setMasterVol] = useState(0.7);
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
          <div className={styles.switchRow}>
            <PowerSwitch isPowered={isPowered} onToggle={onPower} />
          </div>
          <div className={styles.knobRow}>
            <MoogKnob
              label="MASTER"
              size="lg"
              value={masterVol}
              onChange={setMasterVol}
              defaultValue={0.7}
            />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack id="io-spkr-out" label="SPKR" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SequencerReservedPanel() {
  return (
    <div className={`${styles.module} ${styles.moduleBlank}`}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.blankContent}>
          <div className={styles.blankLabel}>960 SEQUENCER</div>
          <div className={styles.blankSub}>RESERVED</div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Main shell ────────────

export default function MoogShell({ onNavigateHome }) {
  const audio      = useMoogAudio();
  const cabinetRef = useRef(null);

  useEffect(() => {
    const el = cabinetRef.current;
    if (!el) return;

    const fit = () => {
      el.style.transform = 'none';
      const natW = el.offsetWidth;
      const natH = el.offsetHeight;
      const availW = window.innerWidth  - 32;
      const availH = window.innerHeight - 60;
      const scale  = Math.min(availW / natW, availH / natH, 1);
      el.style.transform       = scale < 1 ? `scale(${scale})` : 'none';
      el.style.transformOrigin = 'top center';
    };

    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
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
              <VcoModule number={1} />
              <VcoModule number={2} />
              <VcoModule number={3} />
              <NoiseModule />
            </div>

            {/* Row 2: Mixer → Filter → LFO */}
            <div className={`${styles.tier} ${styles.tierRow2}`}>
              <Cp3MixerModule />
              <VcfModule />
              <LfoModule />
            </div>

            {/* Row 3: VCA, Envelopes, Multiples */}
            <div className={`${styles.tier} ${styles.tierRow3}`}>
              <VcaModule />
              <EnvelopeModule label="ENV 1" />
              <EnvelopeModule label="ENV 2" />
              <MultiplesModule />
            </div>

            {/* Row 4: I/O module + 960 Sequencer reserved */}
            <div className={`${styles.tier} ${styles.tierRow4}`}>
              <SequencerReservedPanel />
              <IoModule isPowered={audio.isPowered} onPower={audio.powerOn} />
            </div>
          </div>
        </div>
      </div>
    </MoogPatchProvider>
  );
}
