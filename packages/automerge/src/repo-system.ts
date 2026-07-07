import * as Automerge from '@automerge/automerge';
import type {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerMetadata,
  Repo,
  StorageId
} from '@automerge/automerge-repo';
import {
  runtimeSystemRelations,
  type RelationRuntimeNotification,
  type RuntimePeerRow,
  type RuntimeStorageRow,
  type RuntimeSyncRow,
  type RuntimeSystemState
} from '@tarstate/core/adapter';

import { isRecord } from './value.js';

type AutomergeRepoSystemState = {
  readonly state: () => RuntimeSystemState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly close: () => void;
};
type AutomergeRepoStorageMetric = {
  readonly type: 'doc-loaded' | 'doc-saved' | 'doc-compacted';
  readonly documentId: string;
  readonly durationMillis?: number;
  readonly numOps?: number;
  readonly numChanges?: number;
  readonly sinceHeads?: readonly string[];
  readonly savedHeads?: readonly string[];
};
type AutomergeRepoSystemStateOptions<DocumentShape extends object> = {
  readonly repo: Repo;
  readonly handle: DocHandle<DocumentShape>;
  readonly runtimeId: string;
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly notify: (notification?: RelationRuntimeNotification) => void;
};

export function createAutomergeRepoSystemState<DocumentShape extends object>(
  options: AutomergeRepoSystemStateOptions<DocumentShape>
): AutomergeRepoSystemState {
  const remoteStorageIds = new Set<string>();
  let localStorageId: string | undefined;
  let storageError: string | undefined;
  let lastStorageMetric: AutomergeRepoStorageMetric | undefined;
  let started = false;
  let closed = false;

  const peerStorageIds = () => {
    const ids: string[] = [];
    for (const peerId of options.repo.peers) {
      const storageId = peerMetadataFor(options.repo, peerId)?.storageId;
      if (storageId !== undefined) ids.push(String(storageId));
    }
    return ids;
  };
  const readStorageId = () => {
    if (options.repo.storageSubsystem === undefined) return;
    options.repo.storageId()
      .then((storageId) => {
        if (storageId === undefined || localStorageId === String(storageId)) return;
        localStorageId = String(storageId);
        options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
      })
      .catch((error: unknown) => {
        storageError = error instanceof Error ? error.message : String(error);
        options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
      });
  };
  const onRemoteHeads = (payload: DocHandleRemoteHeadsPayload) => {
    remoteStorageIds.add(String(payload.storageId));
    options.notify({ relationNames: [runtimeSystemRelations.sync.name] });
  };
  const onPeer = () => {
    for (const storageId of peerStorageIds()) remoteStorageIds.add(storageId);
    options.notify({ relationNames: [runtimeSystemRelations.peers.name, runtimeSystemRelations.sync.name] });
  };
  const onStorageMetric = (metric: unknown) => {
    if (!isRepoStorageMetric(metric) || metric.documentId !== String(options.handle.documentId)) return;
    lastStorageMetric = metric;
    options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
  };

  const start = () => {
    if (closed || started) return;
    started = true;
    for (const storageId of peerStorageIds()) remoteStorageIds.add(storageId);
    readStorageId();
    options.handle.on('remote-heads', onRemoteHeads);
    options.repo.networkSubsystem.on('peer', onPeer);
    options.repo.networkSubsystem.on('peer-disconnected', onPeer);
    options.repo.on('doc-metrics', onStorageMetric);
  };

  const stop = () => {
    if (!started) return;
    started = false;
    options.handle.off('remote-heads', onRemoteHeads);
    options.repo.networkSubsystem.off('peer', onPeer);
    options.repo.networkSubsystem.off('peer-disconnected', onPeer);
    options.repo.off('doc-metrics', onStorageMetric);
  };

  return {
    state: () => ({
      peers: runtimePeerRowsFromRepo(options.repo, options.runtimeId),
      sync: runtimeSyncRowsFromRepo({
        repo: options.repo,
        handle: options.handle,
        runtimeId: options.runtimeId,
        localHeads: safeAutomergeHeads(options.getDoc),
        storageIds: Array.from(new Set([...peerStorageIds(), ...remoteStorageIds]))
      }),
      storage: runtimeStorageRowsFromRepo({
        repo: options.repo,
        runtimeId: options.runtimeId,
        localStorageId,
        storageError,
        lastStorageMetric
      })
    }),
    start,
    stop,
    close: () => {
      closed = true;
      stop();
    }
  };
}

