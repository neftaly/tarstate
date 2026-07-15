import type { ArtifactRef } from './artifacts.js';
import type { ScalarDeclaration } from './codec.js';
import type { CapabilityRef } from './issues.js';
import type { RelationDeclaration, SchemaArtifact, SchemaBody } from './schema.js';
import type { JsonValue, PortableValue, TaggedValue } from './value.js';

type Simplify<Value> = { readonly [Key in keyof Value]: Value[Key] };
type StringKey<Value> = Extract<keyof Value, string>;

/** Identity authoring helper: const inference is erased and the portable value is unchanged. */
export const schemaLiteral = <const Body extends SchemaBody>(body: Body): Body => body;

type SchemaBodyOf<Schema> = Schema extends SchemaBody
  ? Schema
  : Schema extends { readonly body: infer Body extends SchemaBody }
    ? Body
    : never;
type RelationsOf<Schema> = SchemaBodyOf<Schema>['relations'];
type RelationOf<Schema, Name extends PropertyKey> = Name extends keyof RelationsOf<Schema> ? RelationsOf<Schema>[Name] : never;
type FieldsOf<Relation> = Relation extends { readonly fields: infer Fields } ? Fields : never;
type OptionalFieldKeys<Fields> = {
  [Key in keyof Fields]-?: Fields[Key] extends { readonly optional: true } ? Key : never
}[keyof Fields];
type RequiredFieldKeys<Fields> = Exclude<keyof Fields, OptionalFieldKeys<Fields>>;

declare const customScalarValue: unique symbol;
declare const referenceKey: unique symbol;

/** A portable custom declaration paired with its exact decoded app value. */
export type CustomScalarDeclaration<Value extends TaggedValue> = {
  readonly kind: 'custom';
  readonly codec: CapabilityRef;
  readonly [customScalarValue]: Value;
};

/** Adds only compile-time codec evidence; the returned declaration stays portable. */
export const customScalar = <Value extends TaggedValue>(codec: CapabilityRef): CustomScalarDeclaration<Value> =>
  ({ kind: 'custom', codec }) as CustomScalarDeclaration<Value>;

export type RelationKey<Relation> = Relation extends { readonly key: infer Names extends readonly string[] }
  ? KeyTuple<Relation, Names>
  : never;

export type ReferenceScalarDeclaration<Target extends RelationDeclaration> = {
  readonly kind: 'ref';
  readonly target: { readonly relationId: Target['relationId'] };
  readonly [referenceKey]: RelationKey<Target>;
};

/** Identity helper used when another literal relation needs to reference this one. */
export const relationDeclaration = <const Relation extends RelationDeclaration>(relation: Relation): Relation => relation;

/** Builds a portable reference whose app value is the target's exact key tuple. */
export const referenceTo = <const Target extends RelationDeclaration>(target: Target): ReferenceScalarDeclaration<Target> =>
  ({ kind: 'ref', target: { relationId: target.relationId } }) as ReferenceScalarDeclaration<Target>;

export type ScalarValueOf<Declaration> =
  Declaration extends CustomScalarDeclaration<infer Value> ? Value
    : Declaration extends ReferenceScalarDeclaration<infer Target> ? RelationKey<Target>
      : Declaration extends { readonly kind: 'string'; readonly values: readonly (infer Value extends string)[] } ? Value
    : Declaration extends { readonly kind: 'string' } ? string
      : Declaration extends { readonly kind: 'boolean' } ? boolean
        : Declaration extends { readonly kind: 'number' | 'integer' } ? number
          : Declaration extends { readonly kind: 'decimal' } ? { readonly kind: 'tarstate.value'; readonly type: 'decimal'; readonly value: string }
            : Declaration extends { readonly kind: 'instant' } ? { readonly kind: 'tarstate.value'; readonly type: 'instant'; readonly value: string }
              : Declaration extends { readonly kind: 'bytes' } ? { readonly kind: 'tarstate.value'; readonly type: 'bytes'; readonly value: string }
                : Declaration extends { readonly kind: 'json' } ? JsonValue
                  : Declaration extends { readonly kind: 'ref' } ? readonly PortableValue[]
                    : Declaration extends { readonly kind: 'custom' } ? TaggedValue
                      : never;

