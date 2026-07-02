import { describe, expectTypeOf, it } from 'vitest';
import { as, env, eq, field, gt, gte, lt, lte, neq, value } from '@tarstate/core/query';
import type { PredicateData } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, numberField, refField, relation, stringField } from '@tarstate/core/schema';

type UserRow = {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly active: boolean;
  readonly age: number;
};

type TaskRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly done: boolean;
  readonly points: number;
};

const schema = defineSchema({
  users: relation<UserRow>({
    key: 'id',
    fields: {
      id: idField('user'),
      teamId: refField('teams.id'),
      name: stringField(),
      active: booleanField(),
      age: numberField()
    }
  }),
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      ownerId: refField('users.id'),
      title: stringField(),
      done: booleanField(),
      points: numberField()
    }
  })
});

describe('query predicate types', () => {
  it('accepts same-value-type expression comparisons', () => {
    const user = as(schema.users, 'user');
    const task = as(schema.tasks, 'task');

    expectTypeOf(eq(user.id, user.name)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(user.id, task.ownerId)).toEqualTypeOf<PredicateData>();
    expectTypeOf(neq(user.age, task.points)).toEqualTypeOf<PredicateData>();
    expectTypeOf(lt(user.age, task.points)).toEqualTypeOf<PredicateData>();
    expectTypeOf(lte(user.age, task.points)).toEqualTypeOf<PredicateData>();
    expectTypeOf(gt(user.age, task.points)).toEqualTypeOf<PredicateData>();
    expectTypeOf(gte(user.age, task.points)).toEqualTypeOf<PredicateData>();
  });

  it('preserves ergonomic literal comparisons', () => {
    const user = as(schema.users, 'user');

    expectTypeOf(eq(user.id, 'ada')).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq('ada', user.id)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(user.age, 37)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(37, user.age)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(user.active, true)).toEqualTypeOf<PredicateData>();
    expectTypeOf(gt(user.age, 18)).toEqualTypeOf<PredicateData>();
  });

  it('accepts env and explicit value comparisons with matching value types', () => {
    const user = as(schema.users, 'user');

    expectTypeOf(eq(user.id, value('ada'))).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(value('ada'), user.id)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(user.age, value(37))).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(value(37), user.age)).toEqualTypeOf<PredicateData>();
    expectTypeOf(gte(user.age, env<number>('minimumAge'))).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(env<string>('currentUserId'), user.id)).toEqualTypeOf<PredicateData>();
    expectTypeOf(eq(field<string>('user', 'id'), 'ada')).toEqualTypeOf<PredicateData>();
  });

  it('rejects obvious cross-type comparisons', () => {
    const user = as(schema.users, 'user');

    // @ts-expect-error string expression cannot be compared to number expression.
    eq(user.id, user.age);
    // @ts-expect-error number expression cannot be compared to string expression.
    eq(user.age, user.id);
    // @ts-expect-error string expression cannot be compared to number literal.
    eq(user.id, 37);
    // @ts-expect-error number expression cannot be compared to string literal.
    eq(user.age, '37');
    // @ts-expect-error typed env values participate in predicate value checks.
    gt(user.age, env<string>('minimumAge'));
    // @ts-expect-error explicit values participate in predicate value checks.
    lt(user.name, value(37));
  });
});
