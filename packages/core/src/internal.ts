export function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (typeof input === 'number') {
    if (Number.isNaN(input)) return '~number:NaN';
    if (input === Infinity) return '~number:Infinity';
    if (input === -Infinity) return '~number:-Infinity';
    if (Object.is(input, -0)) return '~number:-0';
    return JSON.stringify(input);
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function uniqueStrings(...groups: readonly (readonly string[])[]): readonly string[] {
  return Array.from(new Set(groups.flat()));
}
