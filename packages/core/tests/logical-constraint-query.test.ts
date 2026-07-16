import { describe, expect, it } from 'vitest';
import { createLogicalConstraintQuery } from '../src/attachment/logical-constraint-query.js';
import { CapabilityRegistry } from '../src/registry.js';

const schemaView = {
  id: 'urn:test:logical-constraint:schema',
  contentHash: `sha256:${'a'.repeat(64)}` as const
};

describe('logical attachment constraint queries', () => {
  it('supplies source, attachment, basis, and stable row occurrence provenance', () => {
    const evaluate = createLogicalConstraintQuery({
      schemaView,
      relationIds: ['items'],
      registry: new CapabilityRegistry('trust:constraint-provenance'),
      sourceId: 'source:one',
      attachmentId: 'attachment:one'
    });
    const outcome = evaluate({
      kind: 'select',
      input: {
        kind: 'where',
        input: { kind: 'from', relation: { schemaView, relationId: 'items' }, alias: 'item' },
        predicate: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'source-of', alias: 'item' },
          right: { kind: 'literal', value: 'source:one' }
        }
      },
      alias: 'violation',
      fields: {
        subject: { kind: 'record', fields: {
          relationId: { kind: 'literal', value: 'items' },
          key: { kind: 'field', alias: 'item', name: 'id' }
        } },
        evidence: { kind: 'key-of', alias: 'item' }
      }
    }, {
      rows: [{ relationId: 'items', key: ['one'], fields: { id: 'one' }, locator: { token: 'row:one' } }]
    }, { revision: 7 });

    expect(outcome).toMatchObject({
      completeness: 'exact',
      rows: [{ subject: { relationId: 'items', key: 'one' } }],
      issues: []
    });
    expect(outcome.rows[0]?.evidence).toBeTypeOf('string');
  });
});
