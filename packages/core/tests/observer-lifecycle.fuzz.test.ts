import fc from 'fast-check';
import { expect } from 'vitest';
import { prepareManualReadOnlyAttachment } from '../src/attachment-preparation.js';
import {
  AttachmentCatalog,
  DatasetMembership,
  type DatasetMember,
  type SourceSnapshot
} from '../src/database.js';
import {
  DatabaseView,
  type DatabaseQueryMaintenanceInput,
  type MaintainedDatabaseQueryResult,
  type ObserverSnapshot,
  type QueryObserver
} from '../src/observer.js';
import { sealPreparedPlan } from '../src/internal-prepared-plan.js';
import { propertyTest } from './support/property-test.js';

type Row = { readonly id: number; readonly value: string };
type Query = { readonly kind: 'all' };
type Command =
  | { readonly kind: 'acquire'; readonly observer: number }
  | { readonly kind: 'subscribe'; readonly observer: number; readonly listener: number }
  | { readonly kind: 'unsubscribe'; readonly observer: number; readonly listener: number }
  | { readonly kind: 'close'; readonly observer: number }
  | { readonly kind: 'publish' }
  | { readonly kind: 'remove-member' }
  | { readonly kind: 'restore-member' }
  | { readonly kind: 'fail-snapshot' }
  | { readonly kind: 'recover' };

class ModelSource {
  readonly sourceId = 'source:model';
  readonly incarnation = 'source:model:one';
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #rows: readonly Row[] = [{ id: 0, value: 'value:0' }];
  #snapshotFailures = 0;
  subscriptionCount = 0;
  unsubscribeCount = 0;

