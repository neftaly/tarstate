import {
  customScalar,
  pipe,
  relationDeclaration,
  relationLiteral,
  referenceTo,
  schemaLiteral,
  typedCompare,
  typedFrom,
  typedParameter,
  typedPreparedPlan,
  typedWhere,
  type CommitReceipt,
  type QueryNode,
  type TaggedValue
} from '@tarstate/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { useDatabase, useMutationState, useQuery, useRow, type MutationEntry, type ReactPreparedPlan } from '../src/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaView = { id: 'urn:test:react-types', contentHash: hash('a') } as const;
const slugCodec = { id: 'urn:test:codec:slug', version: '1', contractHash: hash('b') } as const;
type Slug = TaggedValue & { readonly type: 'slug'; readonly value: string };

const accounts = relationDeclaration({
  relationId: 'example.account',
  key: ['tenant', 'accountId'],
  fields: {
    tenant: { type: { kind: 'string' } },
    accountId: { type: { kind: 'integer' } }
  }
});

const schema = schemaLiteral({
  relations: {
    accounts,
    entries: {
      relationId: 'example.entry',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        owner: { type: referenceTo(accounts) },
        slug: { type: customScalar<Slug>(slugCodec) },
        note: { type: { kind: 'string' }, optional: true }
      }
    }
  }
});

const entries = relationLiteral(schemaView, schema, 'entries');
const base = typedFrom(entries, 'entry');
const query = pipe(
  base,
  typedWhere(typedCompare('eq', base.aliases.entry.row.owner, typedParameter('owner', referenceTo(accounts)))),
  typedWhere(typedCompare('eq', base.aliases.entry.row.slug, typedParameter('slug', customScalar<Slug>(slugCodec))))
);
const rawPlan = {
  planId: 'plan:entries',
  rootNodeId: 'plan:entries:root',
  query: query.root,
  registryFingerprint: 'registry:one',
  authorityFingerprint: 'authority:one',
  datasetId: 'dataset:one'
};
const prepared = typedPreparedPlan(rawPlan, query);
type Row = {
  readonly id: string;
  readonly owner: readonly [string, number];
  readonly slug: Slug;
  readonly note?: string;
};
type Parameters = { readonly owner: readonly [string, number]; readonly slug: Slug };
const reactPlan: ReactPreparedPlan<QueryNode, Row, Parameters> = prepared;
const slug: Slug = { kind: 'tarstate.value', type: 'slug', value: 'entry' };

const typeFixture = (): void => {
  const snapshot = useQuery(reactPlan, { parameters: { owner: ['tenant', 7], slug } });
  if (snapshot.state === 'open') expectTypeOf(snapshot.current.rows[0]).toEqualTypeOf<Row | undefined>();
  expectTypeOf(useQuery(reactPlan, {
    parameters: { owner: ['tenant', 7], slug },
    selectSnapshot: (current) => current.state === 'open' ? current.current.rows.length : 0
  })).toEqualTypeOf<number>();
  expectTypeOf(useRow(reactPlan, 'entry:one', { parameters: { owner: ['tenant', 7], slug } })).toEqualTypeOf<Row | undefined>();
  expectTypeOf(useMutationState({ selectState: ({ pendingCount }) => pendingCount })).toEqualTypeOf<number>();
  const mutation = useMutationState().mutations[0];
  if (mutation?.state === 'settled') expectTypeOf(mutation.receipt).toEqualTypeOf<CommitReceipt>();
  if (mutation?.state === 'failed') expectTypeOf(mutation.error.message).toEqualTypeOf<string>();

  // @ts-expect-error reference parameters preserve target tuple arity
  useQuery(reactPlan, { parameters: { owner: ['tenant'], slug } });
  // @ts-expect-error reference parameters preserve target key member types
  useRow(reactPlan, 'entry:one', { parameters: { owner: [7, 'tenant'], slug } });
  // @ts-expect-error custom codec parameters keep their exact decoded tag type
  useQuery(reactPlan, { parameters: { owner: ['tenant', 7], slug: { kind: 'tarstate.value', type: 'other', value: 'entry' } } });
  // @ts-expect-error prepared plans reject undeclared parameter names
  useQuery(reactPlan, { parameters: { owner: ['tenant', 7], slug, extra: true } });
  // @ts-expect-error selector props use their self-documenting v1 names
  useQuery(reactPlan, { parameters: { owner: ['tenant', 7], slug }, select: () => 0 });
  // @ts-expect-error the borrowed database hook does not accept caller-selected type assertions
  useDatabase<QueryNode, Row>();
};
void typeFixture;

// @ts-expect-error pending mutations cannot contain terminal receipt evidence
const invalidPendingMutation: MutationEntry = { mutationId: 1, operationEpoch: 'epoch', operationId: 'operation', attachmentId: 'attachment', state: 'pending', receipt: {} as CommitReceipt };
void invalidPendingMutation;

describe('React typed-query contract', () => {
  it('keeps type evidence phantom and the prepared plan unchanged', () => {
    expect(prepared).toBe(rawPlan);
    expect(Object.keys(prepared)).not.toContain('__tarstateRowType');
    expectTypeOf(prepared).toMatchTypeOf<ReactPreparedPlan<QueryNode, Row, Parameters>>();
  });
});
