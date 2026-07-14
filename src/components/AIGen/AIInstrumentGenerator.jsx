import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './AIInstrumentGenerator.module.css';
import ipStyles from '../Workstation/RegionEditor/InstrumentPanel.module.css';
import KeyboardPanel from '../Workstation/RegionEditor/KeyboardPanel';
import RotaryKnob from '../Workstation/RegionEditor/RotaryKnob';
import { toKnob, fromKnob } from '../Workstation/automationMath';
import { EFFECT_DEFS, effectLabel } from '../Workstation/effectDefs';
import useAIInstrument from '../../hooks/useAIInstrument';
import useMidiInput from '../../hooks/useMidiInput';
import { saveToLibrary } from '../Workstation/customInstruments';
import { serializeProject, downloadJSON } from '../Workstation/projectIO';
import { generatePatch, describeApiError } from './claudeService';
import {
  AI_MODELS, DEFAULT_MODEL, DEFAULT_PATCH,
  VOL_META, ENV_META, VOICE_META, FILTER_META, FILTER_TYPES,
} from './patchSchema';

/**
 * AI Instrument Generator — standalone page. Describe an instrument, Claude
 * returns a synth patch (patchSchema.js), useAIInstrument plays it. The knob
 * chassis reflects AND edits the generated patch: audio writes go straight to
 * the hook's imperative setters (Zero-Re-render Rule — audio never waits on a
 * render); React state is just the knob visuals. Double-click a knob returns
 * to the value the AI chose (generatedPatchRef).
 *
 * Keyboard + chassis chrome are shared with the workstation InstrumentPanel
 * (KeyboardPanel + InstrumentPanel.module.css classes). The QWERTY window
 * listener carries the same guards — including offsetParent === null, which
 * keeps the hidden page silent while Root keeps it mounted display:none.
 */

const LS_KEY   = 'voxdaw.anthropicKey';
const LS_MODEL = 'voxdaw.aigenModel';

const MIN_OCT = -2;
const MAX_OCT = 7;

// InstrumentPanel's chromatic QWERTY map (muscle-memory consistency).
const MELODIC_KEY_ORDER = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j',
                           'k', 'o', 'l', 'p', ';', "'", ']'];
const NOTE_SEQ = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const buildMelodicMap = (octaveBase) => {
  const keyToNote = {};
  const noteToKey = {};
  MELODIC_KEY_ORDER.forEach((key, i) => {
    const note = `${NOTE_SEQ[i % 12]}${octaveBase + Math.floor(i / 12)}`;
    keyToNote[key] = note;
    noteToKey[note] = key;
  });
  return { keyToNote, noteToKey };
};

const inTextInput = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

