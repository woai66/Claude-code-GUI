import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ProjectFolderPicker from '@/modules/project-creation-wizard/ProjectFolderPicker';

const mocks = vi.hoisted(() => ({
  chooseDirectory: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: { createProject: mocks.createProject },
}));
vi.mock('@/modules/project-creation-wizard/FolderBrowserModal', () => ({
  default: ({ isOpen, onFolderSelected }: { isOpen: boolean; onFolderSelected: (path: string) => void }) => isOpen
    ? <button onClick={() => onFolderSelected('/server/project')}>Use server folder</button>
    : null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const START_PATH = 'C:\\Work';
const WINDOWS_PATH = 'C:\\Work\\Alpha';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function renderPicker(onFolderReady: (folderPath: string) => void | Promise<void>) {
  return render(
    <ProjectFolderPicker startPath={START_PATH} onFolderReady={onFolderReady}>
      {({ pickFolder, isPicking, error }) => (
        <>
          <button onClick={pickFolder} disabled={isPicking}>Pick</button>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </ProjectFolderPicker>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.chooseDirectory.mockResolvedValue(WINDOWS_PATH);
  mocks.createProject.mockResolvedValue(jsonResponse(200, { success: true, project: { projectId: 'alpha' } }));
  window.claudeGuiDirectories = {
    chooseDirectory: mocks.chooseDirectory,
    getDroppedDirectory: vi.fn(),
  };
});

afterEach(() => {
  delete window.claudeGuiDirectories;
});

test('a picked folder is registered as a project and then handed to the caller', async () => {
  const onFolderReady = vi.fn();
  const view = renderPicker(onFolderReady);
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  await waitFor(() => expect(onFolderReady).toHaveBeenCalledWith(WINDOWS_PATH));
  expect(mocks.chooseDirectory).toHaveBeenCalledWith(START_PATH);
  expect(mocks.createProject).toHaveBeenCalledWith({ path: WINDOWS_PATH });
  expect(view.queryByRole('alert')).toBeNull();
});

test('a folder that already is a project is handed to the caller as well', async () => {
  mocks.createProject.mockResolvedValue(jsonResponse(409, { error: { code: 'PROJECT_ALREADY_EXISTS' } }));
  const onFolderReady = vi.fn();
  const view = renderPicker(onFolderReady);
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  await waitFor(() => expect(onFolderReady).toHaveBeenCalledWith(WINDOWS_PATH));
  expect(view.queryByRole('alert')).toBeNull();
});

test('canceling the native dialog registers nothing and unlocks the trigger', async () => {
  mocks.chooseDirectory.mockResolvedValue(null);
  const onFolderReady = vi.fn();
  const view = renderPicker(onFolderReady);
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  await waitFor(() => expect(mocks.chooseDirectory).toHaveBeenCalledOnce());
  await waitFor(() => expect((view.getByRole('button', { name: 'Pick' }) as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.createProject).not.toHaveBeenCalled();
  expect(onFolderReady).not.toHaveBeenCalled();
});

test('a server refusal is shown and the caller is not told the folder is ready', async () => {
  mocks.createProject.mockResolvedValue(jsonResponse(400, { error: 'Path is not a directory' }));
  const onFolderReady = vi.fn();
  const view = renderPicker(onFolderReady);
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Path is not a directory'));
  expect(onFolderReady).not.toHaveBeenCalled();
  expect((view.getByRole('button', { name: 'Pick' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a failure in the caller is shown instead of being swallowed', async () => {
  const view = renderPicker(async () => { throw new Error('Folder is not listed'); });
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Folder is not listed'));
});

test('without the desktop bridge the server folder browser picks the folder', async () => {
  delete window.claudeGuiDirectories;
  const onFolderReady = vi.fn();
  const view = renderPicker(onFolderReady);
  fireEvent.click(view.getByRole('button', { name: 'Pick' }));
  fireEvent.click(view.getByRole('button', { name: 'Use server folder' }));
  await waitFor(() => expect(onFolderReady).toHaveBeenCalledWith('/server/project'));
  expect(mocks.createProject).toHaveBeenCalledWith({ path: '/server/project' });
});
