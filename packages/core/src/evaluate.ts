import type { TarstateDiagnostic } from './diagnostics.js';
import type { ExprData, OptionalProjection, PredicateData, ProjectionData, Query, QueryData } from './query.js';
import type { RelationLookup, RelationSource } from './source.js';
import type { FieldSpec, RelationRef } from './schema.js';

/** Rows plus diagnostics returned by one query evaluation. */
export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

type Context = Record<string, Record<string, unknown> | null>;
type LookupJoinPlan = {
  readonly alias: string;
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: ExprData;
  readonly rightAliases: readonly string[];
};
type ProjectionStep = {
  readonly fieldName: string;
  readonly expr: ExprData;
};
type RowPlan = {
  readonly relationRef: RelationRef;
  readonly fields: readonly (readonly [string, FieldSpec])[];
  readonly keyFields: readonly string[];
};

/**
 * Evaluate a query once against a source.
 *
 * @remarks Always async so sync and async sources share one call shape.
 *
 * @example `const result = await evaluate(source, query)`
 */
export async function evaluate<Row>(source: RelationSource, query: Query<Row>): Promise<QueryResult<Row>> {
  const diagnostics: TarstateDiagnostic[] = [];
  const contexts = await evaluateData(source, query.relations, query.data, diagnostics);

  if (source.diagnostics) {
    diagnostics.push(...(await collectDiagnostics(source)));
  }

  return {
    rows: contexts as Row[],
    diagnostics
  };
}

async function collectDiagnostics(source: RelationSource): Promise<TarstateDiagnostic[]> {
  try {
    return Array.from(await source.diagnostics?.() ?? []);
  } catch (error) {
    return [
      {
        code: 'source_error',
        message: 'source diagnostics failed',
        detail: error
      }
    ];
  }
}

async function evaluateData(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: QueryData,
  diagnostics: TarstateDiagnostic[]
): Promise<unknown[]> {
  switch (data.op) {
    case 'from':
      return evaluateFrom(source, relationFor(relations, data.relation), data.alias, diagnostics);
    case 'where':
      return evaluateWhere(source, relations, data, diagnostics);
    case 'join':
      return evaluateJoin(source, relations, data, diagnostics);
    case 'select': {
      const projection = projectionPlan(data.projection);
      const inputRows = await evaluateData(source, relations, data.input, diagnostics);
      const output: Record<string, unknown>[] = [];

      for (const context of inputRows) {
        output.push(evaluateProjection(context as Context, projection));
      }

      return output;
    }
  }
}

async function evaluateFrom(
  source: RelationSource,
  relationRef: RelationRef,
  alias: string,
  diagnostics: TarstateDiagnostic[]
): Promise<Context[]> {
  const rows = await readRows(source, relationRef, diagnostics);
  return rowsToContexts(rows, alias, relationRef, diagnostics);
}

async function evaluateWhere(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'where' }>,
  diagnostics: TarstateDiagnostic[]
): Promise<unknown[]> {
  const plannedLookup = lookupForWhere(relations, data);

  if (plannedLookup !== undefined && source.lookup !== undefined) {
    const lookupRows = await readLookup(source, plannedLookup.lookup, diagnostics);
    if (lookupRows !== undefined) {
      return rowsToContexts(lookupRows, plannedLookup.alias, plannedLookup.lookup.relation, diagnostics);
    }
  }

  const inputRows = await evaluateData(source, relations, data.input, diagnostics);
  const output: unknown[] = [];

  for (const context of inputRows) {
    if (evaluatePredicate(context as Context, data.predicate)) {
      output.push(context);
    }
  }

  return output;
}

async function evaluateJoin(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>,
  diagnostics: TarstateDiagnostic[]
): Promise<Context[]> {
  const lookupRows = await evaluateLookupJoin(source, relations, data, diagnostics);

  if (lookupRows !== undefined) {
    return lookupRows;
  }

  const leftRows = (await evaluateData(source, relations, data.left, diagnostics)) as Context[];
  const rightRows = (await evaluateData(source, relations, data.right, diagnostics)) as Context[];
  const output: Context[] = [];
  const rightAliases = aliasesFor(data.right);

  for (const leftRow of leftRows) {
    let matched = false;

    for (const rightRow of rightRows) {
      const combined = { ...leftRow, ...rightRow };

      if (evaluatePredicate(combined, data.on)) {
        output.push(combined);
        matched = true;
      }
    }

    if (!matched && data.kind === 'left') {
      output.push(contextWithNullAliases(leftRow, rightAliases));
    }
  }

  return output;
}

