import { describe, expect, it } from 'vitest';
import { formatWorkspaceStatus } from './workspace-fixture';

describe('dummy app workspace fixture', () => {
  it('formats the app status without Tarstate runtime APIs', () => {
    const status = { label: 'dummy app', purpose: 'shared config check' };

    expect(formatWorkspaceStatus(status)).toBe('dummy app: shared config check');
  });
});
