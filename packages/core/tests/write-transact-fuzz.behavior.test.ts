import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact, type Db } from '@tarstate/core/db';
import { as, asc, eq, from, pipe, sort, value } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, nullable, numberField, optional, relation, stringField } from '@tarstate/core/schema';
import {
  deleteByKey,
  deleteExact,
  deleteRows,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  update,
  updateByKey,
  type WritePatch
} from '@tarstate/core/write';

type Widget = {
  readonly id: string;
  readonly label: string;
  readonly rank: number;
  readonly active: boolean;
  readonly note?: string | null;
};

const fuzzSchema = defineSchema({
  widgets: relation<Widget>({
    key: 'id',
    fields: {
      id: idField('widget'),
      label: stringField(),
      rank: numberField(),
      active: booleanField(),
      note: optional(nullable(stringField()))
    }
  })
});

const widget = as(fuzzSchema.widgets, 'widget');
const widgetsById = pipe(from(widget), sort(asc(widget.id)));

const COVERAGE_TAGS = [
  'insert:fresh',
  'insert:duplicate',
  'insert:invalid',
  'insertIgnore:fresh',
  'insertIgnore:duplicate',
  'insertIgnore:invalid',
  'insertOrReplace:fresh',
  'insertOrReplace:duplicate',
  'insertOrReplace:invalid',
  'insertOrMerge:fresh',
  'insertOrMerge:duplicate',
  'insertOrMerge:invalid',
  'insertOrUpdate:fresh',
  'insertOrUpdate:duplicate',
  'insertOrUpdate:invalid',
  'updateByKey:valid',
  'updateByKey:missing',
  'updateByKey:invalid',
  'update:valid',
  'update:none',
  'update:invalid',
  'deleteByKey:existing',
  'deleteByKey:missing',
  'delete:predicate',
  'deleteExact:exact',
  'deleteExact:inexact',
  'replaceAll:valid',
  'replaceAll:invalid'
] as const;

type CoverageTag = typeof COVERAGE_TAGS[number];
type WidgetPatch = WritePatch<typeof fuzzSchema.widgets>;
type WidgetModel = Map<string, Widget>;
type WidgetUpdate = Readonly<Partial<Record<keyof Widget, unknown>>>;
type WidgetPredicate = (rowValue: Widget) => boolean;
type FuzzDelta = {
  readonly relation: typeof fuzzSchema.widgets;
  readonly added: readonly Widget[];
  readonly removed: readonly Widget[];
};
type ApplyOutcome =
  | { readonly committed: true; readonly delta?: FuzzDelta }
  | { readonly committed: false };
type GeneratedWrite = {
  readonly tag: CoverageTag;
  readonly patch: WidgetPatch;
  readonly apply: (model: WidgetModel) => ApplyOutcome;
};
type ExpectedBatch = {
  readonly committed: boolean;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly FuzzDelta[];
  readonly model: WidgetModel;
  readonly processedTags: readonly CoverageTag[];
};
type Random = {
  readonly int: (exclusiveMax: number) => number;
  readonly bool: (probability?: number) => boolean;
  readonly pick: <Value>(values: readonly Value[]) => Value;
};
type GeneratorState = {
  readonly seed: number;
  readonly rng: Random;
  nextId: number;
};

const TAGS_REQUIRING_EXISTING = new Set<CoverageTag>([
  'insert:duplicate',
  'insertIgnore:duplicate',
  'insertOrReplace:duplicate',
  'insertOrMerge:duplicate',
  'insertOrUpdate:duplicate',
  'updateByKey:valid',
  'updateByKey:invalid',
  'update:valid',
  'update:invalid',
  'deleteByKey:existing',
  'delete:predicate',
  'deleteExact:exact',
  'deleteExact:inexact'
]);

const INVALID_TAGS = new Set<CoverageTag>([
  'insert:duplicate',
  'insert:invalid',
  'insertIgnore:invalid',
  'insertOrReplace:invalid',
  'insertOrMerge:invalid',
  'insertOrUpdate:invalid',
  'updateByKey:invalid',
  'update:invalid',
  'replaceAll:invalid'
]);

