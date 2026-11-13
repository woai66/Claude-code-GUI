import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useStartSessionInFolder } from '@/modules/project-workspace/hooks/useStartSessionInFolder';

const mocks = vi.hoisted(() => ({
  projects: vi.fn(),
  onNewSession: vi.fn(),
  refreshProjectsSilently: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: { projects: mocks.projects },
}));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => ({ sidebarSharedProps: { onNewSession: mocks.onNewSession } }),
  useProjectMainState: () => ({ refreshProjectsSilently: mocks.refreshProjectsSilently }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const ALPHA = { projectId: 'alpha', displayName: 'Alpha', fullPath: 'C:\\Work\\Alpha' };
const BETA = { projectId: 'beta', displayName: 'Beta', fullPath: '/home/user/Beta' };

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.projects.mockResolvedValue({ json: async () => [ALPHA, BETA] });
  mocks.refreshProjectsSilently.mockResolvedValue(undefined);
});

test('starts a session in the project the server lists for the folder and refreshes the sidebar', async () => {
  const { result } = renderHook(() => useStartSessionInFolder());
  await result.current('C:\\Work\\Alpha');
  expect(mocks.onNewSession).toHaveBeenCalledWith(ALPHA);
  expect(mocks.refreshProjectsSilently).toHaveBeenCalledOnce();
});

test('matches a Windows folder regardless of separators, trailing slash and letter case', async () => {
  const { result } = renderHook(() => useStartSessionInFolder());
  await result.current('c:/work/alpha/');
  expect(mocks.onNewSession).toHaveBeenCalledWith(ALPHA);
});

test('keeps letter case significant for POSIX folders', async () => {
  const { result } = renderHook(() => useStartSessionInFolder());
  await expect(result.current('/home/user/beta')).rejects.toThrow('does not appear in the project list');
  expect(mocks.onNewSession).not.toHaveBeenCalled();
});

test('rejects when the server lists no project for the folder', async () => {
  const { result } = renderHook(() => useStartSessionInFolder());
  await expect(result.current('D:\\Elsewhere')).rejects.toThrow('does not appear in the project list');
  expect(mocks.onNewSession).not.toHaveBeenCalled();
  expect(mocks.refreshProjectsSilently).not.toHaveBeenCalled();
});
