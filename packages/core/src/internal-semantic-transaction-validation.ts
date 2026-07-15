import type { ArtifactRef } from './artifacts.js';
import {
  checkSemanticNameBudget as checkNameBudget,
  enterSemanticNode as enter,
  isSemanticRecord as isRecord,
  semanticArtifactRefKey as refKey,
  semanticEnumValue as enumValue,
  semanticInvalid as invalid,
  semanticNonEmptyString as nonEmptyString,
  semanticNonNegativeInteger as nonNegativeInteger,
  semanticShape as shape,
  validateSemanticArtifactRef as validateArtifactRef,
  type SemanticRecord as RecordValue,
  type SemanticValidationContext as ValidationContext
} from './internal-semantic-artifact-validation.js';
import {
  createQueryValidationState,
  recordCapabilityUse,
  reportUndeclaredCapabilities,
  validateQueryNode,
  validateUniqueCapabilities,
  type QueryValidationState
} from './internal-semantic-query-validation.js';
import type { JsonValue } from './value.js';

export const validateTransactionArtifactBody = (
  context: ValidationContext,
  body: JsonValue
): boolean => {
  if (!shape(
    context,
    body,
    ['schemaView', 'parameters', 'statements', 'guards', 'requiredCapabilities'],
    ['returning'],
    ['body']
  )) {
    return false;
  }
  const value = body as RecordValue;
  const schemaView = validateArtifactRef(context, value.schemaView, ['body', 'schemaView']);
  if (!isRecord(value.parameters)) {
    invalid(context, ['body', 'parameters'], 'record_required');
  }
  const parameters = new Set(isRecord(value.parameters) ? Object.keys(value.parameters) : []);
  checkNameBudget(context, parameters.size, ['body', 'parameters']);
  const capabilities = validateUniqueCapabilities(
    context,
    value.requiredCapabilities,
    ['body', 'requiredCapabilities']
  );
  const queryState = createQueryValidationState({
    parameters,
    schemaViews: new Map(schemaView === undefined ? [] : [[refKey(schemaView), schemaView]]),
    requiredCapabilities: capabilities
  });
  if (!Array.isArray(value.statements)) {
    invalid(context, ['body', 'statements'], 'array_required');
  } else {
    value.statements.forEach((statement, index) => validateWriteStatement(
      context,
      statement,
      ['body', 'statements', index],
      schemaView,
      queryState,
      0
    ));
  }
  if (!Array.isArray(value.guards)) {
    invalid(context, ['body', 'guards'], 'array_required');
  } else {
    value.guards.forEach((guard, index) => validateGuard(
      context,
      guard,
      ['body', 'guards', index],
      value.statements,
      queryState
    ));
  }
  if (value.returning !== undefined) {
    if (!Array.isArray(value.returning)) {
      invalid(context, ['body', 'returning'], 'array_required');
    } else {
      const names = new Set<string>();
      value.returning.forEach((returning, index) => {
        const path = ['body', 'returning', index];
        if (!shape(context, returning, ['name', 'root'], [], path)) return;
        const record = returning as RecordValue;
        const name = nonEmptyString(context, record.name, [...path, 'name']);
        if (name !== undefined && names.has(name)) {
          invalid(context, [...path, 'name'], 'duplicate_returning_name');
        } else if (name !== undefined) {
          names.add(name);
        }
        validateQueryNode(context, record.root, [...path, 'root'], new Set(), queryState, 0);
      });
    }
  }
  reportUndeclaredCapabilities(context, queryState);
  return context.issues.length === 0;
};

