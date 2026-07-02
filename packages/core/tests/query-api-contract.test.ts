import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  as,
  expand,
  field,
  from,
  pipe,
  project,
  rename,
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

type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;

const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField(),
      kind: stringField()
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
});
