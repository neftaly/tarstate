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
  })
});

describe('query API contracts', () => {
  it('keeps colliding alias fields in the $ namespace', () => {
    const account = as(schema.accounts, 'account');

    expect(account.name).toBe('accounts');
    expect(account.$.name).toEqual(field('account', 'name'));
    expect(account.id).toEqual(field('account', 'id'));
    expect(account.$.id).toEqual(account.id);
    expectTypeOf(account.name).toEqualTypeOf<string>();
    expectTypeOf(account.$.name).toEqualTypeOf<ExprData<string>>();
    expectTypeOf(account.id).toEqualTypeOf<ExprData<string>>();

    const namedRows = pipe(
      from(account),
      project({
        id: account.id,
        name: account.$.name
      })
    );
    const named = as(namedRows, 'named');

    expect('name' in named).toBe(false);
    expect(named.$.name).toEqual(field('named', 'name'));
    expectTypeOf(named.$.name).toEqualTypeOf<ExprData<string>>();
    // @ts-expect-error Colliding field names must use the namespace.
    expect(named.name).toBeUndefined();
  });

  it('keeps aliased row fields named key in the $ namespace', () => {
    const item = as(schema.keyedItems, 'item');
    const keyedRows = pipe(
      from(item),
      project({
        id: item.id,
        key: item.$.key,
        label: item.label
      })
    );

    expect(item.key).toBe('id');
    expect(item.$.key).toEqual(field('item', 'key'));
    expect(from(item).relations.keyedItems?.key).toBe('id');
    expect(keyedRows.data).toMatchObject({
      op: 'project',
      projection: {
        key: field('item', 'key')
      }
    });
    expectTypeOf(item.$.key).toEqualTypeOf<ExprData<string>>();
    expectTypeOf<QueryRow<typeof keyedRows>>().toEqualTypeOf<Pick<KeyedItem, 'id' | 'key' | 'label'>>();
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
