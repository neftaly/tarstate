import type { AdapterSnapshot, AdapterSource, RelationRuntime } from './adapter.js';
import { stubDiagnostic } from './stub.js';

export type MemoryRelationRuntimeOptions = {
  readonly relationNames?: readonly string[];
  readonly version?: number;
};

export function createMemoryRelationRuntime(
  _input: Record<string, readonly unknown[]> = {},
  options: MemoryRelationRuntimeOptions = {}
): RelationRuntime<number> {
  let version = options.version ?? 0;
  const source: AdapterSource<number> = {
    ...(options.relationNames === undefined ? {} : { relationNames: options.relationNames }),
    rows: () => [],
    version: () => version,
    diagnostics: () => [stubDiagnostic('memory-runtime')]
  };

  return {
    source,
    target: {
      ...(options.relationNames === undefined
        ? {}
        : {
            relationNames: options.relationNames,
            ownsRelation: (relationName: string) => options.relationNames?.includes(relationName) === true
          }),
      apply: (patches) => ({
        status: 'rejected',
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics: [stubDiagnostic('memory-runtime')],
        durability: 'memory',
        version
      })
    },
    snapshot: (): AdapterSnapshot<number> => ({ source, version }),
    subscribe: () => {
      version += 0;
      return () => {};
    }
  };
}