const validateWriteStatement = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  schemaView: ArtifactRef | undefined,
  state: QueryValidationState,
  depth: number
): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'statement_shape');
    return;
  }
  const statement = input;
  if (statement.kind === 'extension') {
    shape(context, statement, ['kind', 'capability', 'payload'], [], path);
    recordCapabilityUse(context, statement.capability, [...path, 'capability'], state);
    return;
  }
  if (
    statement.kind === 'statement.insert'
    || statement.kind === 'statement.upsert'
    || statement.kind === 'statement.replace-all'
  ) {
    shape(
      context,
      statement,
      ['kind', 'relation', 'rows'],
      statement.kind === 'statement.upsert' ? ['onConflict'] : [],
      path
    );
    validateWriteRelation(context, statement.relation, [...path, 'relation'], schemaView);
    validateWriteRows(context, statement.rows, [...path, 'rows'], state, depth + 1);
    if (statement.kind === 'statement.upsert') {
      enumValue(
        context,
        statement.onConflict,
        ['reject', 'keep-existing', 'replace'],
        [...path, 'onConflict']
      );
    }
    return;
  }
  if (statement.kind === 'statement.insert-from-query') {
    shape(context, statement, ['kind', 'relation', 'root'], [], path);
    validateWriteRelation(context, statement.relation, [...path, 'relation'], schemaView);
    validateQueryNode(context, statement.root, [...path, 'root'], new Set(), state, depth + 1);
    return;
  }
  if (statement.kind === 'statement.keyed-delta') {
    shape(context, statement, ['kind', 'relation', 'alias', 'changes'], [], path);
    validateWriteRelation(context, statement.relation, [...path, 'relation'], schemaView);
    const alias = nonEmptyString(context, statement.alias, [...path, 'alias']);
    const aliases = alias === undefined ? new Set<string>() : new Set([alias]);
    if (!Array.isArray(statement.changes) || statement.changes.length === 0) {
      invalid(context, [...path, 'changes'], 'non_empty_array_required');
      return;
    }
    statement.changes.forEach((candidate, index) => {
      const changePath = [...path, 'changes', index];
      if (!isRecord(candidate) || typeof candidate.kind !== 'string') {
        invalid(context, changePath, 'delta_change_shape');
        return;
      }
      if (candidate.kind === 'delta.delete') {
        shape(context, candidate, ['kind', 'key'], [], changePath);
        validateWriteExprRecord(context, candidate.key, [...changePath, 'key'], new Set(), state, depth + 1);
        return;
      }
      if (candidate.kind === 'delta.insert') {
        shape(context, candidate, ['kind', 'fields'], [], changePath);
        validateWriteExprRecord(context, candidate.fields, [...changePath, 'fields'], new Set(), state, depth + 1);
        return;
      }
      if (candidate.kind === 'delta.update') {
        shape(context, candidate, ['kind', 'key', 'edits'], [], changePath);
        validateWriteExprRecord(context, candidate.key, [...changePath, 'key'], new Set(), state, depth + 1);
        if (!isRecord(candidate.edits) || Object.keys(candidate.edits).length === 0) {
          invalid(context, [...changePath, 'edits'], 'non_empty_record_required');
          return;
        }
        for (const [name, edit] of Object.entries(candidate.edits)) {
          validateFieldEdit(context, edit, [...changePath, 'edits', name], aliases, state, depth + 1);
        }
        return;
      }
      invalid(context, [...changePath, 'kind'], 'unknown_delta_change', { kind: candidate.kind });
    });
    return;
  }
  if (statement.kind === 'statement.update') {
    shape(context, statement, ['kind', 'target', 'edits'], [], path);
    const aliases = validateWriteTarget(
      context,
      statement.target,
      [...path, 'target'],
      schemaView,
      state,
      depth + 1
    );
    if (!isRecord(statement.edits) || Object.keys(statement.edits).length === 0) {
      invalid(context, [...path, 'edits'], 'non_empty_record_required');
    } else {
      for (const [name, edit] of Object.entries(statement.edits)) {
        validateFieldEdit(
          context,
          edit,
          [...path, 'edits', name],
          aliases,
          state,
          depth + 1
        );
      }
    }
    return;
  }
  if (statement.kind === 'statement.delete') {
    shape(context, statement, ['kind', 'target'], [], path);
    validateWriteTarget(
      context,
      statement.target,
      [...path, 'target'],
      schemaView,
      state,
      depth + 1
    );
    return;
  }
  if (statement.kind === 'statement.rekey') {
    shape(context, statement, ['kind', 'target', 'key', 'references', 'requires'], [], path);
    const aliases = validateWriteTarget(
      context,
      statement.target,
      [...path, 'target'],
      schemaView,
      state,
      depth + 1
    );
    validateWriteExprRecord(
      context,
      statement.key,
      [...path, 'key'],
      aliases,
      state,
      depth + 1
    );
    enumValue(
      context,
      statement.references,
      ['source-local-declared', 'reject-if-referenced'],
      [...path, 'references']
    );
    recordCapabilityUse(context, statement.requires, [...path, 'requires'], state);
    return;
  }
  if (statement.kind === 'statement.move') {
    shape(
      context,
      statement,
      ['kind', 'target', 'parent', 'position', 'missingAnchor', 'requires'],
      [],
      path
    );
    const aliases = validateWriteTarget(
      context,
      statement.target,
      [...path, 'target'],
      schemaView,
      state,
      depth + 1
    );
    validateWriteExpr(
      context,
      statement.parent,
      [...path, 'parent'],
      aliases,
      state,
      depth + 1
    );
    validateMovePosition(
      context,
      statement.position,
      [...path, 'position'],
      aliases,
      state,
      depth + 1
    );
    enumValue(
      context,
      statement.missingAnchor,
      ['reject', 'beginning', 'end'],
      [...path, 'missingAnchor']
    );
    recordCapabilityUse(context, statement.requires, [...path, 'requires'], state);
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_statement', { kind: statement.kind });
};

