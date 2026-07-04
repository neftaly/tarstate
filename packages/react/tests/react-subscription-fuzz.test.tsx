import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { TarstateProvider, shallow, useViewSubscription } from '@tarstate/react';
import { asc, as, from, pipe, project, sort } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createStore, type StoreViewSnapshot } from '@tarstate/core/store';
import { insertOrReplace, type WritePatch } from '@tarstate/core/write';

const reactActGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

type TagRow = {
  readonly id: string;
  readonly label: string;
};

type SeededRandom = () => number;
type FuzzAction = 'same-length-item' | 'different-length-item' | 'insert-item' | 'tag-only' | 'reset-key' | 'unmount' | 'remount';
type SubscriptionEvent = {
  readonly selected: readonly number[];
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
  sort(asc(item.id)),
  project({
    id: item.id,
    label: item.label
  })
);
const seeds = resolveFuzzSeeds([0x7e11, 0x7e12, 0x7e13, 0x7e14] as const);
const mountedActions = ['same-length-item', 'different-length-item', 'insert-item', 'tag-only', 'reset-key', 'unmount'] as const;
const unmountedActions = ['same-length-item', 'different-length-item', 'insert-item', 'tag-only', 'remount'] as const;

describe('@tarstate/react shallow equality seeded fuzz', () => {
  it('matches the public shallow contract', () => {
    for (const seed of resolveFuzzSeeds([1, 7, 31, 127, 8_191] as const)) {
      const random = createSeededRandom(seed);
      for (let step = 0; step < 96; step += 1) {
        const left = randomShallowValue(random, 0);
        const right = randomShallowPair(random, left);
        expect(shallow(left, right)).toBe(expectedShallow(left, right));
      }
    }
  });
});

describe('@tarstate/react imperative subscription seeded fuzz', () => {
  it('matches shallow equality and lifecycle expectations without React reconciliation', async () => {
    for (const seed of seeds) {
      await runSubscriptionFuzz(seed);
    }
  });
});

async function runSubscriptionFuzz(seed: number): Promise<void> {
  const random = createSeededRandom(seed);
  const store = createStore({
    items: seededRows(seed, 6),
    tags: [{ id: 'tag-0', label: 'Tag 0' }]
  });
  const target = { text: '' };
  const events: SubscriptionEvent[] = [];
  let rows = seededRows(seed, 6);
  let mounted = true;
  let subscriptionKey = 0;
  let renders = 0;
  let activeSelected: readonly number[] | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe({ resetKey }: { readonly resetKey: number }) {
    renders += 1;
    useViewSubscription(itemQuery, {
      resetKey,
      fireImmediately: true,
      select: (snapshot: StoreViewSnapshot<ItemProjection>) => snapshot.rows.map((row) => row.label.length),
      equality: shallow,
      onChange: (selected: readonly number[], snapshot: StoreViewSnapshot<ItemProjection>) => {
        events.push({ selected: [...selected] });
        expect(snapshot.rows.length).toBe(selected.length);
        target.text = formatSelected(selected);
      }
    });

    return createElement('output', undefined, `renders:${renders}`);
  }

  const renderApp = () => createElement(
    TarstateProvider,
    { store },
    mounted ? createElement(Probe, { resetKey: subscriptionKey }) : null
  );

  try {
    await act(async () => {
      renderer = create(renderApp());
    });

    activeSelected = selectedLengths(rows);
    expect(events, `seed ${seed} initial event`).toEqual([
      { selected: activeSelected }
    ]);
    expect(target.text, `seed ${seed} initial target`).toBe(formatSelected(activeSelected));
    expect(renders, `seed ${seed} initial render`).toBe(1);

    for (let step = 0; step < 48; step += 1) {
      const action = chooseAction(random, mounted, step);
      const label = `seed ${seed} step ${step} ${action}`;

      switch (action) {
        case 'same-length-item': {
          const index = randomIndex(random, rows.length);
          const current = rows[index];
          if (current === undefined) throw new Error('fuzz row index escaped rows');
          const nextRow = {
            ...current,
            label: labelOfLength(current.label.length, seed, step, index + 101)
          };
          await commitRows(insertOrReplace(schema.items, nextRow), replaceRow(rows, nextRow), label);
          break;
        }
        case 'different-length-item': {
          const index = randomIndex(random, rows.length);
          const current = rows[index];
          if (current === undefined) throw new Error('fuzz row index escaped rows');
          const nextLength = differentLength(current.label.length, random);
          const nextRow = {
            ...current,
            label: labelOfLength(nextLength, seed, step, index + 211)
          };
          await commitRows(insertOrReplace(schema.items, nextRow), replaceRow(rows, nextRow), label);
          break;
        }
        case 'insert-item': {
          const nextRow = {
            id: `item-${rows.length}`,
            label: labelOfLength(1 + randomIndex(random, 11), seed, step, 307)
          };
          await commitRows(insertOrReplace(schema.items, nextRow), [...rows, nextRow], label);
          break;
        }
        case 'tag-only': {
          const tag = {
            id: `tag-${step % 7}`,
            label: labelOfLength(3 + randomIndex(random, 5), seed, step, 401)
          };
          await commitRows(insertOrReplace(schema.tags, tag), rows, label);
          break;
        }
        case 'reset-key': {
          const beforeEvents = events.length;
          subscriptionKey += 1;
          await act(async () => {
            renderer?.update(renderApp());
          });

          activeSelected = selectedLengths(rows);
          expect(events.length, label).toBe(beforeEvents + 1);
          expect(events.at(-1)?.selected, label).toEqual(activeSelected);
          expect(target.text, label).toBe(formatSelected(activeSelected));
          break;
        }
        case 'unmount': {
          const beforeEvents = events.length;
          const beforeRenders = renders;
          mounted = false;
          await act(async () => {
            renderer?.update(renderApp());
          });

          expect(events.length, label).toBe(beforeEvents);
          expect(renders, label).toBe(beforeRenders);
          break;
        }
        case 'remount': {
          const beforeEvents = events.length;
          const beforeRenders = renders;
          mounted = true;
          await act(async () => {
            renderer?.update(renderApp());
          });

          activeSelected = selectedLengths(rows);
          expect(events.length, label).toBe(beforeEvents + 1);
          expect(events.at(-1)?.selected, label).toEqual(activeSelected);
          expect(target.text, label).toBe(formatSelected(activeSelected));
          expect(renders, label).toBe(beforeRenders + 1);
          break;
        }
      }
    }
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    store.close();
  }

  async function commitRows(patch: WritePatch, nextRows: readonly ItemRow[], label: string): Promise<void> {
    const beforeEvents = events.length;
    const beforeRenders = renders;
    const beforeTarget = target.text;
    const nextSelected = selectedLengths(nextRows);

    await act(async () => {
      await store.commit(patch);
    });
    rows = nextRows;

    if (mounted && activeSelected !== undefined && !shallow(activeSelected, nextSelected)) {
      activeSelected = nextSelected;
      expect(events.length, label).toBe(beforeEvents + 1);
      expect(events.at(-1)?.selected, label).toEqual(nextSelected);
      expect(target.text, label).toBe(formatSelected(nextSelected));
    } else {
      expect(events.length, label).toBe(beforeEvents);
      expect(target.text, label).toBe(beforeTarget);
    }

    expect(renders, label).toBe(beforeRenders);
  }
}

