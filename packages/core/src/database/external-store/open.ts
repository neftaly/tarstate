import {
  bindAttachmentProjection,
  prepareDatabaseAttachment,
  type ReadyAttachmentPreparation
} from '../../attachment/preparation.js';
import { embeddedArtifactKey, indexEmbeddedArtifacts } from '../../attachment/embedded-artifacts.js';
import {
  createMappedAttachmentProjector,
  createMappedDatabaseProjection
} from '../../attachment/mapped-database-projection.js';
import { createAttachmentTransactionService } from '../../attachment/transaction-service.js';
import { createLogicalConstraintQuery } from '../../attachment/logical-constraint-query.js';
import {
  builtInCapabilityRefs,
  registerBuiltInCapabilities
} from '../../builtins.js';
import { acquireExternalStoreRuntime, type AtomicExternalStore } from '../../external-store.js';
import { HostRuntimeRegistry } from '../../host.js';
import { createIssue, type ParseResult } from '../../issues.js';
import type { WritableLogicalState } from '../../logical-edit.js';
import type { CompiledStorageMapping } from '../../mapping.js';
import { CapabilityRegistry } from '../../registry.js';
import { safeParseJsonValue } from '../../value.js';
import { createExternalStoreAtomicSource } from './atomic-source.js';
import { createLiveExternalStoreDatabase } from './live.js';
import { createExternalStoreMappedBinding } from './mapped-binding.js';
import type { ExternalStoreDatabase } from './model.js';

export type OpenExternalStoreDatabaseOptions<State extends object> = {
  readonly sourceId: string;
  readonly store: AtomicExternalStore<State>;
  readonly storeIdentity: object;
  readonly declaration: unknown;
  readonly embeddedArtifacts: unknown;
  readonly authorityScope: string;
  readonly attachmentId?: string;
  /** Optional host boundary for explicit runtime isolation and shared lease ownership. */
  readonly hostRegistry?: HostRuntimeRegistry;
  /** Optional capability policy; ordinary JSON-tree databases use the standard registry. */
  readonly registry?: CapabilityRegistry;
};

/** Opens a writable relational database over plain immutable external-store state. */
export const openExternalStoreDatabase = async <State extends object>(
  input: OpenExternalStoreDatabaseOptions<State>
): Promise<ParseResult<ExternalStoreDatabase>> => {
  assertIdentity(input);
  const declaration = safeParseJsonValue(input.declaration);
  if (!declaration.success) return declaration;
  const embedded = safeParseJsonValue(input.embeddedArtifacts);
  if (!embedded.success) return embedded;
  const artifacts = indexEmbeddedArtifacts(embedded.value);
  if (!artifacts.success) return artifacts;

  const registry = input.registry ?? await standardExternalStoreRegistry();
  const attachmentId = input.attachmentId ?? input.sourceId;
  const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
    sourceId: input.sourceId,
    bootstrap: { status: 'ready', declaration: declaration.value },
    resolveArtifact: (reference) => artifacts.value.get(
      embeddedArtifactKey(reference.id, reference.contentHash)
    ),
    registry,
    createConstraintQuery: ({ schemaView, relationIds, registry: constraintRegistry }) =>
      createLogicalConstraintQuery({
        schemaView,
        relationIds,
        registry: constraintRegistry,
        sourceId: input.sourceId,
        attachmentId
      })
  });
  if (preparation.state !== 'ready') return { success: false, issues: preparation.issues };
  if (!preparation.writable
    || preparation.mapping === undefined
    || preparation.declaration === undefined) {
    return {
      success: false,
      issues: preparation.issues.length > 0
        ? preparation.issues
        : [createIssue({
            code: 'transaction.attachment_unavailable',
            details: { reason: 'writable_mapping_required' }
          })]
    };
  }
  const unsupported = unsupportedMappingIssue(preparation.mapping, input.sourceId);
  if (unsupported !== undefined) return { success: false, issues: [unsupported] };

  const lease = acquireExternalStoreRuntime({
    registry: input.hostRegistry ?? defaultHostRegistry,
    sourceId: input.sourceId,
    store: input.store,
    storeIdentity: input.storeIdentity
  });
  const source = createExternalStoreAtomicSource(lease);
  try {
    const binding = createExternalStoreMappedBinding<State>({
      mapping: preparation.mapping,
      registry
    });
    const attachmentIncarnation = globalThis.crypto.randomUUID();
    const projector = createMappedAttachmentProjector({
      binding,
      constraints: preparation.constraints
    });
    const projection = createMappedDatabaseProjection({
      projector,
      schemaView: preparation.declaration.storageSchema,
      relationIds: [...preparation.relations.keys()],
      sourceId: input.sourceId,
      attachmentId,
      occurrenceId: (row) => row.locator.rowIncarnation
    });
    const boundPreparation = bindAttachmentProjection(
      preparation as ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
      projection
    );
    const transactions = await createAttachmentTransactionService<State, import('./json-tree.js').JsonTreeCommand>({
      attachmentId,
      attachmentIncarnation,
      authorityScope: input.authorityScope,
      preparation: boundPreparation,
      source,
      bindings: [binding],
      registry,
      durability: 'memory'
    });
    return {
      success: true,
      value: createLiveExternalStoreDatabase({
        attachmentId,
        incarnation: attachmentIncarnation,
        authorityScope: input.authorityScope,
        schemaView: preparation.declaration.storageSchema,
        transactions,
        preparation: boundPreparation,
        source,
        projector
      }),
      issues: preparation.issues
    };
  } catch (error) {
    source.close();
    throw error;
  }
};

