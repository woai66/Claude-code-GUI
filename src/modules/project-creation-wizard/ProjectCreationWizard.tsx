import { useCallback, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent } from '@/shared/ui';
import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import { useGithubTokens } from '@/modules/project-creation-wizard/hooks/useGithubTokens';
import { cloneWorkspaceWithProgress, createProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { isCloneWorkflow, shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { WizardFormState } from '@/shared/types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const INITIAL_FORM_STATE: WizardFormState = {
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
};

/** 侧栏的弹窗层用此单页表单添加本地项目，或按需从 GitHub 克隆项目。 */
export default function ProjectCreationWizard({ onClose, onProjectCreated }: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  // 保存目录及可选克隆配置，提交时复用现有项目接口。
  const [formState, setFormState] = useState<WizardFormState>(INITIAL_FORM_STATE);
  // 未编辑时从目录生成名称，用户改名后不被后续目录选择覆盖。
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // 创建期间锁定字段与关闭操作，防止重复提交。
  const [isCreating, setIsCreating] = useState(false);
  // 在弹窗内展示创建失败原因，保留输入便于修正。
  const [error, setError] = useState<string | null>(null);
  // 克隆耗时较长，持续展示接口返回的进度。
  const [cloneProgress, setCloneProgress] = useState('');
  const createPendingRef = useRef(false);
  const shouldCloneRepository = isCloneWorkflow(formState.githubUrl);
  const folderName = formState.workspacePath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const projectName = nameDraft ?? folderName;

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);
  const { tokens: availableTokens, loading: loadingTokens, loadError: tokenLoadError } = useGithubTokens({
    shouldLoad: shouldShowGithubAuthentication(formState.githubUrl),
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const handleCreate = async () => {
    if (createPendingRef.current) return;
    if (!formState.workspacePath.trim()) {
      setError(t('projectWizard.errors.providePath'));
      return;
    }
    createPendingRef.current = true;
    setIsCreating(true);
    setError(null);
    setCloneProgress('');
    try {
      const project = shouldCloneRepository
        ? await cloneWorkspaceWithProgress(formState, { onProgress: setCloneProgress })
        : await createProjectRequest({ path: formState.workspacePath.trim(), customName: projectName.trim() || undefined });
      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('projectWizard.errors.failedToCreate'));
    } finally {
      createPendingRef.current = false;
      setIsCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => {
      // 网页目录浏览有自己的关闭入口，避免 Escape 同时关闭父弹窗。
      if (!open && !isCreating && !document.querySelector('[data-folder-browser]')) onClose();
    }}>
      <DialogContent
        wrapperClassName="z-[60]"
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[520px] overflow-y-auto rounded-2xl p-5 font-sans sm:p-6"
        aria-labelledby="create-project-title"
      >
        <h2 id="create-project-title" className="mb-5 pr-8 text-lg font-semibold tracking-tight">
          {t('projectWizard.title')}
        </h2>
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}
          <fieldset className="min-w-0" disabled={isCreating}>
            <StepConfiguration
              projectName={projectName}
              onProjectNameChange={setNameDraft}
              workspacePath={formState.workspacePath}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              onWorkspacePathChange={(directory) => updateField('workspacePath', directory)}
              onGithubUrlChange={(url) => updateField('githubUrl', url)}
              onTokenModeChange={(mode) => updateField('tokenMode', mode)}
              onSelectedGithubTokenChange={(token) => updateField('selectedGithubToken', token)}
              onNewGithubTokenChange={(token) => updateField('newGithubToken', token)}
            />
          </fieldset>
          {cloneProgress && <p role="status" className="break-words text-xs text-muted-foreground">{cloneProgress}</p>}
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" className="rounded-lg text-muted-foreground"
            onClick={onClose} disabled={isCreating}>{t('projectWizard.buttons.cancel')}</Button>
          <Button type="button" className="rounded-lg bg-foreground px-4 text-background hover:bg-foreground/90"
            disabled={isCreating || !formState.workspacePath.trim()} onClick={handleCreate}>
            {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
            {isCreating
              ? t(shouldCloneRepository ? 'projectWizard.buttons.cloning' : 'projectWizard.buttons.creating')
              : t('projectWizard.buttons.createProject')}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3 h-8 w-8 rounded-lg text-muted-foreground"
          aria-label={t('common:buttons.close', 'Close')} onClick={onClose} disabled={isCreating}>
          <X className="h-4 w-4" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
