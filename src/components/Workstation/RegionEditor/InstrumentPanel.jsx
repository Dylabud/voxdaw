import { useEffect, useRef, useState, useCallback } from 'react';
import * as Tone from 'tone';
import styles from './InstrumentPanel.module.css';
import DrumKitPanel from './DrumKitPanel';
import KeyboardPanel from './KeyboardPanel';
import RotaryKnob from './RotaryKnob';
import { DRUM_KITS, isDrumKit } from '../drumKits';
import { isSampledInstrument, defaultEnvelopeFor } from '../synthFactory';

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

// Moog KeyboardModule's chromatic map (muscle-memory consistency): C → C, then
// extended a further 4th into the second visible octave. Home row = white keys
// (…j k l ; '), top row = black keys (…u [gap] o p [gap] ]) — '[' is the E–F
// no-black-key skip, mirroring 'r'/'i' in the first octave.
const MELODIC_KEY_ORDER = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j',
                           'k', 'o', 'l', 'p', ';', "'", ']'];
const NOTE_SEQ = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Octave stepper bounds (sliding-window keyboard). C-2..C9 spanned at the edges.
const MIN_OCT = -2;
const MAX_OCT = 7;

// Chassis knob metadata — 0..1 ↔ real-value mapping (log for time params so the
// short end has resolution), mirroring EffectsRack's toKnob/fromKnob.
const VOL_META = { min: 0, max: 100 };
const ENV_META = {
  attack:  { min: 0.001, max: 2, scale: 'log', label: 'atk' },
  decay:   { min: 0.001, max: 2, scale: 'log', label: 'dcy' },
  sustain: { min: 0,     max: 1,               label: 'sus' },
  release: { min: 0.001, max: 3, scale: 'log', label: 'rel' },
};
const toKnob = (value, meta) => meta.scale === 'log'
  ? Math.log(value / meta.min) / Math.log(meta.max / meta.min)
  : (value - meta.min) / (meta.max - meta.min);
const fromKnob = (v, meta) => {
  const out = meta.scale === 'log'
    ? meta.min * Math.pow(meta.max / meta.min, v)
    : meta.min + (meta.max - meta.min) * v;
  return Math.min(meta.max, Math.max(meta.min, out));
};
const fmtTime = (s) => (s < 0.1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`);

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
  volume = 75, envelope, onVolumeChange, onEnvelopeChange,
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
        setOctaveBase(b => Math.max(MIN_OCT, Math.min(MAX_OCT, b + (k === 'x' ? 1 : -1))));
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

  // Chassis knob values. Sampled melodic instruments (Tone.Sampler) only expose
  // attack/release, so decay/sustain are hidden; drum kits get no ADSR/octave.
  const sampledMelodic   = !drums && isSampledInstrument(instrument);
  const showDecaySustain = !drums && !sampledMelodic;
  const defEnv = defaultEnvelopeFor(instrument) || {};
  const curEnv = { ...defEnv, ...(envelope || {}) };

  const envKnob = (key) => {
    const meta = ENV_META[key];
    const val = curEnv[key] ?? meta.min;
    return (
      <RotaryKnob
        key={key}
        value01={toKnob(val, meta)}
        defaultValue01={toKnob(defEnv[key] ?? meta.min, meta)}
        onChange={(v) => onEnvelopeChange?.(trackId, { [key]: fromKnob(v, meta) })}
        label={meta.label}
        display={key === 'sustain' ? val.toFixed(2) : fmtTime(val)}
        size={38}
      />
    );
  };

  return (
    <div ref={rootRef} className={styles.panel}>
      <div className={`${styles.content} ${isLoading ? styles.dimmed : ''}`}>
        {isLoading && <span className={styles.loadingText}>loading samples…</span>}

        {/* Control chassis — Master · Envelope · Pitch. Drum kits get no chassis
            (volume lives in the track header; ADSR/octave don't apply). */}
        {!drums && (
        <div className={styles.chassis}>
          <div className={styles.knobGroup}>
            <span className={styles.groupLabel}>master</span>
            <div className={styles.knobRow}>
              <RotaryKnob
                value01={toKnob(volume, VOL_META)}
                defaultValue01={toKnob(75, VOL_META)}
                onChange={(v) => onVolumeChange?.(trackId, fromKnob(v, VOL_META))}
                label="vol"
                display={String(Math.round(volume))}
                size={38}
              />
            </div>
          </div>

          <div className={styles.knobGroup}>
            <span className={styles.groupLabel}>envelope</span>
            <div className={styles.knobRow}>
              {envKnob('attack')}
              {showDecaySustain && envKnob('decay')}
              {showDecaySustain && envKnob('sustain')}
              {envKnob('release')}
            </div>
          </div>

          <div className={styles.knobGroup}>
            <span className={styles.groupLabel}>pitch</span>
            <div className={styles.octaveRow}>
                <button
                  className={styles.octaveBtn}
                  onClick={() => setOctaveBase((b) => Math.max(MIN_OCT, b - 1))}
                  disabled={octaveBase <= MIN_OCT}
                  aria-label="octave down"
                >−</button>
                <span className={styles.octaveDisplay}>OCT&nbsp;{octaveBase}</span>
                <button
                  className={styles.octaveBtn}
                  onClick={() => setOctaveBase((b) => Math.min(MAX_OCT, b + 1))}
                  disabled={octaveBase >= MAX_OCT}
                  aria-label="octave up"
                >+</button>
              </div>
            </div>
          </div>
        )}

        {drums ? (
          <DrumKitPanel instrument={instrument} onTrigger={triggerDrum} hotkeys={noteToKey} />
        ) : (
          <KeyboardPanel octaveBase={octaveBase} onNoteOn={noteOn} onNoteOff={noteOff} hotkeys={noteToKey} />
        )}
        <span className={styles.hint}>
          {drums
            ? 'a s d f g h · j k hats · u i o cymbals · w e r perc'
            : "a–' play · w e t y u o p ] sharps · z / x octave"}
        </span>
      </div>
    </div>
  );
}
