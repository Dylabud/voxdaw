import { useState, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:8080';

export default function useMidi() {
  const [isMidiEnabled, setIsMidiEnabled] = useState(false);
  const wsRef           = useRef(null);
  const midiEnabledRef  = useRef(false);      // ref shadow — safe inside rAF/Tone callbacks
  const activeMidiNotes = useRef(new Set());  // all currently-on notes for panic

  // Stable: closes only over refs, zero deps.
  const sendMidi = useCallback((type, note, velocity = 100) => {
    if (!midiEnabledRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type, note, velocity }));
    if (type === 'noteon') activeMidiNotes.current.add(note);
    else                   activeMidiNotes.current.delete(note);
  }, []);

  // Sends noteoff for every currently-on note without going through sendMidi's
  // enabled-check — used during toggle-off and disengage where we must flush
  // regardless of midiEnabledRef state.
  const panicAllNotes = useCallback(() => {
    activeMidiNotes.current.forEach(note => {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(JSON.stringify({ type: 'noteoff', note, velocity: 0 }));
    });
    activeMidiNotes.current.clear();
  }, []);

  const toggleMidi = useCallback(() => {
    if (midiEnabledRef.current) {
      panicAllNotes();
      wsRef.current?.close();
      wsRef.current = null;
      midiEnabledRef.current = false;
      setIsMidiEnabled(false);
    } else {
      const ws = new WebSocket(WS_URL);
      ws.onopen  = () => { midiEnabledRef.current = true;  setIsMidiEnabled(true);  };
      ws.onclose = () => { midiEnabledRef.current = false; setIsMidiEnabled(false); };
      ws.onerror = () => ws.close(); // cascades into onclose for UI cleanup
      wsRef.current = ws;
    }
  }, [panicAllNotes]);

  return { isMidiEnabled, toggleMidi, sendMidi, panicAllNotes };
}
