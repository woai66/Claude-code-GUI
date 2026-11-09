import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Project, SidebarProviderFilter } from '@/shared/types';
import { useProviderProjectFilter } from '@/modules/sidebar/hooks/useProviderProjectFilter';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
import { hydrateUserPreferences, readUserPreference, resetUserPreferences } from '@/shared/userSettings';

vi.mock('@/shared/api', () => ({ api: {
  projects: vi.fn(), projectSessions: vi.fn(), recentConversations: vi.fn(),
  archivedProjects: vi.fn(), getArchivedSessions: vi.fn(), searchConversationsUrl: vi.fn(),
  deleteProject: vi.fn(),
  user: { preferences: vi.fn(), savePreferences: vi.fn().mockResolvedValue({ ok: true }) },
} }));

const response = (payload: unknown) => ({ ok: true, json: async () => payload }) as Response;
const globalProjects: Project[] = [{
  projectId: 'mixed', displayName: 'Mixed', fullPath: '/mixed',
  sessions: [{ id: 'codex-new', provider: 'codex' }], sessionMeta: { total: 30, hasMore: true },
}];
const claudeProjects: Project[] = [{
  ...globalProjects[0], sessions: [{ id: 'claude-old', provider: 'claude' }],
  sessionMeta: { total: 2, hasMore: true },
}];

const renderController = () => renderHook(({ projects }: { projects: Project[] }) => useSidebarController({
  projects, selectedProject: null, selectedSession: null,
  activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(),
  isLoading: false, isMobile: false, t: ((key: string) => key) as unknown as TFunction,
  onRefresh: vi.fn(), onProjectSelect: vi.fn(), onSessionSelect: vi.fn(),
  setCurrentProject: vi.fn(), setSidebarVisible: vi.fn(), sidebarVisible: true,
}), { initialProps: { projects: globalProjects } });

beforeEach(() => {
  resetUserPreferences();
  vi.mocked(api.user.savePreferences).mockReset().mockResolvedValue(response({}));
  localStorage.clear();
  vi.mocked(api.projects).mockReset().mockResolvedValue(response(claudeProjects));
  vi.mocked(api.projectSessions).mockReset();
  vi.mocked(api.recentConversations).mockReset().mockResolvedValue(response({
    data: { conversations: [], total: 0, hasMore: false },
  }));
  vi.mocked(api.archivedProjects).mockResolvedValue(response({ data: { projects: [] } }));
  vi.mocked(api.getArchivedSessions).mockResolvedValue(response({ data: { sessions: [] } }));
});

afterEach(() => resetUserPreferences());

test('hidden projects survive rescans and agent filters while sessions remain intact', async () => {
  const view = renderController();
  act(() => view.result.current.hideProject(globalProjects[0]));
  assert.deepEqual(view.result.current.filteredProjects, []);
  assert.deepEqual(view.result.current.visibleProjects, []);
  assert.deepEqual(view.result.current.hiddenProjects, globalProjects);
  assert.deepEqual(readUserPreference('hiddenProjectIds', []), ['mixed']);
  assert.deepEqual(JSON.parse(localStorage.getItem('user-preferences') ?? '{}').hiddenProjectIds, ['mixed']);
  view.rerender({ projects: globalProjects.map((project) => ({ ...project })) });
  assert.equal(view.result.current.filteredProjects.length, 0);
  await waitFor(() => assert.deepEqual(vi.mocked(api.user.savePreferences).mock.calls[0], [{ hiddenProjectIds: ['mixed'] }]));
  act(() => view.result.current.setProviderFilter('claude'));
  await waitFor(() => assert.equal(view.result.current.isProviderProjectsLoading, false));
  assert.equal(view.result.current.filteredProjects.length, 0);
  view.unmount();
  const reopened = renderController();
  await waitFor(() => assert.equal(reopened.result.current.isProviderProjectsLoading, false));
  assert.equal(reopened.result.current.filteredProjects.length, 0);
  assert.equal(globalProjects[0].sessions?.[0].id, 'codex-new');
  act(() => reopened.result.current.restoreHiddenProject('mixed'));
  assert.equal(reopened.result.current.filteredProjects[0].projectId, 'mixed');
  assert.equal(reopened.result.current.hiddenProjects.length, 0);
  assert.equal(vi.mocked(api.deleteProject).mock.calls.length, 0);
});

