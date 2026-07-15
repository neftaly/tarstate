import type { ArtifactRef } from './artifacts.js';
import type { CapabilityRef } from './issues.js';
import {
  checkSemanticNameBudget as checkNameBudget,
  enterSemanticNode as enter,
  isSemanticRecord as isRecord,
  semanticArtifactRefKey as refKey,
  semanticCapabilityRefKey as capabilityKey,
  semanticEnumValue as enumValue,
  semanticInvalid as invalid,
  semanticNonEmptyString as nonEmptyString,
  semanticNonNegativeInteger as nonNegativeInteger,
  semanticOptionalNonNegativeInteger as optionalNonNegativeInteger,
  semanticOptionalPositiveInteger as optionalPositiveInteger,
  semanticSetEqual as setEqual,
  semanticShape as shape,
  semanticStringArray as stringArray,
  semanticUnion as union,
  validateSemanticArtifactRef as validateArtifactRef,
  validateSemanticCapabilityRef as validateCapabilityRef,
  type SemanticRecord as RecordValue,
  type SemanticValidationContext as ValidationContext
} from './internal-semantic-artifact-validation.js';
import type { JsonValue } from './value.js';

const unaryQueryKinds = [
  'where',
  'select',
  'with-fields',
  'rename',
  'omit',
  'unnest',
  'aggregate',
  'distinct',
  'order',
  'slice',
  'window',
  'seek'
];

export const validateQueryArtifactBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(
    context,
    body,
    ['schemaViews', 'parameters', 'root', 'requiredCapabilities'],
    [],
    ['body']
  )) {
    return false;
  }
  const value = body as RecordValue;
  const schemaViews = validateUniqueRefs(context, value.schemaViews, ['body', 'schemaViews']);
  const capabilities = validateUniqueCapabilities(
    context,
    value.requiredCapabilities,
    ['body', 'requiredCapabilities']
  );
  const parameterCapabilities = new Map<string, CapabilityUse>();
  const parameters = validateParameterDeclarations(
    context,
    value.parameters,
    ['body', 'parameters'],
    parameterCapabilities
  );
  const state = createQueryValidationState({
    parameters,
    schemaViews,
    requiredCapabilities: capabilities
  });
  validateQueryNode(context, value.root, ['body', 'root'], new Set(), state, 0);
  for (const [key, use] of parameterCapabilities) state.usedCapabilities.set(key, use);
  reportUndeclaredCapabilities(context, state);
  return context.issues.length === 0;
};

type CapabilityUse = { readonly ref: CapabilityRef; readonly path: readonly unknown[] };
export type QueryValidationState = {
  readonly parameters: ReadonlySet<string>;
  readonly schemaViews: ReadonlyMap<string, ArtifactRef>;
  readonly requiredCapabilities: ReadonlyMap<string, CapabilityRef>;
  readonly usedCapabilities: Map<string, CapabilityUse>;
  readonly recursions: Map<string, ReadonlySet<string>>;
};

export const createQueryValidationState = (input: {
  readonly parameters: ReadonlySet<string>;
  readonly schemaViews: ReadonlyMap<string, ArtifactRef>;
  readonly requiredCapabilities: ReadonlyMap<string, CapabilityRef>;
}): QueryValidationState => ({
  ...input,
  usedCapabilities: new Map(),
  recursions: new Map()
});

export const reportUndeclaredCapabilities = (
  context: ValidationContext,
  state: QueryValidationState
): void => {
  for (const [key, use] of state.usedCapabilities) {
    if (!state.requiredCapabilities.has(key)) {
      invalid(context, use.path, 'undeclared_capability', { capability: use.ref });
    }
  }
};

