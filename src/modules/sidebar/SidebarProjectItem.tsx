import { memo, useEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, Folder, MoreHorizontal, Plus, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import { getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** 只向正在重命名的项目传入草稿，保持其他行的 memo 有效。 */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

/** SidebarProjectList 使用此组件展示项目条目、操作菜单和展开的会话列表。 */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.projectId === project.projectId;
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isCompact = useCompactSidebar();

  useEffect(() => {
    if (!isEditing || !isCompact || !renameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        renameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing, isCompact]);

  const saveProjectName = () => onSaveProjectName(project.projectId, renameDraft);
  const selectAndToggleProject = () => {
    if (!isSelected) {
      onProjectSelect(project);
    }
    onToggleProject(project.projectId);
  };
  const projectActions = [
    {
      key: 'rename',
      label: t('projects.renameProject'),
      icon: Edit3,
      onSelect: () => onStartEditingProject(project),
    },
    {
      key: 'star',
      label: isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites'),
      icon: Star,
      onSelect: () => onToggleStarProject(project.projectId),
    },
    {
      key: 'delete',
      label: t('projects.deleteProject'),
      icon: Trash2,
      isDanger: true,
      showDividerBefore: true,
      onSelect: () => onDeleteProject(project),
    },
  ];
  const sessionCountLabel = t('sessions.count', { count: totalSessionCount, defaultValue: '{{count}} sessions' });

  return (
    <div className={cn('space-y-0.5', isDeleting && 'pointer-events-none opacity-50')} aria-busy={isDeleting}>
      <div
        className={cn(
          'group flex min-w-0 items-center rounded-lg pr-1 transition-colors hover:bg-accent/50',
          isSelected && 'bg-accent/70',
        )}
      >
        {isEditing ? (
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 px-2">
            <input
              ref={renameInputRef}
              type="text"
              value={renameDraft}
              aria-label={t('projects.projectNamePlaceholder')}
              placeholder={t('projects.projectNamePlaceholder')}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border"
              autoFocus
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveProjectName();
                }
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  onCancelEditingProject();
                }
              }}
            />
            <Button type="button" variant="ghost" size="sm" className="h-8 w-7 p-0"
              onClick={saveProjectName} aria-label={t('actions.save')}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-7 p-0"
              onClick={onCancelEditingProject} aria-label={t('actions.cancel')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-label={project.displayName}
              title={project.fullPath}
              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
              onClick={selectAndToggleProject}
            >
              {isExpanded
                ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
              <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{project.displayName}</span>
              {isStarred && <Star className="h-3 w-3 flex-shrink-0 fill-current text-amber-500" />}
              {tasksEnabled && <TaskIndicator status={taskStatus} size="xs" />}
              <span className="text-[10px] tabular-nums text-muted-foreground/60" title={sessionCountLabel}>
                {totalSessionCount}
              </span>
            </button>
            <div className={cn(
              'flex flex-shrink-0 items-center group-hover:opacity-100 group-focus-within:opacity-100',
              !isCompact && !isSelected && 'opacity-0',
            )}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onNewSession(project)}
                title={t('sessions.newSession')}
                aria-label={t('sessions.newSession') + ' · ' + project.displayName}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <ActionMenu
                label={t('projects.options', 'Project options') + ' · ' + project.displayName}
                icon={MoreHorizontal}
                iconOnly
                portal
                variant="ghost"
                items={projectActions}
                triggerClassName="h-8 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
              />
            </div>
          </>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        backgroundSessionIds={backgroundSessionIds}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        selectedSessionIds={selectedSessionIds}
        onSetSessionSelection={onSetSessionSelection}
        onToggleSessionSelected={onToggleSessionSelected}
        onCancelSessionSelection={onCancelSessionSelection}
        onDeleteSelectedSessions={onDeleteSelectedSessions}
        t={t}
      />
    </div>
  );
}

// WebSocket 刷新和重命名时，仅重新渲染属性发生变化的项目行。
export default memo(SidebarProjectItem);