test('server preferences restore hidden identities and preserve conversation access', async () => {
  vi.mocked(api.user.preferences).mockResolvedValue(response({ preferences: { hiddenProjectIds: ['mixed'] } }));
  await hydrateUserPreferences();
  const view = renderController();
  assert.equal(view.result.current.filteredProjects.length, 0);
  act(() => view.result.current.setSearchMode('conversations'));
  await waitFor(() => assert.equal(view.result.current.isRecentConversationsLoading, false));
  assert.equal(view.result.current.getProjectSessions(globalProjects[0])[0].id, 'codex-new');
  act(() => view.result.current.restoreHiddenProject('mixed'));
  assert.equal(view.result.current.visibleProjects[0].projectId, 'mixed');
});

test('loads an older agent session and paginates its scope without narrowing workspace data', async () => {
  const { result, rerender } = renderHook(({ provider }: { provider: SidebarProviderFilter }) =>
    useProviderProjectFilter(globalProjects, provider), { initialProps: { provider: 'claude' } });
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.[0].id, 'claude-old'));
  assert.equal(vi.mocked(api.projects).mock.calls[0][0]?.provider, 'claude');
  vi.mocked(api.projectSessions).mockResolvedValue(response({
    sessions: [{ id: 'claude-older', provider: 'claude' }], sessionMeta: { total: 2, hasMore: false },
  }));
  await act(() => result.current.loadMore('mixed'));
  assert.deepEqual(vi.mocked(api.projectSessions).mock.calls[0].slice(0, 2), [
    'mixed', { provider: 'claude', offset: 1, limit: 20 },
  ]);
  assert.deepEqual(result.current.projects[0].sessions?.map((session) => session.id), ['claude-old', 'claude-older']);
  assert.equal(result.current.projects[0].sessionMeta?.hasMore, false);
  assert.equal(globalProjects[0].sessions?.[0].id, 'codex-new');
  rerender({ provider: 'all' });
  assert.equal(result.current.projects, globalProjects);
});

test('late project and pagination responses cannot leak across agent switches', async () => {
  let completePage: (response: Response) => void = () => {};
  vi.mocked(api.projectSessions).mockImplementation(() => new Promise((resolve) => { completePage = resolve; }));
  const { result, rerender } = renderHook(({ provider }: { provider: SidebarProviderFilter }) =>
    useProviderProjectFilter(globalProjects, provider), { initialProps: { provider: 'claude' } });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  const pending = result.current.loadMore('mixed');
  vi.mocked(api.projects).mockResolvedValue(response(globalProjects));
  rerender({ provider: 'codex' });
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.[0].id, 'codex-new'));
  await act(async () => {
    completePage(response({ sessions: [{ id: 'claude-leaked', provider: 'claude' }] }));
    await pending;
  });
  assert.deepEqual(result.current.projects[0].sessions?.map((session) => session.id), ['codex-new']);
});

test('failed filtered requests expose a retry and recover without showing unfiltered sessions', async () => {
  vi.mocked(api.projects).mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useProviderProjectFilter(globalProjects, 'claude'));
  await waitFor(() => assert.equal(result.current.error, true));
  assert.equal(result.current.projects.length, 0);
  act(() => result.current.reload());
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.[0].id, 'claude-old'));
  assert.equal(result.current.error, false);
});

test('a failed background refresh keeps the loaded agent list visible', async () => {
  const { result, rerender } = renderHook(({ projects }: { projects: Project[] }) =>
    useProviderProjectFilter(projects, 'claude'), { initialProps: { projects: globalProjects } });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  const loadedProjects = result.current.projects;
  vi.mocked(api.projects).mockRejectedValueOnce(new Error('offline'));

  rerender({ projects: [...globalProjects] });
  assert.equal(result.current.projects, loadedProjects);
  await waitFor(() => assert.equal(result.current.error, true));
  assert.equal(result.current.projects, loadedProjects);
});

test('a background refresh retains the session depth already loaded for the agent', async () => {
  const sessions = Array.from({ length: 23 }, (_, index) => ({ id: `claude-${index}`, provider: 'claude' }));
  const project = { ...globalProjects[0], sessions: sessions.slice(0, 20), sessionMeta: { total: 23, hasMore: true } };
  vi.mocked(api.projects).mockResolvedValueOnce(response([project]));
  const { result, rerender } = renderHook(({ projects }: { projects: Project[] }) =>
    useProviderProjectFilter(projects, 'claude'), { initialProps: { projects: globalProjects } });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  vi.mocked(api.projectSessions).mockResolvedValue(response({
    sessions: sessions.slice(20), sessionMeta: { total: 23, hasMore: false },
  }));
  await act(() => result.current.loadMore('mixed'));
  assert.equal(result.current.projects[0].sessions?.length, 23);

  vi.mocked(api.projects).mockImplementation(async (filters) => {
    const limit = filters?.sessionsLimit ?? 20;
    return response([{ ...project, sessions: sessions.slice(0, limit), sessionMeta: { total: 23, hasMore: limit < 23 } }]);
  });
  rerender({ projects: [...globalProjects] });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  assert.equal(result.current.projects[0].sessions?.length, 23);
  assert.equal(result.current.projects[0].sessionMeta?.hasMore, false);
});

