export type FuzzRandom = () => number;

export function mulberry32(seed: number): FuzzRandom {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomInt(random: FuzzRandom, maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error('expected non-empty fuzz range');
  return Math.floor(random() * maxExclusive);
}

export function choose<Value>(random: FuzzRandom, values: readonly Value[]): Value {
  const value = values[randomInt(random, values.length)];
  if (value === undefined && !values.includes(undefined as Value)) throw new Error('seeded choice escaped values');
  return value as Value;
}

export function chooseFromSet(random: FuzzRandom, values: ReadonlySet<string>): string {
  return choose(random, Array.from(values).sort());
}

export function shuffle<Value>(random: FuzzRandom, values: readonly Value[]): readonly Value[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(random, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as Value, shuffled[index] as Value];
  }
  return shuffled;
}

export function canonicalRows(rows: readonly unknown[]): readonly unknown[] {
  return rows.map(canonicalValue).sort(compareCanonicalRows);
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function compareCanonicalRows(left: unknown, right: unknown): number {
  return canonicalRowKey(left).localeCompare(canonicalRowKey(right));
}

function canonicalRowKey(input: unknown): string {
  const json = JSON.stringify(input);
  return json === undefined ? String(input) : json;
}

function canonicalValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalValue);
  if (isRecord(input)) {
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalValue(input[key])]));
  }
  return input;
}
