export type RecursiveStoragePath = readonly (string | number)[];

export type RecursiveArrayTraversal = {
  readonly path: RecursiveStoragePath;
  readonly descendants: RecursiveStoragePath;
  readonly absent: 'empty' | 'invalid';
  readonly maxDepth: number;
  readonly maxRows: number;
  readonly maxTraversalSteps: number;
};

export type RecursiveArrayOccurrence = {
  readonly candidate: unknown;
  readonly parentCandidate?: unknown;
  readonly absolutePath: RecursiveStoragePath;
  readonly locator: {
    readonly kind: 'recursive-array-position';
    readonly collectionPath: RecursiveStoragePath;
    readonly index: number;
    readonly depth: number;
    readonly durable: false;
  };
};

export type RecursiveArrayProblem = {
  readonly code:
    | 'collection-absent'
    | 'collection-invalid'
    | 'recursive-limit-exceeded'
    | 'recursive-not-tree';
  readonly path: RecursiveStoragePath;
  readonly details: Readonly<Record<string, unknown>>;
};

export type RecursiveArrayTraversalResult = {
  readonly occurrences: readonly RecursiveArrayOccurrence[];
  readonly problems: readonly RecursiveArrayProblem[];
  readonly complete: boolean;
};

type RecursiveArrayFrame = {
  readonly value: readonly unknown[];
  readonly collectionPath: RecursiveStoragePath;
  readonly depth: number;
  readonly parentCandidate?: unknown;
  index: number;
  readonly length: number;
};

/** Bounded depth-first traversal over enumerable array data properties. */
export const traverseRecursiveArray = (
  root: readonly unknown[],
  traversal: RecursiveArrayTraversal
): RecursiveArrayTraversalResult => {
  const occurrences: RecursiveArrayOccurrence[] = [];
  const problems: RecursiveArrayProblem[] = [];
  const frames: RecursiveArrayFrame[] = [];
  const seenCollections = new WeakSet<object>();
  const seenCandidates = new WeakSet<object>();
  let complete = true;
  let traversalSteps = 0;
  let limited = false;

  const recordProblem = (
    code: RecursiveArrayProblem['code'],
    path: RecursiveStoragePath,
    details: Readonly<Record<string, unknown>>
  ): void => {
    problems.push({ code, path, details });
    complete = false;
  };

  const consumeStep = (path: RecursiveStoragePath): boolean => {
    traversalSteps += 1;
    if (traversalSteps <= traversal.maxTraversalSteps) return true;
    if (!limited) {
      recordProblem('recursive-limit-exceeded', path, {
        limit: 'maxTraversalSteps',
        maximum: traversal.maxTraversalSteps
      });
    }
    limited = true;
    return false;
  };

  const pushCollection = (
    value: readonly unknown[],
    collectionPath: RecursiveStoragePath,
    depth: number,
    parentCandidate?: unknown
  ): boolean => {
    if (!consumeStep(collectionPath)) return false;
    if (seenCollections.has(value)) {
      recordProblem('recursive-not-tree', collectionPath, {
        reason: 'collection_repeated'
      });
      return true;
    }
    seenCollections.add(value);
    const inspected = inspectDataArrayLength(value, collectionPath);
    if (!inspected.success) {
      recordProblem('collection-invalid', inspected.path, inspected.details);
      return true;
    }
    frames.push({
      value,
      collectionPath,
      depth,
      ...(parentCandidate === undefined ? {} : { parentCandidate }),
      index: 0,
      length: inspected.length
    });
    return true;
  };

  if (!pushCollection(root, traversal.path, 0)) {
    return { occurrences, problems, complete };
  }

  while (frames.length > 0 && !limited) {
    const frame = frames.at(-1) as RecursiveArrayFrame;
    if (frame.index >= frame.length) {
      frames.pop();
      continue;
    }
    const index = frame.index;
    frame.index += 1;
    const absolutePath = [...frame.collectionPath, index];
    if (!consumeStep(absolutePath)) break;
    if (occurrences.length >= traversal.maxRows) {
      recordProblem('recursive-limit-exceeded', absolutePath, {
        limit: 'maxRows',
        maximum: traversal.maxRows
      });
      break;
    }
    const inspectedMember = inspectDataArrayMember(
      frame.value,
      index,
      absolutePath
    );
    if (!inspectedMember.success) {
      recordProblem(
        'collection-invalid',
        inspectedMember.path,
        inspectedMember.details
      );
      continue;
    }
    const candidate = inspectedMember.value;
    if (candidate !== null && typeof candidate === 'object') {
      if (seenCandidates.has(candidate)) {
        recordProblem('recursive-not-tree', absolutePath, {
          reason: 'candidate_repeated'
        });
        continue;
      }
      seenCandidates.add(candidate);
    }
    occurrences.push({
      candidate,
      ...(frame.parentCandidate === undefined
        ? {}
        : { parentCandidate: frame.parentCandidate }),
      absolutePath,
      locator: {
        kind: 'recursive-array-position',
        collectionPath: frame.collectionPath,
        index,
        depth: frame.depth,
        durable: false
      }
    });
    if (!isRecord(candidate)) {
      complete = false;
      continue;
    }
    const descendantsPath = [...absolutePath, ...traversal.descendants];
    const descendants = readDataPath(candidate, traversal.descendants);
    if (!descendants.present) {
      if (descendants.reason === 'inspection_failed') {
        recordProblem('collection-invalid', descendantsPath, {
          reason: descendants.reason,
          error: descendants.error
        });
      } else if (traversal.absent === 'invalid') {
        recordProblem('collection-absent', descendantsPath, {});
      }
      continue;
    }
    if (!Array.isArray(descendants.value)) {
      recordProblem('collection-invalid', descendantsPath, {
        expected: 'array'
      });
      continue;
    }
    if (frame.depth >= traversal.maxDepth) {
      const inspected = inspectDataArrayLength(
        descendants.value,
        descendantsPath
      );
      if (!inspected.success) {
        recordProblem('collection-invalid', inspected.path, inspected.details);
      } else if (inspected.length > 0) {
        recordProblem('recursive-limit-exceeded', descendantsPath, {
          limit: 'maxDepth',
          maximum: traversal.maxDepth
        });
      }
      continue;
    }
    if (!pushCollection(
      descendants.value,
      descendantsPath,
      frame.depth + 1,
      candidate
    )) {
      break;
    }
  }
  return { occurrences, problems, complete };
};

