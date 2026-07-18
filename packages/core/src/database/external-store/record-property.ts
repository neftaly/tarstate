/** Writes one enumerable data property without invoking Object.prototype setters. */
export const setEnumerableDataProperty = (
  record: Record<string, unknown>,
  key: string,
  value: unknown
): void => {
  if (key !== '__proto__') {
    record[key] = value;
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
};
