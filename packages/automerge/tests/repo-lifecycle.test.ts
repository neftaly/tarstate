import * as Automerge from '@automerge/automerge';
import { Repo, isValidAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo';
import type { CapabilityRef } from '@tarstate/core';
import { SourceLifecycleCoordinator, type SourceLifecycleCommand } from '@tarstate/core/transactions';
import { toPortableBytes } from '@tarstate/core/values';
import { describe, expect, it, vi } from 'vitest';
import {
  createAutomergeRepoLifecycleAdapter,
  type AutomergeRepoImportPort
} from '../src/repo-lifecycle/index.js';
import { automergeRepoLifecycleIssueDeclarations } from '../src/repo-lifecycle/issues.js';

type TestDocument = {
  title: string;
  local?: boolean;
  remote?: boolean;
};

const sourceCapability: CapabilityRef = {
  id: 'urn:test:automerge-repo-source',
  version: '1',
  contractHash: `sha256:${'1'.repeat(64)}`
};
const authorityViewFingerprint = `sha256:${'2'.repeat(64)}` as const;

describe('Automerge Repo source lifecycle', () => {
  it('declares every issue owned by the optional topic', () => {
    expect(automergeRepoLifecycleIssueDeclarations.map(({ code }) => code)).toEqual([
      'automerge.lifecycle_capability_unsupported',
      'automerge.lifecycle_delete_unsupported'
    ]);
  });

  it('imports exact history once and preserves normal concurrent Automerge merging', async () => {
    const repo = new Repo();
    const importDocument = vi.spyOn(repo, 'import');
    const coordinator = lifecycle(repo);
    const original = Automerge.from<TestDocument>({ title: 'original' });
    const command = createCommand('create', Automerge.save(original));

    const created = await coordinator.execute(command);
    expect(created).toMatchObject({
      outcome: 'committed',
      action: 'create',
      durability: 'memory'
    });
    expect(created.sourceId).toMatch(/^automerge:/);
    const repeated = await coordinator.execute(command);
    expect(repeated).toBe(created);
    expect(importDocument).toHaveBeenCalledOnce();

    if (!isValidAutomergeUrl(created.sourceId)) throw new Error('Expected an Automerge source URL');
    const handle = await repo.find<TestDocument>(created.sourceId);
    expect(handle.doc()).toEqual({ title: 'original' });
    expect(Automerge.getHeads(handle.doc())).toEqual(Automerge.getHeads(original));

    const remote = Automerge.change(Automerge.clone(original), (draft) => {
      draft.remote = true;
    });
    handle.change((draft) => {
      draft.local = true;
    });
    repo.import<TestDocument>(Automerge.save(remote), {
      docId: parseAutomergeUrl(handle.url).documentId
    });
    expect(handle.doc()).toMatchObject({ title: 'original', local: true, remote: true });

    const ambiguous = await coordinator.execute(createCommand(
      'create',
      Automerge.save(Automerge.from<TestDocument>({ title: 'different' }))
    ));
    expect(ambiguous).toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'lifecycle.operation_id_ambiguous' }]
    });
    expect(importDocument).toHaveBeenCalledTimes(2);
    await repo.shutdown();
  });

  it('rejects before mutation and treats a throwing import as unknown', async () => {
    const repo = new Repo();
    const importDocument = vi.spyOn(repo, 'import');
    const coordinator = lifecycle(repo);
    const controller = new AbortController();
    controller.abort();
    const bytes = Automerge.save(Automerge.from<TestDocument>({ title: 'cancelled' }));

    await expect(coordinator.execute(createCommand('cancelled', bytes), {
      signal: controller.signal
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'lifecycle.cancelled' }]
    });
    await expect(coordinator.execute({
      ...createCommand('wrong-capability', bytes),
      request: {
        action: 'create',
        sourceCapability: { ...sourceCapability, version: '2' },
        input: toPortableBytes(bytes)
      }
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'automerge.lifecycle_capability_unsupported' }]
    });
    await expect(coordinator.execute(createCommand('invalid-bytes', new Uint8Array([1, 2, 3]))))
      .resolves.toMatchObject({
        outcome: 'rejected',
        issues: [{ code: 'automerge.value_invalid' }]
      });
    await expect(coordinator.execute({
      ...createCommand('delete-placeholder', bytes),
      request: { action: 'delete', sourceId: 'automerge:unsupported' }
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'automerge.lifecycle_delete_unsupported' }]
    });
    expect(importDocument).not.toHaveBeenCalled();
    await repo.shutdown();

    const uncertainRepo: AutomergeRepoImportPort = {
      import: () => { throw new Error('uncertain import'); }
    };
    const uncertain = await lifecycle(uncertainRepo).execute(createCommand('uncertain', bytes));
    expect(uncertain).toMatchObject({ outcome: 'unknown', durability: 'unknown' });
    expect(uncertain.issues).toContainEqual(expect.objectContaining({
      code: 'lifecycle.outcome_unknown'
    }));

    const mismatchedRepo: AutomergeRepoImportPort = {
      import: (_binary, { docId }) => ({
        documentId: docId,
        doc: () => Automerge.from<TestDocument>({ title: 'wrong history' })
      })
    };
    const mismatched = await lifecycle(mismatchedRepo).execute(createCommand('mismatched', bytes));
    expect(mismatched.outcome).toBe('unknown');
    expect(mismatched.issues).toContainEqual(expect.objectContaining({
      code: 'lifecycle.outcome_unknown'
    }));
  });
});

const lifecycle = (repo: AutomergeRepoImportPort): SourceLifecycleCoordinator =>
  new SourceLifecycleCoordinator({
    lifecycleCoordinatorId: 'lifecycle:automerge-repo',
    operationEpoch: 'epoch:automerge-repo',
    authorityViewFingerprint,
    authorize: () => ({ allowed: true }),
    adapter: createAutomergeRepoLifecycleAdapter({ repo, sourceCapability })
  });

const createCommand = (
  operationId: string,
  bytes: Uint8Array
): SourceLifecycleCommand => ({
  lifecycleCoordinatorId: 'lifecycle:automerge-repo',
  operationEpoch: 'epoch:automerge-repo',
  operationId,
  request: {
    action: 'create',
    sourceCapability,
    input: toPortableBytes(bytes)
  }
});