  snapshot(): SourceSnapshot<{ readonly rows: readonly Row[] }> {
    if (this.#snapshotFailures > 0) {
      this.#snapshotFailures -= 1;
      throw new Error('model snapshot failure');
    }
    return {
      sourceId: this.sourceId,
      operationEpoch: 'epoch:model',
      basis: { incarnation: this.incarnation, revision: this.#revision },
      state: 'ready',
      freshness: 'current',
      storage: { rows: this.#rows },
      issues: []
    };
  }

  subscribe(listener: () => void): () => void {
    this.subscriptionCount += 1;
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCount += 1;
      this.#listeners.delete(listener);
    };
  }

  publish(sequence: number): void {
    this.#revision += 1;
    this.#rows = Object.freeze([{ id: sequence, value: `value:${sequence}` }]);
    for (const listener of Array.from(this.#listeners)) listener();
  }

  notify(): void {
    for (const listener of Array.from(this.#listeners)) listener();
  }

  failNextSnapshot(): void { this.#snapshotFailures += 1; }
  rows(): readonly Row[] { return this.#rows; }
  listenerCount(): number { return this.#listeners.size; }
}

const member = (source: ModelSource): DatasetMember => ({
  attachmentId: 'attachment:model',
  sourceId: source.sourceId,
  expectation: 'required',
  discoveryEdges: ['edge:model']
});

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('acquire'), observer: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant('subscribe'), observer: fc.integer({ min: 0, max: 2 }), listener: fc.integer({ min: 0, max: 1 }) }),
  fc.record({ kind: fc.constant('unsubscribe'), observer: fc.integer({ min: 0, max: 2 }), listener: fc.integer({ min: 0, max: 1 }) }),
  fc.record({ kind: fc.constant('close'), observer: fc.integer({ min: 0, max: 2 }) }),
  fc.constant({ kind: 'publish' }),
  fc.constant({ kind: 'remove-member' }),
  fc.constant({ kind: 'restore-member' }),
  fc.constant({ kind: 'fail-snapshot' }),
  fc.constant({ kind: 'recover' })
);

propertyTest('observer lifecycle commands preserve coherent snapshots and release resources', fc.property(
  fc.array(commandArbitrary, { minLength: 1, maxLength: 40 }),
  (commands) => {
    const source = new ModelSource();
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach({
      attachmentId: 'attachment:model',
      incarnation: 'attachment:model:one',
      sourceId: source.sourceId,
      source,
      authorityScope: 'public',
      discoveryEdges: ['edge:model'],
      preparation: prepareManualReadOnlyAttachment<{ readonly rows: readonly Row[] }, readonly Row[]>({
        schemaViewIds: ['schema:model'],
        project: (snapshot) => snapshot.state !== 'ready' || snapshot.storage == null
          ? { state: 'failed', issues: [] }
          : { state: 'ready', value: snapshot.storage.rows, issues: [] }
      })
    });
    const dataset = new DatasetMembership({ datasetId: 'dataset:model', state: 'settled', members: [member(source)] });
    const evaluate = ({ attachments }: DatabaseQueryMaintenanceInput<Query, readonly Row[]>): MaintainedDatabaseQueryResult<Row> => {
      const rows = attachments.flatMap(({ projection }) => projection);
      return { rows, resultKeys: rows.map(({ id }) => `row:${id}`), completeness: 'exact', issues: [] };
    };
    const database = new DatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public',
      authorityFingerprint: 'authority:model',
      registryFingerprint: 'registry:model',
      attachments: catalog,
      datasets: [dataset],
      canRead: () => true,
      createQueryMaintenance: ({ initialInput }) => {
        let current = evaluate(initialInput);
        return {
          getCurrentResult: () => current,
          updateInput: (input) => (current = evaluate(input)),
          close: () => undefined
        };
      }
    });
    const plan = sealPreparedPlan<Query>({
      planId: 'query:model', rootNodeId: 'query:model:root', query: { kind: 'all' },
      registryFingerprint: 'registry:model', authorityFingerprint: 'authority:model', datasetId: 'dataset:model'
    });
    const observers = new Map<number, QueryObserver<Row>>();
    const subscriptions = new Map<string, { unsubscribe: () => void; healthy: number; throwing: number }>();
    let memberPresent = true;
    let publishSequence = 0;

    const live = (id: number): QueryObserver<Row> | undefined => {
      const observer = observers.get(id);
      return observer?.getSnapshot().state === 'open' ? observer : undefined;
    };
    const assertSnapshot = (snapshot: ObserverSnapshot<Row>): void => {
      if (snapshot.state === 'closed') return;
      expect(snapshot.current.resultKeys).toHaveLength(snapshot.current.rows.length);
      expect(new Set(snapshot.current.resultKeys).size).toBe(snapshot.current.resultKeys.length);
      if (snapshot.current.readiness === 'ready') {
        expect(snapshot.current.rows).toEqual(memberPresent ? source.rows() : []);
        expect(snapshot.current.resultKeys).toEqual(snapshot.current.rows.map(({ id }) => `row:${id}`));
      }
    };

    for (const command of commands) {
      const before = new Map([...observers].map(([id, observer]) => [id, observer.getSnapshot()]));
      const countsBefore = new Map([...subscriptions].map(([key, subscription]) => [key, subscription.healthy]));
      switch (command.kind) {
        case 'acquire':
          if (live(command.observer) === undefined) observers.set(command.observer, database.observe({ plan }));
          break;
        case 'subscribe': {
          const observer = live(command.observer);
          const key = `${command.observer}:${command.listener}`;
          if (observer !== undefined && !subscriptions.has(key)) {
            const state = { unsubscribe: () => undefined, healthy: 0, throwing: 0 };
            const unsubscribeThrowing = observer.subscribe(() => { state.throwing += 1; throw new Error('modeled listener failure'); });
            const unsubscribeHealthy = observer.subscribe(() => { state.healthy += 1; });
            state.unsubscribe = () => { unsubscribeThrowing(); unsubscribeHealthy(); };
            subscriptions.set(key, state);
          }
          break;
        }
        case 'unsubscribe': {
          const key = `${command.observer}:${command.listener}`;
          subscriptions.get(key)?.unsubscribe();
          subscriptions.delete(key);
          break;
        }
        case 'close':
          observers.get(command.observer)?.close();
          observers.get(command.observer)?.close();
          for (const [key, subscription] of subscriptions) if (key.startsWith(`${command.observer}:`)) {
            subscription.unsubscribe();
            subscriptions.delete(key);
          }
          break;
        case 'publish':
          source.publish(++publishSequence);
          break;
        case 'remove-member':
          dataset.replaceMembers([], 'settled');
          memberPresent = false;
          break;
        case 'restore-member':
          dataset.replaceMembers([member(source)], 'settled');
          memberPresent = true;
          break;
        case 'fail-snapshot':
          source.failNextSnapshot();
          source.notify();
          break;
        case 'recover':
          source.publish(++publishSequence);
          break;
      }

      for (const [id, observer] of observers) {
        const snapshot = observer.getSnapshot();
        assertSnapshot(snapshot);
        if (command.kind === 'close' || command.kind === 'acquire') continue;
        if (before.get(id) === snapshot) continue;
        for (const [key, subscription] of subscriptions) {
          if (!key.startsWith(`${id}:`)) continue;
          expect(subscription.healthy).toBeGreaterThan(countsBefore.get(key) ?? -1);
          expect(subscription.throwing).toBe(subscription.healthy);
        }
      }
    }

    for (const subscription of subscriptions.values()) subscription.unsubscribe();
    for (const observer of observers.values()) { observer.close(); observer.close(); }
    expect(database.getActiveMaintenanceCount()).toBe(0);
    expect(source.listenerCount()).toBe(0);
    expect(source.unsubscribeCount).toBe(source.subscriptionCount);
    database.close();
    database.close();
    attachmentLease.close();
    expect(catalog.sourceCount()).toBe(0);
  }
));
