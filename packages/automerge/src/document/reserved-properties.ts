export const automergeMetadataProperty = '__tarstateMetaV1' as const;

export const isAutomergeReservedRootProperty = (property: string): boolean =>
  /^__tarstateMetaV[1-9][0-9]*$/.test(property);
