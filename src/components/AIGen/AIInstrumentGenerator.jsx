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
  AI_MODELS, DEFAULT_MODEL, DEFAULT_PATCH, DEFAULT_LAYER, maxLayersForTier,
  TOKEN_TIERS, DEFAULT_TOKEN_TIER,
  VOL_META, LAYER_VOL_META, ENV_META, VOICE_META, SPREAD_META, COUNT_META,
  PORTAMENTO_META, OCTAVE_META, SEMITONE_META, FILTER_META, FILTER_TYPES,
} from './patchSchema';

/**
 * AI Instrument Generator — standalone page. Describe an instrument, Claude
 * returns a synth patch (patchSchema.js) — a STACK of 1–3 layers — and
 * useAIInstrument plays them together.
 *
 * Layout: a Master Mix panel (master volume, keyboard octave, per-layer volume
 * + mute), then layer tabs, then the active layer's detail chassis (level,
 * octave, envelope, voice, filter, FX). Audio writes go straight to the hook's
 * imperative setters (Zero-Re-render Rule); React state is just the knob
 * visuals. Double-click a knob returns to the value the AI chose (genPatchRef,
 * mirrored per layer). Undo/redo (buttons + Cmd/Ctrl+Z) steps through parameter
 * edits and resets on a new generation. Mute is transient (never saved).
 *
 * Keyboard + chassis chrome are shared with the workstation InstrumentPanel.
 * The QWERTY window listener carries the same guards — including
 * offsetParent === null, which keeps the hidden page silent.
 */

const LS_KEY    = 'voxdaw.anthropicKey';
const LS_MODEL  = 'voxdaw.aigenModel';
const LS_TOKENS = 'voxdaw.aigenTokens';

const MIN_OCT = -2;
const MAX_OCT = 7;
const HISTORY_CAP = 100;
const BURST_MS = 350; // coalesce a knob drag into one undo entry

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

const cloneLayer = (l) =>
  (typeof structuredClone === 'function' ? structuredClone(l) : JSON.parse(JSON.stringify(l)));