export const validateQueryNode = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  outer: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): ReadonlySet<string> => {
  if (!enter(context, path, depth)) return new Set();
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'query_node_shape');
    return new Set();
  }
  const node = input;
  if (node.kind === 'from') {
    shape(context, node, ['kind', 'relation', 'alias'], [], path);
    const relation = validateRelationUse(context, node.relation, [...path, 'relation']);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (
      relation !== undefined
      && state.schemaViews.get(refKey(relation.schemaView)) === undefined
    ) {
      invalid(context, [...path, 'relation', 'schemaView'], 'undeclared_schema_view');
    }
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'values') {
    shape(context, node, ['kind', 'alias', 'rows'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (!Array.isArray(node.rows) || node.rows.some((row) => !isRecord(row))) {
      invalid(context, [...path, 'rows'], 'record_rows_required');
    }
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'recursion-ref') {
    shape(context, node, ['kind', 'name'], [], path);
    const name = nonEmptyString(context, node.name, [...path, 'name']);
    const aliases = name === undefined ? undefined : state.recursions.get(name);
    if (aliases === undefined) invalid(context, [...path, 'name'], 'recursion_reference_unbound');
    return aliases ?? new Set();
  }
  if (node.kind === 'recursive') {
    shape(context, node, ['kind', 'name', 'seed', 'step', 'key'], ['maxIterations', 'maxRows'], path);
    const name = nonEmptyString(context, node.name, [...path, 'name']);
    const seed = validateQueryNode(context, node.seed, [...path, 'seed'], outer, state, depth + 1);
    const ownsRecursionBinding = name !== undefined && !state.recursions.has(name);
    if (name !== undefined && !ownsRecursionBinding) {
      invalid(context, [...path, 'name'], 'duplicate_recursion_name');
    }
    if (name !== undefined && ownsRecursionBinding) state.recursions.set(name, seed);
    const step = validateQueryNode(context, node.step, [...path, 'step'], outer, state, depth + 1);
    if (name !== undefined && ownsRecursionBinding) state.recursions.delete(name);
    if (!setEqual(seed, step)) {
      invalid(context, [...path, 'step'], 'recursive_alias_shape_mismatch');
    }
    validateExprArray(context, node.key, [...path, 'key'], union(outer, seed), state, depth + 1, false);
    optionalPositiveInteger(context, node.maxIterations, [...path, 'maxIterations']);
    optionalPositiveInteger(context, node.maxRows, [...path, 'maxRows']);
    return seed;
  }
  if (node.kind === 'join') {
    shape(context, node, ['kind', 'join', 'left', 'right'], ['on'], path);
    enumValue(context, node.join, ['inner', 'cross', 'left', 'semi', 'anti'], [...path, 'join']);
    const left = validateQueryNode(context, node.left, [...path, 'left'], outer, state, depth + 1);
    const right = validateQueryNode(context, node.right, [...path, 'right'], outer, state, depth + 1);
    const overlap = [...left].filter((alias) => right.has(alias));
    if (overlap.length > 0) {
      invalid(context, path, 'duplicate_join_alias', { aliases: overlap });
    }
    const scope = union(outer, left, right);
    if (node.join === 'cross' && node.on !== undefined) {
      invalid(context, [...path, 'on'], 'cross_join_on_forbidden');
    }
    if (node.join !== 'cross' && node.on === undefined) {
      invalid(context, [...path, 'on'], 'join_condition_required');
    }
    if (node.on !== undefined) {
      validateExpr(context, node.on, [...path, 'on'], scope, state, depth + 1);
    }
    return node.join === 'semi' || node.join === 'anti' ? left : union(left, right);
  }
  if (node.kind === 'set') {
    shape(context, node, ['kind', 'op', 'left', 'right'], [], path);
    enumValue(context, node.op, ['union', 'union-all', 'intersect', 'except'], [...path, 'op']);
    const left = validateQueryNode(context, node.left, [...path, 'left'], outer, state, depth + 1);
    const right = validateQueryNode(context, node.right, [...path, 'right'], outer, state, depth + 1);
    if (!setEqual(left, right)) {
      invalid(context, [...path, 'right'], 'set_alias_shape_mismatch');
    }
    return left;
  }
  if (!unaryQueryKinds.includes(node.kind as string)) {
    invalid(context, [...path, 'kind'], 'unknown_query_node', { kind: node.kind });
    return new Set();
  }
  const inputAliases = validateQueryNode(context, node.input, [...path, 'input'], outer, state, depth + 1);
  const scope = union(outer, inputAliases);
  if (node.kind === 'where') {
    shape(context, node, ['kind', 'input', 'predicate'], [], path);
    validateExpr(context, node.predicate, [...path, 'predicate'], scope, state, depth + 1);
    return inputAliases;
  }
  if (node.kind === 'select' || node.kind === 'with-fields') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    validateExprRecord(context, node.fields, [...path, 'fields'], scope, state, depth + 1);
    if (node.kind === 'with-fields' && alias !== undefined && !inputAliases.has(alias)) {
      invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    }
    return node.kind === 'select' ? (alias === undefined ? new Set() : new Set([alias])) : inputAliases;
  }
  if (node.kind === 'rename') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) {
      invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    }
    if (
      !isRecord(node.fields)
      || Object.values(node.fields).some((name) => typeof name !== 'string' || name.length === 0)
    ) {
      invalid(context, [...path, 'fields'], 'string_map_required');
    } else if (new Set(Object.values(node.fields)).size !== Object.keys(node.fields).length) {
      invalid(context, [...path, 'fields'], 'duplicate_renamed_field');
    }
    return inputAliases;
  }
  if (node.kind === 'omit') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) {
      invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    }
    stringArray(context, node.fields, [...path, 'fields'], true);
    return inputAliases;
  }
  if (node.kind === 'unnest') {
    shape(context, node, ['kind', 'input', 'expression', 'alias', 'field'], [], path);
    validateExpr(context, node.expression, [...path, 'expression'], scope, state, depth + 1);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    nonEmptyString(context, node.field, [...path, 'field']);
    if (alias !== undefined && inputAliases.has(alias)) {
      invalid(context, [...path, 'alias'], 'duplicate_alias');
    }
    return alias === undefined ? inputAliases : union(inputAliases, new Set([alias]));
  }
  if (node.kind === 'aggregate') {
    shape(context, node, ['kind', 'input', 'alias', 'groupBy', 'measures'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    validateExprRecord(context, node.groupBy, [...path, 'groupBy'], scope, state, depth + 1);
    if (!isRecord(node.measures)) {
      invalid(context, [...path, 'measures'], 'record_required');
    } else {
      for (const [name, aggregate] of Object.entries(node.measures)) {
        validateAggregate(
          context,
          aggregate,
          [...path, 'measures', name],
          scope,
          state,
          depth + 1
        );
      }
    }
    if (
      isRecord(node.groupBy)
      && isRecord(node.measures)
      && Object.keys(node.groupBy).some((name) => Object.hasOwn(node.measures as object, name))
    ) {
      invalid(context, path, 'duplicate_aggregate_output');
    }
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'distinct') {
    shape(context, node, ['kind', 'input'], [], path);
    return inputAliases;
  }
  if (node.kind === 'order') {
    shape(context, node, ['kind', 'input', 'by'], [], path);
    validateOrder(context, node.by, [...path, 'by'], scope, state, depth + 1);
    return inputAliases;
  }
  if (node.kind === 'slice') {
    shape(context, node, ['kind', 'input'], ['offset', 'limit'], path);
    optionalNonNegativeInteger(context, node.offset, [...path, 'offset']);
    optionalNonNegativeInteger(context, node.limit, [...path, 'limit']);
    return inputAliases;
  }
  if (node.kind === 'window') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) {
      invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    }
    if (!isRecord(node.fields)) {
      invalid(context, [...path, 'fields'], 'record_required');
    } else {
      for (const [name, window] of Object.entries(node.fields)) {
        validateWindow(
          context,
          window,
          [...path, 'fields', name],
          scope,
          state,
          depth + 1
        );
      }
    }
    return inputAliases;
  }
  if (node.kind === 'seek') {
    shape(context, node, ['kind', 'input', 'by', 'after'], [], path);
    validateOrder(context, node.by, [...path, 'by'], scope, state, depth + 1);
    validateCursor(context, node.after, [...path, 'after']);
    return inputAliases;
  }
  return inputAliases;
};

