import { detachAndFreezeJsonValue } from '../../internal-owned-json.js';
import { ownedReadonlyMap } from '../../internal-owned-map.js';
import { isPreparedPlan } from './prepared-plan.js';
import { defaultValueParseBudget, logicalUnknown, safeParseJsonValue, type JsonValue } from '../../value.js';
import type {
  Completeness,
  Expr,
  FunctionRegistry,
  QueryLogicalValue,
  QueryNode,
  QueryRecord,
  QueryRequest,
  RelationInput,
  RelationUse
} from '../model.js';
import type {
  OwnedQueryMaintenanceSnapshot,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  RelationInputChange,
  RelationRowChange
} from '../incremental-model.js';

const ownedMaintenanceSnapshots = new WeakSet<object>();
const ownedMaintenanceUpdates = new WeakSet<object>();
const ownedQueryLogicalContainers = new WeakSet<object>();
const ownedOccurrenceIdentities = new WeakSet<object>();

/** Ownership evidence for values already detached at a query input boundary. */
export const isOwnedQueryLogicalContainer = (value: object): boolean =>
  ownedQueryLogicalContainers.has(value);

/** Seals a logical container assembled exclusively from already-owned values. */
export const sealOwnedQueryLogicalContainer = <Value extends object>(value: Value): Value => {
  if (!Object.isFrozen(value)) throw new TypeError('Owned query logical container must be frozen');
  ownedQueryLogicalContainers.add(value);
  return value;
};

/** Freezes a trusted scope assembled from already-owned records. */
export const sealOwnedQueryScope = <Value extends Readonly<Record<string, QueryRecord>>>(value: Value): Value => {
  return Object.freeze(value);
};

/** Marks an internally detached, deeply frozen update for reuse across runtime shells. */
export const sealOwnedQueryMaintenanceUpdate = (update: QueryMaintenanceUpdate): QueryMaintenanceUpdate => {
  if (!Object.isFrozen(update)) throw new TypeError('Owned query maintenance update must be frozen');
  ownedMaintenanceUpdates.add(update);
  return update;
};

export const cloneAndFreezeQueryAst = (root: QueryNode): QueryNode => {
  const parsed = safeParseJsonValue(root, { ...defaultValueParseBudget, maxDepth: 1_024 });
  if (!parsed.success) throw new TypeError('Query AST must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  return freezePortableValue(parsed.value) as QueryNode;
};

export const cloneAndFreezeExpression = (expression: Expr): Expr => {
  const parsed = safeParseJsonValue(expression, { ...defaultValueParseBudget, maxDepth: 1_024 });
  if (!parsed.success) throw new TypeError('Query expression must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  return freezePortableValue(parsed.value) as Expr;
};

export const freezePortableValue = <Value extends JsonValue>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezePortableValue(item);
  } else {
    for (const item of Object.values(value)) freezePortableValue(item);
  }
  return Object.freeze(value);
};

export const adoptJsonValue = (input: unknown, label: string): JsonValue => {
  const parsed = detachAndFreezeJsonValue(input);
  if (!parsed.success) throw new TypeError(label + ' must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  return parsed.value;
};

export const adoptJsonRecord = (input: unknown, label: string): Readonly<Record<string, JsonValue>> => {
  const value = adoptJsonValue(input, label);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new TypeError(label + ' must be a portable record');
  return value as Readonly<Record<string, JsonValue>>;
};

/** Detaches registry membership while preserving the identity of opaque implementations. */
export const adoptFunctionRegistry = (registry: FunctionRegistry): FunctionRegistry => ownedReadonlyMap(registry);

const forbiddenQueryKeys = new Set(['__proto__', 'constructor', 'prototype']);

const adoptQueryLogicalValue = (input: unknown, label: string): QueryLogicalValue => {
  if (input !== null && typeof input === 'object' && ownedQueryLogicalContainers.has(input)) {
    return input as QueryLogicalValue;
  }
  const seen = new Set<object>();
  let totalMembers = 0;
  const visit = (value: unknown, depth: number): QueryLogicalValue => {
    if (value === logicalUnknown) return logicalUnknown;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(label + ' contains a non-finite number');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') throw new TypeError(label + ' contains a non-portable value');
    if (depth > defaultValueParseBudget.maxDepth) throw new TypeError(label + ' exceeds the maximum depth');
    if (seen.has(value)) throw new TypeError(label + ' contains a cycle');
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError(label + ' contains a symbol key');
      if (Array.isArray(value)) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > defaultValueParseBudget.maxArrayMembers) throw new TypeError(label + ' contains an invalid or oversized array');
        totalMembers += length;
        if (totalMembers > defaultValueParseBudget.maxTotalMembers) throw new TypeError(label + ' exceeds the total-member budget');
        const output: QueryLogicalValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
          output.push(visit(descriptor.value, depth + 1));
        }
        const owned = Object.freeze(output);
        ownedQueryLogicalContainers.add(owned);
        return owned;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(label + ' contains a hostile prototype');
      if (keys.length > defaultValueParseBudget.maxObjectMembers) throw new TypeError(label + ' exceeds the object-member budget');
      totalMembers += keys.length;
      if (totalMembers > defaultValueParseBudget.maxTotalMembers) throw new TypeError(label + ' exceeds the total-member budget');
      const output: Record<string, QueryLogicalValue> = {};
      for (const key of keys as string[]) {
        if (forbiddenQueryKeys.has(key)) throw new TypeError(label + ' contains a prototype-pollution key');
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile object descriptor');
        output[key] = visit(descriptor.value, depth + 1);
      }
      const owned = Object.freeze(output);
      ownedQueryLogicalContainers.add(owned);
      return owned;
    } finally {
      seen.delete(value);
    }
  };
  return visit(input, 0);
};