const FUZZ_SEEDS = [0x7710, 0x7711, 0x7712, 0x7713] as const;
const BATCHES_PER_SEED = COVERAGE_TAGS.length * 3;

function createRandom(seedValue: number): Random {
  let state = seedValue >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const int = (exclusiveMax: number): number => {
    if (exclusiveMax <= 0) throw new Error('cannot choose from an empty range');
    return Math.floor(next() * exclusiveMax);
  };
  const bool = (probability = 0.5): boolean => next() < probability;
  const pick = <Value>(values: readonly Value[]): Value => {
    const picked = values[int(values.length)];
    if (picked === undefined) throw new Error('cannot choose from an empty array');
    return picked;
  };
  return { int, bool, pick };
}

function createGenerator(seedValue: number): GeneratorState {
  return { seed: seedValue, rng: createRandom(seedValue), nextId: 0 };
}

function openingWidgets(seedValue: number): readonly Widget[] {
  const seedLabel = seedValue.toString(16);
  return [
    { id: `base-${seedLabel}-a`, label: 'alpha', rank: 1, active: true, note: null },
    { id: `base-${seedLabel}-b`, label: 'bravo', rank: 2, active: false },
    { id: `base-${seedLabel}-c`, label: 'charlie', rank: 3, active: true, note: 'seed' },
    { id: `base-${seedLabel}-d`, label: 'delta', rank: 4, active: false }
  ];
}

function freshWidget(generator: GeneratorState): Widget {
  const id = `w-${generator.seed.toString(16)}-${generator.nextId++}`;
  const rowValue = {
    id,
    label: `label-${id}-${generator.rng.int(1_000)}`,
    rank: generator.rng.int(400) - 100,
    active: generator.rng.bool()
  };
  if (!generator.rng.bool(0.45)) return rowValue;
  return {
    ...rowValue,
    note: generator.rng.bool(0.25) ? null : `note-${generator.rng.int(1_000)}`
  };
}

function replacementFor(generator: GeneratorState, current: Widget): Widget {
  return { ...freshWidget(generator), id: current.id };
}

function missingKey(generator: GeneratorState): string {
  return `missing-key-${generator.seed.toString(16)}-${generator.nextId++}`;
}

function missingLabel(generator: GeneratorState): string {
  return `missing-label-${generator.seed.toString(16)}-${generator.nextId++}`;
}

function invalidWidget(generator: GeneratorState): Widget {
  const rowValue = freshWidget(generator);
  switch (generator.rng.int(5)) {
    case 0:
      return { id: rowValue.id, rank: rowValue.rank, active: rowValue.active } as unknown as Widget;
    case 1:
      return { ...rowValue, id: null } as unknown as Widget;
    case 2:
      return { ...rowValue, rank: `rank-${rowValue.rank}` } as unknown as Widget;
    case 3:
      return { ...rowValue, active: null } as unknown as Widget;
    default:
      return null as unknown as Widget;
  }
}

function invalidUpdate(generator: GeneratorState): WidgetUpdate {
  switch (generator.rng.int(4)) {
    case 0:
      return { label: null };
    case 1:
      return { rank: `bad-rank-${generator.rng.int(100)}` };
    case 2:
      return { active: null };
    default:
      return { id: null };
  }
}

function cloneWidget(rowValue: Widget): Widget {
  return { ...rowValue };
}

function cloneModel(model: WidgetModel): WidgetModel {
  return new Map([...model].map(([key, rowValue]) => [key, cloneWidget(rowValue)]));
}

function modelFromRows(rows: readonly Widget[]): WidgetModel {
  return new Map(rows.map((rowValue) => [rowValue.id, cloneWidget(rowValue)]));
}

function modelRowsById(model: WidgetModel): readonly Widget[] {
  return [...model.values()].map(cloneWidget).sort((left, right) => left.id.localeCompare(right.id));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasOwn(input: Record<string, unknown>, fieldName: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, fieldName);
}