const validateExpr = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'expression_shape');
    return;
  }
  const expression = input;
  if (expression.kind === 'literal') {
    shape(context, expression, ['kind', 'value'], [], path);
    return;
  }
  if (expression.kind === 'parameter') {
    shape(context, expression, ['kind', 'name'], [], path);
    const name = nonEmptyString(context, expression.name, [...path, 'name']);
    if (name !== undefined && !state.parameters.has(name)) {
      invalid(context, [...path, 'name'], 'undeclared_parameter');
    }
    return;
  }
  if (expression.kind === 'field') {
    shape(context, expression, ['kind', 'alias', 'name'], [], path);
    validateAliasUse(context, expression.alias, scope, [...path, 'alias']);
    nonEmptyString(context, expression.name, [...path, 'name']);
    return;
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    shape(context, expression, ['kind', 'alias'], [], path);
    validateAliasUse(context, expression.alias, scope, [...path, 'alias']);
    return;
  }
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') {
    shape(context, expression, ['kind', 'op', 'left', 'right'], [], path);
    enumValue(
      context,
      expression.op,
      expression.kind === 'compare'
        ? ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']
        : ['add', 'subtract', 'multiply', 'divide', 'modulo'],
      [...path, 'op']
    );
    validateExpr(context, expression.left, [...path, 'left'], scope, state, depth + 1);
    validateExpr(context, expression.right, [...path, 'right'], scope, state, depth + 1);
    return;
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      shape(context, expression, ['kind', 'op', 'arg'], [], path);
      validateExpr(context, expression.arg, [...path, 'arg'], scope, state, depth + 1);
    } else {
      shape(context, expression, ['kind', 'op', 'args'], [], path);
      enumValue(context, expression.op, ['and', 'or'], [...path, 'op']);
      validateExprArray(
        context,
        expression.args,
        [...path, 'args'],
        scope,
        state,
        depth + 1,
        false
      );
    }
    return;
  }
  if (expression.kind === 'string') {
    shape(context, expression, ['kind', 'op', 'args'], [], path);
    enumValue(context, expression.op, ['concat', 'lower', 'upper', 'length'], [...path, 'op']);
    validateExprArray(
      context,
      expression.args,
      [...path, 'args'],
      scope,
      state,
      depth + 1,
      false
    );
    if (
      expression.op !== 'concat'
      && Array.isArray(expression.args)
      && expression.args.length !== 1
    ) {
      invalid(context, [...path, 'args'], 'string_operator_arity');
    }
    return;
  }
  if (expression.kind === 'array') {
    shape(context, expression, ['kind', 'items'], [], path);
    validateExprArray(
      context,
      expression.items,
      [...path, 'items'],
      scope,
      state,
      depth + 1,
      false
    );
    return;
  }
  if (expression.kind === 'record') {
    shape(context, expression, ['kind', 'fields'], [], path);
    validateExprRecord(context, expression.fields, [...path, 'fields'], scope, state, depth + 1);
    return;
  }
  if (expression.kind === 'case') {
    shape(context, expression, ['kind', 'branches', 'otherwise'], [], path);
    if (!Array.isArray(expression.branches) || expression.branches.length === 0) {
      invalid(context, [...path, 'branches'], 'non_empty_array_required');
    } else {
      expression.branches.forEach((branch, index) => {
        const branchPath = [...path, 'branches', index];
        if (!shape(context, branch, ['when', 'then'], [], branchPath)) return;
        const record = branch as RecordValue;
        validateExpr(
          context,
          record.when,
          [...branchPath, 'when'],
          scope,
          state,
          depth + 1
        );
        validateExpr(
          context,
          record.then,
          [...branchPath, 'then'],
          scope,
          state,
          depth + 1
        );
      });
    }
    validateExpr(context, expression.otherwise, [...path, 'otherwise'], scope, state, depth + 1);
    return;
  }
  if (expression.kind === 'coalesce') {
    shape(context, expression, ['kind', 'args'], [], path);
    validateExprArray(
      context,
      expression.args,
      [...path, 'args'],
      scope,
      state,
      depth + 1,
      true
    );
    return;
  }
  if (expression.kind === 'call') {
    shape(context, expression, ['kind', 'capability', 'args'], [], path);
    recordCapabilityUse(context, expression.capability, [...path, 'capability'], state);
    validateExprArray(
      context,
      expression.args,
      [...path, 'args'],
      scope,
      state,
      depth + 1,
      false
    );
    return;
  }
  if (expression.kind === 'subquery') {
    shape(context, expression, ['kind', 'mode', 'query'], [], path);
    enumValue(context, expression.mode, ['scalar', 'exists'], [...path, 'mode']);
    validateQueryNode(context, expression.query, [...path, 'query'], scope, state, depth + 1);
    return;
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
    shape(context, expression, ['kind', 'value'], [], path);
    validateExpr(context, expression.value, [...path, 'value'], scope, state, depth + 1);
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_expression', { kind: expression.kind });
};

