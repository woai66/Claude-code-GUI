import assert from 'node:assert/strict';
import { fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ComponentProps } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';
import SidebarHeader from '@/modules/sidebar/SidebarHeader';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';

let compactLayout = false;
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => compactLayout }));
vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: ({ session }: { session: SessionWithProvider }) => <div>{session.summary}</div>,
}));

const PROJECT_A: Project = { projectId: 'a', displayName: 'Alpha', fullPath: '/repo/alpha' };
const PROJECT_B: Project = { projectId: 'b', displayName: 'Beta', fullPath: '/repo/beta' };
const PROJECTS = [PROJECT_A, PROJECT_B];
const NO_IDS = new Set<string>();
const noop = () => {};
const LABELS: Record<string, string> = {
  'app.title': 'Claude GUI',
  'sessions.newSession': 'New session',
  'sessions.chooseProject': 'Choose a project for a new session',
  'projects.options': 'Project options',
  'projects.renameProject': 'Rename project',
  'projects.deleteProject': 'Remove project',
  'tooltips.addToFavorites': 'Add to favorites',
  'search.modeProjects': 'Projects',
  'search.modeConversations': 'Conversations',
};
const t = ((key: string, fallback?: unknown) => LABELS[key]
  ?? (typeof fallback === 'string' ? fallback : key)) as unknown as TFunction;

function renderHeader(overrides: Partial<ComponentProps<typeof SidebarHeader>> = {}) {
  return render(<SidebarHeader
    isPWA={false} isMobile={false} projects={PROJECTS} selectedProject={PROJECT_B}
    runningSessionsCount={0} searchFilter="" providerFilter="all" onProviderFilterChange={noop}
    onSearchFilterChange={noop} onClearSearchFilter={noop} searchMode="projects" onSearchModeChange={noop}
    onRefresh={noop} isRefreshing={false} onCreateProject={noop} onNewSession={noop}
    onCollapseSidebar={noop} t={t} {...overrides}
  />);
}

function renderProject(overrides: Partial<ComponentProps<typeof SidebarProjectItem>> = {}) {
  return render(<SidebarProjectItem
    project={PROJECT_A} selectedProject={PROJECT_A} selectedSession={null} isExpanded
    isDeleting={false} isStarred={false} isEditing={false} renameDraft=""
    sessions={[{ id: 'a1', summary: 'Existing conversation', __provider: 'claude' }]}
    initialSessionsLoaded isLoadingMoreSessions={false} currentTime={new Date('2026-10-11T12:00:00Z')}
    sessionRenameId={null} sessionRenameDraft="" tasksEnabled={false} mcpServerStatus={null}
    onRenameDraftChange={noop} onToggleProject={noop} onProjectSelect={noop} onToggleStarProject={noop}
    onStartEditingProject={noop} onCancelEditingProject={noop} onSaveProjectName={noop}
    onDeleteProject={noop} onSessionSelect={noop} onDeleteSession={noop} onLoadMoreSessions={noop}
    activeSessions={NO_IDS} backgroundSessionIds={NO_IDS} attentionSessionIds={NO_IDS}
    onNewSession={noop} onStartEditingSession={noop} onCancelEditingSession={noop} onSaveEditingSession={noop}
    selectedSessionIds={null} onSetSessionSelection={noop} onToggleSessionSelected={noop}
    onCancelSessionSelection={noop} onDeleteSelectedSessions={noop} t={t} {...overrides}
  />);
}

beforeEach(() => { compactLayout = false; });

test('the top new-session action uses the selected project', () => {
  const onNewSession = vi.fn();
  const view = renderHeader({ onNewSession });
  fireEvent.click(view.getByRole('button', { name: 'New session' }));
  assert.deepEqual(onNewSession.mock.calls, [[PROJECT_B]]);
});

test('the dropdown starts a session in the explicitly chosen project', () => {
  const onNewSession = vi.fn();
  const view = renderHeader({ onNewSession });
  fireEvent.click(view.getByRole('button', { name: 'Choose a project for a new session' }));
  fireEvent.click(view.getByRole('menuitem', { name: /Alpha/ }));
  assert.deepEqual(onNewSession.mock.calls, [[PROJECT_A]]);
});

test('with multiple projects and no selection, New asks for a project first', () => {
  const onNewSession = vi.fn();
  const view = renderHeader({ selectedProject: null, onNewSession });
  fireEvent.click(view.getByRole('button', { name: 'New session' }));
  assert.equal(onNewSession.mock.calls.length, 0);
  fireEvent.click(view.getByRole('menuitem', { name: /Beta/ }));
  assert.deepEqual(onNewSession.mock.calls, [[PROJECT_B]]);
});

test('a single project can start immediately without an existing selection', () => {
  const onNewSession = vi.fn();
  const view = renderHeader({ projects: [PROJECT_A], selectedProject: null, onNewSession });
  fireEvent.click(view.getByRole('button', { name: 'New session' }));
  assert.deepEqual(onNewSession.mock.calls, [[PROJECT_A]]);
});

test('an empty workspace offers project creation through New', () => {
  const onCreateProject = vi.fn();
  const onNewSession = vi.fn();
  const view = renderHeader({ projects: [], selectedProject: PROJECT_B, onNewSession, onCreateProject });
  fireEvent.click(view.getByRole('button', { name: 'New session' }));
  assert.equal(onCreateProject.mock.calls.length, 1);
  assert.equal(onNewSession.mock.calls.length, 0);
});

test('a removed selection cannot receive a session, and a refreshed selection uses live metadata', () => {
  const onNewSession = vi.fn();
  const liveProject = { ...PROJECT_A, displayName: 'Renamed Alpha' };
  const view = renderHeader({ projects: [liveProject], selectedProject: PROJECT_B, onNewSession });
  fireEvent.click(view.getByRole('button', { name: 'New session' }));
  assert.deepEqual(onNewSession.mock.calls, [[liveProject]]);
});

test.each([false, true])('project shortcut preserves expansion and targets its project (compact=%s)', (compact) => {
  compactLayout = compact;
  const onNewSession = vi.fn();
  const onToggleProject = vi.fn();
  const view = renderProject({ onNewSession, onToggleProject });
  assert.ok(view.getByText('Existing conversation'));
  assert.equal(view.queryByText('New session'), null);
  fireEvent.click(view.getByRole('button', { name: 'New session · Alpha' }));
  assert.deepEqual(onNewSession.mock.calls, [[PROJECT_A]]);
  assert.equal(onToggleProject.mock.calls.length, 0);
  assert.equal(view.getByRole('button', { name: 'Alpha' }).getAttribute('aria-expanded'), 'true');
});

test('the project menu preserves rename, favorite and removal actions', () => {
  const onDeleteProject = vi.fn();
  const view = renderProject({ onDeleteProject });
  fireEvent.click(view.getByRole('button', { name: 'Project options · Alpha' }));
  assert.ok(view.getByRole('menuitem', { name: 'Rename project' }));
  assert.ok(view.getByRole('menuitem', { name: 'Add to favorites' }));
  fireEvent.click(view.getByRole('menuitem', { name: 'Remove project' }));
  assert.deepEqual(onDeleteProject.mock.calls, [[PROJECT_A]]);
});
