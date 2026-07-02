import { createElement } from 'react';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TarstateDiagnostic } from '@tarstate/core';
import {
  TarstateProvider,
  useCommit,
  useDb,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useTarstateStore,
  useView,
  type QueryHookState,
  type RowHookState,
  type TarstateCommit,
  type TarstateDbInput,
  type TarstateDbSnapshot,
  type TarstateProviderProps,
  type TarstateReactDiagnostic,
  type UseQueryOptions,
  type UseQuerySelectedOptions,
  type UseViewOptions,
  type ViewHookState
} from '@tarstate/react';
import { createStore, type Store, type StoreViewSnapshot } from '@tarstate/core/store';
import { as, from, pipe, project } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
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
  project({
    id: item.id,
    label: item.label
  })
);

describe('@tarstate/react API contract', () => {
  it('exports the provider and hook entry points', () => {
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useTarstateStore).toBeTypeOf('function');
    expect(useTarstateSnapshot).toBeTypeOf('function');
    expect(useDb).toBeTypeOf('function');
    expect(useCommit).toBeTypeOf('function');
    expect(useView).toBeTypeOf('function');
    expect(useRow).toBeTypeOf('function');
    expect(useQuery).toBeTypeOf('function');
  });

  it('keeps the provider seed API explicit', () => {
    assertType(() => expectTypeOf<TarstateProviderProps>().toMatchTypeOf<{
      readonly store?: Store;
      readonly initialDb?: TarstateDbInput;
      readonly resetKey?: string | number;
      readonly children?: unknown;
    }>());
    assertType(() => expectTypeOf<TarstateDbInput>().toMatchTypeOf<Parameters<typeof createStore>[0]>());
    assertType(() => expectTypeOf<TarstateDbSnapshot>().toMatchTypeOf<ReturnType<Store['getSnapshot']>>());
    assertType(() => expectTypeOf<TarstateCommit>().toEqualTypeOf<Store['commit']>());
    assertType(() => expectTypeOf<TarstateReactDiagnostic>().toEqualTypeOf<TarstateDiagnostic>());

    createElement(TarstateProvider, { initialDb: { items: [] }, resetKey: 'seed-a' });

    // @ts-expect-error provider seed prop was renamed to initialDb
    createElement(TarstateProvider, { db: { items: [] } });
  });

  it('keeps hook state shapes slim', () => {
    assertType(() => expectTypeOf<ViewHookState<ItemProjection>>()
      .toEqualTypeOf<Pick<StoreViewSnapshot<ItemProjection>, 'rows' | 'diagnostics' | 'revision' | 'queryKey'> & {
        readonly refresh: () => void;
      }>());
    assertType(() => expectTypeOf<QueryHookState<ItemProjection>>().toEqualTypeOf<{
      readonly data: readonly ItemProjection[];
      readonly diagnostics: readonly TarstateReactDiagnostic[];
      readonly queryKey: string;
      readonly revision: number;
      readonly refresh: () => void;
    }>());
    assertType(() => expectTypeOf<RowHookState<ItemProjection>>().toEqualTypeOf<{
      readonly row: ItemProjection | undefined;
      readonly diagnostics: readonly TarstateReactDiagnostic[];
      readonly queryKey: string;
      readonly revision: number;
      readonly refresh: () => void;
    }>());

    const view = {} as ViewHookState<ItemProjection>;
    const query = {} as QueryHookState<ItemProjection>;

    assertType(() => {
      // @ts-expect-error hook status was removed
      return view.status;
    });
    assertType(() => {
      // @ts-expect-error internal StoreView is no longer exposed
      return view.view;
    });
    assertType(() => {
      // @ts-expect-error internal StoreViewSnapshot is no longer exposed
      return view.snapshot;
    });
    assertType(() => {
      // @ts-expect-error StoreViewSnapshot version is not exposed through React hook state
      return view.version;
    });
    assertType(() => {
      // @ts-expect-error query rows are exposed as data
      return query.rows;
    });
    assertType(() => {
      // @ts-expect-error query result is only passed to select
      return query.result;
    });
  });

  it('keeps view/query options resetKey-based', () => {
    assertType(() => expectTypeOf<UseViewOptions>().toEqualTypeOf<{
      readonly resetKey?: string | number;
    }>());
    assertType(() => expectTypeOf<UseQuerySelectedOptions<ItemProjection, readonly string[]>>()
      .toMatchTypeOf<UseQueryOptions<ItemProjection, readonly string[]>>());

    const defaultQueryOptions = {
      select: (rows) => rows
    } satisfies UseQueryOptions<ItemProjection>;
    assertType(() => expectTypeOf(defaultQueryOptions.select)
      .toEqualTypeOf<(rows: readonly ItemProjection[]) => readonly ItemProjection[]>());

    const queryOptions = {
      resetKey: 'labels',
      select: (rows, result) => rows.map((row) => `${row.label}:${result.diagnostics.length}`)
    } satisfies UseQueryOptions<ItemProjection, readonly string[]>;
    expect(queryOptions.select).toBeTypeOf('function');

    function InvalidOptionsProbe() {
      // @ts-expect-error deps was removed; use resetKey for explicit view recreation
      useView(itemQuery, { deps: [] });
      // @ts-expect-error query deps was removed; use resetKey for explicit view recreation
      useQuery(itemQuery, { deps: [] });
      return null;
    }

    expect(InvalidOptionsProbe).toBeTypeOf('function');
  });

  it('keeps useRow relation keys and predicate selection without keyBy', () => {
    function TypeProbe() {
      const byRelationKey = useRow(schema.items, 'item-a');
      const byQueryPredicate = useRow(itemQuery, (row) => row.id === 'item-a');
      assertType(() => expectTypeOf(byRelationKey).toEqualTypeOf<RowHookState<ItemRow>>());
      assertType(() => expectTypeOf(byQueryPredicate).toEqualTypeOf<RowHookState<ItemProjection>>());

      // @ts-expect-error relation keys must match the relation key value
      useRow(schema.items, 1);
      // @ts-expect-error keyBy was removed; use useRow(relation, key) or useRow(query, predicate)
      useRow(itemQuery, 'item-a', { keyBy: (row: ItemProjection) => row.id });

      return null;
    }

    expect(TypeProbe).toBeTypeOf('function');
  });
});

function assertType(assertion: () => void): void {
  expect(assertion).not.toThrow();
}
