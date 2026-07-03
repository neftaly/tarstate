export type SeededRandom = () => number;

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function chooseSeeded<const Value>(next: SeededRandom, values: readonly Value[]): Value {
  if (values.length === 0) throw new Error('cannot choose from an empty array');
  return values[Math.floor(next() * values.length)] as Value;
}

export function pickSeeded<const Value>(values: readonly Value[], seed: number): Value {
  if (values.length === 0) throw new Error('cannot choose from an empty array');
  return values[Math.abs(seed) % values.length] as Value;
}
