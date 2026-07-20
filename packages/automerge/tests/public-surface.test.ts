import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';
import * as repoLifecycle from '../src/repo-lifecycle/index.js';
import * as systemDatabase from '../src/system-database/index.js';
import * as automergeView from '../src/view/index.js';

describe('production Automerge surface', () => {
  it('exposes one standard database path', () => {
    expect(Object.keys(automerge).sort()).toEqual(['mappedRelationRows', 'openAutomergeDatabase']);
    expect(automerge.mappedRelationRows).toBeTypeOf('function');
    expect(automerge.openAutomergeDatabase).toBeTypeOf('function');
  });

  it('keeps exact-basis materialization in its focused topic', () => {
    expect(Object.keys(automergeView)).toEqual(['viewAutomergeDocumentAtBasis']);
    expect(automergeView.viewAutomergeDocumentAtBasis).toBeTypeOf('function');
  });

  it('keeps Repo source creation in its focused optional topic', () => {
    expect(Object.keys(repoLifecycle)).toEqual(['createAutomergeRepoLifecycleAdapter']);
    expect(repoLifecycle.createAutomergeRepoLifecycleAdapter).toBeTypeOf('function');
    expect('createAutomergeRepoLifecycleAdapter' in automerge).toBe(false);
  });

  it('keeps normalized host facts in a focused optional database topic', () => {
    expect(Object.keys(systemDatabase)).toEqual(['openAutomergeSystemDatabase']);
    expect(systemDatabase.openAutomergeSystemDatabase).toBeTypeOf('function');
    expect('openAutomergeSystemDatabase' in automerge).toBe(false);
  });
});
