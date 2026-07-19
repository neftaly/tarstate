const ownedOccurrenceIdentities = new WeakSet<object>();

/** Descriptor-safe ownership for caller-supplied occurrence identity. */
export const adoptQueryOccurrenceIds = (input: readonly string[]): readonly string[] => {
  if (ownedOccurrenceIdentities.has(input)) return input;
  if (!Array.isArray(input)) throw new TypeError('Query occurrence identities must be an array');
  try {
    const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('Query occurrence identities contains a hostile length');
    }
    const output: string[] = Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || typeof descriptor.value !== 'string') {
        throw new TypeError('Query occurrence identities contains a hostile array descriptor');
      }
      output[index] = descriptor.value;
    }
    Object.freeze(output);
    ownedOccurrenceIdentities.add(output);
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Query occurrence identities')) throw error;
    throw new TypeError('Query occurrence identities could not be inspected', { cause: error });
  }
};

/** Builds trusted occurrence identity without inspecting an intermediate array. */
export const createQueryOccurrenceIds = <Row>(
  rows: readonly Row[],
  identity: (row: Row, index: number) => string
): readonly string[] => {
  const output: string[] = Array(rows.length);
  for (let index = 0; index < rows.length; index += 1) {
    output[index] = identity(rows[index] as Row, index);
  }
  Object.freeze(output);
  ownedOccurrenceIdentities.add(output);
  return output;
};
