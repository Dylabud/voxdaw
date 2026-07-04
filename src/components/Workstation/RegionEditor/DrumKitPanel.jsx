import styles from './InstrumentPanel.module.css';
import { DRUM_KITS } from '../drumKits';

/**
 * Visual drum kit for the instrument tab — a stylized SVG kit whose pieces
 * are click targets, plus a strip of small pads for the sounds that don't
 * fit on a drawn kit (alt kicks, bonus percussion).
 *
 * The 11 main pieces are kit-invariant (every kit in DRUM_KITS maps them);
 * only the pad strip is derived per kit. Pure presentation: all audio and
 * flash-class work happens in InstrumentPanel via onTrigger — this component
 * only stamps data-note attributes for it to target.
 *
 * @param {string} instrument                — drum kit name (key of DRUM_KITS)
 * @param {(note: string) => void} onTrigger — fire a drum hit
 * @param {Record<string,string>} hotkeys    — note → QWERTY letter (tooltips)
 */

// Notes drawn on the kit graphic; everything else in urls goes to the strip.
const SVG_NOTES = new Set(['C4', 'E4', 'D4', 'F4', 'A4', 'C5', 'C#5', 'D#5', 'F#5', 'G#5', 'A#5']);

const padLabel = (file) => file.replace(/\.[^.]+$/, '').replace(/-/g, ' ');

export default function DrumKitPanel({ instrument, onTrigger, hotkeys = {} }) {
  const kit = DRUM_KITS[instrument];
  if (!kit) return null;

  const altNotes = Object.keys(kit.urls).filter(n => !SVG_NOTES.has(n));

  // <g data-note> wrapper: title tooltip, shared piece styling, hit target.
  const Piece = ({ note, label, children, labelX, labelY }) => (
    <g
      data-note={note}
      className={styles.piece}
      onMouseDown={() => onTrigger(note)}
    >
      <title>{`${label} (${note})${hotkeys[note] ? ` — key ${hotkeys[note]}` : ''}`}</title>
      {children}
      {labelX != null && (
        <text className={styles.pieceLabel} x={labelX} y={labelY}>{label}</text>
      )}
    </g>
  );

  return (
    <>
      <svg className={styles.kitSvg} viewBox="0 0 720 300" role="group" aria-label="drum kit">
        {/* Stands first — decorative, behind everything, no pointer events. */}
        <path className={styles.stand} d="M105 168 V 285 M85 285 H 125" />
        <path className={styles.stand} d="M235 68 V 285 M215 285 H 255" />
        <path className={styles.stand} d="M480 58 V 150 M480 240 V 285 M460 285 H 500" />
        <path className={styles.stand} d="M625 92 V 285 M605 285 H 645" />

        {/* Cymbals */}
        <Piece note="F#5" label="crash" labelX={235} labelY={30}>
          <ellipse cx="235" cy="55" rx="58" ry="12" transform="rotate(-8 235 55)" />
        </Piece>
        <Piece note="A#5" label="crash 2" labelX={480} labelY={20}>
          <ellipse cx="480" cy="45" rx="50" ry="11" transform="rotate(6 480 45)" />
        </Piece>
        <Piece note="G#5" label="ride" labelX={625} labelY={54}>
          <ellipse cx="625" cy="78" rx="62" ry="13" transform="rotate(4 625 78)" />
        </Piece>

        {/* Hi-hat — upper tight pair = closed, dropped lower pair = open
            (reads as pedal position). Invisible fat ellipses widen the thin
            hit targets. */}
        <Piece note="C#5" label="hat c" labelX={105} labelY={68}>
          {/* inline style: the .piece class fill would override attributes */}
          <ellipse cx="105" cy="88" rx="48" ry="16" style={{ fill: 'transparent', stroke: 'none' }} />
          <ellipse cx="105" cy="85" rx="42" ry="8" />
          <ellipse cx="105" cy="93" rx="42" ry="8" />
        </Piece>
        <Piece note="D#5" label="hat o" labelX={105} labelY={195}>
          <ellipse cx="105" cy="152" rx="48" ry="22" style={{ fill: 'transparent', stroke: 'none' }} />
          <ellipse cx="105" cy="142" rx="42" ry="9" />
          <ellipse cx="105" cy="166" rx="42" ry="9" />
        </Piece>

        {/* Rack toms above the kick, floor tom to the right */}
        <Piece note="A4" label="mid" labelX={330} labelY={112}>
          <circle cx="330" cy="108" r="32" />
        </Piece>
        <Piece note="C5" label="hi" labelX={405} labelY={106}>
          <circle cx="405" cy="102" r="27" />
        </Piece>
        <Piece note="F4" label="low" labelX={555} labelY={195}>
          <circle cx="555" cy="190" r="46" />
        </Piece>

        {/* Snare with a rim ring (side-stick zone) — rim drawn first, snare
            on top; the exposed annulus is the rim's hit area. */}
        <Piece note="D4" label="rim" labelX={240} labelY={135}>
          <circle cx="240" cy="190" r="48" />
        </Piece>
        <Piece note="E4" label="snare" labelX={240} labelY={194}>
          <circle cx="240" cy="190" r="39" />
        </Piece>

        {/* Kick */}
        <Piece note="C4" label="kick" labelX={400} labelY={215}>
          <circle cx="400" cy="210" r="60" />
        </Piece>
      </svg>

      {altNotes.length > 0 && (
        <div className={styles.padStrip}>
          {altNotes.map(note => (
            <button
              key={note}
              type="button"
              data-note={note}
              className={styles.pad}
              title={`${padLabel(kit.urls[note])} (${note})${hotkeys[note] ? ` — key ${hotkeys[note]}` : ''}`}
              onMouseDown={() => onTrigger(note)}
            >
              {padLabel(kit.urls[note])}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