function selectedLengths(rows: readonly ItemRow[]): readonly number[] {
  return [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => row.label.length);
}

function seededRows(seed: number, count: number): readonly ItemRow[] {
  const random = createSeededRandom(seed ^ 0x517e);
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    label: labelOfLength(2 + randomIndex(random, 8), seed, index, 17)
  }));
}

function replaceRow(rows: readonly ItemRow[], nextRow: ItemRow): readonly ItemRow[] {
  return rows.map((row) => row.id === nextRow.id ? nextRow : row);
}

function chooseAction(random: SeededRandom, mounted: boolean, step: number): FuzzAction {
  if (mounted && step % 17 === 9) return 'unmount';
  if (!mounted && step % 5 === 2) return 'remount';
  if (mounted && step % 13 === 4) return 'reset-key';

  const actions = mounted ? mountedActions : unmountedActions;
  const action = actions[randomIndex(random, actions.length)];
  if (action === undefined) throw new Error('fuzz action index escaped actions');
  return action;
}

function differentLength(length: number, random: SeededRandom): number {
  const nextLength = 1 + ((length + randomIndex(random, 11)) % 12);
  return nextLength === length ? (length % 12) + 1 : nextLength;
}

function labelOfLength(length: number, seed: number, step: number, salt: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length }, (_, index) => {
    const charIndex = Math.abs(seed + step * 17 + salt * 31 + index) % alphabet.length;
    const character = alphabet[charIndex];
    if (character === undefined) throw new Error('label character index escaped alphabet');
    return character;
  }).join('');
}

function formatSelected(selected: readonly number[]): string {
  return selected.join('|');
}

function randomIndex(random: SeededRandom, length: number): number {
  if (length <= 0) throw new Error('cannot choose from an empty fuzz set');
  return Math.floor(random() * length);
}

function randomShallowPair(random: SeededRandom, left: unknown): unknown {
  const roll = random();
  if (roll < 0.15) return left;
  if (roll < 0.3) return cloneShallowValue(left);
  return randomShallowValue(random, 0);
}

function randomShallowValue(random: SeededRandom, depth: number): unknown {
  const kind = randomIndex(random, depth > 1 ? 7 : 10);
  if (kind < 5) return randomAtom(random);
  if (kind === 5) return new Date(randomIndex(random, 10));
  if (kind < 8) {
    return Array.from({ length: randomIndex(random, 5) }, () => randomShallowValue(random, depth + 1));
  }

  const record: Record<string, unknown> = random() < 0.2 ? Object.create(null) as Record<string, unknown> : {};
  const fieldCount = randomIndex(random, 5);
  for (let index = 0; index < fieldCount; index += 1) {
    record[`key-${randomIndex(random, 5)}`] = randomShallowValue(random, depth + 1);
  }
  return record;
}

function randomAtom(random: SeededRandom): unknown {
  const atoms: readonly unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    -0,
    Number.NaN,
    1,
    'alpha',
    'beta'
  ];
  return atoms[randomIndex(random, atoms.length)];
}

function cloneShallowValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (isPlainRecordValue(value)) return { ...value };
  return value;
}

function expectedShallow(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  }
  if (!isPlainRecordValue(left) || !isPlainRecordValue(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && Object.is(left[key], right[key]));
}

function isPlainRecordValue(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function resolveFuzzSeeds(defaultSeeds: readonly number[]): readonly number[] {
  const envSeed = process.env.TARSTATE_FUZZ_SEED;
  if (envSeed === undefined || envSeed.trim() === '') return defaultSeeds;

  const seed = Number(envSeed);
  return Number.isFinite(seed) ? [seed] : defaultSeeds;
}
