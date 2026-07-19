import * as Automerge from '@automerge/automerge';
import {
  generateAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocumentId
} from '@automerge/automerge-repo';
import {
  capabilityRefKey,
  createIssue,
  type CapabilityRef,
  type Issue,
  type PortableValue
} from '@tarstate/core';
import type { SourceLifecycleAdapter } from '@tarstate/core/transactions';
import { safeMaterializePortableBytes } from '@tarstate/core/values';

type ImportedDocument = {
  readonly documentId: DocumentId;
  readonly doc: () => Automerge.Doc<unknown>;
};

/** Small host port required by the creation-only lifecycle adapter. */
export type AutomergeRepoImportPort = {
  readonly import: (bytes: Uint8Array, options: {
    readonly docId: DocumentId;
  }) => ImportedDocument;
};

export type AutomergeRepoLifecycleAdapterOptions = {
  readonly repo: AutomergeRepoImportPort;
  /** Exact source capability accepted by this host Repo. */
  readonly sourceCapability: CapabilityRef;
};

type PreparedImport = {
  readonly bytes: Uint8Array;
  readonly heads: readonly string[];
};

type PreparedImportResult =
  | { readonly success: true; readonly value: PreparedImport }
  | { readonly success: false; readonly issues: readonly Issue[] };

/**
 * Adapts stable Automerge Repo import APIs to Tarstate source creation.
 * Deletion and durable-publication claims are intentionally unsupported.
 */
export const createAutomergeRepoLifecycleAdapter = (
  options: AutomergeRepoLifecycleAdapterOptions
): SourceLifecycleAdapter => {
  const repo = options.repo;
  const sourceCapability = {
    id: options.sourceCapability.id,
    version: options.sourceCapability.version,
    contractHash: options.sourceCapability.contractHash
  };
  const capabilityKey = capabilityRefKey(sourceCapability);
  const preparedImports = new WeakMap<object, PreparedImportResult>();
  const prepare = (value: PortableValue): PreparedImportResult => {
    if (typeof value === 'object' && value !== null) {
      const cached = preparedImports.get(value);
      if (cached !== undefined) return cached;
    }
    const prepared = prepareImport(value);
    if (typeof value === 'object' && value !== null) preparedImports.set(value, prepared);
    return prepared;
  };
  const capabilityIssue = (actual: CapabilityRef): Issue => createIssue({
    code: 'automerge.lifecycle_capability_unsupported',
    phase: 'lifecycle',
    severity: 'error',
    retry: 'after_capability',
    requiredCapabilities: [sourceCapability],
    details: { actual }
  });

  return {
    preflight: (request) => {
      if (request.action === 'delete') return [deleteUnsupportedIssue(request.sourceId)];
      if (capabilityRefKey(request.sourceCapability) !== capabilityKey) {
        return [capabilityIssue(request.sourceCapability)];
      }
      const prepared = prepare(request.input);
      return prepared.success ? [] : prepared.issues;
    },
    allocateSourceId: (_input, capability) => {
      if (capabilityRefKey(capability) !== capabilityKey) {
        throw new TypeError('Automerge Repo source capability is unsupported');
      }
      return generateAutomergeUrl();
    },
    create: ({ sourceId, capability, value, context }) => {
      if (capabilityRefKey(capability) !== capabilityKey) {
        return { outcome: 'rejected', issues: [capabilityIssue(capability)] };
      }
      const prepared = prepare(value);
      if (!prepared.success) return { outcome: 'rejected', issues: prepared.issues };

      // The paired allocator is the only source of IDs for this adapter.
      const documentId = parseAutomergeUrl(sourceId as AutomergeUrl).documentId;

      context.markMutationPossible();
      const imported = repo.import(prepared.value.bytes, { docId: documentId });
      const importedDocument = imported.doc();
      if (
        imported.documentId !== documentId
        || !sameHeads(
          Automerge.getHeads(importedDocument),
          prepared.value.heads
        )
      ) {
        throw new Error('Automerge Repo import did not retain the allocated identity and exact history');
      }
      return { outcome: 'committed', issues: [], durability: 'memory' };
    },
    delete: ({ sourceId }) => ({
      outcome: 'rejected',
      issues: [deleteUnsupportedIssue(sourceId)]
    })
  };
};

const prepareImport = (value: PortableValue): PreparedImportResult => {
  const materialized = safeMaterializePortableBytes(value);
  if (!materialized.success) return materialized;
  try {
    const document = Automerge.load<unknown>(materialized.value);
    return {
      success: true,
      value: {
        bytes: materialized.value,
        heads: Automerge.getHeads(document)
      }
    };
  } catch {
    return {
      success: false,
      issues: [createIssue({
        code: 'automerge.value_invalid',
        phase: 'parse',
        severity: 'error',
        retry: 'after_input'
      })]
    };
  }
};

const deleteUnsupportedIssue = (sourceId: string): Issue => createIssue({
  code: 'automerge.lifecycle_delete_unsupported',
  phase: 'lifecycle',
  severity: 'error',
  retry: 'never',
  sourceId
});

const sameHeads = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  if (expected.size !== right.length) return false;
  for (const head of left) if (!expected.has(head)) return false;
  return true;
};