export const adoptQueryRecord = (input: unknown, label = 'Query row'): QueryRecord => {
  const value = adoptQueryLogicalValue(input, label);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new TypeError(label + ' must be a portable record');
  return value as QueryRecord;
};

export const adoptExpressionScope = (scope: Readonly<Record<string, QueryRecord>>): Readonly<Record<string, QueryRecord>> => {
  const descriptors = inspectOwnedDataRecord(scope, 'Query expression scope', { allowSymbols: true });
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([alias, descriptor]) => [alias, adoptQueryRecord(descriptor.value, 'Query expression row')])));
};

const adoptStringArray = (input: readonly string[], label: string): readonly string[] => {
  if (!Array.isArray(input)) throw new TypeError(label + ' must be an array');
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    const length = lengthDescriptor?.value;
    if (typeof length !== 'number'
      || !Number.isSafeInteger(length)
      || length < 0) {
      throw new TypeError(label + ' contains a hostile length');
    }
    const values: string[] = [];
    values.length = length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || typeof descriptor.value !== 'string') {
        throw new TypeError(label + ' contains a hostile array descriptor');
      }
      values[index] = descriptor.value;
    }
    return Object.freeze(values);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(label + ' could not be inspected', { cause: error });
  }
};

/** Descriptor-safe ownership for capture-frame occurrence identity. */
export const adoptQueryOccurrenceIds = (input: readonly string[]): readonly string[] => {
  if (ownedOccurrenceIdentities.has(input)) return input;
  const owned = adoptStringArray(input, 'Query occurrence identities');
  ownedOccurrenceIdentities.add(owned);
  return owned;
};

/** Builds trusted occurrence identity without re-inspecting an intermediate caller-owned array. */
export const createQueryOccurrenceIds = <Row>(
  rows: readonly Row[],
  identity: (row: Row, index: number) => string
): readonly string[] => {
  const output: string[] = [];
  output.length = rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    const value = identity(rows[index] as Row, index);
    if (typeof value !== 'string') throw new TypeError('Query occurrence identity must be a string');
    output[index] = value;
  }
  Object.freeze(output);
  ownedOccurrenceIdentities.add(output);
  return output;
};

const adoptRelationInput = (input: RelationInput): RelationInput => {
  const descriptors = inspectOwnedDataRecord(input, 'Query relation input', { allowSymbols: true });
  const occurrenceIds = ownedDataValue(descriptors, 'occurrenceIds');
  const sourceId = ownedDataValue(descriptors, 'sourceId');
  const attachmentId = ownedDataValue(descriptors, 'attachmentId');
  const basis = ownedDataValue(descriptors, 'basis');
  return Object.freeze({
    relation: adoptJsonValue(ownedDataValue(descriptors, 'relation'), 'Query relation') as unknown as RelationUse,
    rows: Object.freeze(inspectOwnedArray(ownedDataValue(descriptors, 'rows'), 'Query relation rows', { allowSymbols: true }).map((row) => adoptQueryRecord(row))),
    ...(occurrenceIds === undefined ? {} : { occurrenceIds: adoptQueryOccurrenceIds(occurrenceIds as readonly string[]) }),
    completeness: adoptCompleteness(ownedDataValue(descriptors, 'completeness'), 'Query relation input'),
    ...(sourceId === undefined ? {} : { sourceId: adoptOptionalString(sourceId, 'Query relation sourceId') }),
    ...(attachmentId === undefined ? {} : { attachmentId: adoptOptionalString(attachmentId, 'Query relation attachmentId') }),
    ...(basis === undefined ? {} : { basis: adoptJsonValue(basis, 'Query relation basis') })
  });
};

