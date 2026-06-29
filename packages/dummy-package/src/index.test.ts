import { describe, expect, it } from 'vitest';
import { describeWorkspaceFixture, workspaceFixture } from './index';

describe('dummy package workspace fixture', () => {
  it('keeps package checks independent from Tarstate APIs', () => {
    expect(describeWorkspaceFixture(workspaceFixture)).toBe('@tarstate/dummy-package uses root config');
  });
});
