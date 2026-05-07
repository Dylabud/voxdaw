import { useRef, useState } from 'react';
import styles from './GestureSettings.module.css';
import {
  GESTURE_SOURCES, AUDIO_DESTINATIONS, DEFAULT_MAPPINGS,
  DEFAULT_TRIGGER_MAPPINGS,
  groupedTriggerSources, groupedTriggerDestinations,
} from '../../utils/gestureMappings';

const TRIGGER_SOURCE_GROUPS      = groupedTriggerSources();
const TRIGGER_DESTINATION_GROUPS = groupedTriggerDestinations();

export default function GestureSettings({
  mappings, setMappings,
  triggerMappings, setTriggerMappings,
  onClose,
}) {
  const [tab, setTab] = useState('signals');

  const nextSignalIdRef  = useRef(Math.max(...mappings.map(m => m.id), 0) + 1);
  const nextTriggerIdRef = useRef(Math.max(...triggerMappings.map(m => m.id), 0) + 1);

  // ── Signal handlers ──────────────────────────────────────────────────────────
  const handleSignalAdd = () => {
    setMappings(prev => [
      ...prev,
      { id: nextSignalIdRef.current++, source: GESTURE_SOURCES[0].id, destination: AUDIO_DESTINATIONS[0].id, invert: false },
    ]);
  };
  const handleSignalDelete = (id) => setMappings(prev => prev.filter(m => m.id !== id));
  const handleSignalChange = (id, field, value) =>
    setMappings(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m));
  const handleSignalReset = () => {
    setMappings(DEFAULT_MAPPINGS);
    nextSignalIdRef.current = DEFAULT_MAPPINGS.length + 1;
  };

  // ── Trigger handlers ─────────────────────────────────────────────────────────
  const handleTriggerAdd = () => {
    setTriggerMappings(prev => [
      ...prev,
      { id: nextTriggerIdRef.current++, trigger: TRIGGER_SOURCE_GROUPS[0].options[0].id, destination: TRIGGER_DESTINATION_GROUPS[0].options[0].id },
    ]);
  };
  const handleTriggerDelete = (id) => setTriggerMappings(prev => prev.filter(m => m.id !== id));
  const handleTriggerChange = (id, field, value) =>
    setTriggerMappings(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m));
  const handleTriggerReset = () => {
    setTriggerMappings(DEFAULT_TRIGGER_MAPPINGS);
    nextTriggerIdRef.current = DEFAULT_TRIGGER_MAPPINGS.length + 1;
  };

  // Collision detection — count occurrences of each source/destination per tab
  const sigSourceCounts = {};
  const sigDestCounts   = {};
  for (const m of mappings) {
    sigSourceCounts[m.source]    = (sigSourceCounts[m.source]    || 0) + 1;
    sigDestCounts[m.destination] = (sigDestCounts[m.destination] || 0) + 1;
  }

  const triggerCounts  = {};
  const gateDestCounts = {};
  for (const m of triggerMappings) {
    triggerCounts[m.trigger]      = (triggerCounts[m.trigger]      || 0) + 1;
    gateDestCounts[m.destination] = (gateDestCounts[m.destination] || 0) + 1;
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div className={styles.panel} onMouseDown={e => e.stopPropagation()}>

        <div className={styles.header}>
          <span className={styles.title}>gesture routing</span>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div className={styles.tabNav}>
          <button className={tab === 'signals' ? styles.tabActive : styles.tab} onClick={() => setTab('signals')}>
            [ signals ]
          </button>
          <button className={tab === 'gates' ? styles.tabActive : styles.tab} onClick={() => setTab('gates')}>
            [ gates ]
          </button>
        </div>

        {/* ── Signals tab ── */}
        {tab === 'signals' && (
          <>
            <div className={styles.subheader}>
              map any gesture signal to any audio parameter · invert flips the range
            </div>

            <div className={styles.columnLabels}>
              <span>source</span>
              <span></span>
              <span>destination</span>
              <span>inv</span>
              <span></span>
            </div>

            <div className={styles.rowList}>
              {mappings.length === 0 && (
                <div className={styles.emptyState}>no routings — add one below</div>
              )}
              {mappings.map(m => (
                <div key={m.id} className={styles.row}>
                  <select className={`${styles.select} ${sigSourceCounts[m.source] > 1 ? styles.warningSelect : ''}`} value={m.source}
                    onChange={e => handleSignalChange(m.id, 'source', e.target.value)}>
                    {GESTURE_SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>

                  <span className={styles.arrow}>→</span>

                  <select className={`${styles.select} ${sigDestCounts[m.destination] > 1 ? styles.warningSelect : ''}`} value={m.destination}
                    onChange={e => handleSignalChange(m.id, 'destination', e.target.value)}>
                    {AUDIO_DESTINATIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>

                  <button
                    className={m.invert ? styles.invertBtnActive : styles.invertBtn}
                    onClick={() => handleSignalChange(m.id, 'invert', !m.invert)}
                    title="Invert the signal range"
                  >
                    {m.invert ? '●' : '○'}
                  </button>

                  <button className={styles.deleteBtn} onClick={() => handleSignalDelete(m.id)} title="Remove">×</button>
                </div>
              ))}
            </div>

            <div className={styles.footer}>
              <button className={styles.addBtn} onClick={handleSignalAdd}>[ + add routing ]</button>
              <button className={styles.resetBtn} onClick={handleSignalReset}>[ restore defaults ]</button>
            </div>
          </>
        )}

        {/* ── Gates tab ── */}
        {tab === 'gates' && (
          <>
            <div className={styles.subheader}>
              map finger combos to chord and arp actions · refresh restores defaults
            </div>

            <div className={styles.columnLabels} style={{ gridTemplateColumns: '1fr 20px 1fr 28px' }}>
              <span>trigger</span>
              <span></span>
              <span>action</span>
              <span></span>
            </div>

            <div className={styles.rowList}>
              {triggerMappings.length === 0 && (
                <div className={styles.emptyState}>no triggers — add one below</div>
              )}
              {triggerMappings.map(m => (
                <div key={m.id} className={styles.rowNarrow}>
                  <select className={`${styles.select} ${triggerCounts[m.trigger] > 1 ? styles.warningSelect : ''}`} value={m.trigger}
                    onChange={e => handleTriggerChange(m.id, 'trigger', e.target.value)}>
                    {TRIGGER_SOURCE_GROUPS.map(g => (
                      <optgroup key={g.group} label={g.label}>
                        {g.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </optgroup>
                    ))}
                  </select>

                  <span className={styles.arrow}>→</span>

                  <select className={`${styles.select} ${gateDestCounts[m.destination] > 1 ? styles.warningSelect : ''}`} value={m.destination}
                    onChange={e => handleTriggerChange(m.id, 'destination', e.target.value)}>
                    {TRIGGER_DESTINATION_GROUPS.map(g => (
                      <optgroup key={g.group} label={g.label}>
                        {g.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </optgroup>
                    ))}
                  </select>

                  <button className={styles.deleteBtn} onClick={() => handleTriggerDelete(m.id)} title="Remove">×</button>
                </div>
              ))}
            </div>

            <div className={styles.footer}>
              <button className={styles.addBtn} onClick={handleTriggerAdd}>[ + add trigger ]</button>
              <button className={styles.resetBtn} onClick={handleTriggerReset}>[ restore defaults ]</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
