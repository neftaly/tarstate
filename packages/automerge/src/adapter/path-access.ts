import type { AutomergePath } from '../document/projection.js';

/** Reads an Automerge value without converting or copying source-native scalars. */
export const valueAtAutomergePath = (
  root: unknown,
  path: AutomergePath
): unknown => {
  let current = root;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
};
