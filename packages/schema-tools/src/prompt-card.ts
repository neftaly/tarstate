import {
  canonicalSchemaManifest,
  type CodecDeclarationV1,
  type FieldManifestV1,
  type RelationManifestV1,
  type SchemaManifestV1
} from '@tarstate/core/schema';
import { stringFieldValues } from './field-conventions.js';
import { keyFields, sortedEntries } from './names.js';

export type PromptCardOptions = {
  readonly title?: string;
};

export function emitPromptCard(input: SchemaManifestV1, options: PromptCardOptions = {}): string {
  return emitPromptCardForCanonicalManifest(canonicalSchemaManifest(input), options);
}

export function emitPromptCardForCanonicalManifest(
  manifest: SchemaManifestV1,
  options: PromptCardOptions = {}
): string {
  return [
    '# Tarstate Schema Card',
    '',
    `Title: ${jsonText(options.title ?? manifest.schemaId)}`,
    `Schema ID: ${jsonText(manifest.schemaId)}`,
    `Description: ${jsonText(manifest.description ?? 'Tarstate schema manifest.')}`,
    '',
    '## Relations',
    ...sortedEntries(manifest.relations).flatMap(([relationName, relation]) => relationLines(relationName, relation)),
    ...codecLines(manifest.codecs ?? {}),
    ...ruleLines
  ].join('\n');
}

const ruleLines = [
  '## Rules',
  '- Fields are required unless marked optional.',
  '- Nullable is separate from optional; omitted and null are different states.',
  '- Refs are scalar values pointing at the target relation key field.',
  '- Custom fields name codecs; portable manifests do not include executable validators.',
  '- Extra row fields are invalid for strict row/tool validation.',
  ''
] as const;

function relationLines(relationName: string, relation: RelationManifestV1): readonly string[] {
  return [
    `### Relation ${jsonText(relationName)}`,
    `Key: ${formatKey(relation.key)}`,
    ...(relation.description === undefined ? [] : [`Description: ${jsonText(relation.description)}`]),
    'Fields:',
    ...sortedEntries(relation.fields).map(([fieldName, field]) =>
      `- name: ${jsonText(fieldName)}; type: ${jsonText(describeField(field))}; presence: ${jsonText(presenceLabel(field))}${valueSetLabel(field)}`
    ),
    ''
  ];
}

function codecLines(codecs: Readonly<Record<string, CodecDeclarationV1>>): readonly string[] {
  const codecEntries = sortedEntries(codecs);
  if (codecEntries.length === 0) return [];
  return [
    '## Custom Codecs',
    ...codecEntries.map(([codecName, codec]) =>
      `- codec: ${jsonText(codecName)}; details: ${jsonText(describeCodec(codec))}`
    ),
    ''
  ];
}

function describeCodec(codec: CodecDeclarationV1): string {
  const labels = [
    codec.scalar === undefined ? undefined : `scalar ${codec.scalar}`,
    codec.keyable === true ? 'keyable' : undefined,
    codec.description
  ].filter((label): label is string => label !== undefined);
  return labels.length === 0 ? 'runtime-defined' : labels.join(', ');
}

function formatKey(key: RelationManifestV1['key']): string {
  return jsonText(keyFields(key));
}

function describeField(field: FieldManifestV1): string {
  switch (field.type) {
    case 'id':
      return `id(${field.domain})`;
    case 'ref':
      return `ref(${field.target.relation}.${field.target.field})`;
    case 'custom':
      return `custom(${field.codec})`;
    case 'anchoredPath':
      return 'anchoredPath';
    default:
      return field.type;
  }
}

function valueSetLabel(field: FieldManifestV1): string {
  const values = stringFieldValues(field);
  return values === undefined ? '' : `; values: ${jsonText(values)}`;
}

function presenceLabel(field: FieldManifestV1): string {
  const presence = field.optional === true ? 'optional' : 'required';
  return field.nullable === true ? `${presence}, nullable` : presence;
}

function jsonText(input: string | readonly string[]): string {
  return Array.from(JSON.stringify(input), escapePromptCardCharacter).join('');
}

function escapePromptCardCharacter(char: string): string {
  const code = char.codePointAt(0);
  return code !== undefined && shouldEscapePromptCardCharacter(code)
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : char;
}

function shouldEscapePromptCardCharacter(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f)
    || (code >= 0x7f && code <= 0x9f)
    || code === 0x200e
    || code === 0x200f
    || code === 0x2028
    || code === 0x2029
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
}