export type ValueOfDeclaration<Declaration> =
  Declaration extends ScalarDeclaration ? ScalarValueOf<Declaration>
    : Declaration extends { readonly kind: 'array'; readonly items: infer Item } ? readonly ValueOfDeclaration<Item>[]
      : Declaration extends { readonly kind: 'tuple'; readonly items: infer Items extends readonly unknown[] } ? { readonly [Index in keyof Items]: ValueOfDeclaration<Items[Index]> }
        : Declaration extends { readonly kind: 'record'; readonly fields: infer Fields; readonly optional?: infer Optional extends readonly string[] }
          ? Simplify<
              { readonly [Key in Exclude<keyof Fields, Optional[number]>]: ValueOfDeclaration<Fields[Key]> }
              & { readonly [Key in Extract<keyof Fields, Optional[number]>]?: ValueOfDeclaration<Fields[Key]> }
            >
          : never;

type FieldValue<Field> = Field extends { readonly type: infer Declaration }
  ? ScalarValueOf<Declaration> | (Field extends { readonly nullable: true } ? null : never)
  : never;

type RelationById<Body extends SchemaBody, Id> = {
  [Name in keyof Body['relations']]: Body['relations'][Name] extends { readonly relationId: Id }
    ? Body['relations'][Name]
    : never
}[keyof Body['relations']];

type SchemaScalarValue<Body extends SchemaBody, Declaration> =
  Declaration extends ReferenceScalarDeclaration<infer Target> ? RelationKey<Target>
    : Declaration extends { readonly kind: 'ref'; readonly target: { readonly relationId: infer RelationId } }
      ? SchemaRelationKey<Body, RelationById<Body, RelationId>>
      : ScalarValueOf<Declaration>;

type SchemaFieldValue<Body extends SchemaBody, Field> = Field extends { readonly type: infer Declaration }
  ? SchemaScalarValue<Body, Declaration> | (Field extends { readonly nullable: true } ? null : never)
  : never;

type SchemaRelationKey<Body extends SchemaBody, Relation> = Relation extends { readonly key: infer Names extends readonly string[] }
  ? {
      readonly [Index in keyof Names]: Names[Index] extends keyof FieldsOf<Relation>
        ? SchemaFieldValue<Body, FieldsOf<Relation>[Names[Index]]>
        : never
    }
  : never;

type SchemaRelationRow<Body extends SchemaBody, Relation> = Relation extends RelationDeclaration
  ? Simplify<
      { readonly [Key in RequiredFieldKeys<FieldsOf<Relation>>]: SchemaFieldValue<Body, FieldsOf<Relation>[Key]> }
      & { readonly [Key in OptionalFieldKeys<FieldsOf<Relation>>]?: SchemaFieldValue<Body, FieldsOf<Relation>[Key]> }
    >
  : never;

export type RowOfRelation<Relation> = Relation extends RelationDeclaration
  ? Simplify<
      { readonly [Key in RequiredFieldKeys<FieldsOf<Relation>>]: FieldValue<FieldsOf<Relation>[Key]> }
      & { readonly [Key in OptionalFieldKeys<FieldsOf<Relation>>]?: FieldValue<FieldsOf<Relation>[Key]> }
    >
  : never;

/** Exact application row inferred from a literal schema relation. */
export type SchemaRow<Schema, Name extends StringKey<RelationsOf<Schema>>> = SchemaRelationRow<SchemaBodyOf<Schema>, RelationOf<Schema, Name>>;

type KeyTuple<Relation, Names extends readonly unknown[]> = {
  readonly [Index in keyof Names]: Names[Index] extends keyof FieldsOf<Relation> ? FieldValue<FieldsOf<Relation>[Names[Index]]> : never
};

/** Ordered logical-key tuple inferred from a literal schema relation. */
export type SchemaKey<Schema, Name extends StringKey<RelationsOf<Schema>>> = SchemaRelationKey<SchemaBodyOf<Schema>, RelationOf<Schema, Name>>;

export type LiteralRelation<Body extends SchemaBody, Name extends StringKey<Body['relations']>> = {
  readonly schemaView: ArtifactRef;
  readonly relationId: Body['relations'][Name]['relationId'];
  readonly name: Name;
  readonly declaration: Body['relations'][Name];
};

export const relationLiteral = <const Body extends SchemaBody, const Name extends StringKey<Body['relations']>>(
  schema: SchemaArtifact<Body>,
  name: Name
): LiteralRelation<Body, Name> => {
  const declaration = schema.body.relations[name] as Body['relations'][Name];
  const schemaView = { id: schema.id, contentHash: schema.contentHash };
  return { schemaView, relationId: declaration.relationId, name, declaration };
};
