import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, bench, describe } from 'vitest';
import { TarstateProvider, useViewSubscription, useView } from '@tarstate/react';
import { asc, as, from, pipe, project, sort } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createStore, type StoreViewSnapshot } from '@tarstate/core/store';
import { insertOrReplace } from '@tarstate/core/write';

const reactActGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

type BenchMetrics = {
  readonly label: string;
  commits: number;
  renders: number;
  callbacks: number;
  cleanup: () => void;
};

const ROW_COUNT = 256;
const PATCH_COUNT = 512;
const BENCH_OPTIONS = {
  time: 120,
  iterations: 8,
  warmupTime: 30,
  warmupIterations: 2
};

const schema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField()
    }
  })
});
const item = as(schema.items, 'item');
const itemQuery = pipe(
  from(item),
  sort(asc(item.row.id)),
  project({
    id: item.row.id,
    label: item.row.label
  })
);
const benchMetrics: BenchMetrics[] = [];

let valueSink = 0;

describe('@tarstate/react subscription paths', () => {
  bench('useView render path', useViewRenderPath(), BENCH_OPTIONS);
  bench('imperative subscription path', imperativeSubscriptionPath(), BENCH_OPTIONS);
});

afterAll(() => {
  if (benchMetrics.length === 0) return;

  console.table(benchMetrics.map((metrics) => ({
    path: metrics.label,
    commits: metrics.commits,
    renders: metrics.renders,
    callbacks: metrics.callbacks,
    rendersPerCommit: ratio(metrics.renders, metrics.commits),
    callbacksPerCommit: ratio(metrics.callbacks, metrics.commits)
  })));

  for (const metrics of benchMetrics) metrics.cleanup();
});

function useViewRenderPath(): () => Promise<void> {
  const store = createStore({ items: makeRows() });
  const metrics: BenchMetrics = {
    label: 'useView render path',
    commits: 0,
    renders: 0,
    callbacks: 0,
    cleanup: () => undefined
  };
  let renderer: ReactTestRenderer | undefined;
  let cursor = 0;
  let selected = '';

  function Probe() {
    metrics.renders += 1;
    const state = useView(itemQuery);
    selected = selectedLabels(state.rows);

    return createElement('output', undefined, selected);
  }

  act(() => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  metrics.cleanup = () => {
    act(() => {
      renderer?.unmount();
    });
    store.close();
  };
  benchMetrics.push(metrics);

  return async () => {
    await act(async () => {
      await store.commit(patchAt(cursor));
    });
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;
    consume(selected);
  };
}

function imperativeSubscriptionPath(): () => Promise<void> {
  const store = createStore({ items: makeRows() });
  const metrics: BenchMetrics = {
    label: 'imperative subscription path',
    commits: 0,
    renders: 0,
    callbacks: 0,
    cleanup: () => undefined
  };
  const target = { text: '' };
  let renderer: ReactTestRenderer | undefined;
  let cursor = 0;

  function Probe() {
    metrics.renders += 1;
    useViewSubscription(itemQuery, {
      fireImmediately: true,
      select: (snapshot: StoreViewSnapshot<ItemProjection>) => selectedLabels(snapshot.rows),
      equality: Object.is,
      onChange: (selected: string, snapshot: StoreViewSnapshot<ItemProjection>) => {
        metrics.callbacks += 1;
        valueSink = (valueSink + snapshot.rows.length) % Number.MAX_SAFE_INTEGER;
        target.text = selected;
      }
    });

    return createElement('output', undefined, 'imperative');
  }

  act(() => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  metrics.cleanup = () => {
    act(() => {
      renderer?.unmount();
    });
    store.close();
  };
  benchMetrics.push(metrics);

  return async () => {
    await act(async () => {
      await store.commit(patchAt(cursor));
    });
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;
    consume(target.text);
  };
}

function selectedLabels(rows: readonly ItemProjection[]): string {
  return rows.map((row) => row.label).join('|');
}

function makeRows(): ItemRow[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `item-${index.toString().padStart(4, '0')}`,
    label: `label-${index % 97}`
  }));
}

function patchAt(index: number) {
  const rowIndex = (index * 37) % ROW_COUNT;
  return insertOrReplace(schema.items, {
    id: `item-${rowIndex.toString().padStart(4, '0')}`,
    label: `label-${index}-${(index * 1_009) % 10_000}`
  });
}

function consume(value: string): void {
  valueSink = (valueSink + value.length) % Number.MAX_SAFE_INTEGER;
  if (valueSink < 0) throw new Error('unreachable benchmark sink');
}

function ratio(valueValue: number, count: number): string {
  return (valueValue / Math.max(1, count)).toFixed(2);
}
