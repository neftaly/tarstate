import { fromObjectSource } from './impl.js';
import { validateRelationRow } from './relation.js';
import { createSchemaManifestResolver } from './schema.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationSource } from './source.js';
import type {
  JsonObject,
  RelationRef,
  SchemaManifestResolver,
  SchemaManifestV1
} from './schema.js';

export type RelationSetRows<Row = JsonObject> = Readonly<Record<string, readonly Row[]>>;
type RelationSetRow<Rows extends RelationSetRows<unknown>> =
  Rows[keyof Rows & string][number];
type ReadonlyRelationSetRows<Rows extends RelationSetRows<unknown>> = {
  readonly [Name in keyof Rows & string]: readonly RelationSetRow<Pick<Rows, Name>>[];
};

export type RelationSet<
  Row = JsonObject,
  Rows extends RelationSetRows<unknown> = RelationSetRows<Row>
> = {
  readonly relations: Rows;
};
export type RelationSetRelation = string | Pick<RelationRef, 'name'>;
type RelationNameOnly = string | (Pick<RelationRef, 'name'> & { readonly kind?: never });
type RelationSetRelationName<Relation extends RelationSetRelation> =
  Relation extends string ? Relation
    : Relation extends Pick<RelationRef, 'name'> ? Relation['name'] & string
      : never;
type RelationRefRow<Relation extends RelationRef> =
  Relation extends RelationRef<infer Row> ? Row : never;
type RelationRowsFor<
  Rows extends RelationSetRows<unknown>,
  Relation extends RelationSetRelation
> = RelationSetRelationName<Relation> extends keyof Rows & string
  ? Rows[RelationSetRelationName<Relation>]
  : readonly RelationSetRow<Rows>[];
type RelationInputBoundary<Row extends object = object> = {
  readonly schemaId: string;
  readonly relations: Readonly<Partial<Record<string, readonly Row[]>>>;
};

export type RelationInputEnvelope<
  Row extends object = JsonObject,
  RelationName extends string = string
> = {
  readonly schemaId: string;
  readonly relations: Readonly<Record<RelationName, readonly Row[]>>;
};

export type SingleRelationRowBoundary = {
  readonly relation: RelationSetRelation;
  readonly schema: SchemaManifestV1;
};

export type ParseSingleRelationRowOptions = {
  readonly resolver?: SchemaManifestResolver;
  readonly strictSchemaId?: boolean;
};

export type ParseSingleRelationRowResult<Row extends object> =
  | {
      readonly ok: true;
      readonly diagnostics: readonly TarstateDiagnostic[];
      readonly row: Row;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly TarstateDiagnostic[];
    };

export function relationSet<Rows extends RelationSetRows<unknown>>(
  relations: Rows
): RelationSet<RelationSetRow<Rows>, ReadonlyRelationSetRows<Rows>> {
  return relationSetFromRows(relations);
}

export function relationSetFromRows<Rows extends RelationSetRows<unknown>>(
  relations: Rows
): RelationSet<RelationSetRow<Rows>, ReadonlyRelationSetRows<Rows>> {
  return { relations };
}

export function relationRows<
  Rows extends RelationSetRows<unknown>,
  const Relation extends RelationSetRelation
>(
  set: RelationSet<RelationSetRow<Rows>, Rows>,
  relation: Relation
): RelationRowsFor<Rows, Relation>;
export function relationRows<Row = JsonObject>(
  set: RelationSet<Row>,
  relation: RelationSetRelation
): readonly Row[];
export function relationRows<Row = JsonObject>(
  set: RelationSet<unknown>,
  relation: RelationSetRelation
): readonly Row[] {
  return (set.relations[relationName(relation)] ?? []) as readonly Row[];
}

export function relationSetNames<Rows extends RelationSetRows<unknown>>(
  set: RelationSet<RelationSetRow<Rows>, Rows>
): readonly (keyof Rows & string)[] {
  return Object.keys(set.relations).sort() as readonly (keyof Rows & string)[];
}

export function relationRowCounts<Rows extends RelationSetRows<unknown>>(
  rowsOrSet: RelationSet<RelationSetRow<Rows>, Rows> | Rows
): Readonly<Record<keyof Rows & string, number>> {
  const rows = isRelationSet(rowsOrSet) ? rowsOrSet.relations as Rows : rowsOrSet;
  return Object.fromEntries(
    Object.entries(rows)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, relationRowsValue]) => [name, relationRowsValue.length])
  ) as Readonly<Record<keyof Rows & string, number>>;
}