function isValidWidget(input: unknown): input is Widget {
  if (!isRecord(input)) return false;
  if (typeof input.id !== 'string') return false;
  if (typeof input.label !== 'string') return false;
  if (typeof input.rank !== 'number') return false;
  if (typeof input.active !== 'boolean') return false;
  if (!hasOwn(input, 'note') || input.note === undefined) return true;
  return input.note === null || typeof input.note === 'string';
}

function canonical(input: unknown): string {
  if (input === undefined) return 'undefined';
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(input);
}

function deltaFor(added: readonly Widget[], removed: readonly Widget[]): FuzzDelta | undefined {
  if (added.length === 0 && removed.length === 0) return undefined;
  return {
    relation: fuzzSchema.widgets,
    added: added.map(cloneWidget),
    removed: removed.map(cloneWidget)
  };
}

function applied(deltaValue: FuzzDelta | undefined): ApplyOutcome {
  return deltaValue === undefined
    ? { committed: true }
    : { committed: true, delta: deltaValue };
}

function pickExisting(model: WidgetModel, generator: GeneratorState): Widget | undefined {
  const rows = [...model.values()];
  return rows.length === 0 ? undefined : cloneWidget(generator.rng.pick(rows));
}

function requireExisting(model: WidgetModel, generator: GeneratorState, tag: CoverageTag): Widget {
  const rowValue = pickExisting(model, generator);
  if (rowValue === undefined) throw new Error(`${tag} requires an existing row`);
  return rowValue;
}

function insertVariantWrite(
  tag: CoverageTag,
  patch: WidgetPatch,
  rowValue: Widget,
  mode: 'insert' | 'ignore' | 'replace' | 'merge',
  nextOnConflict?: (current: Widget, incoming: Widget) => Widget
): GeneratedWrite {
  return {
    tag,
    patch,
    apply: (model) => {
      if (!isValidWidget(rowValue)) return { committed: false };
      const incoming = cloneWidget(rowValue);
      const current = model.get(incoming.id);

      if (mode === 'insert') {
        if (current !== undefined) return { committed: false };
        model.set(incoming.id, incoming);
        return applied(deltaFor([incoming], []));
      }

      if (current === undefined) {
        model.set(incoming.id, incoming);
        return applied(deltaFor([incoming], []));
      }

      if (mode === 'ignore') return applied(undefined);

      const next = mode === 'replace'
        ? incoming
        : nextOnConflict?.(cloneWidget(current), incoming) ?? incoming;
      model.set(next.id, cloneWidget(next));
      return applied(deltaFor([next], [current]));
    }
  };
}

function updateByKeyWrite(
  tag: CoverageTag,
  patch: WidgetPatch,
  key: string,
  changeFor: (current: Widget) => WidgetUpdate
): GeneratedWrite {
  return {
    tag,
    patch,
    apply: (model) => {
      const current = model.get(key);
      if (current === undefined) return applied(undefined);
      const nextCandidate = { ...current, ...changeFor(cloneWidget(current)) };
      if (!isValidWidget(nextCandidate)) return { committed: false };
      const next = cloneWidget(nextCandidate);
      model.set(next.id, next);
      return applied(deltaFor([next], [current]));
    }
  };
}

function updateWhereWrite(
  tag: CoverageTag,
  patch: WidgetPatch,
  matches: WidgetPredicate,
  changeFor: (current: Widget) => WidgetUpdate
): GeneratedWrite {
  return {
    tag,
    patch,
    apply: (model) => {
      const matched = [...model.entries()].filter(([, rowValue]) => matches(rowValue));
      const updates: { readonly key: string; readonly current: Widget; readonly next: Widget }[] = [];
      for (const [key, current] of matched) {
        const nextCandidate = { ...current, ...changeFor(cloneWidget(current)) };
        if (!isValidWidget(nextCandidate)) return { committed: false };
        updates.push({ key, current: cloneWidget(current), next: cloneWidget(nextCandidate) });
      }
      for (const { key, next } of updates) model.set(key, next);
      return applied(deltaFor(updates.map(({ next }) => next), updates.map(({ current }) => current)));
    }
  };
}