test('refresh refills server-capped pages without bringing removed sessions back from cache', async () => {
  const sessions = Array.from({ length: 23 }, (_, index) => ({ id: `claude-${index}`, provider: 'claude' }));
  const project = { ...globalProjects[0], sessions: sessions.slice(0, 20), sessionMeta: { total: 23, hasMore: true } };
  vi.mocked(api.projects).mockResolvedValue(response([project]));
  const { result, rerender } = renderHook(({ projects }: { projects: Project[] }) =>
    useProviderProjectFilter(projects, 'claude'), { initialProps: { projects: globalProjects } });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  vi.mocked(api.projectSessions).mockResolvedValueOnce(response({
    sessions: sessions.slice(20), sessionMeta: { total: 23, hasMore: false },
  }));
  await act(() => result.current.loadMore('mixed'));

  const remaining = sessions.filter((session) => session.id !== 'claude-22');
  vi.mocked(api.projects).mockResolvedValue(response([{
    ...project, sessions: remaining.slice(0, 20), sessionMeta: { total: 22, hasMore: true },
  }]));
  vi.mocked(api.projectSessions).mockResolvedValueOnce(response({
    sessions: remaining.slice(20), sessionMeta: { total: 22, hasMore: false },
  }));
  rerender({ projects: [...globalProjects] });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  assert.deepEqual(result.current.projects[0].sessions, remaining);
  assert.deepEqual(result.current.projects[0].sessionMeta, { total: 22, hasMore: false });
  assert.deepEqual(vi.mocked(api.projectSessions).mock.calls.at(-1)?.slice(0, 2), [
    'mixed', { provider: 'claude', offset: 20, limit: 3 },
  ]);
});

test('sidebar load-more serializes scoped requests and project deletion keeps the complete session count', async () => {
  vi.mocked(api.projectSessions).mockResolvedValue(response({
    sessions: [{ id: 'claude-older', provider: 'claude' }], sessionMeta: { total: 2, hasMore: false },
  }));
  const { result } = renderController();
  act(() => result.current.setProviderFilter('claude'));
  await waitFor(() => assert.equal(result.current.filteredProjects[0]?.sessions?.[0].id, 'claude-old'));
  await act(async () => {
    await Promise.all([
      result.current.loadMoreSessionsForProject('mixed'),
      result.current.loadMoreSessionsForProject('mixed'),
    ]);
  });
  assert.equal(vi.mocked(api.projectSessions).mock.calls.length, 1);
  assert.equal(result.current.filteredProjects[0].sessions?.length, 2);
  act(() => result.current.requestProjectDelete(result.current.filteredProjects[0]));
  assert.equal(result.current.pendingDeletion?.kind, 'project');
  if (result.current.pendingDeletion?.kind === 'project') {
    assert.equal(result.current.pendingDeletion.sessionCount, 30);
    assert.equal(result.current.pendingDeletion.project, globalProjects[0]);
  }
});

test('conversation scope is persisted and resets pagination when the agent changes', async () => {
  vi.mocked(api.recentConversations).mockImplementation(async ({ provider } = {}) => response({
    data: {
      conversations: [{ sessionId: `${provider}-session`, provider, projectId: 'mixed', sessionTitle: 'title' }],
      total: 1, hasMore: false,
    },
  }));
  const { result } = renderController();
  act(() => {
    result.current.setProviderFilter('claude');
    result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(result.current.recentConversations[0]?.provider, 'claude'));
  act(() => result.current.setProviderFilter('codex'));
  await waitFor(() => assert.equal(result.current.recentConversations[0]?.provider, 'codex'));
  assert.equal(result.current.recentConversationsTotal, 1);
  assert.equal(localStorage.getItem('sidebar-provider-filter'), 'codex');
  assert.deepEqual(vi.mocked(api.recentConversations).mock.calls.at(-1)?.[0], {
    limit: 40, offset: 0, provider: 'codex',
  });
});
