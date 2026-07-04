export type BenchRandom = () => number;

export function createSeededRandom(seed: number): BenchRandom {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function randomInt(random: BenchRandom, maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error('expected non-empty benchmark range');
  return Math.floor(random() * maxExclusive);
}

export function valueAt<const Value>(values: readonly Value[], cursor: number): Value {
  const value = values[cursor % values.length];
  if (value === undefined) throw new Error('benchmark value set is empty');
  return value;
}

export function colorAt(index: number): string {
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'gray'] as const;
  return colors[index % colors.length] ?? 'gray';
}

export function stableSize(input: unknown): number {
  if (input === null || input === undefined) return 0;
  if (Array.isArray(input)) return input.length;
  if (typeof input === 'object') return Object.keys(input).length;
  if (typeof input === 'string') return input.length;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return input.toString().length;
  }
  if (typeof input === 'symbol' || typeof input === 'function') return input.toString().length;
  return 0;
}
