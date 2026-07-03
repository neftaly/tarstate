import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  TarstateProvider,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useView
} from '@tarstate/react';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { asc, as, eq, from, pipe, project, sort, value, where } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createRuntimeStore, createStore } from '@tarstate/core/store';
import { replaceAll } from '@tarstate/core/write';

type ItemRow = {
  readonly id: string;
  readonly label: string;
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
  sort(asc(item.id)),
  project({
    id: item.id,
    label: item.label
  })
);

describe('@tarstate/react core integration', () => {
  it('renders view, query, and row hook state from a real createStore provider', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha' },
        { id: 'item-b', label: 'Beta' }
      ]
    });
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      const view = useView(itemQuery);
      const query = useQuery(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });
      const rowByPredicate = useRow(itemQuery, (row) => row.id === 'item-b');
      const rowByRelation = useRow(schema.items, 'item-a');

      return createElement(
        'output',
        undefined,
        `${view.revision}:${query.data}:${rowByPredicate.row?.label ?? 'missing'}:${rowByRelation.row?.label ?? 'missing'}:${view.rows.length}`
      );
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('0:Alpha|Beta:Beta:Alpha:2'));

      await act(async () => {
        await store.commit(replaceAll(schema.items, [
          { id: 'item-c', label: 'Gamma' },
          { id: 'item-b', label: 'Beta Prime' }
        ]));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Beta Prime|Gamma:Beta Prime:missing:2'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('recreates view hooks when the query key changes', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha' },
        { id: 'item-b', label: 'Beta' }
      ]
    });
    let renderer: ReactTestRenderer | undefined;

    function Probe({ label }: { readonly label: string }) {
      const query = pipe(
        from(item),
        where(eq(item.label, value(label))),
        project({
          id: item.id,
          label: item.label
        })
      );
      const view = useView(query);
      const queryState = useQuery(query, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });
      const rowState = useRow(query, (row) => row.id === 'item-b');

      return createElement(
        'output',
        undefined,
        `${view.rows.map((row) => row.label).join('|')}:${queryState.data}:${rowState.row?.label ?? 'missing'}`
      );
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe, { label: 'Alpha' })));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('Alpha:Alpha:missing'));

      await act(async () => {
        renderer?.update(createElement(TarstateProvider, { store }, createElement(Probe, { label: 'Beta' })));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('Beta:Beta:Beta'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('propagates runtime and store refreshes through a real createRuntimeStore provider', async () => {
    const runtime = createMemoryRelationRuntime({
      items: [{ id: 'item-a', label: 'Alpha' }]
    });
    const target = runtime.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const store = createRuntimeStore({ runtime, relations: [schema.items] });
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      const snapshot = useTarstateSnapshot();
      const query = useQuery(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });

      return createElement(
        'output',
        undefined,
        `${snapshot.revision}/${query.revision}:${formatVersion(snapshot.version)}:${query.data}`
      );
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('0/0:0:Alpha'));

      await act(async () => {
        await target.apply([
          replaceAll(schema.items, [{ id: 'item-b', label: 'Beta' }])
        ]);
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1/1:1:Beta'));

      await act(async () => {
        await store.refresh();
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('2/2:1:Beta'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });
});

function renderedOutput(value: string): {
  readonly type: 'output';
  readonly props: Record<string, never>;
  readonly children: readonly [string];
} {
  return {
    type: 'output',
    props: {},
    children: [value]
  };
}

function formatVersion(value: unknown): string {
  if (value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
