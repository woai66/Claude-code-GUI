import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ProjectCreationWizard from '@/modules/project-creation-wizard/ProjectCreationWizard';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

const mocks = vi.hoisted(() => ({
  chooseDirectory: vi.fn(),
  getDroppedDirectory: vi.fn(),
  createProjectRequest: vi.fn(),
  cloneWorkspaceWithProgress: vi.fn(),
}));

vi.mock('@/modules/project-creation-wizard/utils/workspaceApi', () => ({
  createProjectRequest: mocks.createProjectRequest,
  cloneWorkspaceWithProgress: mocks.cloneWorkspaceWithProgress,
}));
vi.mock('@/modules/project-creation-wizard/hooks/useGithubTokens', () => ({
  useGithubTokens: () => ({ tokens: [], loading: false, loadError: null }),
}));
vi.mock('@/modules/project-creation-wizard/FolderBrowserModal', () => ({
  default: ({ isOpen, onFolderSelected }: { isOpen: boolean; onFolderSelected: (path: string) => void }) => isOpen
    ? <div data-folder-browser role="dialog" aria-label="Browser folder picker">
        <button onClick={() => onFolderSelected('/server/project')}>Use server folder</button>
      </div>
    : null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => ({
    'projectWizard.title': 'Create project',
    'projectWizard.buttons.cancel': 'Cancel',
    'projectWizard.buttons.createProject': 'Create project',
    'projectWizard.buttons.creating': 'Creating...',
    'projectWizard.buttons.cloning': 'Cloning...',
    'projectWizard.step2.newPath': 'Workspace path',
    'projectWizard.step2.githubUrl': 'GitHub URL',
    'projectWizard.errors.providePath': 'Choose a folder first',
  } as Record<string, string>)[key] ?? fallback ?? key }),
}));

const PROJECT = { projectId: 'new-project', displayName: 'Alpha' };
const WINDOWS_PATH = 'C:\\Work\\Alpha';

function PathField({ disabled = false }: { disabled?: boolean }) {
  // 模拟父组件保存目录，使测试覆盖选择失败时保留已选路径的行为。
  const [directory, setDirectory] = useState('/work/original');
  return <WorkspacePathField value={directory} onChange={setDirectory} disabled={disabled} />;
}

function dropFolder(view: ReturnType<typeof render>, files = [new File([], 'Alpha')]) {
  const dataTransfer = { files, types: ['Files'], dropEffect: '' };
  const target = view.getByRole('group', { name: 'Project folder' });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.chooseDirectory.mockResolvedValue(WINDOWS_PATH);
  mocks.getDroppedDirectory.mockResolvedValue({ path: '/work/dropped' });
  mocks.createProjectRequest.mockResolvedValue(PROJECT);
  mocks.cloneWorkspaceWithProgress.mockResolvedValue(PROJECT);
  window.claudeGuiDirectories = {
    chooseDirectory: mocks.chooseDirectory,
    getDroppedDirectory: mocks.getDroppedDirectory,
  };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
});

afterEach(() => {
  delete window.claudeGuiDirectories;
  vi.unstubAllGlobals();
});

