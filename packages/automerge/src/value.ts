export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return JSON.stringify(input);
  }
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }

  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

export function stableStringify(input: unknown): string {
  return JSON.stringify(normalizeForStableStringify(input));
}

function normalizeForStableStringify(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normalizeForStableStringify);
  if (isRecord(input) && isPlainObjectLike(input)) {
    return Object.fromEntries(Object.keys(input)
      .sort()
      .map((key) => [key, normalizeForStableStringify(input[key])]));
  }

  return input;
}

export function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  return String(left).localeCompare(String(right));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isPlainObjectLike(input: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
