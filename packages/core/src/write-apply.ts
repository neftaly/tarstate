import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { stubDiagnostic } from './stub.js';
import { writeInputPatches, type WriteInput } from './write.js';

export type MutableObjectSourceData = Record<string, unknown[]>;

export type WriteApplyResult = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type AtomicWriteApplyResult = WriteApplyResult & {
  readonly committed: boolean;
};

export function applyWrites(_data: MutableObjectSourceData, patches: WriteInput): WriteApplyResult {
  return {
    patches: Array.from(writeInputPatches(patches)).length,
    applied: 0,
    deltas: [],
    diagnostics: [stubDiagnostic('write-apply')]
  };
}

export function applyWritesAtomic(data: MutableObjectSourceData, patches: WriteInput): AtomicWriteApplyResult {
  return {
    ...applyWrites(data, patches),
    committed: false
  };
}