async function evaluateLookupJoin(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>,
  diagnostics: TarstateDiagnostic[]
): Promise<Context[] | undefined> {
  const plan = lookupForJoin(relations, data);

  if (plan === undefined || source.lookup === undefined) {
    return undefined;
  }

  const planDiagnostics: TarstateDiagnostic[] = [];
  const leftRows = (await evaluateData(source, relations, data.left, planDiagnostics)) as Context[];
  const output: Context[] = [];
  const rightRowPlan = rowPlanFor(plan.relation);

  for (const leftRow of leftRows) {
    const diagnosticsBeforeLookup = planDiagnostics.length;
    const lookupRows = await readLookup(
      source,
      { relation: plan.relation, field: plan.field, value: evaluateExpr(leftRow, plan.value) },
      planDiagnostics
    );

    if (lookupRows === undefined) {
      diagnostics.push(...planDiagnostics.slice(diagnosticsBeforeLookup));
      return undefined;
    }

    let matched = false;
    const seenKeys = lookupRows.length > 1 ? new Set<string>() : undefined;

    for (const lookupRow of lookupRows) {
      const rightRow = rowForContext(lookupRow, rightRowPlan, seenKeys, planDiagnostics);

      if (rightRow === undefined) {
        continue;
      }

      output.push({ ...leftRow, [plan.alias]: rightRow });
      matched = true;
    }

    if (!matched && data.kind === 'left') {
      output.push(contextWithNullAliases(leftRow, plan.rightAliases));
    }
  }

  diagnostics.push(...planDiagnostics);
  return output;
}

function relationFor(relations: Record<string, RelationRef>, relationName: string): RelationRef {
  const relationRef = relations[relationName];

  if (relationRef === undefined) {
    throw new Error(`Unknown relation: ${relationName}`);
  }

  return relationRef;
}

async function readRows(
  source: RelationSource,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[]> {
  try {
    return rowsArray(await source.rows(relationRef));
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source rows failed for relation ${relationRef.name}`,
      relation: relationRef.name,
      detail: error
    });
    return [];
  }
}

async function readLookup(
  source: RelationSource,
  lookup: RelationLookup,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[] | undefined> {
  try {
    const rows = await source.lookup?.(lookup);
    return rows === undefined ? undefined : rowsArray(rows);
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source lookup failed for relation ${lookup.relation.name}`,
      relation: lookup.relation.name,
      field: lookup.field,
      detail: error
    });
    return undefined;
  }
}

function rowsToContexts(
  rows: readonly unknown[],
  alias: string,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): Context[] {
  // Keep scan and lookup result policy identical once rows are returned.
  const seenKeys = new Set<string>();
  const rowPlan = rowPlanFor(relationRef);
  const contexts: Context[] = [];

  for (const row of rows) {
    const contextRow = rowForContext(row, rowPlan, seenKeys, diagnostics);

    if (contextRow === undefined) {
      continue;
    }

    contexts.push({ [alias]: contextRow });
  }

  return contexts;
}

function rowsArray(rows: Iterable<unknown>): readonly unknown[] {
  return Array.isArray(rows) ? rows : Array.from(rows);
}

function rowPlanFor(relationRef: RelationRef): RowPlan {
  return {
    relationRef,
    fields: Object.entries(relationRef.fields),
    keyFields: Array.isArray(relationRef.key) ? relationRef.key : [relationRef.key]
  };
}

