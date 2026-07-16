import { describe, expect, it } from 'vitest';
import {
  buildDatabaseDiscoveryGraph,
  parseDatabaseDiscoveryReferences
} from '../src/database/source-link-graph.js';

const parse = (rows: readonly unknown[]) => {
  const parsed = parseDatabaseDiscoveryReferences(rows);
  expect(parsed.problems).toEqual([]);
  return parsed.references;
};

describe('database source-link graph', () => {
  it('keeps only links reachable from roots and combines every incoming link', () => {
    const built = buildDatabaseDiscoveryGraph(['root'], parse([
      { linkId: 'root-child-required', originSourceId: 'root', targetSourceId: 'child' },
      { linkId: 'root-child-optional', originSourceId: 'root', targetSourceId: 'child', expectation: 'optional' },
      { linkId: 'child-file', originSourceId: 'child', targetSourceId: 'file', targetAttachmentId: 'file-view' },
      { linkId: 'orphan-hidden', originSourceId: 'orphan', targetSourceId: 'hidden' }
    ]));

    expect(built.problems).toEqual([]);
    expect(built.graph?.targets).toEqual([
      {
        sourceId: 'child',
        expectation: 'required',
        discoveryEdges: ['root-child-optional', 'root-child-required']
      },
      {
        sourceId: 'file',
        attachmentId: 'file-view',
        expectation: 'required',
        discoveryEdges: ['child-file']
      }
    ]);
  });

  it('terminates on cycles and does not mistake converging links for cycles', () => {
    const built = buildDatabaseDiscoveryGraph(['root'], parse([
      { linkId: 'root-a', originSourceId: 'root', targetSourceId: 'a' },
      { linkId: 'root-b', originSourceId: 'root', targetSourceId: 'b' },
      { linkId: 'a-c', originSourceId: 'a', targetSourceId: 'c' },
      { linkId: 'b-c', originSourceId: 'b', targetSourceId: 'c' },
      { linkId: 'c-a', originSourceId: 'c', targetSourceId: 'a' }
    ]));

    expect(built.graph?.targets.map(({ sourceId }) => sourceId)).toEqual(['a', 'b', 'c']);
  });

  it('rejects malformed rows, reused link identities, and conflicting attachment targets', () => {
    const parsed = parseDatabaseDiscoveryReferences([
      { linkId: 'same', originSourceId: 'root', targetSourceId: 'one' },
      { linkId: 'same', originSourceId: 'root', targetSourceId: 'two' },
      { linkId: '', originSourceId: 'root', targetSourceId: 'three' }
    ]);
    expect(parsed.problems).toEqual([
      { kind: 'edge-ambiguous', edgeId: 'same', rowIndex: 1 },
      { kind: 'row-invalid', rowIndex: 2 }
    ]);

    const built = buildDatabaseDiscoveryGraph(['root'], parse([
      { linkId: 'one', originSourceId: 'root', targetSourceId: 'child', targetAttachmentId: 'view:one' },
      { linkId: 'two', originSourceId: 'root', targetSourceId: 'child', targetAttachmentId: 'view:two' }
    ]));
    expect(built).toEqual({
      problems: [{ kind: 'target-attachment-ambiguous', sourceId: 'child' }]
    });

    const duplicateMember = buildDatabaseDiscoveryGraph(['root'], parse([
      { linkId: 'three', originSourceId: 'root', targetSourceId: 'first', targetAttachmentId: 'shared-view' },
      { linkId: 'four', originSourceId: 'root', targetSourceId: 'shared-view' }
    ]));
    expect(duplicateMember).toEqual({
      problems: [{
        kind: 'target-member-ambiguous',
        sourceId: 'first',
        attachmentId: 'shared-view'
      }]
    });
  });

  it('walks deeply linked data without consuming the JavaScript call stack', () => {
    const edgeCount = 20_000;
    const rows = Array.from({ length: edgeCount }, (_, index) => ({
      linkId: `link:${index}`,
      originSourceId: `source:${index}`,
      targetSourceId: `source:${index + 1}`
    }));
    rows.push({
      linkId: 'link:cycle',
      originSourceId: `source:${edgeCount}`,
      targetSourceId: 'source:0'
    });

    const built = buildDatabaseDiscoveryGraph(['source:0'], parse(rows));

    expect(built.graph?.targets).toHaveLength(edgeCount);
  });
});