const validateAggregate = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!shape(context, input, ['kind', 'op'], ['value', 'orderBy'], path)) return;
  const aggregate = input as RecordValue;
  if (aggregate.kind !== 'aggregate') invalid(context, [...path, 'kind'], 'aggregate_kind');
  enumValue(
    context,
    aggregate.op,
    [
      'count',
      'count-distinct',
      'sum',
      'average',
      'minimum',
      'maximum',
      'any',
      'every',
      'collect',
      'first',
      'last'
    ],
    [...path, 'op']
  );
  if (aggregate.op !== 'count' && aggregate.value === undefined) {
    invalid(context, [...path, 'value'], 'aggregate_value_required');
  }
  if (aggregate.value !== undefined) {
    validateExpr(context, aggregate.value, [...path, 'value'], scope, state, depth + 1);
  }
  if (aggregate.orderBy !== undefined) {
    validateOrder(context, aggregate.orderBy, [...path, 'orderBy'], scope, state, depth + 1);
  }
};

const validateWindow = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!shape(context, input, ['kind', 'op', 'orderBy'], ['value', 'offset', 'partitionBy'], path)) return;
  const window = input as RecordValue;
  if (window.kind !== 'window') invalid(context, [...path, 'kind'], 'window_kind');
  enumValue(context, window.op, ['row-number', 'rank', 'lag'], [...path, 'op']);
  if (window.op === 'lag' && window.value === undefined) {
    invalid(context, [...path, 'value'], 'lag_value_required');
  }
  if (window.op !== 'lag' && (window.value !== undefined || window.offset !== undefined)) {
    invalid(context, path, 'non_lag_value_or_offset');
  }
  if (window.value !== undefined) {
    validateExpr(context, window.value, [...path, 'value'], scope, state, depth + 1);
  }
  optionalPositiveInteger(context, window.offset, [...path, 'offset']);
  if (window.partitionBy !== undefined) {
    validateExprArray(
      context,
      window.partitionBy,
      [...path, 'partitionBy'],
      scope,
      state,
      depth + 1,
      false
    );
  }
  validateOrder(context, window.orderBy, [...path, 'orderBy'], scope, state, depth + 1);
};

