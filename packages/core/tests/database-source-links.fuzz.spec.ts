import fc from 'fast-check';
import { expect } from 'vitest';
import {
  buildDatabaseDiscoveryGraph,
  parseDatabaseDiscoveryReferences
} from '../src/database/source-link-graph.js';
import { propertyTest } from './support/property-test.js';

const edgeArbitrary = fc.record({
  origin: fc.integer({ min: 0, max: 11 }),
  target: fc.integer({ min: 0, max: 11 }),
  required: fc.boolean()
});

propertyTest('source-link reachability matches an independent fixed-point walk', fc.property(
  fc.array(edgeArbitrary, { maxLength: 60 }),
  (inputs) => {
    const rows = inputs.map((input, index) => ({
      linkId: `link:${index}`,
      originSourceId: `source:${input.origin}`,
      targetSourceId: `source:${input.target}`,
      expectation: input.required ? 'required' : 'optional'
    }));
    const parsed = parseDatabaseDiscoveryReferences(rows);
    expect(parsed.problems).toEqual([]);
    const built = buildDatabaseDiscoveryGraph(['source:0'], parsed.references);
    expect(built.problems).toEqual([]);

    const reachable = new Set(['source:0']);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!reachable.has(row.originSourceId) || reachable.has(row.targetSourceId)) continue;
        reachable.add(row.targetSourceId);
        changed = true;
      }
    }
    const expectedTargets = [...reachable]
      .filter((sourceId) => sourceId !== 'source:0')
      .sort()
      .map((sourceId) => {
        const incoming = rows.filter((row) =>
          reachable.has(row.originSourceId) && row.targetSourceId === sourceId);
        return {
          sourceId,
          expectation: incoming.some(({ expectation }) => expectation === 'required') ? 'required' : 'optional',
          discoveryEdges: incoming.map(({ linkId }) => linkId).sort()
        };
      });

    expect(built.graph?.targets).toEqual(expectedTargets);
  }
));
