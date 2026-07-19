import type { ArtifactRef } from '../artifacts.js';
import { canonicalizeJson } from '../canonical-json.js';
import { capabilityRefKey, createIssue, type CapabilityRef, type Issue } from '../issues.js';
import type { WritableLogicalState } from '../logical-edit.js';
import { evaluateQuery } from '../query/evaluate.js';
import { createQueryOccurrenceIds } from '../query/internal/occurrence-identity.js';
import type { FunctionRegistry, QueryNode, QueryRecord, RelationInput } from '../query/model.js';
import type { CapabilityRegistry } from '../registry.js';
import type { SourceBasis } from '../source-state.js';
import { safeParseJsonValue, type JsonValue } from '../value.js';
import type { AttachmentConstraintQuery } from './preparation.js';

/** Standard pure constraint executor for a projected logical attachment state. */
export const createLogicalConstraintQuery = (input: {
  readonly schemaView: ArtifactRef;
  readonly relationIds: readonly string[];
  readonly registry: CapabilityRegistry;
  readonly sourceId: string;
  readonly attachmentId: string;
}): AttachmentConstraintQuery<WritableLogicalState> => {
  const relationIds = Object.freeze([...new Set(input.relationIds)]);
  const functionsByQuery = new WeakMap<object, { readonly registryRevision: number; readonly functions: FunctionRegistry }>();
  const relationsByState = new WeakMap<WritableLogicalState, {
    readonly basis: SourceBasis;
    readonly relations: readonly RelationInput[];
  }>();
  return (query, state, basis) => {
    try {
      const result = evaluateQuery({
        root: query as QueryNode,
        relations: cachedLogicalRelationInputs(
          state,
          basis,
          relationsByState,
          relationIds,
          input.schemaView,
          input.sourceId,
          input.attachmentId
        ),
        functions: cachedQueryFunctions(query, input.registry, functionsByQuery),
        basis,
        executionBudget: standardConstraintExecutionBudget
      });
      if (result.completeness !== 'exact') {
        return { rows: [], completeness: result.completeness, issues: result.issues };
      }
      return adoptConstraintRows(result.rows, result.issues);
    } catch (error) {
      return {
        rows: [],
        completeness: 'unknown',
        issues: [constraintQueryIssue('execution_failed', error)]
      };
    }
  };
};

const cachedLogicalRelationInputs = (
  state: WritableLogicalState,
  basis: SourceBasis,
  cache: WeakMap<WritableLogicalState, { readonly basis: SourceBasis; readonly relations: readonly RelationInput[] }>,
  relationIds: readonly string[],
  schemaView: ArtifactRef,
  sourceId: string,
  attachmentId: string
): readonly RelationInput[] => {
  const cached = cache.get(state);
  if (cached !== undefined && Object.is(cached.basis, basis)) return cached.relations;
  const relations = logicalRelationInputs(state, relationIds, schemaView, basis, sourceId, attachmentId);
  cache.set(state, { basis, relations });
  return relations;
};

const cachedQueryFunctions = (
  query: JsonValue,
  registry: CapabilityRegistry,
  cache: WeakMap<object, { readonly registryRevision: number; readonly functions: FunctionRegistry }>
): FunctionRegistry => {
  if (!isRecord(query)) return queryFunctions(query, registry);
  const cached = cache.get(query);
  if (cached?.registryRevision === registry.revision) return cached.functions;
  const functions = queryFunctions(query, registry);
  cache.set(query, { registryRevision: registry.revision, functions });
  return functions;
};

const logicalRelationInputs = (
  state: WritableLogicalState,
  relationIds: readonly string[],
  schemaView: ArtifactRef,
  basis: SourceBasis,
  sourceId: string,
  attachmentId: string
): readonly RelationInput[] => {
  const rows = new Map(relationIds.map((relationId) => [relationId, [] as typeof state.rows[number][]]));
  for (const row of state.rows) rows.get(row.relationId)?.push(row);
  return Object.freeze(relationIds.map((relationId) => {
    const relationRows = rows.get(relationId) ?? [];
    return Object.freeze({
      relation: Object.freeze({ schemaView, relationId }),
      rows: Object.freeze(relationRows.map(({ fields }) => fields as QueryRecord)),
      occurrenceIds: createQueryOccurrenceIds(relationRows, ({ locator }) => canonicalizeJson([relationId, locator])),
      completeness: 'exact',
      sourceId,
      attachmentId,
      basis
    });
  }));
};

const adoptConstraintRows = (
  records: readonly QueryRecord[],
  issues: readonly Issue[]
): ReturnType<AttachmentConstraintQuery<WritableLogicalState>> => {
  const rows: { readonly subject: JsonValue; readonly evidence?: JsonValue; readonly details?: JsonValue }[] = [];
  for (const record of records) {
    const parsed = safeParseJsonValue(record);
    if (!parsed.success || !isRecord(parsed.value) || !Object.hasOwn(parsed.value, 'subject')) {
      return {
        rows: [],
        completeness: 'unknown',
        issues: [...issues, ...(!parsed.success ? parsed.issues : [constraintQueryIssue('row_shape')])]
      };
    }
    rows.push(Object.freeze({
      subject: parsed.value.subject as JsonValue,
      ...(parsed.value.evidence === undefined ? {} : { evidence: parsed.value.evidence }),
      ...(parsed.value.details === undefined ? {} : { details: parsed.value.details })
    }));
  }
  return { rows: Object.freeze(rows), completeness: 'exact', issues };
};

const queryFunctions = (query: JsonValue, registry: CapabilityRegistry): FunctionRegistry => {
  const references = new Map<string, CapabilityRef>();
  collectFunctionReferences(query, references);
  const functions = new Map<string, (args: readonly JsonValue[]) => JsonValue>();
  for (const [key, reference] of references) {
    const implementation = registry.implementation(reference)?.implementation;
    if (typeof implementation === 'function') {
      functions.set(key, implementation as (args: readonly JsonValue[]) => JsonValue);
    }
  }
  return functions;
};

const collectFunctionReferences = (value: JsonValue, output: Map<string, CapabilityRef>): void => {
  if (Array.isArray(value)) {
    for (const child of value) collectFunctionReferences(child, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value.kind === 'call' && isCapabilityRef(value.capability)) {
    output.set(capabilityRefKey(value.capability), value.capability);
  }
  for (const child of Object.values(value)) collectFunctionReferences(child as JsonValue, output);
};

const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value)
  && typeof value.id === 'string'
  && typeof value.version === 'string'
  && typeof value.contractHash === 'string';

const constraintQueryIssue = (reason: string, error?: unknown): Issue => createIssue({
  code: 'constraint.query_indeterminate',
  phase: 'constraint',
  retry: 'after_input',
  details: { reason, ...(error === undefined ? {} : { error: error instanceof Error ? error.name : typeof error }) }
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const standardConstraintExecutionBudget = Object.freeze({ maxWorkUnits: 1_000_000 });