const validateOrder = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!Array.isArray(input) || input.length === 0) {
    invalid(context, path, 'non_empty_array_required');
    return;
  }
  input.forEach((term, index) => {
    const termPath = [...path, index];
    if (!shape(context, term, ['value', 'direction'], ['nulls'], termPath)) return;
    const value = term as RecordValue;
    enumValue(context, value.direction, ['asc', 'desc'], [...termPath, 'direction']);
    if (value.nulls !== undefined) {
      enumValue(context, value.nulls, ['first', 'last'], [...termPath, 'nulls']);
    }
    validateExpr(context, value.value, [...termPath, 'value'], scope, state, depth + 1);
  });
};

const validateCursor = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): void => {
  if (!shape(context, input, ['order', 'resultKey', 'basis', 'membershipRevision', 'mode'], [], path)) return;
  const cursor = input as RecordValue;
  if (!Array.isArray(cursor.order)) {
    invalid(context, [...path, 'order'], 'array_required');
  }
  nonEmptyString(context, cursor.resultKey, [...path, 'resultKey']);
  nonNegativeInteger(context, cursor.membershipRevision, [...path, 'membershipRevision']);
  enumValue(context, cursor.mode, ['live'], [...path, 'mode']);
};

const validateParameterDeclarations = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  capabilities: Map<string, CapabilityUse>
): ReadonlySet<string> => {
  if (!isRecord(input)) {
    invalid(context, path, 'record_required');
    return new Set();
  }
  const names = Object.keys(input);
  checkNameBudget(context, names.length, path);
  for (const [name, declaration] of Object.entries(input)) {
    if (name.length === 0) {
      invalid(context, [...path, name], 'empty_parameter_name');
    }
    validateValueDeclaration(context, declaration, [...path, name], 0, capabilities);
  }
  return new Set(names);
};

