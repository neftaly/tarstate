import type { FieldDeclaration, SchemaBody } from './schema.js';
import type {
  QueryResultRowOf,
  TypedAliases,
  TypedQuery
} from './query/authoring.js';
import type { QueryNode } from './query/model.js';
import type { ValueDeclaration } from './query/builder.js';
import type { RelationKey, RowOfRelation } from './schema-authoring.js';
import type { PortableValue } from './value.js';

type StringKey<Value> = Extract<keyof Value, string>;
type SchemaBodyOf<Schema> = Schema extends SchemaBody
  ? Schema
  : Schema extends { readonly body: infer Body extends SchemaBody }
    ? Body
    : never;
type RelationsOf<Schema> = SchemaBodyOf<Schema>['relations'];
type RelationOf<Schema, Name extends PropertyKey> = Name extends keyof RelationsOf<Schema>
  ? RelationsOf<Schema>[Name]
  : never;
type FieldsOf<Relation> = Relation extends { readonly fields: infer Fields } ? Fields : never;

declare const returningRow: unique symbol;

export type TypedReturning<Name extends string, Query extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>> = {
  readonly name: Name;
  readonly root: QueryNode;
  readonly [returningRow]?: QueryResultRowOf<Query>;
};
export const typedReturning = <const Name extends string, Query extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>>(
  name: Name,
  query: Query
): TypedReturning<Name, Query> => ({ name, root: query.root });
export type ReturningRowOf<Returning> = Returning extends TypedReturning<string, infer Query> ? QueryResultRowOf<Query> : Readonly<Record<string, unknown>>;

type CapabilityIds<References> = References extends readonly (infer Reference)[] ? Reference extends { readonly id: infer Id extends string } ? Id : never : never;
type HasCapability<References, Id extends string> = Id extends CapabilityIds<References> ? true : false;
type FieldEditKind<References> = CapabilityIds<References> extends infer Id extends string
  ? Id extends 'urn:tarstate:capability:field/replace' ? 'replace'
    : Id extends 'urn:tarstate:capability:field/counter-increment' ? 'counter-increment'
      : Id extends 'urn:tarstate:capability:field/text-splice' ? 'text-splice'
        : Id extends 'urn:tarstate:capability:field/conflict-resolve' ? 'conflict-resolve'
          : Id extends never ? never : 'custom'
  : never;
type EntityCapabilities<Relation> = Relation extends { readonly entityEditCapabilities: infer References } ? References : readonly [];
type MoveCapability<References> = HasCapability<References, 'urn:tarstate:capability:entity/move'> extends true ? true
  : HasCapability<References, 'urn:tarstate:capability:entity/copy-relocate'> extends true ? true
    : HasCapability<References, 'urn:tarstate:capability:entity/identity-preserving-move'>;
type FieldAccess<Fields> = { readonly [Field in keyof Fields]: Fields[Field] extends FieldDeclaration ? readonly FieldEditKind<Fields[Field]['editCapabilities']>[] : readonly never[] };
type EditableFieldNames<Access> = Access extends { readonly fields: infer Fields } ? { [Field in keyof Fields]-?: Fields[Field] extends readonly (infer Kind)[] ? [Kind] extends [never] ? never : Field : never }[keyof Fields] : never;

/** Compile-time edit capabilities inferred from one literal relation declaration. */
export type RelationAccessOf<Body, Name extends StringKey<RelationsOf<Body>>> = RelationOf<Body, Name> extends infer Relation
  ? {
      readonly declaration: Relation;
      readonly readable: true;
      readonly writable: EditableFieldNames<{ fields: FieldAccess<FieldsOf<Relation>> }> extends never
        ? CapabilityIds<EntityCapabilities<Relation>> extends never ? false : true
        : true;
      readonly rekey: HasCapability<EntityCapabilities<Relation>, 'urn:tarstate:capability:entity/rekey'>;
      readonly move: MoveCapability<EntityCapabilities<Relation>>;
      readonly fields: FieldAccess<FieldsOf<Relation>>;
    }
  : never;

export const relationAccess = <const Body extends SchemaBody, const Name extends StringKey<Body['relations']>>(
  body: Body,
  name: Name
): RelationAccessOf<Body, Name> => {
  const relation = body.relations[name] as Body['relations'][Name];
  const entityIds = new Set((relation.entityEditCapabilities ?? []).map(({ id }) => id));
  const fields = Object.fromEntries(Object.entries(relation.fields).map(([fieldName, declaration]) => [fieldName, (declaration.editCapabilities ?? []).map(({ id }) => fieldEditKind(id))]));
  const writable = Object.values(fields).some((kinds) => kinds.length > 0) || entityIds.size > 0;
  return {
    declaration: relation,
    readable: true,
    writable,
    rekey: entityIds.has('urn:tarstate:capability:entity/rekey'),
    move: entityIds.has('urn:tarstate:capability:entity/move') || entityIds.has('urn:tarstate:capability:entity/copy-relocate') || entityIds.has('urn:tarstate:capability:entity/identity-preserving-move'),
    fields
  } as RelationAccessOf<Body, Name>;
};

type AccessRow<Access> = Access extends { readonly declaration: infer Relation } ? RowOfRelation<Relation> : never;
type AccessKey<Access> = Access extends { readonly declaration: infer Relation } ? RelationKey<Relation> : never;

export const typedFieldEdit = <Access, Field extends EditableFieldNames<Access>>(access: Access, field: Field, value: Field extends keyof AccessRow<Access> ? AccessRow<Access>[Field] : never): { readonly field: Field; readonly value: Field extends keyof AccessRow<Access> ? AccessRow<Access>[Field] : never } => {
  void access;
  return { field, value };
};
export const typedRekey = <Access extends { readonly rekey: true }>(access: Access, key: AccessKey<Access>): { readonly kind: 'rekey'; readonly key: AccessKey<Access> } => { void access; return { kind: 'rekey', key }; };
export const typedMove = <Access extends { readonly move: true }>(access: Access, parent: PortableValue): { readonly kind: 'move'; readonly parent: PortableValue } => { void access; return { kind: 'move', parent }; };

const fieldEditKind = (id: string): string => id.startsWith('urn:tarstate:capability:field/') ? id.slice('urn:tarstate:capability:field/'.length) : 'custom';
