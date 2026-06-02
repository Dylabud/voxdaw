import * as Tone from 'tone';
import { useRef, useState, useCallback, useEffect } from 'react';

// Maps all 52 jack IDs to Tone.js port descriptors.
// type:'out' → source node (plus optional waveform to set before connecting)
// type:'in'  → destination: ToneAudioNode (audio input) or AudioParam (CV input)
// dest:null  → deferred jack (patching does nothing until a later phase wires it)
function buildJackMap(n) {
  return {
    // ── VCO 1 ──
    'vco1-cv':  { type: 'in',  dest: n.vco1.frequency },
    'vco1-fm':  { type: 'in',  dest: n.vco1.frequency },
    'vco1-sin': { type: 'out', node: n.vco1, waveform: 'sine'      },
    'vco1-tri': { type: 'out', node: n.vco1, waveform: 'triangle'  },
    'vco1-saw': { type: 'out', node: n.vco1, waveform: 'sawtooth'  },
    'vco1-sqr': { type: 'out', node: n.vco1, waveform: 'square'    },
    // ── VCO 2 ──
    'vco2-cv':  { type: 'in',  dest: n.vco2.frequency },
    'vco2-fm':  { type: 'in',  dest: n.vco2.frequency },
    'vco2-sin': { type: 'out', node: n.vco2, waveform: 'sine'      },
    'vco2-tri': { type: 'out', node: n.vco2, waveform: 'triangle'  },
    'vco2-saw': { type: 'out', node: n.vco2, waveform: 'sawtooth'  },
    'vco2-sqr': { type: 'out', node: n.vco2, waveform: 'square'    },
    // ── VCO 3 ──
    'vco3-cv':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-fm':  { type: 'in',  dest: n.vco3.frequency },
    'vco3-sin': { type: 'out', node: n.vco3, waveform: 'sine'      },
    'vco3-tri': { type: 'out', node: n.vco3, waveform: 'triangle'  },
    'vco3-saw': { type: 'out', node: n.vco3, waveform: 'sawtooth'  },
    'vco3-sqr': { type: 'out', node: n.vco3, waveform: 'square'    },
    // ── Noise ──
    'noise-wht': { type: 'out', node: n.noiseW },
    'noise-pnk': { type: 'out', node: n.noiseP },
    // ── CP3 Mixer ──
    'cp3-in1': { type: 'in',  dest: n.cp3ch1 },
    'cp3-in2': { type: 'in',  dest: n.cp3ch2 },
    'cp3-in3': { type: 'in',  dest: n.cp3ch3 },
    'cp3-in4': { type: 'in',  dest: n.cp3ch4 },
    'cp3-out': { type: 'out', node: n.cp3bus },
    // ── VCF ──
    'vcf-in':  { type: 'in',  dest: n.vcf },
    'vcf-cv1': { type: 'in',  dest: n.vcf.frequency },
    'vcf-cv2': { type: 'in',  dest: n.vcf.frequency },
    'vcf-env': { type: 'in',  dest: n.vcf.frequency },
    'vcf-out': { type: 'out', node: n.vcf },
    // ── VCA ──
    'vca-in':  { type: 'in',  dest: n.vca },
    'vca-cv':  { type: 'in',  dest: n.vca.gain },
    'vca-out': { type: 'out', node: n.vca },
    // ── ENV 1 ── (gate/trig deferred to Phase 6; out available as CV source)
    'env1-gate': { type: 'in',  dest: null },
    'env1-trig': { type: 'in',  dest: null },
    'env1-out':  { type: 'out', node: n.env1 },
    // ── ENV 2 ──
    'env2-gate': { type: 'in',  dest: null },
    'env2-trig': { type: 'in',  dest: null },
    'env2-out':  { type: 'out', node: n.env2 },
    // ── LFO ──
    'lfo-sync': { type: 'in',  dest: null },
    'lfo-sin':  { type: 'out', node: n.lfo, waveform: 'sine'      },
    'lfo-tri':  { type: 'out', node: n.lfo, waveform: 'triangle'  },
    'lfo-sqr':  { type: 'out', node: n.lfo, waveform: 'square'    },
    'lfo-saw':  { type: 'out', node: n.lfo, waveform: 'sawtooth'  },
    // ── Multiples (passive routing — deferred to Phase 7 audio wiring) ──
    'mult-a1': { type: 'in', dest: null }, 'mult-a2': { type: 'in', dest: null },
    'mult-a3': { type: 'in', dest: null }, 'mult-a4': { type: 'in', dest: null },
    'mult-b1': { type: 'in', dest: null }, 'mult-b2': { type: 'in', dest: null },
    'mult-b3': { type: 'in', dest: null }, 'mult-b4': { type: 'in', dest: null },
    // ── I/O ── (VCA→Master is hardwired on powerOn; SPKR jack is decorative in Phase 3)
    'io-spkr-out': { type: 'in', dest: null },
  };
}

