export function sortedEntries<const Value>(record: Readonly<Record<string, Value>>): readonly (readonly [string, Value])[] {
  return Object.entries(record).sort(([left], [right]) => compareCodeUnits(left, right));
}

export function recordFromEntries<const Value>(
  entries: readonly (readonly [string, Value])[]
): Readonly<Record<string, Value>> {
  return Object.fromEntries(entries) as Readonly<Record<string, Value>>;
}

export function tsPropertyName(input: string): string {
  return isIdentifier(input) ? input : JSON.stringify(input);
}

export function uniqueTypeName(input: string, suffix: string, used: Set<string>): string {
  const base = typeName(input, suffix);
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

export function fileStem(input: string): string {
  const stem = encodeURIComponent(input).replaceAll('~', '~~').replaceAll('%', '~');
  return stem === '' ? 'relation' : stem;
}

export function stringLiteral(input: string): string {
  return JSON.stringify(input);
}

export function keyFields(input: string | readonly [string, string, ...string[]]): readonly string[] {
  return typeof input === 'string' ? [input] : [...input];
}

function typeName(input: string, suffix: string): string {
  const words = input.match(/[A-Za-z0-9]+/g) ?? ['relation'];
  const body = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  const safeBody = /^[0-9]/.test(body) ? `T${body}` : body;
  return `${safeBody}${suffix}`;
}

function isIdentifier(input: string): boolean {
  return /^[$A-Z_a-z][$0-9A-Z_a-z]*$/.test(input);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
