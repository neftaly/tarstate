export type AutomergeBasis = {
  readonly kind: 'automerge-heads';
  readonly heads: readonly string[];
};

export type AutomergeBasisAdoptionResult =
  | { readonly success: true; readonly value: AutomergeBasis }
  | { readonly success: false; readonly reason: 'invalid-basis' | 'unsupported-basis' };

const automergeHeadPattern = /^[0-9a-f]{64}$/;
const invalidBasisResult = Object.freeze({
  success: false,
  reason: 'invalid-basis'
} as const);
const unsupportedBasisResult = Object.freeze({
  success: false,
  reason: 'unsupported-basis'
} as const);

/** Safely adopts portable exact-head evidence without invoking accessors. */
export const adoptAutomergeBasis = (input: unknown): AutomergeBasisAdoptionResult => {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalidBasisResult;
    }
    descriptors = ownDescriptors(input);
  } catch {
    return invalidBasisResult;
  }
  const kind = dataProperty(descriptors.kind);
  if (typeof kind !== 'string') return invalidBasisResult;
  if (kind !== 'automerge-heads') return unsupportedBasisResult;
  const rawHeads = dataProperty(descriptors.heads);
  const heads: string[] = [];
  try {
    if (!Array.isArray(rawHeads)) return invalidBasisResult;
    const headDescriptors = ownDescriptors(rawHeads);
    const length = descriptorValue(headDescriptors.length);
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      return invalidBasisResult;
    }
    for (let index = 0; index < (length as number); index += 1) {
      const head = dataProperty(headDescriptors[String(index)]);
      if (typeof head !== 'string' || !automergeHeadPattern.test(head)) {
        return invalidBasisResult;
      }
      heads.push(head);
    }
  } catch {
    return invalidBasisResult;
  }
  heads.sort();
  for (let index = 1; index < heads.length; index += 1) {
    if (heads[index - 1] === heads[index]) return invalidBasisResult;
  }
  return {
    success: true,
    value: {
      kind,
      heads
    }
  };
};

const dataProperty = (descriptor: PropertyDescriptor | undefined): unknown =>
  descriptor?.enumerable === true && 'value' in descriptor
    ? descriptor.value
    : undefined;

const descriptorValue = (descriptor: PropertyDescriptor | undefined): unknown =>
  descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;

const ownDescriptors = (value: object): Record<string, PropertyDescriptor> =>
  Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