function deleteByKeyWrite(tag: CoverageTag, key: string): GeneratedWrite {
  return {
    tag,
    patch: deleteByKey(fuzzSchema.widgets, key),
    apply: (model) => {
      const current = model.get(key);
      if (current === undefined) return applied(undefined);
      model.delete(key);
      return applied(deltaFor([], [current]));
    }
  };
}

function deleteWhereWrite(tag: CoverageTag, matches: WidgetPredicate): GeneratedWrite {
  return {
    tag,
    patch: deleteRows(fuzzSchema.widgets, eq(widget.active, value(true))),
    apply: (model) => {
      const removed = [...model.entries()].filter(([, rowValue]) => matches(rowValue));
      for (const [key] of removed) model.delete(key);
      return applied(deltaFor([], removed.map(([, rowValue]) => rowValue)));
    }
  };
}

function deleteExactWrite(tag: CoverageTag, exact: Widget): GeneratedWrite {
  return {
    tag,
    patch: deleteExact(fuzzSchema.widgets, exact),
    apply: (model) => {
      const removed: Widget[] = [];
      const exactKey = canonical(exact);
      for (const [key, rowValue] of model) {
        if (canonical(rowValue) !== exactKey) continue;
        removed.push(cloneWidget(rowValue));
        model.delete(key);
      }
      return applied(deltaFor([], removed));
    }
  };
}

function replaceAllWrite(tag: CoverageTag, rows: readonly Widget[]): GeneratedWrite {
  return {
    tag,
    patch: replaceAll(fuzzSchema.widgets, rows),
    apply: (model) => {
      if (!rows.every(isValidWidget)) return { committed: false };
      const removed = [...model.values()].map(cloneWidget);
      model.clear();
      for (const rowValue of rows) model.set(rowValue.id, cloneWidget(rowValue));
      return applied(deltaFor(rows, removed));
    }
  };
}

function makeValidPrefixWrite(generator: GeneratorState): GeneratedWrite {
  const rowValue = freshWidget(generator);
  return insertVariantWrite('insert:fresh', insert(fuzzSchema.widgets, rowValue), rowValue, 'insert');
}

