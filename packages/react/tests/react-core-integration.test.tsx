import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  TarstateProvider,
  useViewSelector,
  useRow,
  useTarstateSnapshot,
  useView
} from '@tarstate/react';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { asc, as, eq, from, pipe, project, sort, value, where } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createRuntimeStore, createStore } from '@tarstate/core/store';
import { insertOrReplace, replaceAll } from '@tarstate/core/write';

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type TagRow = {
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
  }),
  tags: relation<TagRow>({
    key: 'id',
    fields: {
      id: idField('tag'),
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

describe('@tarstate/react core integration', () => {
  it('renders view, selector, and row hook state from a real createStore provider', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha' },
        { id: 'item-b', label: 'Beta' }
      ]
    });
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      const view = useView(itemQuery);
      const selector = useViewSelector(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });
      const rowByPredicate = useRow(itemQuery, (row) => row.id === 'item-b');
      const rowByRelation = useRow(schema.items, 'item-a');

      return createElement(
        'output',
        undefined,
        `${view.revision}:${selector.data}:${rowByPredicate.row?.label ?? 'missing'}:${rowByRelation.row?.label ?? 'missing'}:${view.rows.length}`
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

  it('does not re-render a view selector subscriber on commits to an unrelated relation', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha' }],
      tags: [{ id: 'tag-a', label: 'Tag A' }]
    });
    let renderer: ReactTestRenderer | undefined;
    let renders = 0;

    function Probe() {
      renders += 1;
      const selector = useViewSelector(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });

      return createElement('output', undefined, `${renders}:${selector.data}`);
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Alpha'));

      await act(async () => {
        await store.commit(insertOrReplace(schema.tags, { id: 'tag-b', label: 'Tag B' }));
      });

      expect(renders).toBe(1);
      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Alpha'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('does not re-render when a same-relation commit is filtered out of the query', async () => {
    const visibleQuery = pipe(
      from(item),
      where(eq(item.row.label, value('Visible'))),
      project({
        id: item.row.id,
        label: item.row.label
      })
    );
    const store = createStore({
      items: [
        { id: 'item-visible', label: 'Visible' },
        { id: 'item-hidden', label: 'Hidden' }
      ],
      tags: []
    });
    const selectedRefs: unknown[] = [];
    let renderer: ReactTestRenderer | undefined;
    let renders = 0;

    function Probe() {
      renders += 1;
      const selector = useViewSelector(visibleQuery, {
        select: (rows) => rows.map((row) => row.label)
      });
      selectedRefs.push(selector.data);

      return createElement('output', undefined, `${renders}:${selector.data.join('|')}`);
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Visible'));
      expect(selectedRefs).toHaveLength(1);

      await act(async () => {
        await store.commit(insertOrReplace(schema.items, { id: 'item-hidden', label: 'Hidden Prime' }));
      });

      expect(renders).toBe(1);
      expect(selectedRefs).toHaveLength(1);
      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Visible'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('keeps selected view data stable across unrelated store commits', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha' }],
      tags: [{ id: 'tag-a', label: 'Tag A' }]
    });
    const selectedRefs: unknown[] = [];
    let selectCalls = 0;
    let selectedData: readonly string[] | undefined;
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      const selector = useViewSelector(itemQuery, {
        select: (rows) => {
          selectCalls += 1;
          return rows.map((row) => row.label);
        }
      });
      selectedData = selector.data;
      selectedRefs.push(selector.data);

      return createElement('output', undefined, selector.data.join('|'));
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      const initialData = selectedData;
      expect(selectCalls).toBe(1);
      expect(selectedRefs).toHaveLength(1);
      expect(renderer?.toJSON()).toEqual(renderedOutput('Alpha'));

      await act(async () => {
        await store.commit(insertOrReplace(schema.tags, { id: 'tag-b', label: 'Tag B' }));
      });

      expect(selectCalls).toBe(1);
      expect(selectedData).toBe(initialData);
      expect(selectedRefs).toEqual([initialData]);
      expect(renderer?.toJSON()).toEqual(renderedOutput('Alpha'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('uses selector equality to skip renders when selected data is equivalent', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha' },
        { id: 'item-b', label: 'Beta' }
      ],
      tags: []
    });
    let renderer: ReactTestRenderer | undefined;
    let renders = 0;

    function Probe() {
      renders += 1;
      const selector = useViewSelector(itemQuery, {
        select: (rows: readonly ItemRow[]) => rows.length,
        equality: Object.is
      });

      return createElement('output', undefined, `${renders}:${selector.data}`);
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1:2'));

      await act(async () => {
        await store.commit(insertOrReplace(schema.items, { id: 'item-b', label: 'Beta Prime' }));
      });

      expect(renders).toBe(1);
      expect(renderer?.toJSON()).toEqual(renderedOutput('1:2'));
    } finally {
      act(() => {
        renderer?.unmount();
      });
      store.close();
    }
  });

  it('does not re-render a keyed row subscriber when a different row changes', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha' },
        { id: 'item-b', label: 'Beta' }
      ],
      tags: []
    });
    let renderer: ReactTestRenderer | undefined;
    let renders = 0;

    function Probe() {
      renders += 1;
      const state = useRow(schema.items, 'item-a');

      return createElement('output', undefined, `${renders}:${state.row?.label ?? 'missing'}`);
    }

    try {
      await act(async () => {
        renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
      });

      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Alpha'));

      await act(async () => {
        await store.commit(insertOrReplace(schema.items, { id: 'item-b', label: 'Beta Prime' }));
      });

      expect(renders).toBe(1);
      expect(renderer?.toJSON()).toEqual(renderedOutput('1:Alpha'));
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
      ],
      tags: []
    });
    let renderer: ReactTestRenderer | undefined;

    function Probe({ label }: { readonly label: string }) {
      const query = pipe(
        from(item),
        where(eq(item.row.label, value(label))),
        project({
          id: item.row.id,
          label: item.row.label
        })
      );
      const view = useView(query);
      const selectorState = useViewSelector(query, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });
      const rowState = useRow(query, (row) => row.id === 'item-b');

      return createElement(
        'output',
        undefined,
        `${view.rows.map((row) => row.label).join('|')}:${selectorState.data}:${rowState.row?.label ?? 'missing'}`
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
      const selector = useViewSelector(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      });

      return createElement(
        'output',
        undefined,
        `${snapshot.revision}/${selector.revision}:${formatVersion(snapshot.version)}:${selector.data}`
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

      expect(renderer?.toJSON()).toEqual(renderedOutput('2/1:1:Beta'));
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
