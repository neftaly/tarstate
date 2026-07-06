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

export type RelationSet<Row = JsonObject> = {
  readonly relations: Readonly<Record<string, readonly Row[]>>;
};

export type RelationSetRows<Row = JsonObject> = Readonly<Record<string, readonly Row[]>>;
export type RelationSetRelation = string | Pick<RelationRef, 'name'>;

export type RelationInputEnvelope<Row extends object = JsonObject> = {
  readonly schemaId: string;
  readonly relations: Readonly<Record<string, readonly Row[]>>;
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

export function relationSet<Row = JsonObject>(
  relations: RelationSetRows<Row>
): RelationSet<Row> {
  return relationSetFromRows(relations);
}

export function relationSetFromRows<Row = JsonObject>(
  relations: RelationSetRows<Row>
): RelationSet<Row> {
  return { relations };
}

export function relationRows<Row = JsonObject>(
  set: RelationSet,
  relation: RelationSetRelation
): readonly Row[] {
  return (set.relations[relationName(relation)] ?? []) as readonly Row[];
}

export function relationSetNames(set: RelationSet): readonly string[] {
  return Object.keys(set.relations).sort();
}

export function relationRowCounts(
  rowsOrSet: RelationSet | RelationSetRows
): Readonly<Record<string, number>> {
  const rows = isRelationSet(rowsOrSet) ? rowsOrSet.relations : rowsOrSet;
  return Object.fromEntries(
    Object.entries(rows)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, relationRowsValue]) => [name, relationRowsValue.length])
  );
}

export function relationSetCounts(set: RelationSet): Readonly<Record<string, number>> {
  return relationRowCounts(set);
}

export function relationSetSource(set: RelationSet): RelationSource {
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

export function singleRelationInput<Row extends object>(
  schema: SchemaManifestV1 | string,
  relation: RelationSetRelation,
  row: Row
): RelationInputEnvelope<Row> {
  return {
    schemaId: typeof schema === 'string' ? schema : schema.schemaId,
    relations: {
      [relationName(relation)]: [row]
    }
  };
}

export function parseSingleRelationRow<Row extends object>(
  input: RelationInputEnvelope,
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

function relationName(relation: RelationSetRelation): string {
  return typeof relation === 'string' ? relation : relation.name;
}

function isRelationSet(input: RelationSet | RelationSetRows): input is RelationSet {
  return 'relations' in input && isRecord(input.relations);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