const validateWriteRelation = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  schemaView: ArtifactRef | undefined
): void => {
  if (!shape(context, input, ['relationId', 'schemaView'], [], path)) return;
  const relation = input as RecordValue;
  nonEmptyString(context, relation.relationId, [...path, 'relationId']);
  const ref = validateArtifactRef(context, relation.schemaView, [...path, 'schemaView']);
  if (
    ref !== undefined
    && schemaView !== undefined
    && refKey(ref) !== refKey(schemaView)
  ) {
    invalid(context, [...path, 'schemaView'], 'transaction_schema_mismatch');
  }
};

const validateWriteTarget = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  schemaView: ArtifactRef | undefined,
  state: QueryValidationState,
  depth: number
): ReadonlySet<string> => {
  if (!shape(context, input, ['relation', 'alias'], ['where'], path)) return new Set();
  const target = input as RecordValue;
  validateWriteRelation(context, target.relation, [...path, 'relation'], schemaView);
  const alias = nonEmptyString(context, target.alias, [...path, 'alias']);
  const aliases = alias === undefined ? new Set<string>() : new Set([alias]);
  if (target.where !== undefined) {
    validateWriteExpr(
      context,
      target.where,
      [...path, 'where'],
      aliases,
      state,
      depth + 1
    );
  }
  return aliases;
};

const validateWriteRows = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  state: QueryValidationState,
  depth: number
): void => {
  if (!Array.isArray(input)) {
    invalid(context, path, 'array_required');
    return;
  }
  input.forEach((row, index) => validateWriteExprRecord(
    context,
    row,
    [...path, index],
    new Set(),
    state,
    depth + 1
  ));
};

const validateWriteExprRecord = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  aliases: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!isRecord(input)) {
    invalid(context, path, 'record_required');
    return;
  }
  for (const [name, expression] of Object.entries(input)) {
    validateWriteExpr(context, expression, [...path, name], aliases, state, depth + 1);
  }
};

const validateWriteExpr = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  aliases: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'write_expression_shape');
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
    validateAliasUse(context, expression.alias, aliases, [...path, 'alias']);
    nonEmptyString(context, expression.name, [...path, 'name']);
    return;
  }
  if (expression.kind === 'compare') {
    shape(context, expression, ['kind', 'op', 'left', 'right'], [], path);
    enumValue(
      context,
      expression.op,
      ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
      [...path, 'op']
    );
    validateWriteExpr(
      context,
      expression.left,
      [...path, 'left'],
      aliases,
      state,
      depth + 1
    );
    validateWriteExpr(
      context,
      expression.right,
      [...path, 'right'],
      aliases,
      state,
      depth + 1
    );
    return;
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      shape(context, expression, ['kind', 'op', 'arg'], [], path);
      validateWriteExpr(
        context,
        expression.arg,
        [...path, 'arg'],
        aliases,
        state,
        depth + 1
      );
    } else {
      shape(context, expression, ['kind', 'op', 'args'], [], path);
      enumValue(context, expression.op, ['and', 'or'], [...path, 'op']);
      if (!Array.isArray(expression.args)) {
        invalid(context, [...path, 'args'], 'array_required');
      } else {
        expression.args.forEach((argument, index) => validateWriteExpr(
          context,
          argument,
          [...path, 'args', index],
          aliases,
          state,
          depth + 1
        ));
      }
    }
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_write_expression', { kind: expression.kind });
};

