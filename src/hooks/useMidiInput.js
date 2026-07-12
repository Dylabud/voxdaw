import { useState, useRef, useEffect, useCallback } from 'react';
import * as Tone from 'tone';

// Web MIDI **input** — enumerates connected controllers and routes their
// note-on/off to onNoteOn/onNoteOff so a hardware keyboard plays the page.
//
// Deliberately distinct from useMidi.js, which is MIDI *output* over a
// WebSocket bridge (VoxTool → DAW). This one is a peer hook (CLAUDE.md rule 4)
// on the native Web MIDI API — no Tone, no websocket. Secure-context only
// (localhost / https); unsupported browsers report `supported: false`.
//
// @param onNoteOn  (note: string, velocity01: number) => void
// @param onNoteOff (note: string) => void
// @param rootRef   page root — messages are ignored while it's hidden
//                  (offsetParent === null), mirroring the QWERTY guard.
export default function useMidiInput({ onNoteOn, onNoteOff, rootRef }) {
  const [inputs, setInputs] = useState([]);        // [{ id, name }]
  const [selectedId, setSelectedId] = useState(null);
  const [supported, setSupported] = useState(true);

  const accessRef   = useRef(null);
  const selectedRef = useRef(null);                // bound MIDIInput
  const cbRef       = useRef({ onNoteOn, onNoteOff, rootRef });
  cbRef.current = { onNoteOn, onNoteOff, rootRef };

  const refreshInputs = useCallback((access) => {
    const list = [];
    access.inputs.forEach((i) => list.push({ id: i.id, name: i.name || 'MIDI input' }));
    setInputs(list);
    // Drop the selection if the bound device vanished.
    setSelectedId((cur) => (cur && access.inputs.has(cur) ? cur : (selectedRef.current = null, null)));
  }, []);

  const handleMessage = useCallback((e) => {
    const { onNoteOn: on, onNoteOff: off, rootRef: rr } = cbRef.current;
    if (rr?.current && rr.current.offsetParent === null) return; // page hidden
    const [status, data1, data2] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && data2 > 0) {
      on?.(Tone.Frequency(data1, 'midi').toNote(), data2 / 127);
    } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
      off?.(Tone.Frequency(data1, 'midi').toNote());
    }
    // Sustain / CC / pitch-bend ignored for v1.
  }, []);

  useEffect(() => {
    if (!navigator.requestMIDIAccess) { setSupported(false); return undefined; }
    let cancelled = false;
    navigator.requestMIDIAccess({ sysex: false })
      .then((access) => {
        if (cancelled) return;
        accessRef.current = access;
        refreshInputs(access);
        access.onstatechange = () => refreshInputs(access);
      })
      .catch(() => setSupported(false));
    return () => {
      cancelled = true;
      if (selectedRef.current) selectedRef.current.onmidimessage = null;
      selectedRef.current = null;
      if (accessRef.current) accessRef.current.onstatechange = null;
    };
  }, [refreshInputs]);

  // Bind the chosen device (or null to disconnect). Single writer of
  // onmidimessage on the bound input.
  const selectInput = useCallback((id) => {
    const access = accessRef.current;
    if (selectedRef.current) { selectedRef.current.onmidimessage = null; selectedRef.current = null; }
    const input = id && access ? access.inputs.get(id) : null;
    if (input) { input.onmidimessage = handleMessage; selectedRef.current = input; setSelectedId(id); }
    else setSelectedId(null);
  }, [handleMessage]);

  return { inputs, selectedId, selectInput, supported };
}