function rowForContext(
  row: unknown,
  rowPlan: RowPlan,
  seenKeys: Set<string> | undefined,
  diagnostics: TarstateDiagnostic[]
): Record<string, unknown> | undefined {
  const relationRef = rowPlan.relationRef;

  if (!isRecord(row)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${relationRef.name} is not an object`,
      relation: relationRef.name,
      detail: row
    });
    return undefined;
  }

  const diagnosticCount = appendRowDiagnostics(rowPlan, row, diagnostics);

  if (relationRef.ephemeral && diagnosticCount > 0) {
    return undefined;
  }

  if (seenKeys !== undefined) {
    const key = rowKey(rowPlan, row);
    if (key !== undefined) {
      if (seenKeys.has(key)) {
        diagnostics.push({
          code: 'duplicate_key',
          message: `duplicate key ${key} in relation ${relationRef.name}`,
          relation: relationRef.name,
          key
        });
      }
      seenKeys.add(key);
    }
  }

  return row;
}

function lookupForWhere(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'where' }>
): { readonly lookup: RelationLookup; readonly alias: string } | undefined {
  if (data.input.op !== 'from' || data.predicate.op !== 'eq') {
    return undefined;
  }

  const left = data.predicate.left;
  const right = data.predicate.right;

  if (left.op === 'field' && right.op === 'value' && left.alias === data.input.alias) {
    return {
      lookup: { relation: relationFor(relations, data.input.relation), field: left.field, value: right.value },
      alias: data.input.alias
    };
  }

  if (right.op === 'field' && left.op === 'value' && right.alias === data.input.alias) {
    return {
      lookup: { relation: relationFor(relations, data.input.relation), field: right.field, value: left.value },
      alias: data.input.alias
    };
  }

  return undefined;
}

function lookupForJoin(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>
): LookupJoinPlan | undefined {
  if (data.right.op !== 'from' || data.on.op !== 'eq') {
    return undefined;
  }

  const rightAliases = aliasesFor(data.right);
  const left = data.on.left;
  const right = data.on.right;

  if (left.op === 'field' && right.op === 'field' && left.alias === data.right.alias && right.alias !== data.right.alias) {
    return {
      alias: data.right.alias,
      relation: relationFor(relations, data.right.relation),
      field: left.field,
      value: right,
      rightAliases
    };
  }

  if (left.op === 'field' && right.op === 'field' && right.alias === data.right.alias && left.alias !== data.right.alias) {
    return {
      alias: data.right.alias,
      relation: relationFor(relations, data.right.relation),
      field: right.field,
      value: left,
      rightAliases
    };
  }

  return undefined;
}

function aliasesFor(data: QueryData): string[] {
  switch (data.op) {
    case 'from':
      return [data.alias];
    case 'where':
    case 'select':
      return aliasesFor(data.input);
    case 'join':
      return [...aliasesFor(data.left), ...aliasesFor(data.right)];
  }
}

function appendRowDiagnostics(
  rowPlan: RowPlan,
  row: Record<string, unknown>,
  diagnostics: TarstateDiagnostic[]
): number {
  const relationRef = rowPlan.relationRef;
  const diagnosticsBefore = diagnostics.length;

  for (const [fieldName, spec] of rowPlan.fields) {
    const hasField = Object.hasOwn(row, fieldName);
    const value = row[fieldName];

    if (!hasField || value === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'invalid_row',
          message: `missing required field ${fieldName} in relation ${relationRef.name}`,
          relation: relationRef.name,
          field: fieldName
        });
      }
      continue;
    }

    if (value === null) {
      if (!spec.nullable) {
        diagnostics.push({
          code: 'invalid_row',
          message: `null field ${fieldName} is not nullable in relation ${relationRef.name}`,
          relation: relationRef.name,
          field: fieldName
        });
      }
      continue;
    }

    if (!valueMatches(spec, value)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `invalid field ${fieldName} in relation ${relationRef.name}`,
        relation: relationRef.name,
        field: fieldName,
        detail: value
      });
    }
  }

  return diagnostics.length - diagnosticsBefore;
}

function valueMatches(spec: FieldSpec, value: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'anchoredPath':
      return Array.isArray(value);
  }
}

function rowKey(rowPlan: RowPlan, row: Record<string, unknown>): string | undefined {
  const values: unknown[] = [];

  for (const keyField of rowPlan.keyFields) {
    const value = row[keyField];

    if (value === undefined) {
      return undefined;
    }

    values.push(value);
  }

  return JSON.stringify(values);
}

function evaluatePredicate(context: Context, predicate: PredicateData): boolean {
  switch (predicate.op) {
    case 'eq':
      return evaluateExpr(context, predicate.left) === evaluateExpr(context, predicate.right);
    case 'and':
      for (const item of predicate.predicates) {
        if (!evaluatePredicate(context, item)) {
          return false;
        }
      }
      return true;
    case 'or':
      for (const item of predicate.predicates) {
        if (evaluatePredicate(context, item)) {
          return true;
        }
      }
      return false;
    case 'not':
      return !evaluatePredicate(context, predicate.predicate);
  }
}

function projectionPlan(projection: ProjectionData): ProjectionStep[] {
  const steps: ProjectionStep[] = [];

  for (const [fieldName, expr] of Object.entries(projection)) {
    steps.push({
      fieldName,
      expr: isOptionalProjection(expr) ? expr.expr : expr
    });
  }

  return steps;
}

function evaluateProjection(context: Context, projection: readonly ProjectionStep[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};

  for (const step of projection) {
    row[step.fieldName] = evaluateExpr(context, step.expr);
  }

  return row;
}

function isOptionalProjection(input: ExprData | OptionalProjection): input is OptionalProjection {
  return 'kind' in input && input.kind === 'optionalProjection';
}

function evaluateExpr(context: Context, expr: ExprData): unknown {
  switch (expr.op) {
    case 'field':
      return context[expr.alias]?.[expr.field];
    case 'value':
      return expr.value;
  }
}

function contextWithNullAliases(context: Context, aliases: readonly string[]): Context {
  const output = { ...context };

  for (const alias of aliases) {
    output[alias] = null;
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