function runtimePeerRowsFromRepo(repo: Repo, runtime: string): readonly RuntimePeerRow[] {
  return repo.peers.map((peerId): RuntimePeerRow => {
    const metadata = peerMetadataFor(repo, peerId);
    return {
      id: `${runtime}:peer:${String(peerId)}`,
      runtime,
      peerId: String(peerId),
      state: 'connected',
      connected: true,
      ...(metadata?.isEphemeral === undefined ? {} : { ephemeral: metadata.isEphemeral }),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { detail: { metadata } })
    };
  });
}

function runtimeSyncRowsFromRepo<DocumentShape extends object>(options: {
  readonly repo: Repo;
  readonly handle: DocHandle<DocumentShape>;
  readonly runtimeId: string;
  readonly localHeads: readonly string[] | undefined;
  readonly storageIds: readonly string[];
}): readonly RuntimeSyncRow[] {
  return options.storageIds.map((storageId): RuntimeSyncRow => {
    const syncInfo = options.handle.getSyncInfo(storageId as StorageId);
    const peerId = peerIdForStorageId(options.repo, storageId);
    return {
      id: `${options.runtimeId}:sync:remote:${storageId}`,
      runtime: options.runtimeId,
      state: syncInfo === undefined ? 'unknown' : 'synced',
      documentId: String(options.handle.documentId),
      storageId,
      ...(peerId === undefined ? {} : { peerId }),
      ...(options.localHeads === undefined ? {} : { localHeads: options.localHeads }),
      ...(syncInfo?.lastHeads === undefined ? {} : { remoteHeads: [...syncInfo.lastHeads] }),
      ...(syncInfo?.lastSyncTimestamp === undefined ? {} : { updatedAt: syncInfo.lastSyncTimestamp }),
      detail: {
        source: 'automerge.repo.getSyncInfo'
      }
    };
  });
}

function runtimeStorageRowsFromRepo(options: {
  readonly repo: Repo;
  readonly runtimeId: string;
  readonly localStorageId: string | undefined;
  readonly storageError: string | undefined;
  readonly lastStorageMetric: AutomergeRepoStorageMetric | undefined;
}): readonly RuntimeStorageRow[] {
  if (options.repo.storageSubsystem === undefined) return [];

  const storage = options.localStorageId ?? 'automerge.repo.storage';
  return [{
    id: `${options.runtimeId}:storage:${storage}`,
    runtime: options.runtimeId,
    storage,
    state: options.storageError !== undefined ? 'failed' : options.lastStorageMetric === undefined ? 'idle' : 'synced',
    durability: 'durable',
    ...(options.storageError === undefined ? {} : { lastError: options.storageError }),
    detail: {
      source: 'automerge.repo.storageSubsystem',
      ...(options.localStorageId === undefined ? {} : { storageId: options.localStorageId }),
      ...(options.lastStorageMetric === undefined ? {} : { lastCompleted: options.lastStorageMetric })
    }
  }];
}

function peerMetadataFor(repo: Repo, peerId: unknown): PeerMetadata | undefined {
  return repo.peerMetadataByPeerId[String(peerId) as keyof Repo['peerMetadataByPeerId']];
}

function peerIdForStorageId(repo: Repo, storageId: string): string | undefined {
  for (const peerId of repo.peers) {
    const metadataStorageId = peerMetadataFor(repo, peerId)?.storageId;
    if (metadataStorageId !== undefined && String(metadataStorageId) === storageId) return String(peerId);
  }

  return undefined;
}

function safeAutomergeHeads<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>
): readonly string[] | undefined {
  try {
    return Automerge.getHeads(getDoc());
  } catch {
    return undefined;
  }
}

function isRepoStorageMetric(input: unknown): input is AutomergeRepoStorageMetric {
  if (!isRecord(input) || typeof input.type !== 'string' || typeof input.documentId !== 'string') return false;
  return input.type === 'doc-loaded' || input.type === 'doc-saved' || input.type === 'doc-compacted';
}
