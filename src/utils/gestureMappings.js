export const GESTURE_SOURCES = [
  { id: 'right_hand_size',  label: 'Right Hand Size',   hand: 'right' },
  { id: 'right_pinch_norm', label: 'Right Pinch',       hand: 'right' },
  { id: 'left_pinch_dist',  label: 'Left Pinch',        hand: 'left'  },
  { id: 'left_wrist_y',     label: 'Left Hand Height',  hand: 'left'  },
  { id: 'left_wrist_tilt',  label: 'Left Wrist Tilt',   hand: 'left'  },
  { id: 'left_arp_spread',  label: 'Left Arp Spread',   hand: 'left'  },
];

export const AUDIO_DESTINATIONS = [
  { id: 'filter_cutoff',  label: 'Filter Cutoff'  },
  { id: 'reverb_wet',     label: 'Reverb Wet'     },
  { id: 'vibrato_depth',  label: 'Vibrato Depth'  },
  { id: 'volume',         label: 'Master Volume'  },
  { id: 'arp_volume',     label: 'Arp Volume'     },
];

export const DEFAULT_MAPPINGS = [
  { id: 1, source: 'right_hand_size',  destination: 'filter_cutoff', invert: false },
  { id: 2, source: 'right_pinch_norm', destination: 'volume',        invert: false },
  { id: 3, source: 'left_pinch_dist',  destination: 'reverb_wet',    invert: false },
  { id: 4, source: 'left_wrist_y',     destination: 'vibrato_depth', invert: true  },
  { id: 5, source: 'left_arp_spread',  destination: 'arp_volume',    invert: false },
];

// ── Trigger (gates) constants ──────────────────────────────────────────────────
// Sources are finger-combo conditions, not individual fingers, because the engine
// evaluates combos (middle/ring/pinky simultaneously) — individual finger sources
// cannot be independently wired to the audio logic.

export const TRIGGER_SOURCES = [
  // group: 'right' — chord voicing combos (isFingerExtended on middle/ring/pinky)
  { id: 'right_no_fingers',        label: 'no fingers',            group: 'right' },
  { id: 'right_middle',            label: 'middle',                group: 'right' },
  { id: 'right_middle_ring',       label: 'middle · ring',         group: 'right' },
  { id: 'right_pinky',             label: 'pinky',                 group: 'right' },
  { id: 'right_ring_pinky',        label: 'ring · pinky',          group: 'right' },
  { id: 'right_middle_pinky',      label: 'middle · pinky',        group: 'right' },
  { id: 'right_middle_ring_pinky', label: 'middle · ring · pinky', group: 'right' },
  // group: 'left' — arp mode combos (getArpFingerStates middle/ring/pinky out)
  { id: 'left_no_fingers',         label: 'no fingers',            group: 'left'  },
  { id: 'left_pinky',              label: 'pinky',                 group: 'left'  },
  { id: 'left_ring_pinky',         label: 'ring · pinky',          group: 'left'  },
  { id: 'left_middle',             label: 'middle',                group: 'left'  },
  { id: 'left_middle_ring',        label: 'middle · ring',         group: 'left'  },
  { id: 'left_middle_ring_pinky',  label: 'middle · ring · pinky', group: 'left'  },
  { id: 'left_middle_pinky',       label: 'middle · pinky',        group: 'left'  },
  // group: 'tilt' — left wrist tilt bands (getArpRate, snap mode only)
  { id: 'left_tilt_low',           label: 'tilt < 20°',            group: 'tilt'  },
  { id: 'left_tilt_mid',           label: '20° – 60°',             group: 'tilt'  },
  { id: 'left_tilt_high',          label: 'tilt > 60°',            group: 'tilt'  },
];

