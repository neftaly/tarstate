import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact, type Db, type DbTransactionInput } from '@tarstate/core/db';
import { booleanField, defineSchema, numberField, relation, stringField } from '@tarstate/core/schema';
import { insert, type WritePatch } from '@tarstate/core/write';

type LedgerRow = {
  readonly accountId: string;
  readonly entryId: string;
  readonly amount: number;
  readonly posted: boolean;
};

const malformedSchema = defineSchema({
  ledger: relation<LedgerRow>({
    key: ['accountId', 'entryId'],
    fields: {
      accountId: stringField(),
      entryId: stringField(),
      amount: numberField(),
      posted: booleanField()
    }
  })
});

const ORIGINAL_ROWS: readonly LedgerRow[] = [
  { accountId: 'cash', entryId: 'e1', amount: 10, posted: true }
];
const STAGED_ROW = { accountId: 'cash', entryId: 'staged', amount: 99, posted: false } as const satisfies LedgerRow;
const VALID_ROW = { accountId: 'bank', entryId: 'e2', amount: 20, posted: true } as const satisfies LedgerRow;

type MalformedCase = {
  readonly name: string;
  readonly input: unknown;
  readonly expectedCode: string;
};

describe('malformed write patch fuzz', () => {
  const cases: readonly MalformedCase[] = [
    {
      name: 'unknown op',
      input: { op: 'teleport', relation: malformedSchema.ledger, row: VALID_ROW },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'missing relation ref',
      input: { op: 'insert', row: VALID_ROW },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'wrong relation ref shape',
      input: { op: 'insert', relation: { kind: 'relation', name: 'ledger' }, row: VALID_ROW },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'wrong composite key tuple arity',
      input: { op: 'deleteByKey', relation: malformedSchema.ledger, key: ['cash'] },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'non-array replaceAll rows',
      input: { op: 'replaceAll', relation: malformedSchema.ledger, rows: { 0: VALID_ROW, length: 1 } },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'bad delete predicate shape',
      input: { op: 'delete', relation: malformedSchema.ledger, predicate: { op: 'not-a-predicate', left: true, right: true } },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'prototype-pollution-shaped row object',
      input: { op: 'insert', relation: malformedSchema.ledger, row: polluted({ ...VALID_ROW }) },
      expectedCode: 'write_patch_invalid'
    },
    {
      name: 'prototype-pollution-shaped patch object',
      input: polluted({ op: 'insert', relation: malformedSchema.ledger, row: VALID_ROW }),
      expectedCode: 'write_patch_invalid'
    }
  ];

  it.each(cases)('rejects forged raw patch: $name', ({ input, expectedCode }) => {
    const db = makeDb();

    const outcome = runTransaction(db, input);

    expectAtomicRejection(outcome, db, expectedCode);
  });

  it('rejects atomically when a transaction callback throws after staged writes', () => {
    const db = makeDb();
    const throwingCallback = (() => {
      throw new Error('callback exploded');
    }) as DbTransactionInput;

    const outcome = runTransaction(db, throwingCallback);

    expectAtomicRejection(outcome, db, 'transaction_failed');
  });

  it('rejects atomically when an update function throws after staged writes', () => {
    const db = makeDb();
    const throwingUpdate = {
      op: 'updateByKey',
      relation: malformedSchema.ledger,
      key: ['cash', 'e1'],
      changes: () => {
        throw new Error('update exploded');
      }
    } satisfies Partial<WritePatch>;

    const outcome = runTransaction(db, throwingUpdate);

    expectAtomicRejection(outcome, db, 'transaction_failed');
  });
});

function makeDb(): Db {
  return createDb({ ledger: ORIGINAL_ROWS });
}

function runTransaction(db: Db, input: unknown): ReturnType<typeof tryTransact> {
  return tryTransact(
    db,
    insert(malformedSchema.ledger, STAGED_ROW),
    input as DbTransactionInput,
    insert(malformedSchema.ledger, { accountId: 'bank', entryId: 'after', amount: 30, posted: true })
  );
}

function expectAtomicRejection(outcome: ReturnType<typeof tryTransact>, originalDb: Db, expectedCode: string): void {
  expect(q(originalDb, malformedSchema.ledger)).toEqual(ORIGINAL_ROWS);
  expect(outcome.committed).toBe(false);
  expect(q(outcome.db, malformedSchema.ledger)).toEqual(ORIGINAL_ROWS);
  expect(outcome.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: expectedCode, severity: 'error' })
  ]));
}

function polluted<Row extends Record<string, unknown>>(row: Row): Row {
  Object.defineProperty(row, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true
  });
  return row;
}
