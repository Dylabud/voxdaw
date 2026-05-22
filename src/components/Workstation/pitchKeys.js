export const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const BLACK = new Set(['C#','D#','F#','G#','A#']);

export function buildKeys(loOct, hiOct) {
  const keys = [];
  for (let oct = hiOct; oct >= loOct; oct--) {
    for (let i = 11; i >= 0; i--) {
      const name = NOTE_NAMES[i];
      keys.push({
        name: `${name}${oct}`,
        label: name === 'C' ? `C${oct}` : '',
        black: BLACK.has(name),
      });
    }
  }
  return keys;
}

export const KEYS         = buildKeys(-2, 8);
export const KEY_H        = 18;
export const PIANO_ROLL_H = KEYS.length * KEY_H;
