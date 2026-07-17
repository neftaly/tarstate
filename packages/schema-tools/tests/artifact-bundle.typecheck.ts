import { prepareArtifactBundle } from '../src/artifact-bundle/index.js';

declare const generatedBundle: {
  readonly formatVersion: 1;
  readonly artifacts: readonly unknown[];
  readonly declarations: {
    readonly workspace: unknown;
    readonly archive: unknown;
  };
};

const preparedPromise = prepareArtifactBundle(generatedBundle);
type PreparedResult = Awaited<typeof preparedPromise>;
type PreparedCatalog = Extract<PreparedResult, { readonly success: true }>['value'];
declare const catalog: PreparedCatalog;

catalog.attachment('workspace');
catalog.attachment('archive');
const schema = catalog.artifact({
  id: 'urn:test:schema',
  contentHash: `sha256:${'a'.repeat(64)}`
}, 'schema');
if (schema.success) {
  const exactKind: 'schema' = schema.value.kind;
  void exactKind;
}

// @ts-expect-error generated declaration names reject authored misspellings
catalog.attachment('workspaec');

void preparedPromise;
