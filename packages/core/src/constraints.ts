import type { PredicateData, Query } from './query.js';
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

export type RequiredConstraintData<
  Relation extends RelationRef = RelationRef,
  Field extends ConstraintRelationField<Relation> = ConstraintRelationField<Relation>
> = ConstraintBase<'req'> & {
  readonly relation: Relation;
  readonly field: Field;
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
  | RequiredConstraintData
  | ForeignKeyConstraintData
  | UniqueConstraintData;

/** Named group of constraint descriptors. */
export type ConstraintSet<Constraints extends readonly ConstraintData[] = readonly ConstraintData[]> = {
  readonly kind: 'constraintSet';
  readonly constraints: Constraints;
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
};

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
export function req<Relation extends RelationRef, Field extends ConstraintRelationField<Relation>>(
  relation: Relation,
  field: Field,
  options: ConstraintOptions = {}
): RequiredConstraintData<Relation, Field> {
  return {
    kind: 'constraint',
    op: 'req',
    relation,
    field,
    ...constraintOptions(options)
  };
}

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
  relation: RelationRef,
  fields: ConstraintRelationFields<RelationRef>,
  target: RelationRef,
  targetFields: ConstraintRelationFields<RelationRef>,
  options: ForeignKeyOptions = {}
): ForeignKeyConstraintData {
  return {
    kind: 'constraint',
    op: 'fk',
    relation,
    fields: fieldTuple(fields),
    target,
    targetFields: fieldTuple(targetFields),
    optional: options.optional ?? false,
    ...constraintOptions(options)
  };
}

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
  relation: RelationRef,
  fields: ConstraintRelationFields<RelationRef>,
  options: ConstraintOptions = {}
): UniqueConstraintData {
  return {
    kind: 'constraint',
    op: 'unique',
    relation,
    fields: fieldTuple(fields),
    ...constraintOptions(options)
  };
}

/** Group constraints as schema-adjacent data for validation and transaction checks. */
export function constrain<const Constraints extends readonly ConstraintData[]>(
  ...constraints: Constraints
): ConstraintSet<Constraints> {
  return {
    kind: 'constraintSet',
    constraints
  };
}

function fieldTuple(fields: ConstraintRelationFields<RelationRef>): readonly string[] {
  return typeof fields === 'string' ? [fields] : fields;
}

function constraintOptions(options: ConstraintOptions): ConstraintOptions {
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.message === undefined ? {} : { message: options.message })
  };
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}
