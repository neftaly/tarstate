import { formatWorkspaceStatus, workspaceStatus } from './workspace-fixture';

const root = document.querySelector<HTMLElement>('#app');

if (root !== null) {
  root.textContent = formatWorkspaceStatus(workspaceStatus);
}