export type DataArrayInspection =
  | { readonly success: true; readonly values: readonly unknown[] }
  | {
      readonly success: false;
      readonly path: RecursiveStoragePath;
      readonly details: Readonly<Record<string, unknown>>;
    };

export const inspectDataArray = (
  value: readonly unknown[],
  path: RecursiveStoragePath
): DataArrayInspection => {
  const inspectedLength = inspectDataArrayLength(value, path);
  if (!inspectedLength.success) return inspectedLength;
  const values: unknown[] = [];
  for (let index = 0; index < inspectedLength.length; index += 1) {
    const inspectedMember = inspectDataArrayMember(
      value,
      index,
      [...path, index]
    );
    if (!inspectedMember.success) return inspectedMember;
    values.push(inspectedMember.value);
  }
  return { success: true, values };
};

type DataArrayLengthInspection =
  | { readonly success: true; readonly length: number }
  | {
      readonly success: false;
      readonly path: RecursiveStoragePath;
      readonly details: Readonly<Record<string, unknown>>;
    };

const inspectDataArrayLength = (
  value: readonly unknown[],
  path: RecursiveStoragePath
): DataArrayLengthInspection => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (descriptor === undefined
      || !('value' in descriptor)
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0) {
      return { success: false, path, details: { reason: 'length' } };
    }
    return { success: true, length: descriptor.value as number };
  } catch (error) {
    return {
      success: false,
      path,
      details: {
        reason: 'inspection_threw',
        error: error instanceof Error ? error.name : typeof error
      }
    };
  }
};

type DataArrayMemberInspection =
  | { readonly success: true; readonly value: unknown }
  | {
      readonly success: false;
      readonly path: RecursiveStoragePath;
      readonly details: Readonly<Record<string, unknown>>;
    };

const inspectDataArrayMember = (
  value: readonly unknown[],
  index: number,
  path: RecursiveStoragePath
): DataArrayMemberInspection => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor
      ? { success: true, value: descriptor.value }
      : { success: false, path, details: { reason: 'descriptor' } };
  } catch (error) {
    return {
      success: false,
      path,
      details: {
        reason: 'inspection_threw',
        error: error instanceof Error ? error.name : typeof error
      }
    };
  }
};

export type DataPathRead =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false; readonly reason: 'absent' }
  | {
      readonly present: false;
      readonly reason: 'inspection_failed';
      readonly error: string;
    };

export const readDataPath = (
  root: unknown,
  path: RecursiveStoragePath
): DataPathRead => {
  let value = root;
  try {
    for (const member of path) {
      if ((typeof member === 'number' && !Array.isArray(value))
        || (typeof member === 'string' && !isRecord(value))) {
        return { present: false, reason: 'absent' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        value as object,
        member
      );
      if (descriptor === undefined || !('value' in descriptor)) {
        return { present: false, reason: 'absent' };
      }
      value = descriptor.value;
    }
    return { present: true, value };
  } catch (error) {
    return {
      present: false,
      reason: 'inspection_failed',
      error: error instanceof Error ? error.name : typeof error
    };
  }
};

const isRecord = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
