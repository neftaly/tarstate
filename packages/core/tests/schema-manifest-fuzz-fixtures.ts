import type {
  CodecDeclarationV1,
  FieldManifestV1,
  RefTarget,
  RuntimeCodec,
  SchemaManifestV1
} from '@tarstate/core/schema';
import { chooseSeeded, createSeededRandom, type SeededRandom } from './fuzz-helpers.js';

export type SchemaManifestFuzzCase = {
  readonly manifest: SchemaManifestV1;
  readonly runtimeCodecs: Readonly<Record<string, RuntimeCodec>>;
};

const codecScalarKinds = ['string', 'number', 'boolean', 'null', undefined] as const;

export function makeSchemaManifestFuzzCase(
  seed: number,
  relationCount: number,
  fieldsPerRelation: number
): SchemaManifestFuzzCase {
  const random = createSeededRandom(seed);
  const relations: Record<string, SchemaManifestV1['relations'][string]> = {};
  const codecs: Record<string, CodecDeclarationV1> = {};
  const runtimeCodecs: Record<string, RuntimeCodec> = {};
  const relationNames = new Set<string>();
  const refTargets: RefTarget[] = [];

  for (let relationIndex = 0; relationIndex < relationCount; relationIndex += 1) {
    const relationName = uniqueName(relationNames, makeFuzzName('relation', seed, relationIndex, random));
    const fieldNames = new Set<string>();
    const keyName = uniqueName(fieldNames, relationIndex % 4 === 0 ? `id\n${relationIndex}` : 'id');
    const fields: Record<string, FieldManifestV1> = {
      [keyName]: relationIndex % 2 === 0
        ? { type: 'id', domain: `domain.${relationIndex}` }
        : { type: 'string' }
    };
    let key: SchemaManifestV1['relations'][string]['key'] = keyName;

    if (relationIndex % 5 === 4) {
      const secondKey = uniqueName(fieldNames, makeFuzzName('key', seed, relationIndex, random));
      fields[secondKey] = { type: 'string' };
      key = [keyName, secondKey];
    } else {
      refTargets.push({ relation: relationName, field: keyName });
    }

    for (let fieldIndex = 0; fieldIndex < fieldsPerRelation; fieldIndex += 1) {
      const fieldName = uniqueName(fieldNames, makeFuzzName('field', seed + relationIndex, fieldIndex, random));
      fields[fieldName] = makeFieldManifest(seed, relationIndex, fieldIndex, random, refTargets, codecs, runtimeCodecs);
    }

    relations[relationName] = {
      key,
      fields,
      ...(relationIndex % 7 === 0 ? { ephemeral: true } : {})
    };
  }

  return {
    manifest: {
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: `fuzz.schema.${seed}@1`,
      relations,
      ...(Object.keys(codecs).length === 0 ? {} : { codecs }),
      metadata: { seed, relationCount, fieldsPerRelation }
    },
    runtimeCodecs
  };
}

function makeFieldManifest(
  seed: number,
  relationIndex: number,
  fieldIndex: number,
  random: SeededRandom,
  refTargets: readonly RefTarget[],
  codecs: Record<string, CodecDeclarationV1>,
  runtimeCodecs: Record<string, RuntimeCodec>
): FieldManifestV1 {
  const fieldFlags = makeFieldBaseFlags(random);
  const fieldVariant = Math.floor(random() * (refTargets.length === 0 ? 7 : 8));
  switch (fieldVariant) {
    case 0:
      return { ...fieldFlags, type: 'string' };
    case 1:
      return { ...fieldFlags, type: 'number' };
    case 2:
      return { ...fieldFlags, type: 'boolean' };
    case 3:
      return { ...fieldFlags, type: 'json' };
    case 4:
      return { ...fieldFlags, type: 'id', domain: `domain.${relationIndex}.${fieldIndex}` };
    case 5:
      return { ...fieldFlags, type: 'anchoredPath' };
    case 6:
      return makeCustomFieldManifest(seed, relationIndex, fieldIndex, fieldFlags, random, codecs, runtimeCodecs);
    default:
      return { ...fieldFlags, type: 'ref', target: chooseSeeded(random, refTargets) };
  }
}

function makeCustomFieldManifest(
  seed: number,
  relationIndex: number,
  fieldIndex: number,
  fieldFlags: GeneratedFieldFlags,
  random: SeededRandom,
  codecs: Record<string, CodecDeclarationV1>,
  runtimeCodecs: Record<string, RuntimeCodec>
): FieldManifestV1 {
  const codec = makeFuzzName('codec', seed + relationIndex, fieldIndex, random);
  const codecScalar = chooseSeeded(random, codecScalarKinds);
  const description = random() < 0.35 ? `codec description\n${seed}.${relationIndex}.${fieldIndex}` : undefined;
  codecs[codec] = {
    ...(codecScalar === undefined ? {} : { scalar: codecScalar }),
    ...(description === undefined ? {} : { description }),
    ...(random() < 0.35 ? { keyable: true } : {})
  };
  runtimeCodecs[codec] = {
    codec,
    ...(description === undefined ? {} : { description })
  };
  return { ...fieldFlags, type: 'custom', codec };
}

type GeneratedFieldFlags = Pick<FieldManifestV1, 'optional' | 'nullable'>;

function makeFieldBaseFlags(random: SeededRandom): GeneratedFieldFlags {
  return {
    ...(random() < 0.20 ? { optional: true } : {}),
    ...(random() < 0.15 ? { nullable: true } : {})
  };
}

function makeFuzzName(prefix: string, seed: number, index: number, random: SeededRandom): string {
  return chooseSeeded(random, [
    `${prefix}${index}`,
    `${prefix}.${index}`,
    `${prefix}-${seed}-${index}`,
    `${prefix} ${index}`,
    `${prefix}\nsection-${index}`,
    `${prefix}#${index}`,
    `${prefix}"${index}`
  ]);
}

function uniqueName(used: Set<string>, baseName: string): string {
  let candidate = baseName;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}.${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
