export type WorkspaceStatus = {
  readonly label: string;
  readonly purpose: string;
};

export const workspaceStatus = {
  label: '@tarstate/dummy-app',
  purpose: 'shared config check'
} satisfies WorkspaceStatus;

export const formatWorkspaceStatus = (status: WorkspaceStatus): string => status.label + ': ' + status.purpose;
