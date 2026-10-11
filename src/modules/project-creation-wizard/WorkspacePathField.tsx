import { useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2, Plus } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
};

/** 新建项目的配置区用它选择、拖入或手动填写目录；网页版保留服务器目录浏览。 */
export default function WorkspacePathField({ value, disabled = false, onChange }: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  // 网页版无法取得本机完整路径，保留原有的服务器目录选择弹窗。
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  // 原生选择器和拖入目录的验证共用忙碌状态，避免重复操作。
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  // 拖入时突出目录区域，让用户确认放置位置。
  const [isDraggingFolder, setIsDraggingFolder] = useState(false);
  // 手动路径默认收起，保持主要流程简洁。
  const [isEditingPath, setIsEditingPath] = useState(false);
  // 目录选择与拖入错误就地显示，并保留原先的有效路径。
  const [folderError, setFolderError] = useState<string | null>(null);
  const desktopDirectories = window.claudeGuiDirectories;
  const isBusy = disabled || isChoosingFolder;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

  const chooseFolder = async () => {
    if (isBusy) return;
    setFolderError(null);
    if (!desktopDirectories) {
      setShowFolderBrowser(true);
      return;
    }
    setIsChoosingFolder(true);
    try {
      const directory = await desktopDirectories.chooseDirectory(value || undefined);
      if (directory) onChange(directory);
    } catch {
      setFolderError(t('projectWizard.folders.chooseFailed', 'Could not open the folder picker. Please try again.'));
    } finally {
      setIsChoosingFolder(false);
    }
  };

  const dropFolder = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFolder(false);
    if (isBusy) return;
    setFolderError(null);
    if (!desktopDirectories) {
      setFolderError(t('projectWizard.folders.desktopDrop', 'Use the desktop app to drop a folder, or enter its path.'));
      return;
    }
    setIsChoosingFolder(true);
    try {
      const result = await desktopDirectories.getDroppedDirectory(Array.from(event.dataTransfer.files));
      if (result.path) {
        onChange(result.path);
      } else if (result.error === 'single-folder') {
        setFolderError(t('projectWizard.folders.singleFolder', 'Drop one folder at a time.'));
      } else if (result.error === 'not-directory') {
        setFolderError(t('projectWizard.folders.notDirectory', 'Please drop a folder, rather than a file.'));
      } else {
        setFolderError(t('projectWizard.folders.unavailable', 'This folder is unavailable. Please choose it again.'));
      }
    } catch {
      setFolderError(t('projectWizard.folders.unavailable', 'This folder is unavailable. Please choose it again.'));
    } finally {
      setIsChoosingFolder(false);
    }
  };

  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={t('projectWizard.folders.source', 'Project folder')}
        aria-busy={isChoosingFolder}
        className={cn(
          'rounded-xl border border-border/70 bg-background p-4 transition-colors',
          isDraggingFolder && !isBusy && 'border-ring bg-accent/60 ring-1 ring-ring',
        )}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
          if (!isBusy) setIsDraggingFolder(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            setIsDraggingFolder(false);
          }
        }}
        onDrop={dropFolder}
      >
        {value ? (
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
            </div>
            <p className="min-w-0 flex-1 truncate text-sm" title={value}>{value}</p>
            <Button type="button" variant="ghost" size="sm" className="shrink-0 rounded-lg"
              onClick={chooseFolder} disabled={isBusy}>
              {isChoosingFolder && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('projectWizard.folders.change', 'Change')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-3 text-center">
            <FolderOpen className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {desktopDirectories
                ? t('projectWizard.folders.drop', 'Choose a folder or drop it here')
                : t('projectWizard.folders.chooseHint', 'Choose a project folder')}
            </p>
            <Button type="button" variant="secondary" size="sm" className="h-8 rounded-lg"
              onClick={chooseFolder} disabled={isBusy}>
              {isChoosingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('projectWizard.folders.choose', 'Choose folder')}
            </Button>
          </div>
        )}
      </div>

      <button type="button" className="rounded px-1 text-xs text-muted-foreground hover:text-foreground"
        disabled={isBusy} aria-expanded={isEditingPath} onClick={() => setIsEditingPath((previous) => !previous)}>
        {t('projectWizard.folders.manual', 'Enter path manually')}
      </button>
      {isEditingPath && (
        <Input
          type="text"
          aria-label={t('projectWizard.step2.newPath')}
          placeholder={t('projectWizard.folders.pathPlaceholder', 'Full path to the project folder')}
          value={value}
          onChange={(event) => { setFolderError(null); onChange(event.target.value); }}
          className="rounded-lg"
          disabled={isBusy}
          autoFocus
        />
      )}
      {folderError && <p role="alert" className="text-xs text-destructive">{folderError}</p>}

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={(directory) => { onChange(directory); setShowFolderBrowser(false); }}
      />
    </div>
  );
}