const adoptMaintenanceSnapshotDescriptors = (descriptors: OwnedDataRecord): QueryMaintenanceSnapshot => {
  const parameters = ownedDataValue(descriptors, 'parameters');
  const functions = ownedDataValue(descriptors, 'functions');
  const basis = ownedDataValue(descriptors, 'basis');
  const membershipRevision = ownedDataValue(descriptors, 'membershipRevision');
  const executionBudget = ownedDataValue(descriptors, 'executionBudget');
  return Object.freeze({
    relations: Object.freeze(inspectOwnedArray(ownedDataValue(descriptors, 'relations'), 'Query relations', { allowSymbols: true }).map((input) => adoptRelationInput(input as RelationInput))),
    ...(parameters === undefined ? {} : { parameters: adoptJsonRecord(parameters, 'Query parameters') }),
    ...(functions === undefined ? {} : { functions: adoptFunctionRegistry(functions as FunctionRegistry) }),
    ...(basis === undefined ? {} : { basis: adoptJsonValue(basis, 'Query basis') }),
    ...(membershipRevision === undefined ? {} : { membershipRevision: adoptOptionalIndex(membershipRevision, 'Query membership revision') }),
    ...(executionBudget === undefined ? {} : { executionBudget: adoptExecutionBudget(executionBudget) })
  });
};

export const adoptMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): OwnedQueryMaintenanceSnapshot => {
  if (ownedMaintenanceSnapshots.has(snapshot)) return snapshot as OwnedQueryMaintenanceSnapshot;
  const owned = adoptMaintenanceSnapshotDescriptors(
    inspectOwnedDataRecord(snapshot, 'Query maintenance snapshot', { allowSymbols: true })
  ) as OwnedQueryMaintenanceSnapshot;
  ownedMaintenanceSnapshots.add(owned);
  return owned;
};

const adoptExecutionBudget = (budget: unknown): { readonly maxWorkUnits: number } => {
  const descriptors = inspectOwnedDataRecord(budget, 'Query execution budget');
  if (Reflect.ownKeys(descriptors).length !== 1 || !Object.hasOwn(descriptors, 'maxWorkUnits')) throw new TypeError('Query execution budget must contain exactly maxWorkUnits');
  const maxWorkUnits = adoptOptionalIndex(ownedDataValue(descriptors, 'maxWorkUnits'), 'Query execution budget maxWorkUnits');
  if (maxWorkUnits < 0) throw new TypeError('Query execution budget maxWorkUnits must be non-negative');
  return Object.freeze({ maxWorkUnits });
};

type OwnedDataRecord = Readonly<Record<string, PropertyDescriptor>>;
type OwnedInspectionOptions = { readonly allowSymbols?: boolean };

const inspectOwnedDataRecord = (input: unknown, label: string, options: OwnedInspectionOptions = {}): OwnedDataRecord => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(label + ' must be a plain record');
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(label + ' contains a hostile prototype');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') {
        if (options.allowSymbols === true) continue;
        throw new TypeError(label + ' contains a symbol key');
      }
      if (forbiddenQueryKeys.has(key)) throw new TypeError(label + ' contains a prototype-pollution key');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile object descriptor');
    }
    return descriptors;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(label + ' could not be inspected', { cause: error });
  }
};

const ownedDataValue = (descriptors: OwnedDataRecord, key: string): unknown => descriptors[key]?.value;

const inspectOwnedArray = (input: unknown, label: string, options: OwnedInspectionOptions = {}): readonly unknown[] => {
  if (!Array.isArray(input)) throw new TypeError(label + ' must be an array');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input) as Readonly<Record<string, PropertyDescriptor>>;
    const length = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError(label + ' contains a hostile length');
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') {
        if (options.allowSymbols === true) continue;
        throw new TypeError(label + ' contains a symbol key');
      }
      if (key === 'length' || /^(0|[1-9][0-9]*)$/.test(key)) continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
    }
    const output: unknown[] = [];
    output.length = length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
      output[index] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(label + ' could not be inspected', { cause: error });
  }
};

const adoptOptionalIndex = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(label + ' must be a safe integer');
  return value;
};

const adoptOptionalString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string');
  return value;
};

const adoptCompleteness = (value: unknown, label: string): Completeness => {
  if (value !== 'exact' && value !== 'lower-bound' && value !== 'unknown') throw new TypeError(label + ' has invalid completeness');
  return value;
};

