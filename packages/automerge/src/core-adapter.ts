import * as Automerge from '@automerge/automerge';
import { comparePortableStrings } from './portable-order.js';
import { adoptAutomergeMapStorageBindingOptions } from './internal-options-ownership.js';
import { samePortableJson } from './internal-portable-json.js';
import {
  canonicalizeJson,
  createIssue,
  builtInCapabilityRefs,
  type CapabilityRef,
  type ContentHash,
  type Issue,
  type JsonValue
} from '@tarstate/core/foundation';
import {
  type AtomicSource,
  type IntentMergeResult,
  type LogicalEdit,
  type PlanResult,
  type ProjectionResult,
  type SourceCommitInput,
  type SourceCommitResult,
  type SourceFreshness,
  type SourceLifecycleState,
  type SourceOutcomeLookup,
  type SourceSnapshot,
  type StorageBinding
} from '@tarstate/core/source';
import { conflictsAt, type AutomergePath, type AutomergeProjectionIssue } from './projection.js';
import {
  automergeBasis,
  type AutomergeSourceRuntimeApi,
  type AutomergeBasis,
  type AutomergeSnapshot,
  type AutomergeSourceCommand,
  type AutomergeSourceCommitResult
} from './source.js';
import {
  reportAutomergeDiagnostic,
  runAutomergeCleanups,
  type AutomergeSourceDiagnosticReporter
} from './internal-diagnostics.js';
import {
  AutomergeMapProjectionPlanner,
  type AutomergeMapProjectionPlannerOptions,
  type AutomergeProjectedRow,
  type AutomergePropertyEdit,
  valueAtAutomergePath
} from './storage-binding.js';
import {
  automergePathFootprint,
  findAutomergeFootprintOverlap,
  relateAutomergeFootprints,
  type AutomergePathFootprint
} from './footprint.js';

export {
  automergePathFootprint,
  relateAutomergeFootprints,
  type AutomergePathFootprint,
  type AutomergePathFootprintEntry
} from './footprint.js';

export type AutomergeAtomicSourceOptions<T extends object> = {
  readonly runtime: AutomergeSourceRuntimeApi<T>;
  readonly operationEpoch: string;
  readonly freshness?: SourceFreshness;
  readonly ownsRuntime?: boolean;
  readonly onDiagnostic?: AutomergeSourceDiagnosticReporter;
};

/** Core AtomicSource facade over the proven exact-head Automerge runtime. */
export class AutomergeAtomicSource<T extends object> implements AtomicSource<Automerge.Doc<T>, AutomergeSourceCommand<T>> {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly #runtime: AutomergeSourceRuntimeApi<T>;
  readonly #ownsRuntime: boolean;
  readonly #onDiagnostic: AutomergeSourceDiagnosticReporter | undefined;
  readonly #listeners = new Set<(change?: { readonly beforeBasis?: import('@tarstate/core/source').SourceBasis; readonly afterBasis: import('@tarstate/core/source').SourceBasis }) => void>();
  readonly #unsubscribeRuntime: () => void;
  #freshness: SourceFreshness;
  #lifecycle: SourceLifecycleState = 'ready';
  #lifecycleIssues: readonly Issue[] = Object.freeze([]);
  #lastReady: { readonly basis: AutomergeBasis; readonly storage: Automerge.Doc<T> };

