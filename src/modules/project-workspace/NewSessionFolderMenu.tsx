import { useMemo, useState } from 'react';
import { Folder, FolderOpen, FolderSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProjectFolderPicker } from '@/modules/project-creation-wizard';
import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useStartSessionInFolder } from '@/modules/project-workspace/hooks/useStartSessionInFolder';
import { ActionMenu } from '@/shared/ui';
import { readUserPreference } from '@/shared/userSettings';
import { getProjectLastActivityTime } from '@/shared/utils';

// Projects hidden from the sidebar stay out of this menu as well.
const readHiddenProjectIds = (): Set<string> => {
  const stored = readUserPreference<unknown>('hiddenProjectIds', []);
  return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : []);
};

/**
 * Handed by WorkspaceMain to the chat module's new-session screen. It shows the folder the
 * new session will work in and switches it on the spot: to another project, or to any
 * folder on disk, which becomes a project as soon as it is picked.
 */
export default function NewSessionFolderMenu() {
  const { t } = useTranslation();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { projects, selectedProject, onNewSession } = sidebarSharedProps;
  const startSessionInFolder = useStartSessionInFolder();
  const [hiddenProjectIds, setHiddenProjectIds] = useState(readHiddenProjectIds);

  // Most recently used first, the order in which a folder is most likely wanted again.
  const projectChoices = useMemo(
    () => projects
      .filter((project) => !hiddenProjectIds.has(project.projectId) || project.projectId === selectedProject?.projectId)
      .sort((projectA, projectB) => getProjectLastActivityTime(projectB) - getProjectLastActivityTime(projectA)),
    [hiddenProjectIds, projects, selectedProject?.projectId],
  );

  if (!selectedProject) {
    return null;
  }

  return (
    <ProjectFolderPicker startPath={selectedProject.fullPath} onFolderReady={startSessionInFolder}>
      {({ pickFolder, isPicking, error }) => (
        <div className="mx-auto mt-2 max-w-xs">
          <ActionMenu
            label={selectedProject.displayName}
            ariaLabel={t('mainContent.changeFolder', 'Change the working folder')}
            icon={Folder}
            variant="outline"
            align="left"
            portal
            menuWidth={340}
            disabled={isPicking}
            className="flex w-full"
            triggerClassName="h-9 w-full justify-start gap-2 rounded-lg border-border/60 px-3 font-normal [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate [&>span]:text-left"
            menuClassName="max-h-80"
            header={<p className="px-3 py-2 text-xs text-muted-foreground">{t('mainContent.workInFolder', 'Work in a folder')}</p>}
            // The sidebar can hide a project while this screen stays mounted.
            onOpenChange={(open) => { if (open) setHiddenProjectIds(readHiddenProjectIds()); }}
            items={[
              ...projectChoices.map((project) => ({
                key: project.projectId,
                label: project.displayName,
                description: project.fullPath,
                icon: project.projectId === selectedProject.projectId ? FolderOpen : Folder,
                onSelect: () => {
                  if (project.projectId !== selectedProject.projectId) onNewSession(project);
                },
              })),
              {
                key: 'choose-folder',
                label: t('mainContent.chooseOtherFolder', 'Choose another folder…'),
                icon: FolderSearch,
                showDividerBefore: true,
                onSelect: pickFolder,
              },
            ]}
          />
          <p className="mt-1 truncate px-1 text-center text-[11px] text-muted-foreground/70" title={selectedProject.fullPath}>
            {selectedProject.fullPath}
          </p>
          {error && <p role="alert" className="mt-1 text-center text-xs text-destructive">{error}</p>}
        </div>
      )}
    </ProjectFolderPicker>
  );
}
