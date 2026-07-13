import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { ownedReadonlyMap } from './internal-owned-map.js';
import { defaultValueParseBudget, logicalUnknown, safeParseJsonValue, type JsonValue } from './value.js';
import type {
  Completeness,
  Expr,
  FunctionRegistry,
  QueryLogicalValue,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  QueryNode,
  QueryRecord,
  QueryRequest,
  RelationInput,
  RelationInputChange,
  RelationRowChange,
  RelationUse
} from './query.js';

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
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError(label + ' contains a symbol key');
      if (Array.isArray(value)) {
        if (value.length > defaultValueParseBudget.maxArrayMembers) throw new TypeError(label + ' exceeds the array-member budget');
        totalMembers += value.length;
        if (totalMembers > defaultValueParseBudget.maxTotalMembers) throw new TypeError(label + ' exceeds the total-member budget');
        const output: QueryLogicalValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
          output.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(output);
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
      return Object.freeze(output);
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

export const adoptExpressionScope = (scope: Readonly<Record<string, QueryRecord>>): Readonly<Record<string, QueryRecord>> => Object.freeze(
  Object.fromEntries(Object.entries(scope).map(([alias, row]) => [alias, adoptQueryRecord(row, 'Query expression row')]))
);

const adoptStringArray = (input: readonly string[], label: string): readonly string[] => {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError(label + ' contains a hostile value');
    output.push(descriptor.value);
  }
  return Object.freeze(output);
};

/** Descriptor-safe ownership for capture-frame occurrence identity. */
export const adoptQueryOccurrenceIds = (input: readonly string[]): readonly string[] =>
  adoptStringArray(input, 'Query occurrence identities');

const adoptRelationInput = (input: RelationInput): RelationInput => Object.freeze({
  relation: adoptJsonValue(input.relation, 'Query relation') as unknown as RelationUse,
  rows: Object.freeze(input.rows.map((row) => adoptQueryRecord(row))),
  ...(input.occurrenceIds === undefined ? {} : { occurrenceIds: adoptStringArray(input.occurrenceIds, 'Query occurrence identities') }),
  completeness: input.completeness,
  ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
  ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
  ...(input.basis === undefined ? {} : { basis: adoptJsonValue(input.basis, 'Query relation basis') })
});

export const adoptMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): QueryMaintenanceSnapshot => Object.freeze({
  relations: Object.freeze(snapshot.relations.map(adoptRelationInput)),
  ...(snapshot.parameters === undefined ? {} : { parameters: adoptJsonRecord(snapshot.parameters, 'Query parameters') }),
  ...(snapshot.functions === undefined ? {} : { functions: adoptFunctionRegistry(snapshot.functions) }),
  ...(snapshot.basis === undefined ? {} : { basis: adoptJsonValue(snapshot.basis, 'Query basis') }),
  ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision }),
  ...(snapshot.executionBudget === undefined ? {} : { executionBudget: adoptExecutionBudget(snapshot.executionBudget) })
});

const adoptExecutionBudget = (budget: unknown): { readonly maxWorkUnits: number } => {
  const descriptors = inspectOwnedDataRecord(budget, 'Query execution budget');
  if (Reflect.ownKeys(descriptors).length !== 1 || !Object.hasOwn(descriptors, 'maxWorkUnits')) throw new TypeError('Query execution budget must contain exactly maxWorkUnits');
  const maxWorkUnits = adoptOptionalIndex(ownedDataValue(descriptors, 'maxWorkUnits'), 'Query execution budget maxWorkUnits');
  if (maxWorkUnits < 0) throw new TypeError('Query execution budget maxWorkUnits must be non-negative');
  return Object.freeze({ maxWorkUnits });
};

type OwnedDataRecord = Readonly<Record<string, PropertyDescriptor>>;

const inspectOwnedDataRecord = (input: unknown, label: string): OwnedDataRecord => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(label + ' must be a plain record');
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(label + ' contains a hostile prototype');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new TypeError(label + ' contains a symbol key');
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

const inspectOwnedArray = (input: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(input)) throw new TypeError(label + ' must be an array');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const length = (Reflect.get(descriptors, 'length') as PropertyDescriptor | undefined)?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError(label + ' contains a hostile length');
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new TypeError(label + ' contains a symbol key');
      if (key === 'length' || /^(0|[1-9][0-9]*)$/.test(key)) continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
    }
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' contains a hostile array descriptor');
      output.push(descriptor.value);
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
  const descriptors = inspectOwnedDataRecord(input, 'Query maintenance update');
  const expectedBasis = ownedDataValue(descriptors, 'expectedBasis');
  const basis = ownedDataValue(descriptors, 'basis');
  const expectedMembershipRevision = ownedDataValue(descriptors, 'expectedMembershipRevision');
  const membershipRevision = ownedDataValue(descriptors, 'membershipRevision');
  return Object.freeze({
    ...(expectedBasis === undefined ? {} : { expectedBasis: adoptJsonValue(expectedBasis, 'Expected query basis') }),
    ...(basis === undefined ? {} : { basis: adoptJsonValue(basis, 'Changed query basis') }),
    ...(expectedMembershipRevision === undefined ? {} : { expectedMembershipRevision: adoptOptionalIndex(expectedMembershipRevision, 'Expected membership revision') }),
    ...(membershipRevision === undefined ? {} : { membershipRevision: adoptOptionalIndex(membershipRevision, 'Changed membership revision') }),
    relations: Object.freeze(inspectOwnedArray(ownedDataValue(descriptors, 'relations'), 'Query relation changes').map(adoptRelationInputChange))
  });
};

export const adoptQueryRequest = (request: QueryRequest): QueryRequest => ({
  root: cloneAndFreezeQueryAst(request.root),
  ...adoptMaintenanceSnapshot(request)
});