export default function useMoogAudio() {
  const [isPowered, setIsPowered] = useState(false);

  const isPoweredRef   = useRef(false);
  const hardwiredRef   = useRef(false); // cp3 internal wires + vca→master, done once
  const nodesRef       = useRef(null);
  const jackMapRef     = useRef(null);
  const connectionsRef = useRef(new Map()); // key: "fromId→toId" → { node, dest }

  useEffect(() => {
    const n = {
      vco1:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco2:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      vco3:   new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }),
      noiseW: new Tone.Noise({ type: 'white' }),
      noiseP: new Tone.Noise({ type: 'pink'  }),
      cp3ch1: new Tone.Gain(0.8),
      cp3ch2: new Tone.Gain(0.8),
      cp3ch3: new Tone.Gain(0.8),
      cp3ch4: new Tone.Gain(0.8),
      cp3bus: new Tone.Gain(0.7),
      vcf:    new Tone.Filter({ frequency: 2000, type: 'lowpass', rolloff: -24 }),
      vca:    new Tone.Gain(1.0),
      env1:   new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      env2:   new Tone.Envelope({ attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.5 }),
      lfo:    new Tone.LFO({ frequency: 0.5, type: 'sine', min: -1, max: 1 }),
      master: new Tone.Volume(-12).toDestination(),
    };

    nodesRef.current   = n;
    jackMapRef.current = buildJackMap(n);

    return () => {
      // Stop sources and dispose all nodes on unmount
      [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
        try { node.stop(); } catch (_) {}
      });
      Object.values(n).forEach(node => {
        try { node.dispose(); } catch (_) {}
      });
      connectionsRef.current.clear();
      isPoweredRef.current = false;
      hardwiredRef.current = false;
    };
  }, []);

  const powerOn = useCallback(async () => {
    if (isPoweredRef.current) return;
    await Tone.start(); // satisfies browser autoplay policy
    isPoweredRef.current = true;

    const n = nodesRef.current;
    if (!n) return;

    [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
      try { node.start(); } catch (_) {}
    });

    // Hardwire permanent internal connections (once only — survives powerOff/powerOn cycles)
    if (!hardwiredRef.current) {
      hardwiredRef.current = true;
      n.cp3ch1.connect(n.cp3bus);
      n.cp3ch2.connect(n.cp3bus);
      n.cp3ch3.connect(n.cp3bus);
      n.cp3ch4.connect(n.cp3bus);
      // VCA → Master is always active; user only needs to patch the chain up to VCA-IN
      n.vca.connect(n.master);
    }

    setIsPowered(true);
  }, []);

  const powerOff = useCallback(() => {
    if (!isPoweredRef.current) return;
    isPoweredRef.current = false;

    const n = nodesRef.current;
    if (!n) return;
    [n.vco1, n.vco2, n.vco3, n.noiseW, n.noiseP, n.lfo].forEach(node => {
      try { node.stop(); } catch (_) {}
    });

    setIsPowered(false);
  }, []);

  const connect = useCallback((fromId, toId) => {
    const jm = jackMapRef.current;
    if (!jm) return;

    const from = jm[fromId];
    const to   = jm[toId];
    if (!from || !to) return;
    if (from.type !== 'out' || to.type !== 'in') return;
    if (to.dest === null) return; // deferred jack — silently no-op

    const key = `${fromId}→${toId}`;
    if (connectionsRef.current.has(key)) return;

    // Set VCO or LFO waveform to match the specific output jack patched
    if (from.waveform) from.node.type = from.waveform;

    try {
      from.node.connect(to.dest);
      connectionsRef.current.set(key, { node: from.node, dest: to.dest });
    } catch (e) {
      console.warn(`[MoogAudio] connect ${key}:`, e.message);
    }
  }, []);

  const disconnect = useCallback((fromId, toId) => {
    const key  = `${fromId}→${toId}`;
    const conn = connectionsRef.current.get(key);
    if (!conn) return;

    try {
      conn.node.disconnect(conn.dest);
    } catch (e) {
      console.warn(`[MoogAudio] disconnect ${key}:`, e.message);
    }
    connectionsRef.current.delete(key);
  }, []);

  return { powerOn, powerOff, connect, disconnect, isPowered };
}
