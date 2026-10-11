import { Settings, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '@/shared/types';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** SidebarContent 使用此组件展示底部的设置、版本和更新状态。 */
export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0 border-t border-border/50 px-3 py-2 pb-safe-area-inset-bottom">
      {restartRequired && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {t('version.restartRequired')}
        </div>
      )}
      {updateAvailable && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onShowVersionModal}
        >
          <ArrowUpCircle className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 truncate">{releaseInfo?.title || 'v' + latestVersion}</span>
          <span className="ml-auto text-[10px]">{t('version.updateAvailable')}</span>
        </button>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-4 w-4" />
          {t('actions.settings')}
        </button>
        <button
          type="button"
          title={t('app.title') + ' v' + currentVersion}
          aria-label={t('app.title') + ' v' + currentVersion}
          className="rounded-lg px-2 py-1 text-[10px] tabular-nums text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          onClick={onShowVersionModal}
        >
          v{currentVersion}
        </button>
      </div>
    </div>
  );
}
