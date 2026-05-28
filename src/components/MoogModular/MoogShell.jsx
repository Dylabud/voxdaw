import styles from './MoogShell.module.css';

// ──────────── Atomic hardware primitives ────────────

function Screw({ pos }) {
  return <div className={`${styles.screw} ${styles[pos]}`} />;
}

const TICK_COUNT  = 11;
const MIN_ANGLE   = -135;
const MAX_ANGLE   =  135;

function KnobScale({ size }) {
  const showNums = size === 'xl' || size === 'lg';
  return (
    <div className={`${styles.knobScale} ${styles[`ks_${size}`]}`}>
      {Array.from({ length: TICK_COUNT }, (_, i) => {
        const angle   = MIN_ANGLE + (i / (TICK_COUNT - 1)) * (MAX_ANGLE - MIN_ANGLE);
        const isMajor = i === 0 || i === 5 || i === 10;
        return (
          <div
            key={i}
            className={styles.tickArm}
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <div className={`${styles.tickLine} ${isMajor ? styles.tickMajor : ''}`} />
            {showNums && isMajor && (
              <span
                className={styles.tickNum}
                style={{ transform: `translateX(-50%) rotate(${-angle}deg)` }}
              >
                {i}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KnobPlaceholder({ label, size = 'md' }) {
  return (
    <div className={styles.knobGroup}>
      <div className={`${styles.knobWrap} ${styles[`knobWrap_${size}`]}`}>
        <KnobScale size={size} />
        <div className={`${styles.knob} ${styles[`knob_${size}`]}`}>
          <div className={styles.knobCap} />
        </div>
      </div>
      {label && <span className={styles.knobLabel}>{label}</span>}
    </div>
  );
}

function Jack({ label }) {
  return (
    <div className={styles.jackGroup}>
      <div className={styles.jack} />
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

// ──────────── Module panels ────────────

function VcoModule({ number }) {
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
            <KnobPlaceholder label="FREQ" size="xl" />
            <KnobPlaceholder label="FINE" size="sm" />
            <KnobPlaceholder label="WAVE" size="sm" />
          </div>
          <div className={styles.switchRow}>
            <ToggleSwitch labels={['HI', 'LO']} />
            <ToggleSwitch labels={['SAW', 'SQR']} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack label="CV" />
            <Jack label="FM" />
            <Jack label="SIN" />
            <Jack label="TRI" />
            <Jack label="SAW" />
            <Jack label="SQR" />
          </div>
        </div>
      </div>
    </div>
  );
}

function VcfModule() {
  return (
    <div className={`${styles.module} ${styles.moduleWide}`}>
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
            <KnobPlaceholder label="CUTOFF" size="xl" />
            <KnobPlaceholder label="RESONANCE" size="lg" />
            <KnobPlaceholder label="ENV AMT" size="md" />
            <KnobPlaceholder label="KBD" size="sm" />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack label="IN" />
            <Jack label="CV 1" />
            <Jack label="CV 2" />
            <Jack label="ENV" />
            <Jack label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

function VcaModule() {
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
            <KnobPlaceholder label="GAIN" size="lg" />
            <KnobPlaceholder label="ENV AMT" size="md" />
          </div>
          <div className={styles.switchRow}>
            <ToggleSwitch labels={['LOG', 'LIN']} />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack label="IN" />
            <Jack label="CV" />
            <Jack label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvelopeModule({ label }) {
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
            <KnobPlaceholder label="A" size="md" />
            <KnobPlaceholder label="D" size="md" />
            <KnobPlaceholder label="S" size="md" />
            <KnobPlaceholder label="R" size="md" />
          </div>
          <PlateDivider />
          <div className={styles.jackRow}>
            <Jack label="GATE" />
            <Jack label="TRIG" />
            <Jack label="OUT" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BlankPanel() {
  return (
    <div className={`${styles.module} ${styles.moduleBlank}`}>
      <Screw pos="screwTL" /><Screw pos="screwTR" />
      <Screw pos="screwBL" /><Screw pos="screwBR" />
      <div className={styles.plate}>
        <div className={styles.blankContent}>
          <div className={styles.blankLabel}>PATCH AREA</div>
          <div className={styles.jackGrid}>
            {Array.from({ length: 12 }, (_, i) => (
              <Jack key={i} label="" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────── Main shell ────────────

export default function MoogShell({ onNavigateHome }) {
  return (
    <div className={styles.shell}>
      <button className={styles.homeBtn} onClick={onNavigateHome}>← home</button>

      <div className={styles.cabinet}>
        <div className={styles.nameplate}>
          <span className={styles.nameplateModel}>MODEL 55</span>
          <span className={styles.nameplateBrand}>MOOG MODULAR SYNTHESIZER</span>
          <span className={styles.nameplateSerial}>SER. No. 0001-A</span>
        </div>

        <div className={styles.rack}>
          <div className={`${styles.tier} ${styles.tierVco}`}>
            <VcoModule number={1} />
            <VcoModule number={2} />
            <VcoModule number={3} />
          </div>

          <TierSep />

          <div className={`${styles.tier} ${styles.tierFilt}`}>
            <VcfModule />
            <VcaModule />
          </div>

          <TierSep />

          <div className={`${styles.tier} ${styles.tierEnv}`}>
            <EnvelopeModule label="ENV 1" />
            <EnvelopeModule label="ENV 2" />
            <BlankPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
