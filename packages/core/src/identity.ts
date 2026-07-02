const stableValueCache = new Map<string, unknown>();

/** Canonicalize values for stable structural identity. */
export function stableValue(value: unknown): unknown {
  const canonical = canonicalStableValue(value);
  if (!isRecord(canonical) && !Array.isArray(canonical)) {
    return canonical;
  }

  const key = JSON.stringify(stableKeyValue(value));
  const existing = stableValueCache.get(key);
  if (existing !== undefined) {
    return existing;
  }

  stableValueCache.set(key, canonical);
  return canonical;
}

function canonicalStableValue(value: unknown): unknown {
  if (value === undefined) {
    return { $tarstate: 'undefined' };
  }

  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

/** Stable JSON key for canonicalized structural identity. */
export function stableKey(value: unknown): string {
  return JSON.stringify(stableKeyValue(value));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function stableKeyValue(value: unknown): unknown {
  if (value === undefined) {
    return { $tarstate: 'undefined', $type: 'undefined' };
  }

  if (Array.isArray(value)) {
    return value.map(stableKeyValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableKeyValue(value[key])]));
}
