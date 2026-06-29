export type WorkspaceFixture = {
  readonly packageName: string;
  readonly configSource: 'root config';
};

export const workspaceFixture = {
  packageName: '@tarstate/dummy-package',
  configSource: 'root config'
} satisfies WorkspaceFixture;

export const describeWorkspaceFixture = (fixture: WorkspaceFixture): string =>
  fixture.packageName + ' uses ' + fixture.configSource;