function makeWriteForTag(generator: GeneratorState, tag: CoverageTag, model: WidgetModel): GeneratedWrite {
  switch (tag) {
    case 'insert:fresh': {
      const rowValue = freshWidget(generator);
      return insertVariantWrite(tag, insert(fuzzSchema.widgets, rowValue), rowValue, 'insert');
    }
    case 'insert:duplicate': {
      const current = requireExisting(model, generator, tag);
      const rowValue = replacementFor(generator, current);
      return insertVariantWrite(tag, insert(fuzzSchema.widgets, rowValue), rowValue, 'insert');
    }
    case 'insert:invalid': {
      const rowValue = invalidWidget(generator);
      return insertVariantWrite(tag, insert(fuzzSchema.widgets, rowValue), rowValue, 'insert');
    }
    case 'insertIgnore:fresh': {
      const rowValue = freshWidget(generator);
      return insertVariantWrite(tag, insertIgnore(fuzzSchema.widgets, rowValue), rowValue, 'ignore');
    }
    case 'insertIgnore:duplicate': {
      const current = requireExisting(model, generator, tag);
      const rowValue = replacementFor(generator, current);
      return insertVariantWrite(tag, insertIgnore(fuzzSchema.widgets, rowValue), rowValue, 'ignore');
    }
    case 'insertIgnore:invalid': {
      const rowValue = invalidWidget(generator);
      return insertVariantWrite(tag, insertIgnore(fuzzSchema.widgets, rowValue), rowValue, 'ignore');
    }
    case 'insertOrReplace:fresh': {
      const rowValue = freshWidget(generator);
      return insertVariantWrite(tag, insertOrReplace(fuzzSchema.widgets, rowValue), rowValue, 'replace');
    }
    case 'insertOrReplace:duplicate': {
      const current = requireExisting(model, generator, tag);
      const rowValue = replacementFor(generator, current);
      return insertVariantWrite(tag, insertOrReplace(fuzzSchema.widgets, rowValue), rowValue, 'replace');
    }
    case 'insertOrReplace:invalid': {
      const rowValue = invalidWidget(generator);
      return insertVariantWrite(tag, insertOrReplace(fuzzSchema.widgets, rowValue), rowValue, 'replace');
    }
    case 'insertOrMerge:fresh': {
      const rowValue = freshWidget(generator);
      return insertVariantWrite(
        tag,
        insertOrMerge(fuzzSchema.widgets, rowValue, { merge: ['label', 'rank', 'active'] }),
        rowValue,
        'merge',
        (current, incoming) => ({ ...current, label: incoming.label, rank: incoming.rank, active: incoming.active })
      );
    }
    case 'insertOrMerge:duplicate': {
      const current = requireExisting(model, generator, tag);
      const rowValue = replacementFor(generator, current);
      return insertVariantWrite(
        tag,
        insertOrMerge(fuzzSchema.widgets, rowValue, { merge: ['label', 'rank', 'active'] }),
        rowValue,
        'merge',
        (existing, incoming) => ({ ...existing, label: incoming.label, rank: incoming.rank, active: incoming.active })
      );
    }
    case 'insertOrMerge:invalid': {
      const rowValue = invalidWidget(generator);
      return insertVariantWrite(
        tag,
        insertOrMerge(fuzzSchema.widgets, rowValue, { merge: ['label'] }),
        rowValue,
        'merge',
        (current) => current
      );
    }
    case 'insertOrUpdate:fresh': {
      const rowValue = freshWidget(generator);
      const bump = generator.rng.int(9) + 1;
      const updateCurrent = (current: Widget): Partial<Widget> => ({ rank: current.rank + bump });
      return insertVariantWrite(
        tag,
        insertOrUpdate(fuzzSchema.widgets, rowValue, { update: (current) => ({ rank: current.rank + bump }) }),
        rowValue,
        'merge',
        (current) => ({ ...current, ...updateCurrent(current) })
      );
    }
    case 'insertOrUpdate:duplicate': {
      const current = requireExisting(model, generator, tag);
      const rowValue = replacementFor(generator, current);
      const suffix = generator.rng.int(1_000);
      const bump = generator.rng.int(9) + 1;
      const updateCurrent = (existing: Widget): Partial<Widget> => ({
        label: `${existing.label}-upsert-${suffix}`,
        rank: existing.rank + bump,
        active: !existing.active
      });
      return insertVariantWrite(
        tag,
        insertOrUpdate(fuzzSchema.widgets, rowValue, {
          update: (existing) => ({
            label: `${existing.label}-upsert-${suffix}`,
            rank: existing.rank + bump,
            active: !existing.active
          })
        }),
        rowValue,
        'merge',
        (existing) => ({ ...existing, ...updateCurrent(existing) })
      );
    }
    case 'insertOrUpdate:invalid': {
      const rowValue = invalidWidget(generator);
      return insertVariantWrite(
        tag,
        insertOrUpdate(fuzzSchema.widgets, rowValue, { update: { label: `unused-${generator.rng.int(1_000)}` } }),
        rowValue,
        'merge',
        (current) => current
      );
    }
    case 'updateByKey:valid': {
      const current = requireExisting(model, generator, tag);
      const suffix = generator.rng.int(1_000);
      const bump = generator.rng.int(9) + 1;
      const updateCurrent = (rowValue: Widget): WidgetUpdate => ({
        label: `${rowValue.label}-key-${suffix}`,
        rank: rowValue.rank + bump
      });
      return updateByKeyWrite(
        tag,
        updateByKey(fuzzSchema.widgets, current.id, (rowValue) => ({
          label: `${rowValue.label}-key-${suffix}`,
          rank: rowValue.rank + bump
        })),
        current.id,
        updateCurrent
      );
    }
    case 'updateByKey:missing': {
      const key = missingKey(generator);
      const changes = { label: `missing-${generator.rng.int(1_000)}` } as const;
      return updateByKeyWrite(tag, updateByKey(fuzzSchema.widgets, key, changes), key, () => changes);
    }
    case 'updateByKey:invalid': {
      const current = requireExisting(model, generator, tag);
      const changes = invalidUpdate(generator);
      return updateByKeyWrite(
        tag,
        updateByKey(fuzzSchema.widgets, current.id, changes as unknown as Partial<Widget>),
        current.id,
        () => changes
      );
    }
    case 'update:valid': {
      const current = requireExisting(model, generator, tag);
      const active = current.active;
      const suffix = generator.rng.int(1_000);
      const bump = generator.rng.int(9) + 1;
      const updateCurrent = (rowValue: Widget): WidgetUpdate => ({
        label: `${rowValue.label}-where-${suffix}`,
        rank: rowValue.rank + bump
      });
      return updateWhereWrite(
        tag,
        update(fuzzSchema.widgets, eq(widget.active, value(active)), (rowValue) => ({
          label: `${rowValue.label}-where-${suffix}`,
          rank: rowValue.rank + bump
        })),
        (rowValue) => rowValue.active === active,
        updateCurrent
      );
    }
    case 'update:none': {
      const label = missingLabel(generator);
      const changes = { rank: generator.rng.int(1_000) } as const;
      return updateWhereWrite(
        tag,
        update(fuzzSchema.widgets, eq(widget.label, value(label)), changes),
        (rowValue) => rowValue.label === label,
        () => changes
      );
    }
    case 'update:invalid': {
      const current = requireExisting(model, generator, tag);
      const changes = invalidUpdate(generator);
      return updateWhereWrite(
        tag,
        update(fuzzSchema.widgets, eq(widget.label, value(current.label)), changes as unknown as Partial<Widget>),
        (rowValue) => rowValue.label === current.label,
        () => changes
      );
    }
    case 'deleteByKey:existing': {
      const current = requireExisting(model, generator, tag);
      return deleteByKeyWrite(tag, current.id);
    }
    case 'deleteByKey:missing':
      return deleteByKeyWrite(tag, missingKey(generator));
    case 'delete:predicate': {
      const current = requireExisting(model, generator, tag);
      const active = current.active;
      return {
        ...deleteWhereWrite(tag, (rowValue) => rowValue.active === active),
        patch: deleteRows(fuzzSchema.widgets, eq(widget.active, value(active)))
      };
    }
    case 'deleteExact:exact': {
      const current = requireExisting(model, generator, tag);
      return deleteExactWrite(tag, current);
    }
    case 'deleteExact:inexact': {
      const current = requireExisting(model, generator, tag);
      const exact = generator.rng.bool()
        ? ({ id: current.id, label: current.label } as unknown as Widget)
        : ({ ...current, label: `${current.label}-miss` } as Widget);
      return deleteExactWrite(tag, exact);
    }
    case 'replaceAll:valid': {
      const rows = Array.from({ length: 1 + generator.rng.int(4) }, () => freshWidget(generator));
      return replaceAllWrite(tag, rows);
    }
    case 'replaceAll:invalid': {
      const rows = [freshWidget(generator), invalidWidget(generator)];
      return replaceAllWrite(tag, rows);
    }
    default:
      return tag satisfies never;
  }
}