  constructor(options: AutomergeAtomicSourceOptions<T>) {
    if (options.operationEpoch.length === 0) throw new TypeError('operationEpoch must not be empty');
    this.#runtime = options.runtime;
    this.sourceId = options.runtime.sourceId;
    this.operationEpoch = options.operationEpoch;
    this.#freshness = options.freshness ?? 'current';
    this.#ownsRuntime = options.ownsRuntime === true;
    this.#onDiagnostic = options.onDiagnostic;
    const initial = options.runtime.snapshot();
    this.#lastReady = { basis: initial.basis, storage: initial.storage };
    this.#unsubscribeRuntime = options.runtime.subscribe((change) => {
      const latest = this.#runtime.snapshot();
      this.#lastReady = { basis: latest.basis, storage: latest.storage };
      this.#publish({ beforeBasis: change.beforeBasis, afterBasis: change.afterBasis });
    });
  }

  snapshot = (): SourceSnapshot<Automerge.Doc<T>> => {
    if (this.#lifecycle !== 'ready') {
      return Object.freeze({
        sourceId: this.sourceId,
        operationEpoch: this.operationEpoch,
        basis: this.#lastReady.basis,
        state: this.#lifecycle,
        freshness: this.#lifecycle === 'closed' ? 'none' : this.#freshness,
        issues: this.#lifecycleIssues
      });
    }
    const current = this.#runtime.snapshot();
    return Object.freeze({
      sourceId: this.sourceId,
      operationEpoch: this.operationEpoch,
      basis: current.basis,
      state: 'ready',
      freshness: this.#freshness,
      storage: current.storage,
      issues: this.#lifecycleIssues
    });
  };

  subscribe = (listener: (change?: { readonly beforeBasis?: import('@tarstate/core/source').SourceBasis; readonly afterBasis: import('@tarstate/core/source').SourceBasis }) => void): (() => void) => {
    if (this.#lifecycle === 'closed') return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  commit = async (input: SourceCommitInput<AutomergeSourceCommand<T>>): Promise<SourceCommitResult> => {
    if (this.#lifecycle !== 'ready') {
      return frozenCoreCommitResult({ outcome: 'rejected', issues: [sourceStateIssue(this.sourceId, this.#lifecycle)] });
    }
    if (input.operationEpoch !== this.operationEpoch) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: [createIssue({
          code: 'transaction.operation_epoch_expired',
          sourceId: this.sourceId,
          operationId: input.operationId,
          retry: 'never',
          details: { expected: this.operationEpoch, received: input.operationEpoch }
        })]
      });
    }
    const basis = parseAutomergeBasis(input.expectedBasis);
    if (basis === undefined) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: [createIssue({
          code: 'transaction.expected_basis_stale',
          phase: 'commit',
          severity: 'error',
          retry: 'after_refresh',
          sourceId: this.sourceId,
          operationId: input.operationId,
          details: { reason: 'automerge_basis_required' }
        })]
      });
    }
    const result = await this.#runtime.commit({
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      expectedBasis: basis,
      commands: input.commands
    });
    return coreCommitResult(result);
  };

  relateFootprints = relateAutomergeFootprints;

  mergeIntents = (plans: readonly PlanResult<AutomergeSourceCommand<T>>[]): IntentMergeResult<AutomergeSourceCommand<T>> => {
    const intents = plans.flatMap(({ intents }) => intents)
      .map((intent) => ({ intent, sortKey: canonicalizeJson(intent.footprint) }))
      .sort((left, right) => comparePortableStrings(left.sortKey, right.sortKey))
      .map(({ intent }) => intent);
    const overlap = findAutomergeFootprintOverlap(intents.map(({ footprint }) => footprint));
    if (overlap.status === 'unknown') {
      return {
        outcome: 'unknown',
        issues: [adapterIssue('binding.footprint_relation_unknown', 'plan', this.sourceId, undefined, undefined, { footprint: intents[overlap.footprintIndex]?.footprint })]
      };
    }
    if (overlap.status === 'overlap') {
      const left = intents[overlap.leftIndex]!;
      const right = intents[overlap.rightIndex]!;
      const relation = this.relateFootprints(left.footprint, right.footprint);
      return {
        outcome: 'conflict',
        issues: [adapterIssue('binding.write_footprint_overlap', 'plan', this.sourceId, undefined, undefined, { relation, left: left.footprint, right: right.footprint })]
      };
    }
    return { outcome: 'merged', commands: intents.map(({ command }) => command) };
  };

  stage = (snapshot: SourceSnapshot<Automerge.Doc<T>>, commands: readonly AutomergeSourceCommand<T>[]): { readonly storage: Automerge.Doc<T>; readonly issues: readonly Issue[] } => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) throw new TypeError('Cannot stage a non-ready Automerge snapshot');
    try {
      const storage = commands.length === 0
        ? snapshot.storage
        : Automerge.change(Automerge.clone(snapshot.storage), { message: 'tarstate staged source commit', time: 0 }, (draft) => {
            for (const command of commands) command.apply(draft);
          });
      return { storage, issues: [] };
    } catch (error) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('automerge.command_failed', 'plan', this.sourceId, undefined, undefined, { message: error instanceof Error ? error.message : String(error) })]
      };
    }
  };

  basisForStagedStorage = (_snapshot: SourceSnapshot<Automerge.Doc<T>>, stagedStorage: Automerge.Doc<T>): AutomergeBasis =>
    automergeBasis(stagedStorage);

  queryOutcome = async (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): Promise<SourceOutcomeLookup<SourceCommitResult>> => {
    const lookup = this.#runtime.queryOutcome(input);
    if (lookup.status === 'known') return Object.freeze({ status: 'known', result: coreCommitResult(lookup.result) });
    return lookup;
  };

  setFreshness(freshness: SourceFreshness): void {
    if (this.#lifecycle === 'closed' || freshness === this.#freshness) return;
    this.#freshness = freshness;
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  setLifecycle(state: Exclude<SourceLifecycleState, 'ready' | 'closed'>, issues: readonly Issue[] = []): void {
    if (this.#lifecycle === 'closed') throw new Error('Automerge atomic source is closed');
    if (state === this.#lifecycle && sameIssues(issues, this.#lifecycleIssues)) return;
    this.#lifecycle = state;
    this.#lifecycleIssues = Object.freeze([...issues]);
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  markReady(freshness: SourceFreshness = 'current'): void {
    if (this.#lifecycle === 'closed') throw new Error('Automerge atomic source is closed');
    this.#lifecycle = 'ready';
    this.#freshness = freshness;
    this.#lifecycleIssues = Object.freeze([]);
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  close(): void {
    if (this.#lifecycle === 'closed') return;
    this.#lifecycle = 'closed';
    this.#freshness = 'none';
    this.#lifecycleIssues = Object.freeze([createIssue({ code: 'source.closed', sourceId: this.sourceId, retry: 'never' })]);
    this.#publish({ afterBasis: this.#lastReady.basis });
    this.#listeners.clear();
    runAutomergeCleanups([
      { operation: 'close.unsubscribe-runtime', cleanup: this.#unsubscribeRuntime },
      ...(this.#ownsRuntime ? [{ operation: 'close.runtime', cleanup: () => this.#runtime.close() }] : [])
    ], 'atomic-source', this.#onDiagnostic);
  }

  #publish(change: { readonly beforeBasis?: AutomergeBasis; readonly afterBasis: AutomergeBasis }): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(change);
      } catch (error) {
        reportAutomergeDiagnostic(this.#onDiagnostic, {
          kind: 'listener_error', component: 'atomic-source', operation: 'publish', error
        });
      }
    }
  }
}

export type AutomergeMapStorageBindingOptions<Row extends Readonly<Record<string, JsonValue>>> = AutomergeMapProjectionPlannerOptions<Row> & {
  readonly id?: string;
};

/** Core StorageBinding facade over the proven pure Automerge map binding. */
export class AutomergeMapStorageBinding<T extends object, Row extends Readonly<Record<string, JsonValue>>>
implements StorageBinding<Automerge.Doc<T>, AutomergeSourceCommand<T>, AutomergeProjectedRow<Row>> {
  readonly id: string;
  readonly relationIds: readonly string[];
  readonly declaredReadFootprint: AutomergePathFootprint;
  readonly declaredWriteFootprint: AutomergePathFootprint;
  readonly #relationId: string;
  readonly #collectionPath: AutomergePath;
  readonly #keySource: AutomergeMapStorageBindingOptions<Row>['keySource'];
  readonly #projectionPlanner: AutomergeMapProjectionPlanner<T, Row>;
  readonly #projections = new WeakMap<object, Map<string, ProjectionResult<AutomergeProjectedRow<Row>>>>();
  #previousProjection: {
    readonly snapshot: Pick<AutomergeSnapshot<T>, 'sourceId' | 'basis'>;
    readonly projection: ReturnType<AutomergeMapProjectionPlanner<T, Row>['project']>;
  } | undefined;

  constructor(options: AutomergeMapStorageBindingOptions<Row>) {
    const owned = adoptAutomergeMapStorageBindingOptions<Row>(options);
    this.id = owned.id ?? 'automerge-map:' + owned.relationId;
    this.#relationId = owned.relationId;
    this.relationIds = Object.freeze([owned.relationId]);
    this.#collectionPath = owned.collectionPath;
    this.#keySource = owned.keySource;
    this.declaredReadFootprint = automergePathFootprint([{ scope: 'subtree', path: this.#collectionPath }]);
    this.declaredWriteFootprint = this.declaredReadFootprint;
    this.#projectionPlanner = new AutomergeMapProjectionPlanner(owned);
  }

  project = (snapshot: SourceSnapshot<Automerge.Doc<T>>, requestedRelations?: ReadonlySet<string>): ProjectionResult<AutomergeProjectedRow<Row>> => {
    if (requestedRelations !== undefined && !requestedRelations.has(this.#relationId)) {
      return Object.freeze({ rows: Object.freeze([]), completeness: 'exact', issues: Object.freeze([]) });
    }
    const adapted = readyAutomergeSnapshot(snapshot);
    if (adapted === undefined) return { rows: [], completeness: 'unknown', issues: [sourceStateIssue(snapshot.sourceId, snapshot.state)] };
    const cached = this.#projections.get(adapted.storage)?.get(snapshot.sourceId);
    if (cached !== undefined) return cached;
    const projection = this.#projectionPlanner.project(adapted, this.#previousProjection);
    this.#previousProjection = { snapshot: { sourceId: adapted.sourceId, basis: adapted.basis }, projection };
    const result = Object.freeze({
      rows: projection.rows,
      completeness: projection.completeness,
      issues: Object.freeze(projection.issues.map((issue) => projectionIssue(issue, snapshot.sourceId, this.#relationId, 'query')))
    });
    const bySource = this.#projections.get(adapted.storage) ?? new Map<string, ProjectionResult<AutomergeProjectedRow<Row>>>();
    if (!bySource.has(snapshot.sourceId) && bySource.size >= 64) bySource.delete(bySource.keys().next().value as string);
    bySource.set(snapshot.sourceId, result);
    this.#projections.set(adapted.storage, bySource);
    return result;
  };

  plan = (snapshot: SourceSnapshot<Automerge.Doc<T>>, edits: readonly LogicalEdit[]): PlanResult<AutomergeSourceCommand<T>> => {
    const handledEdits = edits.flatMap((edit, editIndex) => edit.relationId === this.#relationId
      ? [{ editIndex, mode: 'exclusive' as const }]
      : []);
    const relevant = handledEdits.map(({ editIndex }) => edits[editIndex] as LogicalEdit);
    const empty = automergePathFootprint([]);
    if (relevant.length === 0) return { handledEdits, readFootprint: empty, writeFootprint: empty, intents: [], issues: [] };
    const adapted = readyAutomergeSnapshot(snapshot);
    if (adapted === undefined) return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: empty, intents: [], issues: [sourceStateIssue(snapshot.sourceId, snapshot.state)] };
    const projection = this.project(snapshot);
    const resolvesOnly = relevant.every(({ kind }) => kind === 'conflict-resolve');
    const issues: Issue[] = projection.issues
      .filter((issue) => !resolvesOnly || (issue.code !== 'automerge.map_key_conflict' && issue.code !== 'automerge.logical_key_ambiguous'))
      .map((issue) => ({ ...issue, phase: 'plan' as const }));
    const rowsByLocator = new Map<string, AutomergeProjectedRow<Row>[]>();
    for (const row of projection.rows) {
      const key = canonicalizeJson(row.locator);
      const bucket = rowsByLocator.get(key);
      if (bucket === undefined) rowsByLocator.set(key, [row]);
      else bucket.push(row);
    }
    const intents: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> }[] = [];
    const addPropertyEdit = (edit: AutomergePropertyEdit): void => {
      const planned = this.#projectionPlanner.plan(adapted, [edit]);
      issues.push(...planned.issues.map((issue) => projectionIssue(issue, snapshot.sourceId, this.#relationId, 'plan')));
      if (planned.issues.length === 0 && planned.commands[0] !== undefined && planned.footprints[0] !== undefined) {
        intents.push({ footprint: automergePathFootprint([{ scope: 'exact', path: planned.footprints[0].path }]), command: planned.commands[0] });
      } else if (planned.issues.length === 0) {
        throw new TypeError('Automerge property planner returned no command or footprint for ' + edit.kind);
      }
    };
    for (const edit of relevant) {
      if (edit.kind === 'insert') {
        const mapKey = mapKeyFromLogicalKey(edit.key);
        const collection = valueAtAutomergePath(adapted.storage, this.#collectionPath);
        if (this.#keySource !== 'map-key' || mapKey === undefined || !isRecord(collection)) {
          issues.push(adapterIssue('mapping.key_invalid', 'plan', snapshot.sourceId, this.#relationId, undefined, { reason: this.#keySource === 'map-key' ? 'single_string_key_required' : 'insert_requires_map_key_storage' }));
          continue;
        }
        const path = [...this.#collectionPath, mapKey];
        if (Object.hasOwn(collection, mapKey) || conflictsAt(collection, mapKey).length > 0) {
          issues.push(createIssue({ code: 'transaction.upsert_conflict', sourceId: snapshot.sourceId, relationId: this.#relationId, key: edit.key, path, retry: 'after_input' }));
          continue;
        }
        intents.push({
          footprint: automergePathFootprint([{ scope: 'exact', path }]),
          command: {
            description: 'insert map row',
            apply: (draft) => {
              const target = valueAtAutomergePath(draft, this.#collectionPath);
              if (!isRecord(target) || Object.hasOwn(target, mapKey)) throw new Error('Insert target changed after planning');
              target[mapKey] = copyPortableValue(edit.fields);
            }
          }
        });
        continue;
      }
      const candidates = rowsByLocator.get(canonicalizeJson(edit.locator)) ?? [];
      if (candidates.length !== 1) {
        issues.push(adapterIssue(
          candidates.length === 0 ? 'mapping.locator_stale' : 'mapping.locator_invalid',
          'plan',
          snapshot.sourceId,
          this.#relationId,
          undefined,
          { candidates: candidates.length }
        ));
        continue;
      }
      const row = candidates[0]!;
      if (!samePortableJson(row.key, edit.key)) {
        issues.push(adapterIssue('mapping.locator_stale', 'plan', snapshot.sourceId, this.#relationId, undefined, { reason: 'logical_key_changed' }));
        continue;
      }
      if (edit.kind === 'replace-fields') {
        if (typeof this.#keySource !== 'string' && Object.hasOwn(edit.fields, this.#keySource.field) && !samePortableJson(edit.fields[this.#keySource.field], row.fields[this.#keySource.field])) {
          issues.push(createIssue({ code: 'mapping.rekey_required', sourceId: snapshot.sourceId, relationId: this.#relationId, path: [...row.storagePath, this.#keySource.field], retry: 'after_input' }));
          continue;
        }
        for (const [field, value] of Object.entries(edit.fields).sort(([left], [right]) => comparePortableStrings(left, right))) {
          if (!samePortableJson(row.fields[field], value)) addPropertyEdit({ kind: 'replace', path: [...row.storagePath, field], value });
        }
      } else if (edit.kind === 'replace-row') {
        if (typeof this.#keySource !== 'string' && !samePortableJson(edit.fields[this.#keySource.field], row.fields[this.#keySource.field])) {
          issues.push(createIssue({ code: 'mapping.rekey_required', sourceId: snapshot.sourceId, relationId: this.#relationId, path: [...row.storagePath, this.#keySource.field], retry: 'after_input' }));
          continue;
        }
        if (!samePortableJson(row.fields, edit.fields)) addPropertyEdit({ kind: 'replace', path: row.storagePath, value: edit.fields });
      } else if (edit.kind === 'delete') {
        addPropertyEdit({ kind: 'delete', path: row.storagePath });
      } else if (edit.kind === 'counter-increment') {
        addPropertyEdit({ kind: 'counter-increment', path: [...row.storagePath, edit.field], by: edit.by });
      } else if (edit.kind === 'text-splice') {
        addPropertyEdit({ kind: 'text-splice', path: [...row.storagePath, edit.field], index: edit.index, deleteCount: edit.deleteCount, value: edit.value });
      } else if (edit.kind === 'list-splice') {
        const path = [...row.storagePath, edit.field];
        const current = valueAtAutomergePath(adapted.storage, path);
        const conflict = firstConflictPath(adapted.storage, path);
        if (conflict !== undefined) {
          issues.push(adapterIssue('transaction.conflict_requires_resolution', 'plan', snapshot.sourceId, this.#relationId, undefined, undefined, conflict));
        } else if (!Array.isArray(current) || !validSplice(edit.index, edit.deleteCount, current.length)) {
          issues.push(adapterIssue('transaction.edit_type_mismatch', 'plan', snapshot.sourceId, this.#relationId, undefined, { edit: 'list-splice' }, path));
        } else {
          intents.push({
            footprint: automergePathFootprint([{ scope: 'exact', path }]),
            command: {
              description: 'splice list',
              apply: (draft) => {
                const list = valueAtAutomergePath(draft, path);
                if (!Array.isArray(list)) throw new Error('List changed after planning');
                Automerge.deleteAt(list, edit.index, edit.deleteCount);
                if (edit.values.length > 0) Automerge.insertAt(list, edit.index, ...edit.values.map(copyPortableValue));
              }
            }
          });
        }
      } else if (edit.kind === 'conflict-resolve') {
        addPropertyEdit({
          kind: 'conflict-resolve',
          path: edit.field === undefined ? row.storagePath : [...row.storagePath, edit.field],
          observedChangeHashes: edit.observedChangeHashes,
          selectedChangeHash: edit.selectedChangeHash
        });
      } else if (edit.kind === 'rekey') {
        issues.push(unsupportedEditIssue(snapshot.sourceId, this.#relationId, builtInCapabilityRefs.rekey, 'rekey_requires_reference_aware_lowering'));
      } else if (edit.kind === 'move-relocate') {
        const capability = edit.mode === 'identity-preserving' ? builtInCapabilityRefs.identityPreservingMove : builtInCapabilityRefs.copyRelocate;
        issues.push(unsupportedEditIssue(snapshot.sourceId, this.#relationId, capability, 'automerge_move_unsupported'));
      } else {
        assertNever(edit);
      }
    }
    const writeFootprint = automergePathFootprint(intents.flatMap(({ footprint }) => footprint.entries));
    if (issues.length > 0) return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: [], issues };
    const command: AutomergeSourceCommand<T> | undefined = intents.length === 0
      ? undefined
      : {
          description: intents.map(({ command: planned }) => planned.description).join('; '),
          apply: (draft) => {
            for (const intent of intents) intent.command.apply(draft);
          }
        };
    return {
      handledEdits,
      readFootprint: this.declaredReadFootprint,
      writeFootprint,
      intents: command === undefined ? [] : [{ footprint: writeFootprint, command }],
      issues: []
    };
  };
}

const readyAutomergeSnapshot = <T extends object>(snapshot: SourceSnapshot<Automerge.Doc<T>>) =>
  snapshot.state !== 'ready' || snapshot.storage === undefined || parseAutomergeBasis(snapshot.basis) === undefined
    ? undefined
    : { sourceId: snapshot.sourceId, basis: parseAutomergeBasis(snapshot.basis)!, storage: snapshot.storage };

const frozenCoreCommitResult = (result: SourceCommitResult): SourceCommitResult => Object.freeze({
  ...result,
  ...('beforeBasis' in result && result.beforeBasis !== undefined ? {
    beforeBasis: result.beforeBasis,
    ...(result.afterBasis === undefined ? {} : { afterBasis: result.afterBasis })
  } : {}),
  issues: Object.freeze([...result.issues])
});

const coreCommitResult = (result: AutomergeSourceCommitResult): SourceCommitResult => frozenCoreCommitResult({
  outcome: result.outcome,
  ...('beforeBasis' in result ? { beforeBasis: result.beforeBasis, afterBasis: result.afterBasis } : {}),
  issues: result.issues.map((issue) => adapterIssue(
    issue.code,
    issue.phase,
    issue.sourceId,
    undefined,
    issue.operationId,
    issue.details
  ))
});

const projectionIssue = (issue: AutomergeProjectionIssue, sourceId: string, relationId: string, phase: 'query' | 'plan'): Issue =>
  adapterIssue(issue.code, phase, sourceId, relationId, undefined, issue.details, issue.path);

const adapterIssue = (
  code: string,
  phase: 'load' | 'query' | 'plan' | 'commit',
  sourceId: string,
  relationId?: string,
  operationId?: string,
  details?: unknown,
  path?: readonly unknown[]
): Issue => createIssue({
  code,
  phase,
  severity: phase === 'query' && (code.includes('conflict') || code.includes('ambiguous')) ? 'warning' : 'error',
  retry: adapterRetry(code, phase),
  sourceId,
  ...(relationId === undefined ? {} : { relationId }),
  ...(operationId === undefined ? {} : { operationId }),
  ...(details === undefined ? {} : { details }),
  ...(path === undefined ? {} : { path })
});

const sourceStateIssue = (sourceId: string, state: SourceLifecycleState): Issue => createIssue({
  code: state === 'closed' ? 'source.closed' : 'source.not_ready',
  phase: state === 'closed' ? 'lifecycle' : 'load',
  severity: 'error',
  retry: state === 'closed' ? 'never' : 'after_refresh',
  sourceId,
  details: { state }
});

const parseAutomergeBasis = (value: unknown): AutomergeBasis | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { readonly kind?: unknown; readonly heads?: unknown };
  if (candidate.kind !== 'automerge-heads' || !Array.isArray(candidate.heads) || candidate.heads.some((head) => typeof head !== 'string')) return undefined;
  return { kind: 'automerge-heads', heads: [...new Set(candidate.heads as string[])].sort() };
};

const sameIssues = (left: readonly Issue[], right: readonly Issue[]): boolean => samePortableJson(left, right);

const mapKeyFromLogicalKey = (key: JsonValue): string | undefined =>
  Array.isArray(key) && key.length === 1 && typeof key[0] === 'string' ? key[0] : undefined;

const validSplice = (index: number, deleteCount: number, length: number): boolean =>
  Number.isSafeInteger(index) && Number.isSafeInteger(deleteCount) && index >= 0 && deleteCount >= 0 && index <= length && index + deleteCount <= length;

const firstConflictPath = (doc: object, path: AutomergePath): AutomergePath | undefined => {
  for (let index = 0; index < path.length; index += 1) {
    const owner = valueAtAutomergePath(doc, path.slice(0, index));
    if (owner === null || typeof owner !== 'object') return undefined;
    if (Array.isArray(owner)) continue;
    if (conflictsAt(owner, path[index]!).length > 1) return path.slice(0, index + 1);
  }
  return undefined;
};

const unsupportedEditIssue = (sourceId: string, relationId: string, capability: CapabilityRef, reason: string): Issue => createIssue({
  code: 'transaction.capability_unavailable',
  sourceId,
  relationId,
  requiredCapabilities: [capability],
  retry: 'after_capability',
  details: { reason }
});

const copyPortableValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyPortableValue);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyPortableValue(child)]));
};

const assertNever = (value: never): never => { throw new TypeError('Unsupported Automerge edit: ' + String(value)); };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const adapterRetry = (code: string, phase: 'load' | 'query' | 'plan' | 'commit'): NonNullable<Issue['retry']> => {
  if (code === 'transaction.operation_id_ambiguous') return 'never';
  if (code === 'transaction.expected_basis_stale' || code === 'transaction.conflict_observation_stale' || code.startsWith('mapping.locator_')) return 'after_refresh';
  if (code.includes('conflict') || code.includes('ambiguous')) return 'manual_repair';
  return phase === 'load' ? 'after_refresh' : 'after_input';
};