const adoptIndexedQueryRow = (input: unknown, label: string): NonNullable<RelationRowChange['before']> => {
  const descriptors = inspectOwnedDataRecord(input, label);
  return Object.freeze({
    index: adoptOptionalIndex(ownedDataValue(descriptors, 'index'), label + ' index'),
    row: adoptQueryRecord(ownedDataValue(descriptors, 'row'), label + ' row')
  });
};

const adoptRelationChangeState = (input: unknown, label: string): NonNullable<RelationInputChange['before']> => {
  const descriptors = inspectOwnedDataRecord(input, label);
  const basis = ownedDataValue(descriptors, 'basis');
  return Object.freeze({
    index: adoptOptionalIndex(ownedDataValue(descriptors, 'index'), label + ' index'),
    completeness: adoptCompleteness(ownedDataValue(descriptors, 'completeness'), label),
    ...(basis === undefined ? {} : { basis: adoptJsonValue(basis, label + ' basis') })
  });
};

const adoptRelationRowChange = (input: unknown): RelationRowChange => {
  const descriptors = inspectOwnedDataRecord(input, 'Query row change');
  const before = ownedDataValue(descriptors, 'before');
  const after = ownedDataValue(descriptors, 'after');
  return Object.freeze({
    occurrenceId: adoptOptionalString(ownedDataValue(descriptors, 'occurrenceId'), 'Query row change occurrenceId'),
    ...(before === undefined ? {} : { before: adoptIndexedQueryRow(before, 'Query row change before') }),
    ...(after === undefined ? {} : { after: adoptIndexedQueryRow(after, 'Query row change after') })
  });
};

const adoptRelationInputChange = (input: unknown): RelationInputChange => {
  const descriptors = inspectOwnedDataRecord(input, 'Query relation change');
  const sourceId = ownedDataValue(descriptors, 'sourceId');
  const attachmentId = ownedDataValue(descriptors, 'attachmentId');
  const before = ownedDataValue(descriptors, 'before');
  const after = ownedDataValue(descriptors, 'after');
  return Object.freeze({
    relation: adoptJsonValue(ownedDataValue(descriptors, 'relation'), 'Changed query relation') as unknown as RelationUse,
    ...(sourceId === undefined ? {} : { sourceId: adoptOptionalString(sourceId, 'Query relation change sourceId') }),
    ...(attachmentId === undefined ? {} : { attachmentId: adoptOptionalString(attachmentId, 'Query relation change attachmentId') }),
    ...(before === undefined ? {} : { before: adoptRelationChangeState(before, 'Query relation change before') }),
    ...(after === undefined ? {} : { after: adoptRelationChangeState(after, 'Query relation change after') }),
    rows: Object.freeze(inspectOwnedArray(ownedDataValue(descriptors, 'rows'), 'Query relation row changes').map(adoptRelationRowChange))
  });
};

export const adoptQueryMaintenanceUpdate = (input: QueryMaintenanceUpdate): QueryMaintenanceUpdate => {
  if (ownedMaintenanceUpdates.has(input)) return input;
  const descriptors = inspectOwnedDataRecord(input, 'Query maintenance update');
  const expectedBasis = ownedDataValue(descriptors, 'expectedBasis');
  const basis = ownedDataValue(descriptors, 'basis');
  const expectedMembershipRevision = ownedDataValue(descriptors, 'expectedMembershipRevision');
  const membershipRevision = ownedDataValue(descriptors, 'membershipRevision');
  const owned = Object.freeze({
    ...(expectedBasis === undefined ? {} : { expectedBasis: adoptJsonValue(expectedBasis, 'Expected query basis') }),
    ...(basis === undefined ? {} : { basis: adoptJsonValue(basis, 'Changed query basis') }),
    ...(expectedMembershipRevision === undefined ? {} : { expectedMembershipRevision: adoptOptionalIndex(expectedMembershipRevision, 'Expected membership revision') }),
    ...(membershipRevision === undefined ? {} : { membershipRevision: adoptOptionalIndex(membershipRevision, 'Changed membership revision') }),
    relations: Object.freeze(inspectOwnedArray(ownedDataValue(descriptors, 'relations'), 'Query relation changes').map(adoptRelationInputChange))
  });
  ownedMaintenanceUpdates.add(owned);
  return owned;
};

export const adoptQueryRequest = (
  request: QueryRequest
): QueryRequest => {
  const descriptors = inspectOwnedDataRecord(request, 'Query request', { allowSymbols: true });
  const root = ownedDataValue(descriptors, 'root');
  return Object.freeze({
    root: isPreparedPlan<QueryNode>(root)
      ? root
      : cloneAndFreezeQueryAst(root as QueryNode),
    ...adoptMaintenanceSnapshotDescriptors(descriptors)
  });
};