function tagAt(index: number): CoverageTag {
  const tag = COVERAGE_TAGS[index % COVERAGE_TAGS.length];
  if (tag === undefined) throw new Error('missing coverage tag');
  return tag;
}

function previewWrite(stage: WidgetModel, writes: GeneratedWrite[], writeValue: GeneratedWrite): ApplyOutcome {
  writes.push(writeValue);
  return writeValue.apply(stage);
}

function generateBatch(generator: GeneratorState, model: WidgetModel, batchIndex: number): readonly GeneratedWrite[] {
  const stage = cloneModel(model);
  const primary = tagAt(batchIndex + generator.seed);
  const writes: GeneratedWrite[] = [];
  const primaryIsInvalid = INVALID_TAGS.has(primary);
  const prefixCount = primaryIsInvalid ? 1 + generator.rng.int(2) : generator.rng.int(2);

  for (let index = 0; index < prefixCount; index += 1) {
    const outcome = previewWrite(stage, writes, makeValidPrefixWrite(generator));
    if (!outcome.committed) throw new Error('valid prefix write unexpectedly rejected');
  }

  if (TAGS_REQUIRING_EXISTING.has(primary) && stage.size === 0) {
    const outcome = previewWrite(stage, writes, makeValidPrefixWrite(generator));
    if (!outcome.committed) throw new Error('existing-row setup unexpectedly rejected');
  }

  const primaryOutcome = previewWrite(stage, writes, makeWriteForTag(generator, primary, stage));
  if (primaryOutcome.committed) {
    const suffixCount = generator.rng.int(3);
    for (let index = 0; index < suffixCount; index += 1) {
      const outcome = previewWrite(stage, writes, makeValidPrefixWrite(generator));
      if (!outcome.committed) throw new Error('valid suffix write unexpectedly rejected');
    }
  } else {
    writes.push(makeValidPrefixWrite(generator));
  }

  return writes;
}