const validateValueDeclaration = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  depth: number,
  capabilities: Map<string, CapabilityUse>
): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'value_declaration_shape');
    return;
  }
  const declaration = input;
  const kind = declaration.kind as string;
  if (declaration.kind === 'array') {
    shape(context, declaration, ['kind', 'items'], [], path);
    validateValueDeclaration(
      context,
      declaration.items as JsonValue,
      [...path, 'items'],
      depth + 1,
      capabilities
    );
    return;
  }
  if (declaration.kind === 'tuple') {
    shape(context, declaration, ['kind', 'items'], [], path);
    if (!Array.isArray(declaration.items)) {
      invalid(context, [...path, 'items'], 'array_required');
    } else {
      declaration.items.forEach((item, index) => validateValueDeclaration(
        context,
        item,
        [...path, 'items', index],
        depth + 1,
        capabilities
      ));
    }
    return;
  }
  if (declaration.kind === 'record') {
    shape(context, declaration, ['kind', 'fields'], ['optional'], path);
    if (!isRecord(declaration.fields)) {
      invalid(context, [...path, 'fields'], 'record_required');
    } else {
      for (const [name, field] of Object.entries(declaration.fields)) {
        validateValueDeclaration(
          context,
          field,
          [...path, 'fields', name],
          depth + 1,
          capabilities
        );
      }
    }
    if (declaration.optional !== undefined) {
      const optional = stringArray(
        context,
        declaration.optional,
        [...path, 'optional'],
        true
      );
      if (optional !== undefined && isRecord(declaration.fields)) {
        for (const name of optional) {
          if (!Object.hasOwn(declaration.fields, name)) {
            invalid(
              context,
              [...path, 'optional'],
              'unknown_optional_field',
              { field: name }
            );
          }
        }
      }
    }
    return;
  }
  if (declaration.kind === 'string') {
    shape(context, declaration, ['kind'], ['values'], path);
    if (declaration.values !== undefined) {
      stringArray(context, declaration.values, [...path, 'values'], true);
    }
    return;
  }
  if (['boolean', 'number', 'integer', 'decimal', 'bytes', 'json'].includes(kind)) {
    shape(context, declaration, ['kind'], [], path);
    return;
  }
  if (declaration.kind === 'instant') {
    shape(context, declaration, ['kind', 'precision'], [], path);
    enumValue(
      context,
      declaration.precision,
      ['millisecond', 'microsecond', 'nanosecond'],
      [...path, 'precision']
    );
    return;
  }
  if (declaration.kind === 'ref') {
    shape(context, declaration, ['kind', 'target'], [], path);
    if (shape(context, declaration.target, ['relationId'], [], [...path, 'target'])) {
      nonEmptyString(
        context,
        (declaration.target as RecordValue).relationId,
        [...path, 'target', 'relationId']
      );
    }
    return;
  }
  if (declaration.kind === 'custom') {
    shape(context, declaration, ['kind', 'codec'], [], path);
    const ref = validateCapabilityRef(context, declaration.codec, [...path, 'codec']);
    if (ref !== undefined) {
      capabilities.set(capabilityKey(ref), { ref, path: [...path, 'codec'] });
    }
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_value_declaration');
};

