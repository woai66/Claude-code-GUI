import { ChevronDown, Folder, FolderPlus, PanelLeftClose, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button, Input } from '@/shared/ui';
import { APP_WORDMARK_FONT_FAMILY, PROVIDER_LABELS } from '@/shared/constants';
import type { Project, SidebarProviderFilter, SidebarSearchMode } from '@/shared/types';
import SidebarModeTabs from '@/modules/sidebar/SidebarModeTabs';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  projects: Project[];
  selectedProject: Project | null;
  runningSessionsCount: number;
  searchFilter: string;
  providerFilter: SidebarProviderFilter;
  onProviderFilterChange: (provider: SidebarProviderFilter) => void;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onNewSession: (project: Project) => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

function NewSessionAction({ projects, selectedProject, onNewSession, onCreateProject, t }: Pick<
  SidebarHeaderProps, 'projects' | 'selectedProject' | 'onNewSession' | 'onCreateProject' | 't'
>) {
  // 使用实时列表，避免给已移除的项目创建会话。
  const currentProject = projects.find((project) => project.projectId === selectedProject?.projectId)
    ?? (projects.length === 1 ? projects[0] : null);
  const projectChoices = projects.map((project) => ({
    key: project.projectId,
    label: project.displayName,
    description: project.fullPath,
    icon: Folder,
    onSelect: () => onNewSession(project),
  }));
  const pickerLabel = t('sessions.chooseProject', 'Choose a project for a new session');
  const newSessionLabel = t('sessions.newSession');

  if (!currentProject && projects.length > 1) {
    return (
      <ActionMenu
        label={newSessionLabel}
        icon={Plus}
        items={projectChoices}
        variant="ghost"
        align="left"
        className="min-w-0 flex-1"
        triggerClassName="h-9 w-full justify-start gap-2 rounded-lg bg-accent/60 px-3 font-normal hover:bg-accent [&>span]:flex-1 [&>span]:text-left"
        menuClassName="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
        header={<p className="px-3 py-2 text-xs text-muted-foreground">{pickerLabel}</p>}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center rounded-lg bg-accent/60">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-lg px-3 font-normal hover:bg-accent"
        title={currentProject ? newSessionLabel + ' · ' + currentProject.displayName : newSessionLabel}
        onClick={() => currentProject ? onNewSession(currentProject) : onCreateProject()}
      >
        <Plus className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">{newSessionLabel}</span>
      </Button>
      {projects.length > 1 && (
        <ActionMenu
          label={pickerLabel}
          icon={ChevronDown}
          iconOnly
          items={projectChoices}
          variant="ghost"
          triggerClassName="h-9 w-8 rounded-lg p-0 text-muted-foreground hover:bg-accent"
          menuClassName="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
          header={<p className="px-3 py-2 text-xs text-muted-foreground">{pickerLabel}</p>}
        />
      )}
    </div>
  );
}

/** SidebarContent 使用此组件提供搜索、新建会话和项目/对话筛选入口。 */
export default function SidebarHeader({
  isPWA,
  isMobile,
  projects,
  selectedProject,
  runningSessionsCount,
  searchFilter,
  providerFilter,
  onProviderFilterChange,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onNewSession,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');

  return (
    <div
      className="flex-shrink-0 space-y-3 px-3 pb-2 pt-3"
      style={isPWA && isMobile ? { paddingTop: '16px' } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <h1
          className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground"
          style={{ fontFamily: APP_WORDMARK_FONT_FAMILY }}
        >
          {t('app.title')}
        </h1>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (isRefreshing ? 'animate-spin' : '')} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onCollapseSidebar}
            title={t('tooltips.hideSidebar')}
            aria-label={t('tooltips.hideSidebar')}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          value={searchFilter}
          onChange={(event) => onSearchFilterChange(event.target.value)}
          className="h-9 rounded-lg border-border/60 bg-background pl-9 pr-8 text-sm shadow-sm placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-offset-0"
        />
        {searchFilter && (
          <button
            type="button"
            onClick={onClearSearchFilter}
            aria-label={t('tooltips.clearSearch')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <NewSessionAction
          projects={projects}
          selectedProject={selectedProject}
          onNewSession={onNewSession}
          onCreateProject={onCreateProject}
          t={t}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 w-9 flex-shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onCreateProject}
          title={t('tooltips.createProject')}
          aria-label={t('tooltips.createProject')}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2 pt-1">
        <SidebarModeTabs
          searchMode={searchMode}
          onSearchModeChange={onSearchModeChange}
          runningSessionsCount={runningSessionsCount}
          t={t}
        />
        <select
          aria-label={t('search.providerFilter', 'Filter by agent')}
          value={providerFilter}
          onChange={(event) => onProviderFilterChange(event.target.value as SidebarProviderFilter)}
          className="h-8 w-full rounded-lg border border-border/50 bg-transparent px-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <option value="all">{t('search.allProviders', 'All agents')}</option>
          {Object.entries(PROVIDER_LABELS).map(([provider, label]) => (
            <option key={provider} value={provider}>{label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