export const TRIGGER_DESTINATIONS = [
  // group: 'chord'
  { id: 'chord_root',          label: 'Root only',    group: 'chord'    },
  { id: 'chord_minor',         label: 'Minor',        group: 'chord'    },
  { id: 'chord_major',         label: 'Major',        group: 'chord'    },
  { id: 'chord_root_7',        label: 'Root + 7th',     group: 'chord'    },
  { id: 'chord_root_maj7',     label: 'Root + Maj 7th', group: 'chord'    },
  { id: 'chord_minor_7',       label: 'Minor 7th',      group: 'chord'    },
  { id: 'chord_major_7',       label: 'Major 7th',      group: 'chord'    },
  // group: 'complex_chord'
  { id: 'chord_sus4',      label: 'Sus 4',        group: 'complex_chord' },
  { id: 'chord_dim',       label: 'Diminished',   group: 'complex_chord' },
  { id: 'chord_maj_oct',   label: 'Maj +Oct',     group: 'complex_chord' },
  { id: 'chord_min_oct',   label: 'Min +Oct',     group: 'complex_chord' },
  { id: 'chord_maj_sub',   label: 'Maj Sub Bass', group: 'complex_chord' },
  { id: 'chord_min_sub',   label: 'Min Sub Bass', group: 'complex_chord' },
  { id: 'chord_root_sub2', label: 'Root −2 Oct',  group: 'complex_chord' },
  { id: 'chord_poly_maj',  label: 'Poly Major',   group: 'complex_chord' },
  { id: 'chord_poly_min',  label: 'Poly Minor',   group: 'complex_chord' },
  { id: 'chord_maj_9',     label: 'Major 9th',    group: 'complex_chord' },
  { id: 'chord_min_9',     label: 'Minor 9th',    group: 'complex_chord' },
  // group: 'arp_mode'
  { id: 'arp_off',             label: 'Arp off',      group: 'arp_mode' },
  { id: 'arp_octave',          label: 'Octave',       group: 'arp_mode' },
  { id: 'arp_simple',          label: 'Simple',       group: 'arp_mode' },
  { id: 'arp_complex',         label: 'Complex',      group: 'arp_mode' },
  { id: 'arp_complex_random',  label: 'Cmplx Rnd',    group: 'arp_mode' },
  { id: 'arp_simple_random',   label: 'Simple Rnd',   group: 'arp_mode' },
  // group: 'arp_rate'
  { id: 'arp_rate_4n',         label: '1/4 note',        group: 'arp_rate'    },
  { id: 'arp_rate_8n',         label: '1/8 note',        group: 'arp_rate'    },
  { id: 'arp_rate_16n',        label: '1/16 note',       group: 'arp_rate'    },
  // group: 'arp_pattern'
  { id: 'arp_simple_up',       label: 'Simple Up',       group: 'arp_pattern' },
  { id: 'arp_simple_down',     label: 'Simple Down',     group: 'arp_pattern' },
  { id: 'arp_complex_up',      label: 'Complex Up',      group: 'arp_pattern' },
  { id: 'arp_complex_down',    label: 'Complex Down',    group: 'arp_pattern' },
  { id: 'arp_complex_down_up', label: 'Complex Down/Up', group: 'arp_pattern' },
];

const TRIGGER_GROUP_LABELS = {
  right:         'Right Hand',
  left:          'Left Hand',
  tilt:          'Left Wrist Tilt',
  chord:         'Chord',
  complex_chord: 'Complex Chord',
  arp_mode:      'Arp Mode',
  arp_rate:      'Arp Rate',
  arp_pattern:   'Arp Pattern',
};

export function groupedTriggerSources() {
  return buildOptGroups(TRIGGER_SOURCES, TRIGGER_GROUP_LABELS);
}

export function groupedTriggerDestinations() {
  return buildOptGroups(TRIGGER_DESTINATIONS, TRIGGER_GROUP_LABELS);
}

function buildOptGroups(items, labels) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.group)) map.set(item.group, []);
    map.get(item.group).push(item);
  }
  return Array.from(map.entries()).map(([group, options]) => ({
    group,
    label: labels[group] ?? group,
    options,
  }));
}

export const DEFAULT_TRIGGER_MAPPINGS = [
  { id: 1,  trigger: 'right_no_fingers',        destination: 'chord_root'         },
  { id: 2,  trigger: 'right_middle',            destination: 'chord_minor'        },
  { id: 3,  trigger: 'right_middle_ring',       destination: 'chord_major'        },
  { id: 4,  trigger: 'right_pinky',             destination: 'chord_root_7'       },
  { id: 5,  trigger: 'right_ring_pinky',        destination: 'chord_root_maj7'    },
  { id: 6,  trigger: 'right_middle_pinky',      destination: 'chord_minor_7'      },
  { id: 7,  trigger: 'right_middle_ring_pinky', destination: 'chord_major_7'      },
  { id: 8,  trigger: 'left_no_fingers',         destination: 'arp_off'            },
  { id: 9,  trigger: 'left_pinky',              destination: 'arp_octave'         },
  { id: 10, trigger: 'left_ring_pinky',         destination: 'arp_off'            },
  { id: 11, trigger: 'left_middle',             destination: 'arp_simple'         },
  { id: 12, trigger: 'left_middle_ring',        destination: 'arp_complex'        },
  { id: 13, trigger: 'left_middle_ring_pinky',  destination: 'arp_complex_random' },
  { id: 14, trigger: 'left_middle_pinky',       destination: 'arp_simple_random'  },
  { id: 15, trigger: 'left_tilt_low',           destination: 'arp_rate_4n'        },
  { id: 16, trigger: 'left_tilt_mid',           destination: 'arp_rate_8n'        },
  { id: 17, trigger: 'left_tilt_high',          destination: 'arp_rate_16n'       },
];
