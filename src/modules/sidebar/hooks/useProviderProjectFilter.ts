import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, Project, SidebarProviderFilter } from '@/shared/types';

async function restoreLoadedSessionDepth(
  project: Project,
  loadedCount: number,
  provider: LLMProvider,
  signal: AbortSignal,
): Promise<Project> {
  if ((project.sessions?.length ?? 0) >= loadedCount || !project.sessionMeta?.hasMore) {
    return project;
  }
  const sessions = [...(project.sessions ?? [])];
  const ids = new Set(sessions.map((session) => session.id));
  let offset = sessions.length;
  let sessionMeta = project.sessionMeta;
  // The server caps page size; refill deeper pages without restoring deleted or archived rows from cache.
  while (offset < loadedCount && sessionMeta.hasMore) {
    const response = await api.projectSessions(project.projectId, {
      provider, offset, limit: loadedCount - offset,
    }, { signal });
    if (!response.ok) {
      throw new Error('Unable to refresh filtered sessions.');
    }
    const page = await response.json() as Pick<Project, 'sessions' | 'sessionMeta'>;
    if (!Array.isArray(page.sessions) || !page.sessionMeta) {
      throw new Error('Invalid sessions response.');
    }
    sessionMeta = page.sessionMeta;
    if (page.sessions.length === 0) {
      break;
    }
    offset += page.sessions.length;
    for (const session of page.sessions) {
      if (!ids.has(session.id)) {
        ids.add(session.id);
        sessions.push(session);
      }
    }
  }
  return { ...project, sessions, sessionMeta };
}

/** Used by the sidebar controller to paginate an agent's sessions without narrowing workspace state. */
export function useProviderProjectFilter(projects: Project[], provider: SidebarProviderFilter) {
  // A scoped snapshot prevents a late response from showing another agent's projects.
  const [snapshot, setSnapshot] = useState({
    provider,
    projects: [] as Project[],
    sourceProjects: null as Project[] | null,
    revision: -1,
    error: false,
  });
  // Explicit retries also refresh a filter when the parent project payload has not changed.
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  // Refresh the pages the user has opened, so expanded projects do not collapse back to their first page.
  const loadedSessionCounts = useRef({ provider, counts: new Map<string, number>() });
  const reload = useCallback(() => setRevision((previous) => previous + 1), []);
  const isLoading = provider !== 'all' && (
    snapshot.provider !== provider || snapshot.sourceProjects !== projects || snapshot.revision !== revision
  );

  useEffect(() => {
    const request = ++sequence.current;
    if (loadedSessionCounts.current.provider !== provider) {
      loadedSessionCounts.current = { provider, counts: new Map() };
    }
    if (provider === 'all') {
      return;
    }
    const controller = new AbortController();
    const requestedCounts = new Map(loadedSessionCounts.current.counts);
    void (async () => {
      try {
        const sessionsLimit = Math.max(20, ...requestedCounts.values());
        const response = await api.projects({
          provider, skipSynchronization: true, ...(sessionsLimit > 20 ? { sessionsLimit } : {}),
        }, { signal: controller.signal });
        if (!response.ok) {
          throw new Error('Unable to load filtered projects.');
        }
        const payload = await response.json() as Project[];
        if (!Array.isArray(payload)) {
          throw new Error('Invalid projects response.');
        }
        const refreshedProjects = await Promise.all(payload.map((project) => restoreLoadedSessionDepth(
          project, requestedCounts.get(project.projectId) ?? 0, provider, controller.signal,
        )));
        if (sequence.current === request) {
          setSnapshot({ provider, projects: refreshedProjects, sourceProjects: projects, revision, error: false });
        }
      } catch {
        if (sequence.current === request && !controller.signal.aborted) {
          setSnapshot((previous) => ({
            provider, projects: previous.provider === provider ? previous.projects : [],
            sourceProjects: projects, revision, error: true,
          }));
        }
      }
    })();
    return () => {
      controller.abort();
      if (sequence.current === request) {
        sequence.current += 1;
      }
    };
  }, [projects, provider, revision]);

  const loadMore = useCallback(async (projectId: string) => {
    if (provider === 'all' || snapshot.provider !== provider) {
      return;
    }
    const project = snapshot.projects.find((candidate) => candidate.projectId === projectId);
    if (!project?.sessionMeta?.hasMore || isLoading) {
      return;
    }
    const request = sequence.current;
    const response = await api.projectSessions(projectId, {
      provider,
      offset: project.sessions?.length ?? 0,
      limit: 20,
    });
    if (!response.ok) {
      throw new Error('Unable to load filtered sessions.');
    }
    const page = await response.json() as Pick<Project, 'sessions' | 'sessionMeta'>;
    if (sequence.current !== request) {
      return;
    }
    const loadedIds = new Set([...(project.sessions ?? []), ...(page.sessions ?? [])].map((session) => session.id));
    loadedSessionCounts.current.counts.set(projectId, loadedIds.size);
    setSnapshot((previous) => sequence.current !== request || previous.provider !== provider ? previous : ({
      ...previous,
      projects: previous.projects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }
        const existing = candidate.sessions ?? [];
        const ids = new Set(existing.map((session) => session.id));
        return {
          ...candidate,
          sessions: [...existing, ...(page.sessions ?? []).filter((session) => !ids.has(session.id))],
          sessionMeta: page.sessionMeta,
        };
      }),
    }));
  }, [isLoading, provider, snapshot]);

  return {
    projects: provider === 'all' ? projects : snapshot.provider === provider ? snapshot.projects : [],
    isLoading,
    error: provider !== 'all' && !isLoading && snapshot.error,
    loadMore,
    reload,
  };
}