const fmtTime = (s) => (s < 0.1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`);
const fmtVal = (v, meta) => {
  if (typeof v !== 'number') return String(v);
  if (meta.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
  if (meta.unit === 's')  return fmtTime(v);
  if (meta.unit === 'db') return v.toFixed(1);
  return Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(2);
};
const fmtSigned = (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const engineLabel = (voice) => (voice.engine === 'simple' ? 'osc' : voice.engine);
const layerLabel = (l) => `${engineLabel(l.voice)}·${l.voice.oscillator}${l.octave ? ` ${fmtSigned(l.octave)}oct` : ''}`;

// Transparent stand-in when a layer's filter is null — the chassis always shows
// the filter group (mirrors useAIInstrument/customInstrumentSynth FILTER_NEUTRAL).
const NEUTRAL_FILTER = { type: 'lowpass', frequency: 18000, q: 0.7071 };

const clampOct = (o) => Math.max(OCTAVE_META.min, Math.min(OCTAVE_META.max, o));

export default function AIInstrumentGenerator({ onNavigateHome, isDarkMode, onThemeToggle }) {
  const rootRef      = useRef(null);
  const heldByKeyRef = useRef(new Map());        // e.key → note captured at keydown
  const genPatchRef  = useRef(DEFAULT_PATCH);    // knob double-click restore target (per layer)

  const [patch, setPatch] = useState(DEFAULT_PATCH);
  const [activeLayer, setActiveLayer] = useState(0);
  const [muted, setMuted] = useState([false]);   // transient per-layer mute (never saved)
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => {
    const saved = localStorage.getItem(LS_MODEL);
    return AI_MODELS.some(m => m.id === saved) ? saved : DEFAULT_MODEL;
  });
  const [tokenTier, setTokenTier] = useState(() => {
    const saved = localStorage.getItem(LS_TOKENS);
    return saved && saved in TOKEN_TIERS ? saved : DEFAULT_TOKEN_TIER;
  });
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);       // transient success line
  const [octaveBase, setOctaveBase] = useState(4);   // keyboard playback octave
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameMenu, setNameMenu] = useState(false);  // right-click "edit name" menu
  const [hist, setHist] = useState({ canUndo: false, canRedo: false });

  const {
    applyPatch, noteOn, noteOff, releaseAll,
    setVolume, setLayerVolume, setLayerMute, setEnvelope, setVoiceParam, setLayerPitch, setFilter, setEffectParam,
  } = useAIInstrument();

  // INIT patch — keyboard playable before the first generation.
  useEffect(() => { applyPatch(DEFAULT_PATCH); }, [applyPatch]);

  // ── Undo / redo history over the patch (parameters only) ─────────────────
  const histRef    = useRef({ past: [], future: [] });
  const pendingRef = useRef({ base: null, timer: null });
  const syncHist = useCallback(() => {
    setHist({ canUndo: histRef.current.past.length > 0, canRedo: histRef.current.future.length > 0 });
  }, []);
  const commitPending = useCallback(() => {
    const p = pendingRef.current;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p.base === null) return;
    const h = histRef.current;
    h.past.push(p.base);
    if (h.past.length > HISTORY_CAP) h.past.shift();
    h.future = [];
    p.base = null;
    syncHist();
  }, [syncHist]);
  // Call with the pre-edit patch at the TOP of a param handler. Coalesces a
  // drag burst into one entry (base captured once, committed BURST_MS after the
  // last change) — mirrors the workstation burst-coalescer.
  const recordEdit = useCallback((prev) => {
    const p = pendingRef.current;
    if (p.base === null) p.base = prev;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(commitPending, BURST_MS);
  }, [commitPending]);
  // Immediate entry for structural changes (add/remove layer).
  const pushHistoryNow = useCallback((prev) => {
    commitPending();
    const h = histRef.current;
    h.past.push(prev);
    if (h.past.length > HISTORY_CAP) h.past.shift();
    h.future = [];
    syncHist();
  }, [commitPending, syncHist]);
  const resetHistory = useCallback(() => {
    if (pendingRef.current.timer) clearTimeout(pendingRef.current.timer);
    pendingRef.current = { base: null, timer: null };
    histRef.current = { past: [], future: [] };
    syncHist();
  }, [syncHist]);

  // Restore a patch snapshot to both state and audio (full rebuild). Mute is
  // transient, so a rebuild lands all layers unmuted.
  const applyRestored = useCallback((p) => {
    setPatch(p);
    applyPatch(p);
    setActiveLayer(a => Math.min(a, p.layers.length - 1));
    setMuted(p.layers.map(() => false));
  }, [applyPatch]);

  const undo = useCallback(() => {
    commitPending();
    const h = histRef.current;
    if (!h.past.length) return;
    h.future.push(patch);
    applyRestored(h.past.pop());
    syncHist();
  }, [patch, commitPending, applyRestored, syncHist]);
  const redo = useCallback(() => {
    const h = histRef.current;
    if (!h.future.length) return;
    h.past.push(patch);
    applyRestored(h.future.pop());
    syncHist();
  }, [patch, applyRestored, syncHist]);

  // Stable ref so the mounted-once keydown listener always calls the latest.
  const undoRedoRef = useRef({ undo, redo });
  undoRedoRef.current = { undo, redo };
  useEffect(() => {
    const onKey = (e) => {
      if (rootRef.current?.offsetParent === null) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if (inTextInput()) return; // let the prompt/name inputs do native text undo
      e.preventDefault();
      if (e.shiftKey) undoRedoRef.current.redo();
      else undoRedoRef.current.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // Close the save / name menus on any outside click.
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
      releaseAll();
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
      const res = await generatePatch({
        apiKey, model, description: prompt.trim(), mode: 'patch',
        maxTokens: TOKEN_TIERS[tokenTier], maxLayers: maxLayersForTier(tokenTier),
      });
      if (res.refusal) {
        setError('the model declined this request — try rephrasing');
      } else {
        genPatchRef.current = res.patch;
        setPatch(res.patch);
        applyPatch(res.patch);
        setActiveLayer(0);
        setMuted(res.patch.layers.map(() => false));
        resetHistory(); // a new instrument wipes the undo stack
      }
    } catch (err) {
      const d = describeApiError(err);
      setError(d.msg);
      if (d.kind === 'auth') openSettings();
    } finally {
      setIsGenerating(false);
    }
  };

  // ── Layer add / remove (structural — one undo entry, rebuilds the graph) ──
  const addLayer = () => {
    if (patch.layers.length >= maxLayersForTier(tokenTier)) return;
    pushHistoryNow(patch);
    const nl = cloneLayer(DEFAULT_LAYER);
    const next = { ...patch, layers: [...patch.layers, nl] };
    genPatchRef.current = { ...genPatchRef.current, layers: [...(genPatchRef.current.layers ?? []), cloneLayer(nl)] };
    setPatch(next);
    applyPatch(next);
    setActiveLayer(next.layers.length - 1);
    setMuted(next.layers.map(() => false));
  };
  const removeLayer = (i) => {
    if (patch.layers.length <= 1) return;
    pushHistoryNow(patch);
    const next = { ...patch, layers: patch.layers.filter((_, j) => j !== i) };
    genPatchRef.current = { ...genPatchRef.current, layers: (genPatchRef.current.layers ?? []).filter((_, j) => j !== i) };
    setPatch(next);
    applyPatch(next);
    setActiveLayer(a => Math.min(a, next.layers.length - 1));
    setMuted(next.layers.map(() => false));
  };

  // ── Knob handlers — audio imperatively, React state for the visual ──────
  const updateLayer = (i, fn) =>
    setPatch(p => ({ ...p, layers: p.layers.map((l, j) => (j === i ? fn(l) : l)) }));

  const onVolKnob = (v01) => {
    recordEdit(patch);
    const db = fromKnob(v01, VOL_META);
    setVolume(db);
    setPatch(p => ({ ...p, volume: db }));
  };
  const changeLayerVolume = (i, v01) => {
    recordEdit(patch);
    const db = fromKnob(v01, LAYER_VOL_META);
    setLayerVolume(i, db);
    updateLayer(i, l => ({ ...l, volume: db }));
  };
  const changeLayerOctave = (i, octave) => {
    recordEdit(patch);
    const oct = clampOct(octave);
    setLayerPitch(i, { ...patch.layers[i], octave: oct });
    updateLayer(i, l => ({ ...l, octave: oct }));
  };
  const changeLayerSemitone = (i, semitone) => {
    recordEdit(patch);
    const s = Math.max(SEMITONE_META.min, Math.min(SEMITONE_META.max, semitone));
    setLayerPitch(i, { ...patch.layers[i], semitone: s });
    updateLayer(i, l => ({ ...l, semitone: s }));
  };
  const toggleMute = (i) => {
    const next = !muted[i];
    setLayerMute(i, next); // transient — no history entry
    setMuted(m => m.map((v, j) => (j === i ? next : v)));
  };
  const onEnvKnob = (key) => (v01) => {
    recordEdit(patch);
    const val = fromKnob(v01, ENV_META[key]);
    setEnvelope(activeLayer, { [key]: val });
    updateLayer(activeLayer, l => ({ ...l, envelope: { ...l.envelope, [key]: val } }));
  };
  // count/spread are oscillator sub-params (Tone deep-merges the .set partial);
  // harmonicity/modulationIndex/portamento are top-level synth params.
  const voiceSetObj = (key, val) =>
    (key === 'count' || key === 'spread') ? { oscillator: { [key]: val } } : { [key]: val };
  const onVoiceKnob = (key, meta) => (v01) => {
    recordEdit(patch);
    const val = fromKnob(v01, meta);
    setVoiceParam(activeLayer, voiceSetObj(key, val));
    updateLayer(activeLayer, l => ({ ...l, voice: { ...l.voice, [key]: val } }));
  };
  const onFilterChange = (partial) => {
    recordEdit(patch);
    setFilter(activeLayer, partial);
    updateLayer(activeLayer, l => ({ ...l, filter: { ...(l.filter ?? NEUTRAL_FILTER), ...partial } }));
  };
  const onFxParam = (fxIndex, key, value) => {
    recordEdit(patch);
    setEffectParam(activeLayer, fxIndex, key, value);
    updateLayer(activeLayer, l => ({
      ...l,
      effects: l.effects.map((fx, j) =>
        j === fxIndex ? { ...fx, params: { ...fx.params, [key]: value } } : fx),
    }));
  };

  const gen = genPatchRef.current;
  const L = patch.layers[activeLayer] ?? DEFAULT_LAYER;
  const genL = gen.layers?.[activeLayer] ?? DEFAULT_LAYER;
  const curFilter = L.filter ?? NEUTRAL_FILTER;
  const genFilter = genL.filter ?? NEUTRAL_FILTER;
  const engine = L.voice.engine;
  const meta = patch.layers.length === 1
    ? layerLabel(L) + (L.effects.length ? ` · ${L.effects.map(e => effectLabel(e.type).toLowerCase()).join(' · ')}` : '')
    : `${patch.layers.length} layers · ${patch.layers.map(layerLabel).join(' · ')}`;

  const knobGroup = (label, children, key = label) => (
    <div className={ipStyles.knobGroup} key={key}>
      <span className={ipStyles.groupLabel}>{label}</span>
      <div className={ipStyles.knobRow}>{children}</div>
    </div>
  );

  const fxControl = (fxIndex, key, m) => {
    const val = L.effects[fxIndex].params[key];
    const genVal = genL.effects?.[fxIndex]?.params?.[key] ?? EFFECT_DEFS[L.effects[fxIndex].type].params[key].default;
    if (m.kind === 'toggle') {
      return (
        <button
          key={key}
          className={`${styles.pill} ${val ? styles.pillOn : ''}`}
          onClick={() => onFxParam(fxIndex, key, !val)}
        >{m.label}</button>
      );
    }
    if (m.kind === 'select') {
      return (
        <label key={key} className={styles.miniSelectWrap}>
          <select className={styles.miniSelect} value={val} onChange={(e) => onFxParam(fxIndex, key, e.target.value)}>
            {m.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className={styles.miniSelectLabel}>{m.label}</span>
        </label>
      );
    }
    return (
      <RotaryKnob
        key={key}
        value01={toKnob(val, m)}
        defaultValue01={toKnob(genVal, m)}
        onChange={(v01) => onFxParam(fxIndex, key, fromKnob(v01, m))}
        label={m.label}
        display={fmtVal(val, m)}
        size={38}
      />
    );
  };

  // Octave stepper markup (shared by keyboard octave + per-layer octave).
  const stepper = (label, display, onDown, onUp, downDisabled, upDisabled, title) => (
    <div className={ipStyles.knobGroup}>
      <span className={ipStyles.groupLabel}>{label}</span>
      <div className={ipStyles.octaveRow}>
        <button className={ipStyles.octaveBtn} onClick={onDown} disabled={downDisabled} aria-label={`${label} down`}>−</button>
        <span className={ipStyles.octaveDisplay} title={title}>{display}</span>
        <button className={ipStyles.octaveBtn} onClick={onUp} disabled={upDisabled} aria-label={`${label} up`}>+</button>
      </div>
    </div>
  );

  // Voice group children — portamento always; harm/mod-idx for fm/am; fat unison.
  const voiceKnobs = [
    <RotaryKnob key="glide" value01={toKnob(L.voice.portamento ?? 0, PORTAMENTO_META)}
      defaultValue01={toKnob(genL.voice.portamento ?? 0, PORTAMENTO_META)}
      onChange={onVoiceKnob('portamento', PORTAMENTO_META)} label="glide"
      display={fmtTime(L.voice.portamento ?? 0)} size={38} />,
  ];
  if (engine !== 'simple') {
    voiceKnobs.push(
      <RotaryKnob key="harm" value01={toKnob(L.voice.harmonicity ?? 3, VOICE_META.harmonicity)}
        defaultValue01={toKnob(genL.voice.harmonicity ?? 3, VOICE_META.harmonicity)}
        onChange={onVoiceKnob('harmonicity', VOICE_META.harmonicity)} label="harm"
        display={(L.voice.harmonicity ?? 3).toFixed(2)} size={38} />
    );
    if (engine === 'fm') voiceKnobs.push(
      <RotaryKnob key="modidx" value01={toKnob(L.voice.modulationIndex ?? 10, VOICE_META.modulationIndex)}
        defaultValue01={toKnob(genL.voice.modulationIndex ?? 10, VOICE_META.modulationIndex)}
        onChange={onVoiceKnob('modulationIndex', VOICE_META.modulationIndex)} label="mod idx"
        display={String(Math.round(L.voice.modulationIndex ?? 10))} size={38} />
    );
  }
  if (L.voice.oscillator.startsWith('fat')) {
    voiceKnobs.push(
      <RotaryKnob key="voices" value01={toKnob(L.voice.count ?? 3, COUNT_META)}
        defaultValue01={toKnob(genL.voice.count ?? 3, COUNT_META)}
        onChange={onVoiceKnob('count', COUNT_META)} label="voices"
        display={String(Math.round(L.voice.count ?? 3))} size={38} />,
      <RotaryKnob key="spread" value01={toKnob(L.voice.spread ?? 20, SPREAD_META)}
        defaultValue01={toKnob(genL.voice.spread ?? 20, SPREAD_META)}
        onChange={onVoiceKnob('spread', SPREAD_META)} label="spread"
        display={String(Math.round(L.voice.spread ?? 20))} size={38} />
    );
  }

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
          <button className={styles.iconBtn} onClick={() => (showSettings ? setShowSettings(false) : openSettings())} title="API settings">⚙</button>
          <button className={styles.iconBtn} onClick={onThemeToggle} title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}>{isDarkMode ? '◑' : '○'}</button>
        </div>
      </header>

      {/* ── API settings ── */}
      {showSettings && (
        <div className={styles.settings}>
          <span className={styles.settingsLabel}>anthropic api key</span>
          <div className={styles.settingsRow}>
            <input type="password" className={styles.keyInput} value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)} placeholder="sk-ant-…" spellCheck={false} />
            <button className={styles.settingsBtn} onClick={() => {
              const k = keyDraft.trim();
              if (k) localStorage.setItem(LS_KEY, k); else localStorage.removeItem(LS_KEY);
              setApiKey(k); setShowSettings(false);
            }}>[ save ]</button>
            <button className={styles.settingsBtn} onClick={() => {
              localStorage.removeItem(LS_KEY); setApiKey(''); setKeyDraft('');
            }}>[ clear ]</button>
          </div>
          <p className={styles.settingsNote}>
            stored only in this browser (localStorage) · sent only to api.anthropic.com<br />
            cost per generation: {AI_MODELS.map(m => `${m.label} ${m.cost.replace(' / patch', '')}`).join(' · ')}
          </p>
        </div>
      )}

      {/* ── Prompt bar ── */}
      <form className={styles.promptBar} onSubmit={handleGenerate}>
        <input className={styles.promptInput} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe your instrument… (e.g. huge cinematic pad: deep sub, warm body, glassy shimmer an octave up)"
          disabled={isGenerating} spellCheck={false} />
        {midiSupported && midiInputs.length > 0 && (
          <select className={styles.modelSelect} value={midiSelectedId ?? ''}
            onChange={(e) => selectMidi(e.target.value || null)} title="MIDI input device">
            <option value="">MIDI: off</option>
            {midiInputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        <select className={styles.modelSelect} value={tokenTier}
          onChange={(e) => { setTokenTier(e.target.value); localStorage.setItem(LS_TOKENS, e.target.value); }}
          disabled={isGenerating} title="Response token budget — a ceiling, not a cost. “xtra” unlocks up to 5 layers.">
          <option value="medium">tokens: med</option>
          <option value="high">tokens: high</option>
          <option value="xhigh">tokens: xtra</option>
        </select>
        <select className={styles.modelSelect} value={model}
          onChange={(e) => { setModel(e.target.value); localStorage.setItem(LS_MODEL, e.target.value); }}
          disabled={isGenerating} title="Claude model">
          {AI_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className={styles.generateBtn} type="submit" disabled={isGenerating}>
          {isGenerating ? '[ generating… ]' : '[ generate ]'}
        </button>
        <button type="button" className={styles.histBtn} onClick={undo} disabled={!hist.canUndo} title="Undo (⌘/Ctrl+Z)">↶</button>
        <button type="button" className={styles.histBtn} onClick={redo} disabled={!hist.canRedo} title="Redo (⇧⌘/Ctrl+Z)">↷</button>
        <div className={styles.saveWrap} data-aigen-menu>
          <button type="button" className={styles.saveBtn} onClick={() => setShowSaveMenu(v => !v)}
            disabled={isGenerating} title="Save this instrument">[ save ▾ ]</button>
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
            <input className={styles.nameInput} defaultValue={patch.name} autoFocus maxLength={48} spellCheck={false}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                else if (e.key === 'Escape') { e.target.value = patch.name; e.target.blur(); }
              }}
              onBlur={(e) => commitName(e.target.value)} />
          ) : (
            <span className={styles.nameBox} data-aigen-menu title="Double-click or right-click to rename"
              onDoubleClick={() => { setNameMenu(false); setEditingName(true); }}
              onContextMenu={(e) => { e.preventDefault(); setNameMenu(true); }}>
              {patch.name}
              {nameMenu && (
                <span className={styles.nameMenu}>
                  <button type="button" className={styles.nameMenuItem}
                    onClick={() => { setNameMenu(false); setEditingName(true); }}>edit name</button>
                </span>
              )}
            </span>
          )}
          <span className={styles.patchMeta}>{meta}</span>
        </div>

        {/* ── Master mix panel ── */}
        <div className={styles.mixPanel}>
          <div className={styles.mixMaster}>
            <span className={styles.mixSectionLabel}>master</span>
            <RotaryKnob value01={toKnob(patch.volume, VOL_META)} defaultValue01={toKnob(gen.volume, VOL_META)}
              onChange={onVolKnob} label="vol" display={fmtVal(patch.volume, VOL_META)} size={40} />
            {stepper('octave', `OCT ${octaveBase}`,
              () => setOctaveBase(b => Math.max(MIN_OCT, b - 1)),
              () => setOctaveBase(b => Math.min(MAX_OCT, b + 1)),
              octaveBase <= MIN_OCT, octaveBase >= MAX_OCT, 'keyboard playback octave')}
          </div>
          <div className={styles.mixStrips}>
            {patch.layers.map((l, i) => (
              <div key={i} className={`${styles.chStrip} ${i === activeLayer ? styles.chStripActive : ''}`}>
                <div className={styles.chHead}>
                  <button className={styles.chSelect} onClick={() => setActiveLayer(i)} title={layerLabel(l)}>L{i + 1}</button>
                  {patch.layers.length > 1 && (
                    <button className={styles.chRemove} onClick={() => removeLayer(i)} title="remove this layer">×</button>
                  )}
                </div>
                <RotaryKnob value01={toKnob(l.volume ?? 0, LAYER_VOL_META)}
                  defaultValue01={toKnob(gen.layers?.[i]?.volume ?? 0, LAYER_VOL_META)}
                  onChange={(v01) => changeLayerVolume(i, v01)} label="vol"
                  display={fmtVal(l.volume ?? 0, LAYER_VOL_META)} size={34} />
                {stepper('octave', fmtSigned(l.octave),
                  () => changeLayerOctave(i, l.octave - 1), () => changeLayerOctave(i, l.octave + 1),
                  l.octave <= OCTAVE_META.min, l.octave >= OCTAVE_META.max, 'octave offset')}
                {stepper('semi', fmtSigned(l.semitone),
                  () => changeLayerSemitone(i, l.semitone - 1), () => changeLayerSemitone(i, l.semitone + 1),
                  l.semitone <= SEMITONE_META.min, l.semitone >= SEMITONE_META.max, 'semitone offset')}
                <button className={`${styles.muteBtn} ${muted[i] ? styles.muteBtnOn : ''}`}
                  onClick={() => toggleMute(i)} title={muted[i] ? 'unmute layer' : 'mute layer'}>mute</button>
              </div>
            ))}
            {patch.layers.length < maxLayersForTier(tokenTier) && (
              <button className={styles.layerAddBtn} onClick={addLayer} title="add a stacked layer">+ layer</button>
            )}
          </div>
        </div>

        {/* ── Active layer detail chassis (envelope / voice / filter / FX) ── */}
        <div className={ipStyles.chassis}>
          {knobGroup('envelope', ['attack', 'decay', 'sustain', 'release'].map(key => (
            <RotaryKnob key={key} value01={toKnob(L.envelope[key], ENV_META[key])}
              defaultValue01={toKnob(genL.envelope[key], ENV_META[key])} onChange={onEnvKnob(key)}
              label={ENV_META[key].label}
              display={key === 'sustain' ? L.envelope[key].toFixed(2) : fmtTime(L.envelope[key])} size={38} />
          )), `env-${activeLayer}`)}

          {knobGroup('voice', voiceKnobs, `voice-${activeLayer}-${engine}-${L.voice.oscillator}`)}

          {knobGroup('filter', (
            <>
              <label className={styles.miniSelectWrap}>
                <select className={styles.miniSelect} value={curFilter.type} onChange={(e) => onFilterChange({ type: e.target.value })}>
                  {FILTER_TYPES.map(t => <option key={t} value={t}>{t.replace('pass', '')}</option>)}
                </select>
                <span className={styles.miniSelectLabel}>type</span>
              </label>
              <RotaryKnob value01={toKnob(curFilter.frequency, FILTER_META.frequency)}
                defaultValue01={toKnob(genFilter.frequency, FILTER_META.frequency)}
                onChange={(v01) => onFilterChange({ frequency: fromKnob(v01, FILTER_META.frequency) })}
                label="cutoff" display={fmtVal(curFilter.frequency, FILTER_META.frequency)} size={38} />
              <RotaryKnob value01={toKnob(curFilter.q, FILTER_META.q)} defaultValue01={toKnob(genFilter.q, FILTER_META.q)}
                onChange={(v01) => onFilterChange({ q: fromKnob(v01, FILTER_META.q) })}
                label="res" display={curFilter.q.toFixed(1)} size={38} />
            </>
          ), `filter-${activeLayer}`)}

          {L.effects.map((fx, i) =>
            knobGroup(
              effectLabel(fx.type).toLowerCase(),
              Object.entries(EFFECT_DEFS[fx.type].params).map(([key, m]) => fxControl(i, key, m)),
              `${activeLayer}-${fx.type}-${i}`,
            ))}
        </div>

        <KeyboardPanel octaveBase={octaveBase} onNoteOn={handleNoteOn} onNoteOff={handleNoteOff}
          hotkeys={buildMelodicMap(octaveBase).noteToKey} />
        <span className={ipStyles.hint}>a–' play · w e t y u o p ] sharps · z / x octave</span>
      </main>
    </div>
  );
}