const validateExprArray = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number,
  nonEmpty: boolean
): void => {
  if (!Array.isArray(input) || (nonEmpty && input.length === 0)) {
    invalid(context, path, nonEmpty ? 'non_empty_array_required' : 'array_required');
    return;
  }
  input.forEach((expression, index) => validateExpr(
    context,
    expression,
    [...path, index],
    scope,
    state,
    depth + 1
  ));
};

const validateExprRecord = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  scope: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!isRecord(input)) {
    invalid(context, path, 'record_required');
    return;
  }
  for (const [name, expression] of Object.entries(input)) {
    validateExpr(context, expression, [...path, name], scope, state, depth + 1);
  }
};

const validateRelationUse = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): { readonly schemaView: ArtifactRef; readonly relationId: string } | undefined => {
  if (!shape(context, input, ['schemaView', 'relationId'], [], path)) return undefined;
  const value = input as RecordValue;
  const schemaView = validateArtifactRef(
    context,
    value.schemaView,
    [...path, 'schemaView']
  );
  const relationId = nonEmptyString(context, value.relationId, [...path, 'relationId']);
  return schemaView === undefined || relationId === undefined
    ? undefined
    : { schemaView, relationId };
};

const validateUniqueRefs = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): ReadonlyMap<string, ArtifactRef> => {
  const refs = new Map<string, ArtifactRef>();
  if (!Array.isArray(input)) {
    invalid(context, path, 'array_required');
    return refs;
  }
  checkNameBudget(context, input.length, path);
  input.forEach((candidate, index) => {
    const ref = validateArtifactRef(context, candidate, [...path, index]);
    if (ref === undefined) return;
    const key = refKey(ref);
    if (refs.has(key)) {
      invalid(context, [...path, index], 'duplicate_artifact_ref');
    } else {
      refs.set(key, ref);
    }
  });
  return refs;
};

export const validateUniqueCapabilities = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): ReadonlyMap<string, CapabilityRef> => {
  const refs = new Map<string, CapabilityRef>();
  if (!Array.isArray(input)) {
    invalid(context, path, 'array_required');
    return refs;
  }
  checkNameBudget(context, input.length, path);
  input.forEach((candidate, index) => {
    const ref = validateCapabilityRef(context, candidate, [...path, index]);
    if (ref === undefined) return;
    const key = capabilityKey(ref);
    if (refs.has(key)) {
      invalid(context, [...path, index], 'duplicate_capability_ref');
    } else {
      refs.set(key, ref);
    }
  });
  return refs;
};

export const recordCapabilityUse = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  state: QueryValidationState
): void => {
  const ref = validateCapabilityRef(context, input, path);
  if (ref !== undefined) {
    state.usedCapabilities.set(capabilityKey(ref), { ref, path });
  }
};

const validateAliasUse = (
  context: ValidationContext,
  value: JsonValue | undefined,
  aliases: ReadonlySet<string>,
  path: readonly unknown[]
): void => {
  const alias = nonEmptyString(context, value, path);
  if (alias !== undefined && !aliases.has(alias)) {
    invalid(context, path, 'alias_not_in_scope');
  }
};