const fmtTime = (s) => (s < 0.1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`);
const fmtVal = (v, meta) => {
  if (typeof v !== 'number') return String(v);
  if (meta.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
  if (meta.unit === 's')  return fmtTime(v);
  if (meta.unit === 'db') return v.toFixed(1);
  return Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(2);
};

// Transparent stand-in when the patch carries filter: null — the chassis
// always shows the filter group (mirrors useAIInstrument.FILTER_NEUTRAL).
const NEUTRAL_FILTER = { type: 'lowpass', frequency: 18000, q: 0.7071 };

export default function AIInstrumentGenerator({ onNavigateHome, isDarkMode, onThemeToggle }) {
  const rootRef      = useRef(null);
  const heldByKeyRef = useRef(new Map());        // e.key → note captured at keydown
  const genPatchRef  = useRef(DEFAULT_PATCH);    // knob double-click restore target

  const [patch, setPatch] = useState(DEFAULT_PATCH);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => {
    const saved = localStorage.getItem(LS_MODEL);
    return AI_MODELS.some(m => m.id === saved) ? saved : DEFAULT_MODEL;
  });
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);       // transient success line
  const [octaveBase, setOctaveBase] = useState(4);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameMenu, setNameMenu] = useState(false);  // right-click "edit name" menu

  const {
    applyPatch, noteOn, noteOff, releaseAll,
    setVolume, setEnvelope, setVoiceParam, setFilter, setEffectParam,
  } = useAIInstrument();

  // INIT patch — keyboard playable before the first generation.
  useEffect(() => { applyPatch(DEFAULT_PATCH); }, [applyPatch]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  const setPressed = useCallback((note, on) => {
    rootRef.current?.querySelector(`[data-note="${note}"]`)
      ?.classList.toggle(ipStyles.keyDown, on);
  }, []);
  const handleNoteOn = useCallback((note, velocity) => {
    noteOn(note, velocity);
    setPressed(note, true);
  }, [noteOn, setPressed]);
  const handleNoteOff = useCallback((note) => {
    noteOff(note);
    setPressed(note, false);
  }, [noteOff, setPressed]);

  // ── MIDI input (Web MIDI) — hardware controller plays the generator ───────
  const { inputs: midiInputs, selectedId: midiSelectedId, selectInput: selectMidi, supported: midiSupported } =
    useMidiInput({ onNoteOn: handleNoteOn, onNoteOff: handleNoteOff, rootRef });

  // Flash a transient notice line (save confirmations).
  const flashNotice = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveToWorkstation = useCallback(() => {
    setShowSaveMenu(false);
    saveToLibrary(patch.name, patch);
    flashNotice(`saved "${patch.name}" to workstation instruments`);
  }, [patch, flashNotice]);

  const saveAsVoxdaw = useCallback(() => {
    setShowSaveMenu(false);
    // A self-contained id/def just for the file (independent of the library).
    const id = `custom:${crypto.randomUUID()}`;
    const def = { id, name: patch.name, patch };
    const track = {
      id: 't1', name: patch.name, instrument: id, color: '#5DCAA5',
      isMuted: false, isSolo: false, volume: 75, pan: 0, effects: [],
    };
    const payload = serializeProject({
      bpm: 120, totalMeasures: 24, tracks: [track], regions: [], notes: [],
      name: patch.name, globalAutomations: [], groups: [], customInstruments: [def],
    });
    const safe = (patch.name || 'instrument').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase() || 'instrument';
    downloadJSON(payload, `${safe}.voxdaw`);
    flashNotice(`exported ${safe}.voxdaw`);
  }, [patch, flashNotice]);

  // ── Rename the generated patch ──────────────────────────────────────────────
  const commitName = useCallback((raw) => {
    const name = String(raw ?? '').trim().slice(0, 48);
    if (name) {
      setPatch((p) => ({ ...p, name }));
      genPatchRef.current = { ...genPatchRef.current, name };
    }
    setEditingName(false);
  }, []);

  // Close the save / name menus on any outside click (menu roots opt out via
  // data-aigen-menu, so a click on the toggle or an item runs its own handler).
  useEffect(() => {
    if (!showSaveMenu && !nameMenu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('[data-aigen-menu]')) { setShowSaveMenu(false); setNameMenu(false); }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showSaveMenu, nameMenu]);

  // QWERTY — single window listener (InstrumentPanel pattern, melodic only).
  useEffect(() => {
    const { keyToNote } = buildMelodicMap(octaveBase);
    const held = heldByKeyRef.current;

    const releaseAllHeld = () => {
      for (const note of held.values()) handleNoteOff(note);
      held.clear();
    };

    const down = (e) => {
      if (rootRef.current?.offsetParent === null) return; // page hidden (Root keeps pages mounted)
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (inTextInput()) return; // doubly load-bearing — the prompt bar is a text input
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'x') {
        setOctaveBase(b => Math.max(MIN_OCT, Math.min(MAX_OCT, b + (k === 'x' ? 1 : -1))));
        return;
      }
      const note = keyToNote[k];
      if (!note || held.has(k)) return;
      held.set(k, note);
      handleNoteOn(note);
    };
    const up = (e) => {
      const note = held.get(e.key.toLowerCase());
      if (!note) return;
      held.delete(e.key.toLowerCase());
      handleNoteOff(note);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAllHeld);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAllHeld);
      releaseAllHeld();
      releaseAll(); // catches mouse-held notes too
    };
  }, [octaveBase, handleNoteOn, handleNoteOff, releaseAll]);

  // ── Generate ────────────────────────────────────────────────────────────
  const openSettings = () => { setKeyDraft(apiKey); setShowSettings(true); };

  const handleGenerate = async (e) => {
    e?.preventDefault();
    if (isGenerating) return;
    if (!apiKey) { openSettings(); return; }
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError(null);
    try {
      const res = await generatePatch({ apiKey, model, description: prompt.trim(), mode: 'patch' });
      if (res.refusal) {
        setError('the model declined this request — try rephrasing');
      } else {
        genPatchRef.current = res.patch;
        setPatch(res.patch);
        applyPatch(res.patch);
      }
    } catch (err) {
      const d = describeApiError(err);
      setError(d.msg);
      if (d.kind === 'auth') openSettings();
    } finally {
      setIsGenerating(false);
    }
  };

  // ── Knob handlers — audio imperatively, React state for the visual ──────
  const onVolKnob = (v01) => {
    const db = fromKnob(v01, VOL_META);
    setVolume(db);
    setPatch(p => ({ ...p, volume: db }));
  };
  const onEnvKnob = (key) => (v01) => {
    const val = fromKnob(v01, ENV_META[key]);
    setEnvelope({ [key]: val });
    setPatch(p => ({ ...p, envelope: { ...p.envelope, [key]: val } }));
  };
  const onVoiceKnob = (key) => (v01) => {
    const val = fromKnob(v01, VOICE_META[key]);
    setVoiceParam(key, val);
    setPatch(p => ({ ...p, voice: { ...p.voice, [key]: val } }));
  };
  const onFilterChange = (partial) => {
    setFilter(partial);
    setPatch(p => ({ ...p, filter: { ...(p.filter ?? NEUTRAL_FILTER), ...partial } }));
  };
  const onFxParam = (i, key, value) => {
    setEffectParam(i, key, value);
    setPatch(p => ({
      ...p,
      effects: p.effects.map((fx, j) =>
        j === i ? { ...fx, params: { ...fx.params, [key]: value } } : fx),
    }));
  };

  const gen = genPatchRef.current;
  const curFilter = patch.filter ?? NEUTRAL_FILTER;
  const genFilter = gen.filter ?? NEUTRAL_FILTER;
  const engine = patch.voice.engine;

  const knobGroup = (label, children, key = label) => (
    <div className={ipStyles.knobGroup} key={key}>
      <span className={ipStyles.groupLabel}>{label}</span>
      <div className={ipStyles.knobRow}>{children}</div>
    </div>
  );

  const fxControl = (i, key, meta) => {
    const val = patch.effects[i].params[key];
    const genVal = gen.effects[i]?.params?.[key] ?? EFFECT_DEFS[patch.effects[i].type].params[key].default;
    if (meta.kind === 'toggle') {
      return (
        <button
          key={key}
          className={`${styles.pill} ${val ? styles.pillOn : ''}`}
          onClick={() => onFxParam(i, key, !val)}
        >{meta.label}</button>
      );
    }
    if (meta.kind === 'select') {
      return (
        <label key={key} className={styles.miniSelectWrap}>
          <select
            className={styles.miniSelect}
            value={val}
            onChange={(e) => onFxParam(i, key, e.target.value)}
          >
            {meta.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className={styles.miniSelectLabel}>{meta.label}</span>
        </label>
      );
    }
    return (
      <RotaryKnob
        key={key}
        value01={toKnob(val, meta)}
        defaultValue01={toKnob(genVal, meta)}
        onChange={(v01) => onFxParam(i, key, fromKnob(v01, meta))}
        label={meta.label}
        display={fmtVal(val, meta)}
        size={38}
      />
    );
  };

  return (
    <div ref={rootRef} className={styles.page}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.homeBtn} onClick={onNavigateHome}>[ home ]</button>
          <span className={styles.wordmark}>
            <span className={styles.dots}>··</span> Instrument Generator
          </span>
        </div>
        <div className={styles.headerRight}>
          <button
            className={styles.iconBtn}
            onClick={() => (showSettings ? setShowSettings(false) : openSettings())}
            title="API settings"
          >⚙</button>
          <button
            className={styles.iconBtn}
            onClick={onThemeToggle}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >{isDarkMode ? '◑' : '○'}</button>
        </div>
      </header>

      {/* ── API settings ── */}
      {showSettings && (
        <div className={styles.settings}>
          <span className={styles.settingsLabel}>anthropic api key</span>
          <div className={styles.settingsRow}>
            <input
              type="password"
              className={styles.keyInput}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="sk-ant-…"
              spellCheck={false}
            />
            <button
              className={styles.settingsBtn}
              onClick={() => {
                const k = keyDraft.trim();
                if (k) localStorage.setItem(LS_KEY, k);
                else localStorage.removeItem(LS_KEY);
                setApiKey(k);
                setShowSettings(false);
              }}
            >[ save ]</button>
            <button
              className={styles.settingsBtn}
              onClick={() => {
                localStorage.removeItem(LS_KEY);
                setApiKey('');
                setKeyDraft('');
              }}
            >[ clear ]</button>
          </div>
          <p className={styles.settingsNote}>
            stored only in this browser (localStorage) · sent only to api.anthropic.com<br />
            cost per generation: {AI_MODELS.map(m => `${m.label} ${m.cost.replace(' / patch', '')}`).join(' · ')}
          </p>
        </div>
      )}

      {/* ── Prompt bar ── */}
      <form className={styles.promptBar} onSubmit={handleGenerate}>
        <input
          className={styles.promptInput}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe your instrument… (e.g. warm vintage electric piano with a bell-like attack)"
          disabled={isGenerating}
          spellCheck={false}
        />
        {midiSupported && midiInputs.length > 0 && (
          <select
            className={styles.modelSelect}
            value={midiSelectedId ?? ''}
            onChange={(e) => selectMidi(e.target.value || null)}
            title="MIDI input device — play the generator from a hardware controller"
          >
            <option value="">MIDI: off</option>
            {midiInputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        <select
          className={styles.modelSelect}
          value={model}
          onChange={(e) => { setModel(e.target.value); localStorage.setItem(LS_MODEL, e.target.value); }}
          disabled={isGenerating}
          title="Claude model"
        >
          {AI_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className={styles.generateBtn} type="submit" disabled={isGenerating}>
          {isGenerating ? '[ generating… ]' : '[ generate ]'}
        </button>
        <div className={styles.saveWrap} data-aigen-menu>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => setShowSaveMenu(v => !v)}
            disabled={isGenerating}
            title="Save this instrument"
          >[ save ▾ ]</button>
          {showSaveMenu && (
            <div className={styles.saveMenu}>
              <button type="button" className={styles.saveMenuItem} onClick={saveToWorkstation}>to workstation</button>
              <button type="button" className={styles.saveMenuItem} onClick={saveAsVoxdaw}>as .voxdaw file</button>
            </div>
          )}
        </div>
      </form>
      {error && <div className={styles.errorLine}>{error}</div>}
      {notice && <div className={styles.noticeLine}>{notice}</div>}

      {/* ── Instrument ── */}
      <main className={styles.stage}>
        <div className={styles.patchRow}>
          {editingName ? (
            <input
              className={styles.nameInput}
              defaultValue={patch.name}
              autoFocus
              maxLength={48}
              spellCheck={false}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                else if (e.key === 'Escape') { e.target.value = patch.name; e.target.blur(); }
              }}
              onBlur={(e) => commitName(e.target.value)}
            />
          ) : (
            <span
              className={styles.nameBox}
              data-aigen-menu
              title="Double-click or right-click to rename"
              onDoubleClick={() => { setNameMenu(false); setEditingName(true); }}
              onContextMenu={(e) => { e.preventDefault(); setNameMenu(true); }}
            >
              {patch.name}
              {nameMenu && (
                <span className={styles.nameMenu}>
                  <button
                    type="button"
                    className={styles.nameMenuItem}
                    onClick={() => { setNameMenu(false); setEditingName(true); }}
                  >edit name</button>
                </span>
              )}
            </span>
          )}
          <span className={styles.patchMeta}>
            {engine === 'simple' ? 'osc' : engine} · {patch.voice.oscillator}
            {patch.effects.length > 0 && ` · ${patch.effects.map(e => effectLabel(e.type).toLowerCase()).join(' · ')}`}
          </span>
        </div>

        <div className={ipStyles.chassis}>
          {knobGroup('master', (
            <RotaryKnob
              value01={toKnob(patch.volume, VOL_META)}
              defaultValue01={toKnob(gen.volume, VOL_META)}
              onChange={onVolKnob}
              label="vol"
              display={fmtVal(patch.volume, VOL_META)}
              size={38}
            />
          ))}

          {knobGroup('envelope', ['attack', 'decay', 'sustain', 'release'].map(key => (
            <RotaryKnob
              key={key}
              value01={toKnob(patch.envelope[key], ENV_META[key])}
              defaultValue01={toKnob(gen.envelope[key], ENV_META[key])}
              onChange={onEnvKnob(key)}
              label={ENV_META[key].label}
              display={key === 'sustain' ? patch.envelope[key].toFixed(2) : fmtTime(patch.envelope[key])}
              size={38}
            />
          )))}

          {engine !== 'simple' && knobGroup('voice', (
            <>
              <RotaryKnob
                value01={toKnob(patch.voice.harmonicity ?? 3, VOICE_META.harmonicity)}
                defaultValue01={toKnob(gen.voice.harmonicity ?? 3, VOICE_META.harmonicity)}
                onChange={onVoiceKnob('harmonicity')}
                label="harm"
                display={(patch.voice.harmonicity ?? 3).toFixed(2)}
                size={38}
              />
              {engine === 'fm' && (
                <RotaryKnob
                  value01={toKnob(patch.voice.modulationIndex ?? 10, VOICE_META.modulationIndex)}
                  defaultValue01={toKnob(gen.voice.modulationIndex ?? 10, VOICE_META.modulationIndex)}
                  onChange={onVoiceKnob('modulationIndex')}
                  label="mod idx"
                  display={String(Math.round(patch.voice.modulationIndex ?? 10))}
                  size={38}
                />
              )}
            </>
          ))}

          {knobGroup('filter', (
            <>
              <label className={styles.miniSelectWrap}>
                <select
                  className={styles.miniSelect}
                  value={curFilter.type}
                  onChange={(e) => onFilterChange({ type: e.target.value })}
                >
                  {FILTER_TYPES.map(t => <option key={t} value={t}>{t.replace('pass', '')}</option>)}
                </select>
                <span className={styles.miniSelectLabel}>type</span>
              </label>
              <RotaryKnob
                value01={toKnob(curFilter.frequency, FILTER_META.frequency)}
                defaultValue01={toKnob(genFilter.frequency, FILTER_META.frequency)}
                onChange={(v01) => onFilterChange({ frequency: fromKnob(v01, FILTER_META.frequency) })}
                label="cutoff"
                display={fmtVal(curFilter.frequency, FILTER_META.frequency)}
                size={38}
              />
              <RotaryKnob
                value01={toKnob(curFilter.q, FILTER_META.q)}
                defaultValue01={toKnob(genFilter.q, FILTER_META.q)}
                onChange={(v01) => onFilterChange({ q: fromKnob(v01, FILTER_META.q) })}
                label="res"
                display={curFilter.q.toFixed(1)}
                size={38}
              />
            </>
          ))}

          <div className={ipStyles.knobGroup}>
            <span className={ipStyles.groupLabel}>pitch</span>
            <div className={ipStyles.octaveRow}>
              <button
                className={ipStyles.octaveBtn}
                onClick={() => setOctaveBase(b => Math.max(MIN_OCT, b - 1))}
                disabled={octaveBase <= MIN_OCT}
                aria-label="octave down"
              >−</button>
              <span className={ipStyles.octaveDisplay}>OCT&nbsp;{octaveBase}</span>
              <button
                className={ipStyles.octaveBtn}
                onClick={() => setOctaveBase(b => Math.min(MAX_OCT, b + 1))}
                disabled={octaveBase >= MAX_OCT}
                aria-label="octave up"
              >+</button>
            </div>
          </div>

          {patch.effects.map((fx, i) =>
            knobGroup(
              effectLabel(fx.type).toLowerCase(),
              Object.entries(EFFECT_DEFS[fx.type].params).map(([key, meta]) => fxControl(i, key, meta)),
              `${fx.type}-${i}`,
            ))}
        </div>

        <KeyboardPanel
          octaveBase={octaveBase}
          onNoteOn={handleNoteOn}
          onNoteOff={handleNoteOff}
          hotkeys={buildMelodicMap(octaveBase).noteToKey}
        />
        <span className={ipStyles.hint}>a–' play · w e t y u o p ] sharps · z / x octave</span>
      </main>
    </div>
  );
}