const createStandardExternalStoreRegistry = async (): Promise<CapabilityRegistry> => {
  const registry = new CapabilityRegistry('tarstate:external-store-standard');
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'tarstate:external-store:field-replace-v1',
    implementation: Object.freeze({ kind: 'json-tree-field-replace' })
  });
  return registry;
};

const standardExternalStoreRegistryPromise = createStandardExternalStoreRegistry();

const standardExternalStoreRegistry = (): Promise<CapabilityRegistry> =>
  standardExternalStoreRegistryPromise;

const unsupportedMappingIssue = (
  mapping: CompiledStorageMapping,
  sourceId: string
): ReturnType<typeof createIssue> | undefined => {
  for (const [relationId, relation] of mapping.relations) {
    const fields = [...Object.entries(relation.mapping.keys), ...Object.entries(relation.mapping.fields)];
    for (const [field, mapped] of fields) {
      if (mapped.kind === 'source-metadata'
        && mapped.value === 'collection-element-identity') {
        return createIssue({
          code: 'mapping.source_metadata_unavailable',
          phase: 'resolve',
          severity: 'error',
          retry: 'after_input',
          sourceId,
          relationId,
          details: { field, value: mapped.value, source: 'external-store' }
        });
      }
    }
  }
  return undefined;
};

const assertIdentity = <State extends object>(
  input: OpenExternalStoreDatabaseOptions<State>
): void => {
  if (typeof input.sourceId !== 'string' || input.sourceId.length === 0) {
    throw new TypeError('sourceId must be a non-empty string');
  }
  if (typeof input.authorityScope !== 'string' || input.authorityScope.length === 0) {
    throw new TypeError('authorityScope must be a non-empty string');
  }
  if (input.attachmentId !== undefined
    && (typeof input.attachmentId !== 'string' || input.attachmentId.length === 0)) {
    throw new TypeError('attachmentId must be a non-empty string');
  }
  if (input.storeIdentity === null || typeof input.storeIdentity !== 'object') {
    throw new TypeError('storeIdentity must be an object');
  }
};

const defaultHostRegistry = new HostRuntimeRegistry({
  trustPolicyId: 'tarstate:external-store-default-host'
});
