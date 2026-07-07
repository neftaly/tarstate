import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  as,
  eq,
  expand,
  field,
  from,
  gt,
  gte,
  lt,
  lte,
  neq,
  pipe,
  project,
  rename,
  value,
  without,
  type ExprData,
  type Query
} from '@tarstate/core/query';
import {
  defineSchema,
  relation,
  stringField
} from '@tarstate/core/schema';

type Account = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
};

type KeyedItem = {
  readonly id: string;
  readonly key: string;
  readonly label: string;
};

type CollisionItem = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly row: string;
};

type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;

const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField(),
      kind: stringField()
    }
  }),
  keyedItems: relation<KeyedItem>({
    key: 'id',
    fields: {
      id: stringField(),
      key: stringField(),
      label: stringField()
    }
  }),
  collisionItems: relation<CollisionItem>({
    key: 'id',
    fields: {
      id: stringField(),
      key: stringField(),
      name: stringField(),
      kind: stringField(),
      row: stringField()
    }
  })
});

describe('query API contracts', () => {
  it('exposes aliased row fields only through the row namespace', () => {
    const account = as(schema.accounts, 'account');

    expect(account.name).toBe('accounts');
    expect(account.row.name).toEqual(field('account', 'name'));
    expect(account.row.id).toEqual(field('account', 'id'));
    expect('id' in account).toBe(false);
    expectTypeOf(account.name).toEqualTypeOf<string>();
    expectTypeOf(account.row.name).toEqualTypeOf<ExprData<string>>();
    expectTypeOf(account.row.id).toEqualTypeOf<ExprData<string>>();
    // @ts-expect-error Flat row-field access is not part of the aliased relation API.
    void account.id;

    const namedRows = pipe(
      from(account),
      project({
        id: account.row.id,
        name: account.row.name
      })
    );
    const named = as(namedRows, 'named');

    expect('name' in named).toBe(false);
    expect(named.row.name).toEqual(field('named', 'name'));
    expectTypeOf(named.row.name).toEqualTypeOf<ExprData<string>>();
    // @ts-expect-error Query aliases expose projected fields only through .row.
    expect(named.name).toBeUndefined();
  });

  it('supports row fields named key, name, kind, and row in the row namespace', () => {
    const item = as(schema.keyedItems, 'item');
    const keyedRows = pipe(
      from(item),
      project({
        id: item.row.id,
        key: item.row.key,
        label: item.row.label
      })
    );

    expect(item.key).toBe('id');
    expect(item.row.key).toEqual(field('item', 'key'));
    expect(from(item).relations.keyedItems?.key).toBe('id');
    expect(keyedRows.data).toMatchObject({
      op: 'project',
      projection: {
        key: field('item', 'key')
      }
    });
    expectTypeOf(item.row.key).toEqualTypeOf<ExprData<string>>();
    // @ts-expect-error Non-metadata flat row fields are not exposed on aliases.
    void item.label;
    expectTypeOf<QueryRow<typeof keyedRows>>().toEqualTypeOf<Pick<KeyedItem, 'id' | 'key' | 'label'>>();

    const collision = as(schema.collisionItems, 'collision');

    expect(collision.key).toBe('id');
    expect(collision.name).toBe('collisionItems');
    expect(collision.kind).toBe('relation');
    expect(collision.row.key).toEqual(field('collision', 'key'));
    expect(collision.row.name).toEqual(field('collision', 'name'));
    expect(collision.row.kind).toEqual(field('collision', 'kind'));
    expect(collision.row.row).toEqual(field('collision', 'row'));
    expectTypeOf(collision.row.row).toEqualTypeOf<ExprData<string>>();
  });

  it('tracks row-shape transform types for without, rename, and expand', () => {
    const account = as(schema.accounts, 'account');
    const withoutName = pipe(from(account), without('name', 'kind'));

    expectTypeOf<QueryRow<typeof withoutName>>().toEqualTypeOf<Omit<Account, 'name' | 'kind'>>();
    expect(withoutName.data).toMatchObject({ op: 'without', fields: ['name', 'kind'] });

    const renamed = pipe(from(account), rename({ name: 'label', kind: 'category' }));

    expectTypeOf<QueryRow<typeof renamed>>().toEqualTypeOf<
      Omit<Account, 'name' | 'kind'> & { readonly label: string; readonly category: string }
    >();
    expect(renamed.data).toMatchObject({
      op: 'rename',
      fields: { name: 'label', kind: 'category' }
    });

    const expanded = pipe(
      from(account),
      expand(field<ReadonlyArray<{ readonly code: string; readonly count: number }>>('account', 'pairs'), {
        as: 'pair',
        fields: ['code', 'count']
      })
    );

    expectTypeOf<QueryRow<typeof expanded>>().toMatchTypeOf<
      Account & {
        readonly pair: { readonly code: string; readonly count: number };
        readonly code: string;
        readonly count: number;
      }
    >();
    expect(expanded.data).toMatchObject({
      op: 'expand',
      as: 'pair',
      fields: ['code', 'count']
    });
  });

  it('rejects cross-type predicate comparisons', () => {
    const name = field<string>('account', 'name');
    const amount = field<number>('entry', 'amount');
    const posted = field<boolean>('entry', 'posted');

    expect(eq(name, value('Cash'))).toEqual({
      op: 'eq',
      left: name,
      right: { op: 'value', value: 'Cash' }
    });
    const invalidEq = () =>
      // @ts-expect-error equality predicates require comparable expression value types.
      eq(name, amount);
    const invalidNeq = () =>
      // @ts-expect-error inequality predicates require comparable expression value types.
      neq(amount, posted);
    const invalidLt = () =>
      // @ts-expect-error range predicates require comparable expression value types.
      lt(name, amount);
    const invalidLte = () =>
      // @ts-expect-error range predicates require comparable expression value types.
      lte(amount, name);
    const invalidGt = () =>
      // @ts-expect-error range predicates require comparable expression value types.
      gt(posted, amount);
    const invalidGte = () =>
      // @ts-expect-error range predicates require comparable expression value types.
      gte(amount, posted);
    void invalidEq;
    void invalidNeq;
    void invalidLt;
    void invalidLte;
    void invalidGt;
    void invalidGte;
  });
});
