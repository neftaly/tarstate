import { canonicalizeJson } from '../../canonical-json.js';
import type { ExternalStoreBasis, ExternalStoreLease } from '../../external-store.js';
import { createIssue, type Issue } from '../../issues.js';
import { comparePortableStrings } from '../../portable-order.js';
import type {
  AtomicSource,
  IntentMergeResult,
  PlanResult,
  SourceCommitInput,
  SourceCommitResult
} from '../../source-protocol.js';
import type { SourceBasis, SourceSnapshot } from '../../source-state.js';
import {
  applyJsonTreeCommands,
  relateJsonTreeFootprints,
  type JsonTreeCommand
} from './json-tree.js';

export type ExternalStoreAtomicSource<State extends object> = AtomicSource<State, JsonTreeCommand> & {
  readonly operationEpoch: string;
  readonly basisForStagedStorage: NonNullable<AtomicSource<State, JsonTreeCommand>['basisForStagedStorage']>;
  readonly close: () => void;
};

export const createExternalStoreAtomicSource = <State extends object>(
  lease: ExternalStoreLease<State>
): ExternalStoreAtomicSource<State> => {
  const { runtime } = lease;
  const operationEpoch = runtime.incarnation;
  let closed = false;

  const snapshot = (): SourceSnapshot<State> => {
    const current = runtime.snapshot();
    if (closed) {
      return Object.freeze({
        sourceId: current.sourceId,
        operationEpoch,
        basis: externalSourceBasis(current.basis),
        state: 'closed',
        freshness: 'none',
        issues: Object.freeze([createIssue({
          code: 'source.closed',
          phase: 'lifecycle',
          severity: 'error',
          retry: 'never',
          sourceId: current.sourceId
        })])
      });
    }
    return Object.freeze({
      sourceId: current.sourceId,
      operationEpoch,
      basis: externalSourceBasis(current.basis),
      state: current.state,
      freshness: current.freshness,
      ...(current.storage === undefined ? {} : { storage: current.storage }),
      issues: current.issues
    });
  };

  const stage = (
    sourceSnapshot: SourceSnapshot<State>,
    commands: readonly JsonTreeCommand[]
  ): { readonly storage: State; readonly issues: readonly Issue[] } => {
    if (sourceSnapshot.state !== 'ready' || sourceSnapshot.storage === undefined) {
      throw new TypeError('Cannot stage a non-ready external-store snapshot');
    }
    const applied = applyJsonTreeCommands(sourceSnapshot.storage, commands);
    return { storage: applied.state, issues: applied.issues };
  };

  const source: ExternalStoreAtomicSource<State> = {
    sourceId: runtime.sourceId,
    operationEpoch,
    snapshot,
    subscribe: (listener) => closed ? () => undefined : runtime.subscribe(() => {
      const current = runtime.snapshot();
      listener({ afterBasis: externalSourceBasis(current.basis) });
    }),
    commit: async (input: SourceCommitInput<JsonTreeCommand>): Promise<SourceCommitResult> => {
      if (closed) {
        return commitResult({
          outcome: 'rejected',
          issues: [sourceIssue('source.closed', runtime.sourceId, input.operationId)]
        });
      }
      if (input.operationEpoch !== operationEpoch) {
        return commitResult({
          outcome: 'rejected',
          issues: [sourceIssue(
            'transaction.operation_epoch_expired',
            runtime.sourceId,
            input.operationId,
            { expected: operationEpoch, received: input.operationEpoch }
          )]
        });
      }
      const basis = parseExternalSourceBasis(input.expectedBasis);
      if (basis === undefined) {
        return commitResult({
          outcome: 'rejected',
          issues: [sourceIssue(
            'transaction.expected_basis_stale',
            runtime.sourceId,
            input.operationId,
            { reason: 'external_store_basis_required' }
          )]
        });
      }
      const committed = runtime.commit(basis, (current) => {
        const applied = applyJsonTreeCommands(current, input.commands);
        return {
          state: applied.state,
          changed: applied.changed,
          result: applied.issues
        };
      });
      if (committed.outcome === 'rejected') {
        return commitResult({
          outcome: 'rejected',
          beforeBasis: externalSourceBasis(committed.beforeBasis),
          issues: committed.issues
        });
      }
      if (committed.result.length > 0) {
        return commitResult({
          outcome: 'rejected',
          beforeBasis: externalSourceBasis(committed.beforeBasis),
          afterBasis: externalSourceBasis(committed.afterBasis),
          issues: committed.result
        });
      }
      return commitResult({
        outcome: 'committed',
        beforeBasis: externalSourceBasis(committed.beforeBasis),
        afterBasis: externalSourceBasis(committed.afterBasis),
        issues: []
      });
    },
    relateFootprints: relateJsonTreeFootprints,
    mergeIntents: mergeJsonTreeIntents,
    stage,
    basisForStagedStorage: (sourceSnapshot, stagedStorage) => {
      const basis = parseExternalSourceBasis(sourceSnapshot.basis);
      if (basis === undefined) throw new TypeError('External-store staged basis requires an external-store snapshot');
      return Object.is(sourceSnapshot.storage, stagedStorage)
        ? externalSourceBasis(basis)
        : externalSourceBasis({ ...basis, revision: basis.revision + 1 });
    },
    close: () => {
      if (closed) return;
      closed = true;
      lease.release();
    }
  };
  return Object.freeze(source);
};

