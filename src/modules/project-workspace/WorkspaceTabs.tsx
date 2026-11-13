import { MessageSquare, Terminal, Folder, GitBranch, type LucideIcon } from 'lucide-react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
};

type TabDefinition = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const TABS: TabDefinition[] = [
  { id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

/** Rendered by WorkspaceHeader to switch between the workspace's chat, terminal, files and source control views. */
export default function WorkspaceTabs({ activeTab, setActiveTab }: WorkspaceTabsProps) {
  const { t } = useTranslation();

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = t(tab.labelKey);

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <Pill
              role="tab"
              aria-label={displayLabel}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              isActive={isActive}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown}
              className="h-8 max-w-44 px-2.5 py-[5px]"
            >
              <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                {displayLabel}
              </span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
