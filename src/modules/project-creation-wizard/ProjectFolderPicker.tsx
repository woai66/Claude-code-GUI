import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';
import { registerProjectFolder } from '@/modules/project-creation-wizard/utils/workspaceApi';

type ProjectFolderPickerControls = {
  /** Opens the folder picker: the native dialog in the desktop app, the server folder browser on the web. */
  pickFolder: () => void;
  /** True from opening the picker until the picked folder is ready, so the trigger can lock itself. */
  isPicking: boolean;
  /** Why the last pick failed, or null; the caller decides where to show it. */
  error: string | null;
};

type ProjectFolderPickerProps = {
  /** Folder the native dialog opens at. */
  startPath?: string;
  /** Receives the picked folder once it is registered as a project. A rejection is reported as `error`. */
  onFolderReady: (folderPath: string) => void | Promise<void>;
  children: (controls: ProjectFolderPickerControls) => ReactNode;
};

/**
 * Used by the project-workspace module to start working in any folder in one step: the
 * picked folder becomes a project straight away, with no creation dialog in between.
 */
export default function ProjectFolderPicker({ startPath, onFolderReady, children }: ProjectFolderPickerProps) {
  const { t } = useTranslation();
  // A browser cannot read local paths, so the web build browses the server's folders instead.
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFolder = async (folderPath: string) => {
    setIsPicking(true);
    try {
      await registerProjectFolder(folderPath);
      await onFolderReady(folderPath);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : t('projectWizard.errors.failedToCreate'));
    } finally {
      setIsPicking(false);
    }
  };

  const pickFolder = async () => {
    if (isPicking) return;
    setError(null);
    const desktopDirectories = window.claudeGuiDirectories;
    if (!desktopDirectories) {
      setShowFolderBrowser(true);
      return;
    }

    // Locked while the native dialog is open so a second click cannot open another one.
    setIsPicking(true);
    let folderPath: string | null = null;
    try {
      folderPath = await desktopDirectories.chooseDirectory(startPath);
    } catch {
      setError(t('projectWizard.folders.chooseFailed', 'Could not open the folder picker. Please try again.'));
    }
    if (folderPath) {
      await openFolder(folderPath);
    } else {
      setIsPicking(false);
    }
  };

  return (
    <>
      {children({ pickFolder: () => void pickFolder(), isPicking, error })}
      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={(folderPath) => {
          setShowFolderBrowser(false);
          void openFolder(folderPath);
        }}
      />
    </>
  );
}
