import type { FieldManifestV1 } from '@tarstate/core/schema';

export function stringFieldValues(field: FieldManifestV1): readonly string[] | undefined {
  if (field.type !== 'string') return undefined;
  return field.values;
}
