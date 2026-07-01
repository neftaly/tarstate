import type { ExprData, PredicateData, Query } from './query.js';
import type { RelationRef } from './schema.js';

/** Row type carried by a relation reference. */
export type ConstraintRelationRow<Relation extends RelationRef> =
  Relation extends RelationRef<infer Row> ? Row : never;

/** Field name belonging to a relation row. */
export type ConstraintRelationField<Relation extends RelationRef> = keyof ConstraintRelationRow<Relation> & string;

/** Field tuple belonging to a relation row. */
export type ConstraintRelationFields<Relation extends RelationRef> =
  | readonly ConstraintRelationField<Relation>[]
  | ConstraintRelationField<Relation>;

export type ConstraintOptions = {
  readonly name?: string;
  readonly message?: string;
};

export type CheckConstraintData<Row = unknown> = ConstraintBase<'check'> & {
  readonly query?: Query<Row>;
  readonly predicate: PredicateData;
};

export type QueryRequiredConstraintData<
  Row extends Record<string, unknown> = Record<string, unknown>,
  Field extends keyof Row & string = keyof Row & string
> = ConstraintBase<'req'> & {
  readonly query: Query<Row>;
  readonly field: Field;
};

export type RequiredConstraintData<
  Relation extends RelationRef = RelationRef,
  Field extends ConstraintRelationField<Relation> = ConstraintRelationField<Relation>
> = ConstraintBase<'req'> & {
  readonly relation: Relation;
  readonly field: Field;
};

export type QueryForeignKeyConstraintData<
  Row extends Record<string, unknown> = Record<string, unknown>,
  Target extends RelationRef | Query = RelationRef | Query,
  SourceFields extends readonly (keyof Row & string)[] = readonly (keyof Row & string)[],
  TargetFields extends readonly string[] = readonly string[]
> = ConstraintBase<'fk'> & {
  readonly query: Query<Row>;
  readonly fields: SourceFields;
  readonly target: Target;
  readonly targetFields: TargetFields;
  readonly optional: boolean;
  readonly cascade?: ForeignKeyCascade;
};

export type ForeignKeyConstraintData<
  Source extends RelationRef = RelationRef,
  Target extends RelationRef = RelationRef,
  SourceFields extends readonly ConstraintRelationField<Source>[] = readonly ConstraintRelationField<Source>[],
  TargetFields extends readonly ConstraintRelationField<Target>[] = readonly ConstraintRelationField<Target>[]
> = ConstraintBase<'fk'> & {
  readonly relation: Source;
  readonly fields: SourceFields;
  readonly target: Target;
  readonly targetFields: TargetFields;
  readonly optional: boolean;
  readonly cascade?: ForeignKeyCascade;
};

export type QueryUniqueConstraintData<
  Row extends Record<string, unknown> = Record<string, unknown>,
  Fields extends readonly (keyof Row & string)[] = readonly (keyof Row & string)[]
> = ConstraintBase<'unique'> & {
  readonly query: Query<Row>;
  readonly fields: Fields;
};

export type QueryUniqueExpressionConstraintData<
  Row = unknown,
  Expressions extends readonly ExprData[] = readonly ExprData[]
> = ConstraintBase<'unique'> & {
  readonly query: Query<Row>;
  readonly expressions: Expressions;
};

export type UniqueConstraintData<
  Relation extends RelationRef = RelationRef,
  Fields extends readonly ConstraintRelationField<Relation>[] = readonly ConstraintRelationField<Relation>[]
> = ConstraintBase<'unique'> & {
  readonly relation: Relation;
  readonly fields: Fields;
};

/** Constraint descriptor understood by planners/evaluators. */
export type ConstraintData =
  | CheckConstraintData
  | QueryRequiredConstraintData
  | RequiredConstraintData
  | QueryForeignKeyConstraintData
  | ForeignKeyConstraintData
  | QueryUniqueExpressionConstraintData
  | QueryUniqueConstraintData
  | UniqueConstraintData;

