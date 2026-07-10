import EffectsRack from './RegionEditor/EffectsRack';
import { automatedFxKeys } from './automationMath';
import styles from './GroupFxPanel.module.css';

/**
 * Bottom-docked effects rack for a GROUP bus — the cheapest correct group-FX
 * surface: RegionEditor is deeply track-coupled (piano roll, audition,
 * instrument tab), but EffectsRack itself is channel-agnostic (it only needs
 * effects + CRUD callbacks), so it hosts a group directly. The rack's CSS
 * offsets itself by --left-col-width (it normally overlays the editor beside
 * the inspector column); the host zeroes that var so it fills this panel.
 */
export default function GroupFxPanel({
  group, performanceQuality, onClose, onAdd, onRemove, onToggleBypass, onUpdate,
}) {
  if (!group) return null;
  return (
    <div className={styles.panel} style={{ '--track-color': group.color }}>
      <div className={styles.header}>
        <span className={styles.dot} style={{ background: group.color }} />
        <span className={styles.title}>{group.name} — group effects</span>
        <span className={styles.hint}>applied after each member track's own effects</span>
        <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
      </div>
      <div className={styles.rackHost} style={{ '--left-col-width': '0px' }}>
        <EffectsRack
          effects={group.effects ?? []}
          trackId={group.id}
          onAdd={onAdd}
          onRemove={onRemove}
          onToggleBypass={onToggleBypass}
          onUpdate={onUpdate}
          performanceQuality={performanceQuality}
          automatedKeys={automatedFxKeys(group)}
        />
      </div>
    </div>
  );
}
