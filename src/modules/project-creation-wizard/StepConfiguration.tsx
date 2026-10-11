import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { GithubTokenCredential, TokenMode } from '@/shared/types';
import GithubAuthenticationCard from '@/modules/project-creation-wizard/GithubAuthenticationCard';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

type StepConfigurationProps = {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
};

/** 单页新建项目弹窗用它展示名称、目录和折叠的 GitHub 克隆选项。 */
export default function StepConfiguration({
  projectName,
  onProjectNameChange,
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onWorkspacePathChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);

  return (
    <div className="space-y-4">
      {!githubUrl.trim() && (
        <div>
          <label htmlFor="new-project-name" className="mb-2 block text-sm font-medium">
            {t('projectWizard.projectName', 'Project name')}
          </label>
          <Input id="new-project-name" value={projectName} className="h-10 rounded-lg"
            placeholder={t('projectWizard.namePlaceholder', 'Defaults to the folder name')}
            onChange={(event) => onProjectNameChange(event.target.value)} disabled={isCreating} />
        </div>
      )}
      <div>
        <p className="mb-2 text-sm font-medium">
          {githubUrl.trim()
            ? t('projectWizard.folders.cloneDestination', 'Clone into')
            : t('projectWizard.folders.source', 'Project folder')}
        </p>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
        />

        {githubUrl.trim() && <p className="mt-1 text-xs text-muted-foreground">
          {t('projectWizard.folders.cloneHelp', 'The repository will be cloned into a new subfolder here.')}
        </p>}
      </div>

      <details onToggle={(event) => {
        if (!event.currentTarget.open && !isCreating) onGithubUrlChange('');
      }}>
        <summary className="cursor-pointer rounded text-xs text-muted-foreground hover:text-foreground"
          onClick={(event) => { if (isCreating) event.preventDefault(); }}>
          {t('projectWizard.cloneRepository', 'Clone from GitHub (optional)')}
        </summary>
        <div className="mt-3 space-y-3">
          <label htmlFor="new-project-github-url" className="block text-sm font-medium">
            {t('projectWizard.step2.githubUrl')}
          </label>
          <Input
            id="new-project-github-url"
            type="text"
            value={githubUrl}
            onChange={(event) => onGithubUrlChange(event.target.value)}
            placeholder="https://github.com/username/repository"
            className="w-full rounded-lg"
            disabled={isCreating}
          />

          {showGithubAuth && (
            <GithubAuthenticationCard
              tokenMode={tokenMode}
              selectedGithubToken={selectedGithubToken}
              newGithubToken={newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              onTokenModeChange={onTokenModeChange}
              onSelectedGithubTokenChange={onSelectedGithubTokenChange}
              onNewGithubTokenChange={onNewGithubTokenChange}
            />
          )}
        </div>
      </details>
    </div>
  );
}