/** Named group of constraint descriptors. */
export type ConstraintSet<
  Constraints extends readonly ConstraintData[] = readonly ConstraintData[],
  Row = unknown
> = {
  readonly kind: 'constraintSet';
  readonly constraints: Constraints;
  readonly query?: Query<Row>;
};

export type {
  ConstraintValidationInput,
  ConstraintValidationOptions,
  ConstraintValidationResult
} from './constraints-validation.js';
export { validateAttachedConstraints, validateConstraints } from './constraints-validation.js';
export type {
  ConstrainedDb,
  ConstraintAttachment,
  ConstraintAttachmentInput
} from './constraints-attachment.js';
export {
  attachConstraints,
  attachedConstraintsFor,
  constraintAttachmentsFor,
  detachConstraints,
  hasAttachedConstraints
} from './constraints-attachment.js';
export {
  DbConstraintTransactionError,
  transactConstrained,
  tryTransactConstrained
} from './constraints-transactions.js';

type ConstraintBase<Op extends string> = ConstraintOptions & {
  readonly kind: 'constraint';
  readonly op: Op;
};

type ForeignKeyOptions = ConstraintOptions & {
  /** Allow null or undefined source key fields without reporting a missing reference. */
  readonly optional?: boolean;
  /** Delete source rows when a referenced target row is deleted. */
  readonly cascade?: ForeignKeyCascade;
};

export type ForeignKeyCascade = boolean | string;

export function check(predicate: PredicateData, options?: ConstraintOptions): CheckConstraintData;
export function check<Row>(query: Query<Row>, predicate: PredicateData, options?: ConstraintOptions): CheckConstraintData<Row>;
/** Declare a row-level boolean check constraint. */
export function check<Row>(
  first: PredicateData | Query<Row>,
  second: PredicateData | ConstraintOptions = {},
  third: ConstraintOptions = {}
): CheckConstraintData<Row> {
  const query = isQuery(first) ? first : undefined;
  const predicate = isQuery(first) ? second as PredicateData : first;
  const options = isQuery(first) ? third : second as ConstraintOptions;

  return {
    kind: 'constraint',
    op: 'check',
    ...(query === undefined ? {} : { query }),
    predicate,
    ...constraintOptions(options)
  };
}

/** Declare that a relation field must be present. */
export function req<Row extends Record<string, unknown>, Field extends keyof Row & string>(
  query: Query<Row>,
  field: Field,
  options?: ConstraintOptions
): QueryRequiredConstraintData<Row, Field>;
export function req<Relation extends RelationRef, Field extends ConstraintRelationField<Relation>>(
  relation: Relation,
  field: Field,
  options?: ConstraintOptions
): RequiredConstraintData<Relation, Field>;
export function req(
  relationOrQuery: RelationRef | Query,
  field: string,
  options: ConstraintOptions = {}
): RequiredConstraintData | QueryRequiredConstraintData {
  if (isQuery(relationOrQuery)) {
    return {
      kind: 'constraint',
      op: 'req',
      query: relationOrQuery as Query<Record<string, unknown>>,
      field,
      ...constraintOptions(options)
    };
  }

  return {
    kind: 'constraint',
    op: 'req',
    relation: relationOrQuery,
    field,
    ...constraintOptions(options)
  };
}

export function fk<
  Row extends Record<string, unknown>,
  SourceField extends keyof Row & string,
  Target extends RelationRef,
  TargetField extends ConstraintRelationField<Target>
>(
  query: Query<Row>,
  field: SourceField,
  target: Target,
  targetField: TargetField,
  options?: ForeignKeyOptions
): QueryForeignKeyConstraintData<Row, Target, readonly [SourceField], readonly [TargetField]>;
export function fk<
  Row extends Record<string, unknown>,
  const SourceFields extends readonly (keyof Row & string)[],
  Target extends RelationRef,
  const TargetFields extends readonly ConstraintRelationField<Target>[]
