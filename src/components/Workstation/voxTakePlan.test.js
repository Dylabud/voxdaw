/**
 * Vox take planning (Vox Phase 132): one track per I/O input, the photographed
 * voice per input, and how many photo passes the routing needs.
 */
import { hzToMidi, assignChannels, planPhotoPasses, trackNotes, nextStepOff } from './voxTakePlan';

const counts = (o) => new Map(Object.entries(o));

describe('hzToMidi', () => {
  it('rounds to the nearest key and reports the offset', () => {
    expect(hzToMidi(440)).toEqual({ midi: 69, cents: 0 });
    const r = hzToMidi(440 * Math.pow(2, 0.3 / 12)); // 30 cents sharp
    expect(r.midi).toBe(69);
    expect(r.cents).toBeCloseTo(30, 6);
    expect(hzToMidi(440 * Math.pow(2, 0.6 / 12)).midi).toBe(70); // past halfway → next key
  });
});

describe('assignChannels — every I/O input is one track', () => {
  it('three chord voices into one input = ONE track, photographed through the busiest voice', () => {
    const ch = assignChannels(
      counts({ 'chordseq-root-out': 8, 'chordseq-3rd-out': 8, 'chordseq-5th-out': 8 }),
      { 'chordseq-root-out': [5], 'chordseq-3rd-out': [5], 'chordseq-5th-out': [5] });
    expect(ch).toHaveLength(1);
    expect(ch[0].ch).toBe(5);
    expect(ch[0].groups).toHaveLength(3);
    expect(ch[0].selected).toBe('chordseq-root-out'); // tie → the ROOT
  });

  it('a 960 bass on IN 1 and the keyboard on IN 2 = two tracks', () => {
    const ch = assignChannels(counts({ 'seq-pitch-out': 16, 'kbd-pitch-out': 5 }),
      { 'seq-pitch-out': [1], 'kbd-pitch-out': [2] });
    expect(ch.map(c => [c.ch, c.selected])).toEqual([[1, 'seq-pitch-out'], [2, 'kbd-pitch-out']]);
  });

  it('shared input: the part with the most notes is photographed; ties go to the keyboard', () => {
    expect(assignChannels(counts({ 'seq-pitch-out': 16, 'kbd-pitch-out': 5 }),
      { 'seq-pitch-out': [3], 'kbd-pitch-out': [3] })[0].selected).toBe('seq-pitch-out');
    expect(assignChannels(counts({ 'seq-pitch-out': 4, 'kbd-pitch-out': 4 }),
      { 'seq-pitch-out': [3], 'kbd-pitch-out': [3] })[0].selected).toBe('kbd-pitch-out');
  });

  it('a part split to two inputs is on both tracks; parts that played nothing / reached nothing are dropped', () => {
    const ch = assignChannels(counts({ 'seq-pitch-out': 6, 'qnt-cv-out': 0, 'seq2-pitch-out': 3 }),
      { 'seq-pitch-out': [1, 4], 'qnt-cv-out': [2], 'seq2-pitch-out': [] });
    expect(ch.map(c => c.ch)).toEqual([1, 4]);
    expect(ch.every(c => c.selected === 'seq-pitch-out')).toBe(true);
  });
});

describe('planPhotoPasses', () => {
  it('parts on separate inputs photograph together in ONE pass', () => {
    const routes = { a: [1], b: [2], c: [3] };
    const passes = planPhotoPasses(
      [{ ch: 1, selected: 'a' }, { ch: 2, selected: 'b' }, { ch: 3, selected: 'c' }], routes);
    expect(passes).toEqual([{ play: ['a', 'b', 'c'], record: [1, 2, 3] }]);
  });

  it('one part on two inputs plays once and records both', () => {
    expect(planPhotoPasses([{ ch: 1, selected: 'a' }, { ch: 4, selected: 'a' }], { a: [1, 4] }))
      .toEqual([{ play: ['a'], record: [1, 4] }]);
  });

  it('a part that would leak into another input\'s photo gets its own pass', () => {
    // a reaches 1 AND 2; input 2 is photographed through b → a must not play while 2 records.
    const passes = planPhotoPasses([{ ch: 1, selected: 'a' }, { ch: 2, selected: 'b' }],
      { a: [1, 2], b: [2] });
    expect(passes).toEqual([{ play: ['a'], record: [1] }, { play: ['b'], record: [2] }]);
  });

  it('nothing to photograph → no passes', () => {
    expect(planPhotoPasses([], {})).toEqual([]);
  });
});

describe('trackNotes', () => {
  it('merges the groups of one input, de-duplicating the same note at the same tick', () => {
    const byGroup = new Map([
      ['seq-pitch-out', [{ midi: 48, on: 0, off: 90 }, { midi: 50, on: 96, off: 180 }]],
      ['qnt-cv-out',    [{ midi: 48, on: 0, off: 90 }, { midi: 51, on: 96, off: 180 }]],
    ]);
    expect(trackNotes(['seq-pitch-out', 'qnt-cv-out'], byGroup).map(n => [n.on, n.midi]))
      .toEqual([[0, 48], [96, 50], [96, 51]]);
  });
});

describe('nextStepOff — rest-gated notes sound until the next step', () => {
  const steps = [0, 96, 192, 288];            // a 960's steps (ticks), played or rest
  it('runs to the following step, not the gate', () => {
    expect(nextStepOff(0, steps, 77)).toBe(96);
    expect(nextStepOff(96, steps, 999)).toBe(192);
  });
  it('a note between steps (externally clocked / clipped) still ends at the next one', () => {
    expect(nextStepOff(100, steps, 999)).toBe(192);
  });
  it('the last note falls back to one step length', () => {
    expect(nextStepOff(288, steps, 384)).toBe(384);
    expect(nextStepOff(5, [], 101)).toBe(101);
  });
});
