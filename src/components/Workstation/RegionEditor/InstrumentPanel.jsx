import { useEffect, useRef, useState, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './InstrumentPanel.module.css';
import DrumKitPanel from './DrumKitPanel';
import KeyboardPanel from './KeyboardPanel';
import { DRUM_KITS, isDrumKit } from '../drumKits';

/**
 * Instrument-tab performance UI: routes to the visual drum kit (drum kit
 * tracks) or the playable keyboard (melodic tracks), owns the single QWERTY
 * window listener for both, and drives all audio through the hook's
 * audition API — so notes ride the track's volume → pan → FX → mute chain
 * (unlike the piano-roll key preview, which goes straight to Destination).
 *
 * Zero-Re-render Rule: note on/off, drum hits and flashes are direct DOM
 * (classList on [data-note] elements via rootRef). The only React state is
 * octaveBase — a discrete cold-path action.
 *
 * @param {string}   trackId
 * @param {string}   instrument         — local dropdown state from RegionEditor
 * @param {boolean}  isLoading          — sampler buffers still downloading
 * @param {Function} auditionAttack / auditionRelease / auditionReleaseAll / auditionPrime
 */

// Moog KeyboardModule's chromatic map (muscle-memory consistency): C → C.
const MELODIC_KEY_ORDER = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const NOTE_SEQ = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Drum piece hotkeys — NOT the chromatic map: a chromatic octave would hit
// unmapped keys (C#4, F#4…) and Tone.Sampler would repitch neighbors there.
const DRUM_NOTE_TO_KEY = {
  'C4': 'a', 'E4': 's', 'D4': 'd',                    // kick, snare, rim/alt snare
  'F4': 'f', 'A4': 'g', 'C5': 'h',                    // toms low/mid/high
  'C#5': 'j', 'D#5': 'k',                             // hats closed/open
  'F#5': 'u', 'G#5': 'i', 'A#5': 'o',                 // crash/ride/crash 2
  'D5': 'w', 'E5': 'e', 'F5': 'r',                    // bonus percussion
};

const buildMaps = (instrument, octaveBase) => {
  const keyToNote = {};
  const noteToKey = {};
  if (isDrumKit(instrument)) {
    const urls = DRUM_KITS[instrument]?.urls ?? {};
    for (const [note, key] of Object.entries(DRUM_NOTE_TO_KEY)) {
      if (!urls[note]) continue; // filter to sounds this kit actually has
      keyToNote[key] = note;
      noteToKey[note] = key;
    }
  } else {
    MELODIC_KEY_ORDER.forEach((key, i) => {
      const note = `${NOTE_SEQ[i % 12]}${octaveBase + Math.floor(i / 12)}`;
      keyToNote[key] = note;
      noteToKey[note] = key;
    });
  }
  return { keyToNote, noteToKey };
};

const inTextInput = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export default function InstrumentPanel({
  trackId, instrument, isLoading,
  auditionAttack, auditionRelease, auditionReleaseAll, auditionPrime,
}) {
  const rootRef        = useRef(null);
  const heldByKeyRef   = useRef(new Map()); // e.key → note captured at keydown
  const flashTimersRef = useRef(new Map()); // note  → timeout id
  const [octaveBase, setOctaveBase] = useState(4);

  const drums = isDrumKit(instrument);

  const elFor = useCallback((note) =>
    rootRef.current?.querySelector(`[data-note="${note}"]`), []);

  // PianoRoll flash pattern: cancel prior timer, force reflow so a rapid
  // re-fire restarts the CSS animation (getBoundingClientRect — SVG elements
  // have no offsetWidth), re-add class.
  const hitFlash = useCallback((note) => {
    const el = elFor(note);
    if (!el) return;
    const timers = flashTimersRef.current;
    clearTimeout(timers.get(note));
    el.classList.remove(styles.hit);
    void el.getBoundingClientRect();
    el.classList.add(styles.hit);
    timers.set(note, setTimeout(() => {
      el.classList.remove(styles.hit);
      timers.delete(note);
    }, 200));
  }, [elFor]);

  const setPressed = useCallback((note, on) => {
    elFor(note)?.classList.toggle(styles.keyDown, on);
  }, [elFor]);

  const triggerDrum = useCallback((note) => {
    Tone.start().then(() => auditionAttack(trackId, note));
    hitFlash(note);
  }, [trackId, auditionAttack, hitFlash]);

  const noteOn = useCallback((note) => {
    Tone.start().then(() => auditionAttack(trackId, note));
    setPressed(note, true);
  }, [trackId, auditionAttack, setPressed]);

  const noteOff = useCallback((note) => {
    auditionRelease(trackId, note);
    setPressed(note, false);
  }, [trackId, auditionRelease, setPressed]);

  // Prime: build the audition synth (and start any sample download) as soon
  // as the tab opens; re-runs on instrument change to rebuild it.
  useEffect(() => {
    if (trackId) auditionPrime?.(trackId);
  }, [trackId, instrument, auditionPrime]);

  // QWERTY — single window listener for both panel kinds.
  useEffect(() => {
    if (!trackId) return undefined;
    const { keyToNote } = buildMaps(instrument, octaveBase);
    const isDrums = isDrumKit(instrument);
    const held = heldByKeyRef.current;

    const releaseAllHeld = () => {
      for (const note of held.values()) {
        if (isDrums) continue; // one-shots ring out
        auditionRelease(trackId, note);
        setPressed(note, false);
      }
      held.clear();
    };

    const down = (e) => {
      if (rootRef.current?.offsetParent === null) return; // page hidden (Root keeps pages mounted)
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (inTextInput()) return;
      const k = e.key.toLowerCase();
      if (!isDrums && (k === 'z' || k === 'x')) {
        setOctaveBase(b => Math.max(3, Math.min(4, b + (k === 'x' ? 1 : -1))));
        return;
      }
      const note = keyToNote[k];
      if (!note || held.has(k)) return;
      held.set(k, note);
      if (isDrums) triggerDrum(note);
      else noteOn(note);
    };
    const up = (e) => {
      const note = held.get(e.key.toLowerCase());
      if (!note) return;
      held.delete(e.key.toLowerCase());
      if (!isDrums) noteOff(note);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAllHeld);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAllHeld);
      releaseAllHeld();
      auditionReleaseAll?.(trackId); // catches mouse-held notes on tab switch/unmount too
    };
  }, [trackId, instrument, octaveBase, triggerDrum, noteOn, noteOff, setPressed, auditionRelease, auditionReleaseAll]);

  // Flash timers die with the panel.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  if (!trackId) return null;

  const { noteToKey } = buildMaps(instrument, octaveBase);

  return (
    <div ref={rootRef} className={styles.panel}>
      <div className={`${styles.content} ${isLoading ? styles.dimmed : ''}`}>
        {isLoading && <span className={styles.loadingText}>loading samples…</span>}
        {drums ? (
          <DrumKitPanel instrument={instrument} onTrigger={triggerDrum} hotkeys={noteToKey} />
        ) : (
          <KeyboardPanel octaveBase={octaveBase} onNoteOn={noteOn} onNoteOff={noteOff} hotkeys={noteToKey} />
        )}
        <span className={styles.hint}>
          {drums
            ? 'a s d f g h · j k hats · u i o cymbals · w e r perc'
            : 'a–k play · w e t y u sharps · z / x octave'}
        </span>
      </div>
    </div>
  );
}