>(
  query: Query<Row>,
  fields: SourceFields,
  target: Target,
  targetFields: TargetFields,
  options?: ForeignKeyOptions
): QueryForeignKeyConstraintData<Row, Target, SourceFields, TargetFields>;
export function fk<
  Row extends Record<string, unknown>,
  SourceField extends keyof Row & string,
  TargetRow extends Record<string, unknown>,
  TargetField extends keyof TargetRow & string
>(
  query: Query<Row>,
  field: SourceField,
  target: Query<TargetRow>,
  targetField: TargetField,
  options?: ForeignKeyOptions
): QueryForeignKeyConstraintData<Row, Query<TargetRow>, readonly [SourceField], readonly [TargetField]>;
export function fk<
  Row extends Record<string, unknown>,
  const SourceFields extends readonly (keyof Row & string)[],
  TargetRow extends Record<string, unknown>,
  const TargetFields extends readonly (keyof TargetRow & string)[]
>(
  query: Query<Row>,
  fields: SourceFields,
  target: Query<TargetRow>,
  targetFields: TargetFields,
  options?: ForeignKeyOptions
): QueryForeignKeyConstraintData<Row, Query<TargetRow>, SourceFields, TargetFields>;
export function fk<
  Source extends RelationRef,
  SourceField extends ConstraintRelationField<Source>,
  Target extends RelationRef,
  TargetField extends ConstraintRelationField<Target>
>(
  relation: Source,
  field: SourceField,
  target: Target,
  targetField: TargetField,
  options?: ForeignKeyOptions
): ForeignKeyConstraintData<Source, Target, readonly [SourceField], readonly [TargetField]>;
export function fk<
  Source extends RelationRef,
  const SourceFields extends readonly ConstraintRelationField<Source>[],
  Target extends RelationRef,
  const TargetFields extends readonly ConstraintRelationField<Target>[]
>(
  relation: Source,
  fields: SourceFields,
  target: Target,
  targetFields: TargetFields,
  options?: ForeignKeyOptions
): ForeignKeyConstraintData<Source, Target, SourceFields, TargetFields>;
/** Declare a foreign-key descriptor. */
export function fk(
  relationOrQuery: RelationRef | Query,
  fields: ConstraintRelationFields<RelationRef> | string | readonly string[],
  target: RelationRef | Query,
  targetFields: ConstraintRelationFields<RelationRef> | string | readonly string[],
  options: ForeignKeyOptions = {}
): ForeignKeyConstraintData | QueryForeignKeyConstraintData {
  if (isQuery(relationOrQuery)) {
    return {
      kind: 'constraint',
      op: 'fk',
      query: relationOrQuery as Query<Record<string, unknown>>,
      fields: fieldTuple(fields),
      target,
      targetFields: fieldTuple(targetFields),
      optional: options.optional ?? false,
      ...(options.cascade === undefined ? {} : { cascade: options.cascade }),
      ...constraintOptions(options)
    };
  }

  return {
    kind: 'constraint',
    op: 'fk',
    relation: relationOrQuery,
    fields: fieldTuple(fields),
    target: target as RelationRef,
    targetFields: fieldTuple(targetFields),
    optional: options.optional ?? false,
    ...(options.cascade === undefined ? {} : { cascade: options.cascade }),
    ...constraintOptions(options)
  };
}

export function unique<Row extends Record<string, unknown>, Field extends keyof Row & string>(
  query: Query<Row>,
  field: Field,
  options?: ConstraintOptions
): QueryUniqueConstraintData<Row, readonly [Field]>;
export function unique<
  Row,
  Expression extends ExprData
>(
  query: Query<Row>,
  expression: Expression,
  options?: ConstraintOptions
): QueryUniqueExpressionConstraintData<Row, readonly [Expression]>;
export function unique<
  Row,
  const Expressions extends readonly ExprData[]
