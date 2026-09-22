import { useRef } from 'react';
import styles from './MoogFader.module.css';

// ── Vertical slide fader (Phase 104) ──
//
// A late-60s console fader: a recessed slot milled into the faceplate with a
// knurled aluminium cap riding in it. Chosen over a rotary knob for the I/O input
// stage because a fader is far NARROWER than a knob's tick ring (a `sm` MoogKnob
// reserves 52px of width; this reserves 26px), which is what let the channel count
// go from 4 to 8 inside the same plate — the module got no wider or taller.
//
// Drag anywhere on the fader to move it; the whole body is the grab target, not
// just the cap, which is how a real fader behaves and is far easier to hit.
// Double-click resets to `defaultValue`, matching MoogKnob's gesture.
//
// `cursor: ns-resize` is LOAD-BEARING, not decoration: it is what tells the
// cabinet's `isInteractive` check this is a control rather than empty faceplate to
// grab and pan the rack with. The camera's pan listener is native on `.cabinet`, so
// it has already fired by the time React dispatches — stopPropagation cannot help.

const TRAVEL_PX = 58;   // must match .faderSlot height minus .faderCap height in the CSS

export default function MoogFader({
  label, value = 0, onChange, defaultValue = 0.8, title,
}) {
  const bodyRef = useRef(null);

  const begin = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startV = value;
    const onMove = (ev) => {
      // Up = louder. Screen Y grows downward, so the delta is inverted.
      const dv = (startY - ev.clientY) / TRAVEL_PX;
      onChange?.(Math.max(0, Math.min(1, startV + dv)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const v = Math.max(0, Math.min(1, value));
  // 0 = bottom of travel, 1 = top. `bottom` positions the cap from the slot floor.
  const capBottom = v * TRAVEL_PX;

  return (
    <div className={styles.faderGroup} title={title}>
      <div
        ref={bodyRef}
        className={styles.faderBody}
        onMouseDown={begin}
        onDoubleClick={() => onChange?.(defaultValue)}
      >
        <div className={styles.faderSlot}>
          {/* Scale ticks etched into the faceplate beside the slot */}
          <div className={styles.faderTicks} aria-hidden="true">
            {[0, 1, 2, 3, 4].map(i => <span key={i} className={styles.faderTick} />)}
          </div>
          <div className={styles.faderCap} style={{ bottom: `${capBottom}px` }}>
            <div className={styles.faderCapLine} />
          </div>
        </div>
      </div>
      {label && <span className={styles.faderLabel}>{label}</span>}
    </div>
  );
}
