// Per-track insert-effect registry — the single source of truth for the available
// effect types, their display labels, and their default parameters.
//
// Consumed by: WorkstationShell's addEffect() (default params), the EffectsList /
// EffectsRack "Add Effect" dropdowns, and (later) the audio engine + param UI.
//
// NOTE: this is the UI/state skeleton — no DSP is wired yet. When audio lands, each
// type maps to a Tone node inserted on the per-track chain (trackPan → effects →
// trackMute). The param keys below mirror the Tone params already used elsewhere in
// the app (Tone.Filter / Tone.FeedbackDelay / Tone.Freeverb) so wiring is low-friction.

export const EFFECT_DEFS = {
  filter: { label: 'Filter', params: { frequency: 5000, q: 1 } },
  delay:  { label: 'Delay',  params: { time: 0.25, feedback: 0.3, wet: 0.3 } },
  reverb: { label: 'Reverb', params: { roomSize: 0.7, wet: 0.3 } },
};

// Stable ordering for the Add-Effect dropdowns.
export const EFFECT_TYPES = Object.keys(EFFECT_DEFS);

// Display label for an effect type, with a safe fallback for unknown/legacy types.
export function effectLabel(type) {
  return EFFECT_DEFS[type]?.label ?? String(type ?? 'FX');
}
