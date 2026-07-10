import { describe, expect, it } from 'vitest';
import {
  commitLensUpdate,
  issue,
  projectLensRelation,
  resolveLensPath,
  type ArtifactRef,
  type LensArtifact,
  type LensRows,
  type SchemaLensBody
} from '../src/v1-spike.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const v1: ArtifactRef = { id: 'urn:example:schema:tasks:1', contentHash: hash('1') };
const v200: ArtifactRef = { id: 'urn:example:schema:work-items:200', contentHash: hash('2') };
const lensRef: ArtifactRef = { id: 'urn:example:lens:v200-v1:compat', contentHash: hash('3') };
const alternateLensRef: ArtifactRef = { id: 'urn:example:lens:v200-v1:alternate', contentHash: hash('4') };
const workItems = 'example.task';
const comments = 'example.comment';

const lensBody: SchemaLensBody = {
  from: v200,
  to: v1,
  relations: [
    {
      fromRelationId: workItems,
      toRelationId: workItems,
      steps: [
        { kind: 'lens.hide', from: 'id', write: 'preserve' },
        { kind: 'lens.field', from: 'legacySlug', to: 'slug', write: 'invertible' },
        { kind: 'lens.field', from: 'name', to: 'title', write: 'invertible' },
        {
          kind: 'lens.value-map', from: 'state', to: 'state', unmapped: 'reject', cases: [
            { from: 'open', to: 'open', writeBack: 'to-from' },
            { from: 'done', to: 'done', writeBack: 'to-from' },
            { from: 'blocked', to: 'open', writeBack: 'reject' }
          ]
        },
        { kind: 'lens.hide', from: 'notes', write: 'preserve' }
      ]
    },
    {
      fromRelationId: comments,
      toRelationId: comments,
      steps: [
        { kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' },
        { kind: 'lens.field', from: 'body', to: 'body', write: 'invertible' },
        {
          kind: 'lens.lookup', from: 'taskId', to: 'taskSlug',
          through: { schemaView: v200, relationId: workItems },
          sourceFields: ['id'], resultFields: ['legacySlug'],
          onMissing: 'reject', onAmbiguous: 'reject', write: 'invertible'
        }
      ]
    }
  ]
};

const selectedLens: LensArtifact = { ref: lensRef, body: lensBody };
const alternateLens: LensArtifact = { ref: alternateLensRef, body: lensBody };

const fixtureRows = (): LensRows => ({
  [workItems]: [
    { id: 'id:draft', legacySlug: 'draft-plan', name: 'Draft plan', state: 'open', notes: 'v200 only', serverOnly: { retained: true } },
    { id: 'id:blocked', legacySlug: 'blocked-plan', name: 'Blocked plan', state: 'blocked', notes: 'not visible' },
    { id: 'id:done', legacySlug: 'done-plan', name: 'Done plan', state: 'done', notes: null }
  ],
  [comments]: [
    { id: 'comment:1', taskId: 'id:draft', body: 'First', moderation: { unknown: true } }
  ]
});

const validateCurrentConstraints = (rows: LensRows) => {
  const issues = [];
  const items = rows[workItems] ?? [];
  const ids = new Set(items.map((row) => row.id));
  const slugs = items.map((row) => row.legacySlug);
  if (items.some((row) => row.name === '')) issues.push(issue('work_item.name_required', 'constraint'));
  if (new Set(slugs).size !== slugs.length) issues.push(issue('work_item.legacy_slug_unique', 'constraint'));
  if ((rows[comments] ?? []).some((row) => !ids.has(row.taskId))) issues.push(issue('comment.task_required', 'constraint'));
  return issues;
};

describe('v1/v200 lens spike', () => {
  it('requires an exact selection when two compatible paths exist', () => {
    expect(resolveLensPath(v200, v1, [selectedLens, alternateLens])).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.path_ambiguous' }] });
    expect(resolveLensPath(v200, v1, [selectedLens, alternateLens], [lensRef])).toMatchObject({ outcome: 'resolved', lens: { ref: lensRef } });
    expect(resolveLensPath(v200, v1, [selectedLens, alternateLens], [lensRef, alternateLensRef])).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.path_ambiguous' }] });
  });

  it('rejects same-ID lens metadata with different hashes before reading', () => {
    const conflict = { ref: { ...lensRef, contentHash: hash('9') }, body: lensBody } satisfies LensArtifact;
    expect(resolveLensPath(v200, v1, [selectedLens, conflict], [lensRef])).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.metadata_conflict' }] });
  });

  it('projects renamed fields/refs, hides newer fields, and reports blocked as lossy', () => {
    const rows = fixtureRows();
    const tasksProjection = projectLensRelation(lensBody, workItems, rows);
    expect(tasksProjection.rows).toEqual([
      { slug: 'draft-plan', title: 'Draft plan', state: 'open' },
      { slug: 'blocked-plan', title: 'Blocked plan', state: 'open' },
      { slug: 'done-plan', title: 'Done plan', state: 'done' }
    ]);
    expect(tasksProjection.issues).toMatchObject([{ code: 'lens.lossy_value', severity: 'warning' }]);
    expect(projectLensRelation(lensBody, comments, rows).rows).toEqual([{ id: 'comment:1', body: 'First', taskSlug: 'draft-plan' }]);
  });

  it('writes title field-wise while preserving IDs, notes, and unknown storage', () => {
    const original = fixtureRows();
    const result = commitLensUpdate({ lens: lensBody, relationId: workItems, rows: original, viewKey: { slug: 'draft-plan' }, edits: { title: 'Renamed by v1' }, validate: validateCurrentConstraints });
    expect(result).toMatchObject({ outcome: 'committed', returning: { slug: 'draft-plan', title: 'Renamed by v1', state: 'open' } });
    if (result.outcome !== 'committed') throw new Error('expected commit');
    expect(result.rows[workItems]?.[0]).toEqual({ id: 'id:draft', legacySlug: 'draft-plan', name: 'Renamed by v1', state: 'open', notes: 'v200 only', serverOnly: { retained: true } });
  });

  it('enforces newer required constraints and makes an incapable old executor read-only', () => {
    const rows = fixtureRows();
    expect(commitLensUpdate({ lens: lensBody, relationId: workItems, rows, viewKey: { slug: 'draft-plan' }, edits: { title: '' }, validate: validateCurrentConstraints })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'work_item.name_required' }] });
    expect(commitLensUpdate({ lens: lensBody, relationId: workItems, rows, viewKey: { slug: 'draft-plan' }, edits: { title: 'Otherwise valid' }, constraintsReady: false })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'constraint.capability_unavailable' }] });
  });

  it('rejects reverse writes through the blocked-to-open lossy representation', () => {
    const result = commitLensUpdate({ lens: lensBody, relationId: workItems, rows: fixtureRows(), viewKey: { slug: 'blocked-plan' }, edits: { state: 'done' }, validate: validateCurrentConstraints });
    expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.lossy_reverse' }] });
  });

  it('rekeys the compatibility slug without changing stable ID-based references', () => {
    const result = commitLensUpdate({ lens: lensBody, relationId: workItems, rows: fixtureRows(), viewKey: { slug: 'draft-plan' }, edits: { slug: 'draft-renamed' }, validate: validateCurrentConstraints });
    expect(result).toMatchObject({ outcome: 'committed', returning: { slug: 'draft-renamed' } });
    if (result.outcome !== 'committed') throw new Error('expected commit');
    expect(result.rows[workItems]?.[0]).toMatchObject({ id: 'id:draft', legacySlug: 'draft-renamed' });
    expect(result.rows[comments]?.[0]).toMatchObject({ taskId: 'id:draft' });

    const duplicate = commitLensUpdate({ lens: lensBody, relationId: workItems, rows: fixtureRows(), viewKey: { slug: 'draft-plan' }, edits: { slug: 'done-plan' }, validate: validateCurrentConstraints });
    expect(duplicate).toMatchObject({ outcome: 'rejected', issues: [{ code: 'work_item.legacy_slug_unique' }] });
  });

  it('translates changed refs through a unique lookup and rejects missing/ambiguous paths', () => {
    const rows = fixtureRows();
    const changed = commitLensUpdate({ lens: lensBody, relationId: comments, rows, viewKey: { id: 'comment:1' }, edits: { taskSlug: 'done-plan' }, validate: validateCurrentConstraints });
    expect(changed).toMatchObject({ outcome: 'committed', returning: { taskSlug: 'done-plan' } });
    if (changed.outcome !== 'committed') throw new Error('expected commit');
    expect(changed.rows[comments]?.[0]).toMatchObject({ taskId: 'id:done', moderation: { unknown: true } });

    expect(commitLensUpdate({ lens: lensBody, relationId: comments, rows, viewKey: { id: 'comment:1' }, edits: { taskSlug: 'missing' } })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.lookup_missing' }] });
    const ambiguousRows = { ...rows, [workItems]: [...(rows[workItems] ?? []), { id: 'id:duplicate', legacySlug: 'done-plan', name: 'Duplicate', state: 'open' }] };
    expect(commitLensUpdate({ lens: lensBody, relationId: comments, rows: ambiguousRows, viewKey: { id: 'comment:1' }, edits: { taskSlug: 'done-plan' } })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.lookup_ambiguous' }] });
  });
});

