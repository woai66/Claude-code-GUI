import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';

// Windows reports the same folder with either separator and in any letter case.
const normalizeFolderPath = (folderPath: string): string => {
  const unified = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
};

/**
 * Used by NewSessionFolderMenu and WorkspaceStateView to open a new session in a folder
 * that was just registered as a project. The returned function rejects when the server
 * does not list a project for that folder.
 */
export function useStartSessionInFolder(): (folderPath: string) => Promise<void> {
  const { t } = useTranslation();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { refreshProjectsSilently } = useProjectMainState();
  const { onNewSession } = sidebarSharedProps;

  return useCallback(async (folderPath: string) => {
    // The folder may have become a project a moment ago, so ask the server rather than
    // searching the list already on screen.
    const response = await api.projects();
    const projects = (await response.json()) as Project[];
    const wantedPath = normalizeFolderPath(folderPath);
    const project = projects.find((candidate) => normalizeFolderPath(candidate.fullPath) === wantedPath);
    if (!project) {
      throw new Error(t('mainContent.folderNotListed', 'This folder was added, but it does not appear in the project list yet. Refresh the sidebar and try again.'));
    }

    onNewSession(project);
    // Brings the sidebar's list in line; the session page above does not wait for it.
    void refreshProjectsSilently();
  }, [onNewSession, refreshProjectsSilently, t]);
}
