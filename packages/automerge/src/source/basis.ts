import * as Automerge from '@automerge/automerge';
import type { AutomergeBasis } from '../shared/basis-adoption.js';
export {
  adoptAutomergeBasis,
  type AutomergeBasis,
  type AutomergeBasisAdoptionResult
} from '../shared/basis-adoption.js';

/** Captures the document's current exact-head basis. */
export const automergeBasis = (document: Automerge.Doc<unknown>): AutomergeBasis => Object.freeze({
  kind: 'automerge-heads',
  heads: Object.freeze([...Automerge.getHeads(document)].sort())
});

export const exactAutomergeHeadsEqual = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  if (left.length !== right.length) return false;
  if (isSorted(left) && isSorted(right)) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) return false;
  }
  return true;
};

export const exactAutomergeBasisEqual = (
  left: AutomergeBasis,
  right: AutomergeBasis
): boolean => exactAutomergeHeadsEqual(left.heads, right.heads);

const isSorted = (values: readonly string[]): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] as string) > (values[index] as string)) return false;
  }
  return true;
};