function applyExpectedBatch(model: WidgetModel, writes: readonly GeneratedWrite[]): ExpectedBatch {
  const stage = cloneModel(model);
  const deltas: FuzzDelta[] = [];
  const processedTags: CoverageTag[] = [];
  let patches = 0;

  for (const writeValue of writes) {
    patches += 1;
    processedTags.push(writeValue.tag);
    const result = writeValue.apply(stage);
    if (!result.committed) {
      return {
        committed: false,
        patches,
        applied: deltas.length,
        deltas,
        model,
        processedTags
      };
    }
    if (result.delta !== undefined) deltas.push(result.delta);
  }

  return {
    committed: true,
    patches,
    applied: deltas.length,
    deltas,
    model: stage,
    processedTags
  };
}

describe('seeded write transaction model fuzz', () => {
  it('matches final rows and deltas for generated write batches', () => {
    const exercisedTags = new Set<CoverageTag>();

    for (const seedValue of FUZZ_SEEDS) {
      const generator = createGenerator(seedValue);
      let model = modelFromRows(openingWidgets(seedValue));
      let db: Db = createDb({ widgets: modelRowsById(model) });

      for (let batchIndex = 0; batchIndex < BATCHES_PER_SEED; batchIndex += 1) {
        const writes = generateBatch(generator, model, batchIndex);
        const expected = applyExpectedBatch(model, writes);
        const beforeRows = modelRowsById(model);
        const label = `seed ${seedValue.toString(16)} batch ${batchIndex}: ${writes.map((writeValue) => writeValue.tag).join(' -> ')}`;
        const result = tryTransact(db, writes.map((writeValue) => writeValue.patch));

        expect(result.committed, label).toBe(expected.committed);
        expect(result.patches, label).toBe(expected.patches);
        expect(result.applied, label).toBe(expected.applied);
        expect(result.deltas, label).toEqual(expected.deltas);

        for (const tag of expected.processedTags) exercisedTags.add(tag);

        if (expected.committed) {
          expect(result.diagnostics, label).toEqual([]);
          db = result.db;
          model = expected.model;
        } else {
          expect(result.db, label).toBe(db);
          expect(result.diagnostics, label).toEqual(expect.arrayContaining([
            expect.objectContaining({ severity: 'error' })
          ]));
          expect(q(result.db, widgetsById), label).toEqual(beforeRows);
        }

        expect(q(db, widgetsById), label).toEqual(modelRowsById(model));
      }
    }

    expect([...exercisedTags].sort()).toEqual([...COVERAGE_TAGS].sort());
  });
});