const mergeJsonTreeIntents = (
  plans: readonly PlanResult<JsonTreeCommand>[]
): IntentMergeResult<JsonTreeCommand> => {
  if (plans.length === 1) {
    const intents = (plans[0] as PlanResult<JsonTreeCommand>).intents;
    if (intents.length <= 1) {
      return {
        outcome: 'merged',
        commands: intents.length === 0
          ? []
          : [(intents[0] as (typeof intents)[number]).command]
      };
    }
  }
  const intents = plans.flatMap(({ intents }) => intents)
    .map((intent) => ({ intent, sortKey: canonicalizeJson(intent.footprint) }))
    .sort((left, right) => comparePortableStrings(left.sortKey, right.sortKey))
    .map(({ intent }) => intent);
  for (let leftIndex = 0; leftIndex < intents.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < intents.length; rightIndex += 1) {
      const left = intents[leftIndex] as (typeof intents)[number];
      const right = intents[rightIndex] as (typeof intents)[number];
      const relation = relateJsonTreeFootprints(left.footprint, right.footprint);
      if (relation === 'disjoint') continue;
      return {
        outcome: relation === 'unknown' ? 'unknown' : 'conflict',
        issues: [createIssue({
          code: relation === 'unknown'
            ? 'binding.footprint_relation_unknown'
            : 'binding.write_footprint_overlap',
          phase: 'plan',
          severity: 'error',
          retry: 'after_input',
          details: { relation, left: left.footprint, right: right.footprint }
        })]
      };
    }
  }
  return { outcome: 'merged', commands: intents.map(({ command }) => command) };
};

const externalSourceBasis = (basis: ExternalStoreBasis): SourceBasis => Object.freeze({
  kind: 'external-store',
  incarnation: basis.incarnation,
  revision: basis.revision
});

const parseExternalSourceBasis = (basis: SourceBasis): ExternalStoreBasis | undefined => {
  if (basis === null || typeof basis !== 'object' || Array.isArray(basis)) return undefined;
  const candidate = basis as { readonly kind?: unknown; readonly incarnation?: unknown; readonly revision?: unknown };
  if (candidate.kind !== 'external-store'
    || typeof candidate.incarnation !== 'string'
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 0) return undefined;
  return { incarnation: candidate.incarnation, revision: candidate.revision as number };
};

const commitResult = (input: SourceCommitResult): SourceCommitResult => Object.freeze({
  ...input,
  issues: Object.freeze([...input.issues])
});

const sourceIssue = (
  code: string,
  sourceId: string,
  operationId: string,
  details?: unknown
): Issue => createIssue({
  code,
  phase: 'commit',
  severity: 'error',
  retry: code === 'transaction.expected_basis_stale' ? 'after_refresh' : 'never',
  sourceId,
  operationId,
  ...(details === undefined ? {} : { details })
});
