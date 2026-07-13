/** Collision-free, allocation-light identity for an ordered tuple of strings. */
export const stringTupleKey = (...parts: readonly string[]): string => {
  let key = '';
  for (const part of parts) key += part.length + ':' + part;
  return key;
};