>(
  query: Query<Row>,
  expressions: Expressions,
  options?: ConstraintOptions
): QueryUniqueExpressionConstraintData<Row, Expressions>;
export function unique<
  Row extends Record<string, unknown>,
  const Fields extends readonly (keyof Row & string)[]
>(
  query: Query<Row>,
  fields: Fields,
  options?: ConstraintOptions
): QueryUniqueConstraintData<Row, Fields>;
export function unique<Relation extends RelationRef, Field extends ConstraintRelationField<Relation>>(
  relation: Relation,
  field: Field,
  options?: ConstraintOptions
): UniqueConstraintData<Relation, readonly [Field]>;
export function unique<
  Relation extends RelationRef,
  const Fields extends readonly ConstraintRelationField<Relation>[]
>(
  relation: Relation,
  fields: Fields,
  options?: ConstraintOptions
): UniqueConstraintData<Relation, Fields>;
/** Declare a uniqueness descriptor. */
export function unique(
  relationOrQuery: RelationRef | Query,
  fields: ConstraintRelationFields<RelationRef> | string | readonly string[] | ExprData | readonly ExprData[],
  options: ConstraintOptions = {}
): UniqueConstraintData | QueryUniqueConstraintData | QueryUniqueExpressionConstraintData {
  if (isQuery(relationOrQuery)) {
    if (isExprTupleInput(fields)) {
      return {
        kind: 'constraint',
        op: 'unique',
        query: relationOrQuery,
        expressions: exprTuple(fields),
        ...constraintOptions(options)
      };
    }

    return {
      kind: 'constraint',
      op: 'unique',
      query: relationOrQuery as Query<Record<string, unknown>>,
      fields: fieldTuple(fields as ConstraintRelationFields<RelationRef> | string | readonly string[]),
      ...constraintOptions(options)
    };
  }

  if (isExprTupleInput(fields)) {
    throw new TypeError(
      'unique(relation, expression) is not supported; project the expression into a query field or use unique(query, expression)'
    );
  }

  return {
    kind: 'constraint',
    op: 'unique',
    relation: relationOrQuery,
    fields: fieldTuple(fields as ConstraintRelationFields<RelationRef> | string | readonly string[]),
    ...constraintOptions(options)
  };
}

/** Group constraints as schema-adjacent data for validation and transaction checks. */
export function constrain<Row, const Constraints extends readonly ConstraintData[]>(
  query: Query<Row>,
  ...constraints: Constraints
): ConstraintSet<Constraints, Row>;
export function constrain<const Constraints extends readonly ConstraintData[]>(
  ...constraints: Constraints
): ConstraintSet<Constraints>;
export function constrain(
  first: Query | ConstraintData,
  ...rest: readonly ConstraintData[]
): ConstraintSet {
  if (isQuery(first)) {
    return {
      kind: 'constraintSet',
      query: first,
      constraints: rest.map((constraint) => bindConstraintToQuery(first, constraint))
    };
  }

  return {
    kind: 'constraintSet',
    constraints: [first, ...rest]
  };
}

function fieldTuple(fields: ConstraintRelationFields<RelationRef> | string | readonly string[]): readonly string[] {
  return typeof fields === 'string' ? [fields] : fields;
}

function exprTuple(expressions: ExprData | readonly ExprData[]): readonly ExprData[] {
  return isExprData(expressions) ? [expressions] : expressions;
}

function constraintOptions(options: ConstraintOptions): ConstraintOptions {
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.message === undefined ? {} : { message: options.message })
  };
}

function bindConstraintToQuery(query: Query, constraint: ConstraintData): ConstraintData {
  if ('query' in constraint || 'relation' in constraint) {
    return constraint;
  }

  return constraint.op === 'check'
    ? { ...constraint, query }
    : constraint;
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function isExprData(input: unknown): input is ExprData {
  return typeof input === 'object' && input !== null && 'op' in input;
}

function isExprTupleInput(input: unknown): input is ExprData | readonly ExprData[] {
  return isExprData(input) || (Array.isArray(input) && input.length > 0 && input.every(isExprData));
}
