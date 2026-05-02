import { useState } from 'react';
import styles from './MidiModal.module.css';

const NodeLink = () => (
  <a className={styles.link} href="https://nodejs.org/" target="_blank" rel="noreferrer">Node.js</a>
);

const LoopMidiLink = () => (
  <a className={styles.link} href="https://www.tobias-erichsen.de/software/loopmidi.html" target="_blank" rel="noreferrer">loopMIDI</a>
);

export default function MidiModal({ onClose }) {
  const [view, setView] = useState('menu');

  const views = {
    menu: (
      <>
        <h2 className={styles.heading}>MIDI Bridge Connection</h2>
        <p className={styles.body}>
          The local MIDI bridge is currently offline. Are you setting this up
          for the first time?
        </p>
        <div className={styles.actionsStack}>
          <button className={styles.ghostBtn} onClick={() => setView('returning')}>
            [ I've already set this up ]
          </button>
          <button className={styles.ghostBtn} onClick={() => setView('windows')}>
            [ First time on Windows ]
          </button>
          <button className={styles.ghostBtn} onClick={() => setView('mac')}>
            [ First time on Mac / Linux ]
          </button>
        </div>
        <div className={styles.actionsRow}>
          <button className={styles.closeBtn} onClick={onClose}>cancel</button>
        </div>
      </>
    ),

    returning: (
      <>
        <h2 className={styles.heading}>Reconnect Bridge</h2>
        <p className={styles.body}>
          1. Open your downloaded <code className={styles.code}>voxdaw-server</code> folder.<br />
          2. Double-click your Start script (<code className={styles.code}>Start-Windows.bat</code> or{' '}
          <code className={styles.code}>Start-Mac.command</code>).<br />
          3. Leave the terminal window open in the background!
        </p>
        <div className={styles.actionsRow}>
          <button className={styles.closeBtn} onClick={() => setView('menu')}>[ back ]</button>
          <button className={styles.primaryBtn} onClick={onClose}>[ close &amp; try again ]</button>
        </div>
      </>
    ),

    windows: (
      <>
        <h2 className={styles.heading}>Windows Setup</h2>
        <p className={styles.body}>
          1. Install <NodeLink /> (nodejs.org).<br />
          2. Download and install <LoopMidiLink />. Create a new port named exactly{' '}
          <code className={styles.code}>VoxDaw</code>.<br />
          3. Download the Bridge below, unzip it, and run{' '}
          <code className={styles.code}>Start-Windows.bat</code>.<br />
          4. Leave the terminal window open!
        </p>
        <div className={styles.actionsRow}>
          <button className={styles.closeBtn} onClick={() => setView('menu')}>[ back ]</button>
          <a className={styles.primaryBtn} href="/VoxDaw-MIDI-Bridge.zip" download>
            [ download bridge ]
          </a>
        </div>
      </>
    ),

    mac: (
      <>
        <h2 className={styles.heading}>Mac Setup</h2>
        <p className={styles.body}>
          1. Install <NodeLink /> (nodejs.org).<br />
          2. Download the Bridge below, unzip it, and run{' '}
          <code className={styles.code}>Start-Mac.command</code>.<br />
          3. Leave the terminal window open!<br />
          <em>*(Linux users: run <code className={styles.code}>node server.js</code> directly via ALSA).*</em>
        </p>
        <div className={styles.actionsRow}>
          <button className={styles.closeBtn} onClick={() => setView('menu')}>[ back ]</button>
          <a className={styles.primaryBtn} href="/VoxDaw-MIDI-Bridge.zip" download>
            [ download bridge ]
          </a>
        </div>
      </>
    ),
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.box} onClick={e => e.stopPropagation()}>
        {views[view]}
      </div>
    </div>
  );
}
