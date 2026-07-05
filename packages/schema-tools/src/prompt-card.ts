import { canonicalSchemaManifest, type CodecDeclarationV1, type FieldManifestV1, type RelationManifestV1, type SchemaManifestV1 } from '@tarstate/core/schema';
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
  const lines: string[] = [
    '# Tarstate Schema Card',
    '',
    `Title: ${jsonText(options.title ?? manifest.schemaId)}`,
    `Schema ID: ${jsonText(manifest.schemaId)}`,
    `Description: ${jsonText(manifest.description ?? 'Tarstate schema manifest.')}`,
    ''
  ];

  lines.push('## Relations');
  for (const [relationName, relation] of sortedEntries(manifest.relations)) {
    lines.push(`### Relation ${jsonText(relationName)}`);
    lines.push(`Key: ${formatKey(relation.key)}`);
    if (relation.description !== undefined) lines.push(`Description: ${jsonText(relation.description)}`);
    lines.push('Fields:');
    for (const [fieldName, field] of sortedEntries(relation.fields)) {
      lines.push(`- name: ${jsonText(fieldName)}; type: ${jsonText(describeField(field))}; presence: ${jsonText(presenceLabel(field))}`);
    }
    lines.push('');
  }

  const codecEntries = sortedEntries(manifest.codecs ?? {});
  if (codecEntries.length > 0) {
    lines.push('## Custom Codecs');
    for (const [codecName, codec] of codecEntries) {
      lines.push(`- codec: ${jsonText(codecName)}; details: ${jsonText(describeCodec(codec))}`);
    }
    lines.push('');
  }

  lines.push('## Rules');
  lines.push('- Fields are required unless marked optional.');
  lines.push('- Nullable is separate from optional; omitted and null are different states.');
  lines.push('- Refs are scalar values pointing at the target relation key field.');
  lines.push('- Custom fields name codecs; portable manifests do not include executable validators.');
  lines.push('- Extra row fields are invalid for strict row/tool validation.');
  lines.push('');
  return lines.join('\n');
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

function presenceLabel(field: FieldManifestV1): string {
  const labels = [field.optional === true ? 'optional' : 'required'];
  if (field.nullable === true) labels.push('nullable');
  return labels.join(', ');
}

function jsonText(input: string | readonly string[]): string {
  let result = '';
  for (const char of JSON.stringify(input)) {
    const code = char.codePointAt(0);
    result += code !== undefined && shouldEscapePromptCardCharacter(code)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : char;
  }
  return result;
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