export function relationSetCounts<Rows extends RelationSetRows<unknown>>(
  set: RelationSet<RelationSetRow<Rows>, Rows>
): Readonly<Record<keyof Rows & string, number>> {
  return relationRowCounts(set);
}

export function relationSetSource(set: RelationSet<unknown>): RelationSource {
  return fromObjectSource(set.relations as Record<string, readonly unknown[]>);
}

export function relationSetFromSource(
  source: RelationSource,
  relations: readonly RelationRef[]
): RelationSet<unknown> {
  return relationSetFromRows(Object.fromEntries(
    relations.map((relationRef) => [relationRef.name, [...source.rows(relationRef)]])
  ));
}

export function singleRelationInput<
  const Relation extends RelationRef,
  Row extends RelationRefRow<Relation>
>(
  schema: SchemaManifestV1 | string,
  relation: Relation,
  row: Row
): RelationInputEnvelope<Row, RelationSetRelationName<Relation>>;
export function singleRelationInput<const Relation extends RelationNameOnly, Row extends object>(
  schema: SchemaManifestV1 | string,
  relation: Relation,
  row: Row
): RelationInputEnvelope<Row, RelationSetRelationName<Relation>>;
export function singleRelationInput(
  schema: SchemaManifestV1 | string,
  relation: RelationSetRelation,
  row: object
): RelationInputEnvelope<object> {
  const name = relationName(relation);
  return {
    schemaId: typeof schema === 'string' ? schema : schema.schemaId,
    relations: singleRelationRows(name, row)
  };
}

export function parseSingleRelationRow<Row extends object>(
  input: RelationInputBoundary,
  boundary: SingleRelationRowBoundary,
  options: ParseSingleRelationRowOptions = {}
): ParseSingleRelationRowResult<Row> {
  const diagnostics: TarstateDiagnostic[] = [];
  const expectedSchemaId = boundary.schema.schemaId;
  const relationNameValue = relationName(boundary.relation);

  if (options.strictSchemaId !== false && input.schemaId !== expectedSchemaId) {
    diagnostics.push({
      code: 'relation_invalid',
      severity: 'error',
      message: `expected schema "${expectedSchemaId}" but received "${input.schemaId}"`,
      relation: relationNameValue,
      surface: 'relation-set'
    });
  }

  const rows = input.relations[relationNameValue] ?? [];
  if (rows.length !== 1) {
    diagnostics.push({
      code: 'relation_invalid',
      severity: 'error',
      message: `relation "${relationNameValue}" must contain exactly one row`,
      relation: relationNameValue,
      surface: 'relation-set',
      detail: { count: rows.length }
    });
  }

  const row = rows[0];
  let parsedRow: Row | undefined;
  if (row !== undefined) {
    if (!isRecord(row)) {
      diagnostics.push({
        code: 'row_invalid',
        severity: 'error',
        message: `relation "${relationNameValue}" row must be an object`,
        relation: relationNameValue,
        surface: 'relation-set',
        detail: row
      });
    } else {
      try {
        const resolver = options.resolver ?? createSchemaManifestResolver();
        const relationRef = resolver.relation(boundary.schema, relationNameValue);
        diagnostics.push(...validateRelationRow(relationRef, row));
        parsedRow = row as Row;
      } catch (error) {
        diagnostics.push({
          code: 'relation_invalid',
          severity: 'error',
          message: error instanceof Error ? error.message : 'relation row validation failed',
          relation: relationNameValue,
          surface: 'relation-set',
          detail: error
        });
      }
    }
  }

  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') || parsedRow === undefined
    ? { ok: false, diagnostics }
    : { ok: true, diagnostics, row: parsedRow };
}

function relationName<const Relation extends RelationSetRelation>(
  relation: Relation
): RelationSetRelationName<Relation> {
  return (typeof relation === 'string' ? relation : relation.name) as RelationSetRelationName<Relation>;
}

function singleRelationRows<const Name extends string>(
  name: Name,
  row: object
): Readonly<Record<Name, readonly object[]>> {
  return { [name]: [row] } as unknown as Readonly<Record<Name, readonly object[]>>;
}

function isRelationSet(input: unknown): input is RelationSet<unknown> {
  return isRecord(input) && 'relations' in input && isRecord(input.relations);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
