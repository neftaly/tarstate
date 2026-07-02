import { fromIndexedObjectSource } from '@tarstate/core/indexed-source';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  numberField,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';

export type TeamRow = {
  readonly id: string;
  readonly name: string;
  readonly rank: number;
};

export type UserRow = {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly active: boolean;
  readonly age: number;
  readonly tags: readonly string[];
};

export type TaskRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly done: boolean;
  readonly points: number;
};

export const coreSchema = defineSchema({
  teams: relation<TeamRow>({
    key: 'id',
    fields: {
      id: idField('team'),
      name: stringField(),
      rank: numberField()
    }
  }),
  users: relation<UserRow>({
    key: 'id',
    fields: {
      id: idField('user'),
      teamId: refField('teams.id'),
      name: stringField(),
      active: booleanField(),
      age: numberField(),
      tags: jsonField()
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

export const designTeam: TeamRow = { id: 'design', name: 'Design', rank: 2 };
export const engineeringTeam: TeamRow = { id: 'eng', name: 'Engineering', rank: 1 };
export const adaUser: UserRow = {
  id: 'ada',
  teamId: 'eng',
  name: 'Ada',
  active: true,
  age: 37,
  tags: ['compiler', 'runtime']
};
export const beaUser: UserRow = {
  id: 'bea',
  teamId: 'design',
  name: 'Bea',
  active: true,
  age: 29,
  tags: ['research']
};
export const calUser: UserRow = {
  id: 'cal',
  teamId: 'missing',
  name: 'Cal',
  active: false,
  age: 41,
  tags: []
};
export const draftEvaluatorTask: TaskRow = {
  id: 't1',
  ownerId: 'ada',
  title: 'Draft evaluator',
  done: false,
  points: 5
};
export const shipRuntimeTask: TaskRow = {
  id: 't2',
  ownerId: 'ada',
  title: 'Ship runtime',
  done: true,
  points: 8
};
export const reviewFixturesTask: TaskRow = {
  id: 't3',
  ownerId: 'bea',
  title: 'Review fixtures',
  done: false,
  points: 3
};

export const teams: readonly TeamRow[] = [designTeam, engineeringTeam];
export const users: readonly UserRow[] = [adaUser, beaUser, calUser];
export const tasks: readonly TaskRow[] = [draftEvaluatorTask, shipRuntimeTask, reviewFixturesTask];

export const sourceData = {
  teams,
  users,
  tasks
} satisfies Record<string, readonly unknown[]>;

export function objectSource(): RelationSource {
  return fromObjectSource(sourceData);
}

export function indexedSource(): RelationSource {
  return fromIndexedObjectSource(sourceData);
}

export function emptyCoreData(): Record<string, readonly unknown[]> {
  return { teams: [], users: [], tasks: [] };
}