const validateFieldEdit = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  aliases: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'field_edit_shape');
    return;
  }
  const edit = input;
  if (edit.kind === 'edit.replace') {
    shape(context, edit, ['kind', 'value'], [], path);
    validateWriteExpr(context, edit.value, [...path, 'value'], aliases, state, depth + 1);
    return;
  }
  if (edit.kind === 'edit.counter-increment') {
    shape(context, edit, ['kind', 'amount'], [], path);
    validateWriteExpr(context, edit.amount, [...path, 'amount'], aliases, state, depth + 1);
    return;
  }
  if (edit.kind === 'edit.text-splice') {
    shape(context, edit, ['kind', 'index', 'deleteCount', 'insert'], [], path);
    for (const name of ['index', 'deleteCount', 'insert']) {
      validateWriteExpr(context, edit[name], [...path, name], aliases, state, depth + 1);
    }
    return;
  }
  if (edit.kind === 'edit.list-splice') {
    shape(context, edit, ['kind', 'index', 'deleteCount', 'values', 'requires'], [], path);
    validateWriteExpr(context, edit.index, [...path, 'index'], aliases, state, depth + 1);
    validateWriteExpr(
      context,
      edit.deleteCount,
      [...path, 'deleteCount'],
      aliases,
      state,
      depth + 1
    );
    if (!Array.isArray(edit.values)) {
      invalid(context, [...path, 'values'], 'array_required');
    } else {
      edit.values.forEach((value, index) => validateWriteExpr(
        context,
        value,
        [...path, 'values', index],
        aliases,
        state,
        depth + 1
      ));
    }
    recordCapabilityUse(context, edit.requires, [...path, 'requires'], state);
    return;
  }
  if (edit.kind === 'edit.conflict-resolve') {
    shape(context, edit, ['kind', 'observed', 'value'], [], path);
    if (!Array.isArray(edit.observed)) {
      invalid(context, [...path, 'observed'], 'array_required');
    }
    validateWriteExpr(context, edit.value, [...path, 'value'], aliases, state, depth + 1);
    return;
  }
  if (edit.kind === 'extension') {
    shape(context, edit, ['kind', 'capability', 'payload'], [], path);
    recordCapabilityUse(context, edit.capability, [...path, 'capability'], state);
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_field_edit', { kind: edit.kind });
};

const validateMovePosition = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  aliases: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'move_position_shape');
    return;
  }
  if (input.kind === 'beginning' || input.kind === 'end') {
    shape(context, input, ['kind'], [], path);
    return;
  }
  if (input.kind === 'before' || input.kind === 'after') {
    shape(context, input, ['kind', 'anchor'], [], path);
    validateWriteExpr(
      context,
      input.anchor,
      [...path, 'anchor'],
      aliases,
      state,
      depth + 1
    );
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_move_position');
};

const validateGuard = (
  context: ValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  statements: JsonValue | undefined,
  state: QueryValidationState
): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    invalid(context, path, 'guard_shape');
    return;
  }
  const guard = input;
  if (guard.kind === 'guard.affected-count') {
    shape(context, guard, ['kind', 'statementIndex', 'count', 'op', 'value'], [], path);
    nonNegativeInteger(context, guard.statementIndex, [...path, 'statementIndex']);
    if (
      Number.isInteger(guard.statementIndex)
      && Array.isArray(statements)
      && (guard.statementIndex as number) >= statements.length
    ) {
      invalid(context, [...path, 'statementIndex'], 'statement_index_out_of_range');
    }
    enumValue(
      context,
      guard.count,
      ['matched', 'logicallyChanged', 'inserted', 'deleted'],
      [...path, 'count']
    );
    enumValue(context, guard.op, ['eq', 'gte', 'lte'], [...path, 'op']);
    nonNegativeInteger(context, guard.value, [...path, 'value']);
    return;
  }
  if (guard.kind === 'guard.query') {
    shape(context, guard, ['kind', 'root', 'expect'], [], path);
    enumValue(context, guard.expect, ['exists', 'empty'], [...path, 'expect']);
    validateQueryNode(context, guard.root, [...path, 'root'], new Set(), state, 0);
    return;
  }
  if (guard.kind === 'extension') {
    shape(context, guard, ['kind', 'capability', 'payload'], [], path);
    recordCapabilityUse(context, guard.capability, [...path, 'capability'], state);
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_guard');
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
