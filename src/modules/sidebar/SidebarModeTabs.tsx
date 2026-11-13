import { Fragment } from 'react';
import { Activity, Archive, Folder, MessageSquare, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { SidebarSearchMode } from '@/shared/types';
import { useTabOverflow } from '@/modules/sidebar/hooks/useTabOverflow';

type ModeTab = {
  mode: SidebarSearchMode;
  label: string;
  /** Shown beside the label in the overflow dropdown; the strip itself is text only. */
  icon: LucideIcon;
};

type SidebarModeTabsProps = {
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  runningSessionsCount: number;
  t: TFunction;
};

/**
 * Used by SidebarHeader for the section strip above the search box, in both the
 * desktop and the mobile header.
 *
 * Every tab carries its name: four short words fit the default sidebar width, where icons
 * alone left "running" and "archive" unexplained. The sidebar is resizable, so the tabs
 * that no longer fit move into a "…" dropdown at the right edge instead of spilling out.
 */
export default function SidebarModeTabs({
  searchMode,
  onSearchModeChange,
  runningSessionsCount,
  t,
}: SidebarModeTabsProps) {
  const tabs: ModeTab[] = [
    { mode: 'projects', label: t('search.modeProjects'), icon: Folder },
    { mode: 'conversations', label: t('search.modeConversations'), icon: MessageSquare },
    { mode: 'running', label: t('search.modeRunning', 'Running'), icon: Activity },
    { mode: 'archived', label: t('search.modeArchived', 'Archive'), icon: Archive },
  ];

  const activeIndex = tabs.findIndex((tab) => tab.mode === searchMode);
  const { rowRef, mirrorRef, visibleIndexes } = useTabOverflow(tabs.length, activeIndex);
  const hiddenTabs = tabs.filter((_, index) => !visibleIndexes.includes(index));
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);
  const moreLabel = t('search.modeMore', 'More');

  const renderTab = (tab: ModeTab, canGrow: boolean) => {
    const isActive = tab.mode === searchMode;
    const showRunningCount = tab.mode === 'running' && runningSessionsCount > 0;

    return (
      <button
        onClick={() => onSearchModeChange(tab.mode)}
        aria-pressed={isActive}
        className={cn(
          'flex min-w-0 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-normal transition-all',
          // Grow from each label's own width, so a longer label with a count is not
          // squeezed to the same width as a two-character one.
          canGrow && 'flex-auto',
          isActive
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <span className="truncate">{tab.label}</span>
        {showRunningCount && (
          <span className="flex h-3.5 min-w-3.5 flex-none items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white">
            {runningBadgeText}
          </span>
        )}
      </button>
    );
  };

  const overflowTrigger = (
    <ActionMenu
      label={moreLabel}
      ariaLabel={moreLabel}
      icon={MoreHorizontal}
      iconOnly
      portal
      variant="ghost"
      size="sm"
      className="flex-none"
      triggerClassName="h-auto rounded-md px-2 py-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3.5"
      items={hiddenTabs.map((tab) => ({
        key: tab.mode,
        label: tab.label,
        icon: tab.icon,
        onSelect: () => onSearchModeChange(tab.mode),
      }))}
    />
  );

  return (
    <div className="rounded-lg bg-muted/50 p-0.5">
      <div ref={rowRef} className="relative flex">
        {visibleIndexes.map((index) => (
          <Fragment key={tabs[index].mode}>{renderTab(tabs[index], true)}</Fragment>
        ))}
        {hiddenTabs.length > 0 && overflowTrigger}

        {/*
          An off-layout copy of the whole strip. What to drop can only be decided
          from every tab's natural width, and a tab that has already been dropped
          is no longer in the row to measure. Clipped rather than merely hidden so
          it cannot widen an ancestor's scroll area.
        */}
        <div aria-hidden className="pointer-events-none invisible absolute inset-0 overflow-hidden">
          <div ref={mirrorRef} className="flex w-max">
            {tabs.map((tab) => (
              <div key={tab.mode} className="flex-none">{renderTab(tab, false)}</div>
            ))}
            <div className="flex-none">{overflowTrigger}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