test('native selection fills the path and folder name, then creates the project in one step', async () => {
  const onClose = vi.fn();
  const onProjectCreated = vi.fn();
  const view = render(<ProjectCreationWizard onClose={onClose} onProjectCreated={onProjectCreated} />);
  expect((view.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByRole('button', { name: /Next/ })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('Alpha'));
  expect(view.getByTitle(WINDOWS_PATH)).toBeTruthy();
  expect(view.queryByRole('dialog', { name: 'Browser folder picker' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.createProjectRequest).toHaveBeenCalledWith({ path: WINDOWS_PATH, customName: 'Alpha' });
  expect(onProjectCreated).toHaveBeenCalledWith(PROJECT);
});

test('canceling native selection keeps the previous directory', async () => {
  mocks.chooseDirectory.mockResolvedValue(null);
  const view = render(<PathField />);
  fireEvent.click(view.getByRole('button', { name: 'Change' }));
  await waitFor(() => expect(view.getByRole('group').getAttribute('aria-busy')).toBe('false'));
  expect(mocks.chooseDirectory).toHaveBeenCalledWith('/work/original');
  expect(view.getByTitle('/work/original')).toBeTruthy();
  expect(view.queryByRole('alert')).toBeNull();
});

test('a native picker failure preserves the previous directory and allows retry', async () => {
  mocks.chooseDirectory.mockRejectedValue(new Error('picker unavailable'));
  const view = render(<PathField />);
  fireEvent.click(view.getByRole('button', { name: 'Change' }));
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Could not open'));
  expect(view.getByTitle('/work/original')).toBeTruthy();
  expect((view.getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(false);
});

test('dropping a folder sets its full path while keeping a custom project name', async () => {
  const view = render(<ProjectCreationWizard onClose={() => {}} />);
  fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'My project' } });
  dropFolder(view);
  await waitFor(() => expect(view.getByTitle('/work/dropped')).toBeTruthy());
  expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('My project');
  fireEvent.click(view.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(mocks.createProjectRequest).toHaveBeenCalledWith({
    path: '/work/dropped', customName: 'My project',
  }));
});

test.each(['not-directory', 'single-folder', 'unavailable'])('a rejected %s drop leaves the directory unchanged', async (error) => {
  mocks.getDroppedDirectory.mockResolvedValue({ error });
  const view = render(<PathField />);
  dropFolder(view);
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(view.getByTitle('/work/original')).toBeTruthy();
});

test('disabled directory fields ignore dropped folders', () => {
  const view = render(<PathField disabled />);
  dropFolder(view);
  expect(mocks.getDroppedDirectory).not.toHaveBeenCalled();
  expect(view.getByTitle('/work/original')).toBeTruthy();
});

test('web users can browse a server folder and can also enter a path manually', async () => {
  delete window.claudeGuiDirectories;
  const view = render(<ProjectCreationWizard onClose={() => {}} />);
  fireEvent.click(view.getByRole('button', { name: 'Choose folder' }));
  fireEvent.click(view.getByRole('button', { name: 'Use server folder' }));
  expect(view.getByTitle('/server/project')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Enter path manually' }));
  fireEvent.change(view.getByLabelText('Workspace path'), { target: { value: ' /server/new-project ' } });
  fireEvent.click(view.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(mocks.createProjectRequest).toHaveBeenCalledWith({
    path: '/server/new-project', customName: 'new-project',
  }));
});

test('creation errors preserve the form and only one request is in flight', async () => {
  let reject: (error: Error) => void = () => {};
  mocks.createProjectRequest.mockImplementation(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  const onClose = vi.fn();
  const view = render(<ProjectCreationWizard onClose={onClose} />);
  dropFolder(view);
  await waitFor(() => expect(view.getByTitle('/work/dropped')).toBeTruthy());
  const create = view.getByRole('button', { name: 'Create project' });
  fireEvent.click(create);
  fireEvent.click(create);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(mocks.createProjectRequest).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  reject(new Error('Path already exists'));
  await waitFor(() => expect(view.getByText('Path already exists')).toBeTruthy());
  expect(view.getByTitle('/work/dropped')).toBeTruthy();
  expect((view.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(false);
});

test('optional cloning still uses the chosen parent directory and existing clone API', async () => {
  const onClose = vi.fn();
  const view = render(<ProjectCreationWizard onClose={onClose} />);
  fireEvent.click(view.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(view.getByTitle(WINDOWS_PATH)).toBeTruthy());
  fireEvent.click(view.getByText('Clone from GitHub (optional)'));
  fireEvent.change(view.getByLabelText('GitHub URL'), { target: { value: 'git@github.com:owner/repo.git' } });
  fireEvent.click(view.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.cloneWorkspaceWithProgress).toHaveBeenCalledWith(expect.objectContaining({
    workspacePath: WINDOWS_PATH, githubUrl: 'git@github.com:owner/repo.git',
  }), expect.anything());
  expect(mocks.createProjectRequest).not.toHaveBeenCalled();
});
