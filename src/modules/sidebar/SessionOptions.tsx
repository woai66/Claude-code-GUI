import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Edit2, GitBranch, MoreHorizontal, Terminal, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { DesktopClaudeResumeResult, LLMProvider } from '@/shared/types';
import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import { PROVIDER_LABELS } from '@/shared/constants';

type SessionOptionsProps = {
  sessionId: string;
  sessionName: string;
  provider: LLMProvider;
  /**
   * The project that owns the session. Null where the row does not know it, in
   * which case rename is withheld rather than guessed — it is keyed by project.
   */
  projectId: string | null;
  /** 本地项目目录，用于在独立 PowerShell 中恢复 Claude 会话。 */
  projectPath: string | null;
  /** A running session cannot be deleted or forked, matching the Projects row. */
  isProcessing: boolean;
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Bound by the caller, which owns the session object the fork needs. */
  onFork?: () => void;
  /** Withheld where the row has nowhere to send a delete. */
  canDelete?: boolean;
  className?: string;
  t: TFunction;
};

/**
 * A session row's controls: the options menu, and the inline rename that
 * replaces it while a rename is open.
 *
 * Shared by the Projects list and the Conversations list so the two rows cannot
 * drift — the first cut of the Conversations row copied this markup, which is
 * how two rows end up diverging one fix at a time. Callers keep only what is
 * genuinely theirs: where the controls sit, and whether deleting is offered.
 */
export default function SessionOptions({
  sessionId,
  sessionName,
  provider,
  projectId,
  projectPath,
  isProcessing,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onFork,
  canDelete = true,
  className,
  t,
}: SessionOptionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 菜单展示原生终端的启动结果，并在启动期间阻止重复点击。
  const [resumeState, setResumeState] = useState<DesktopClaudeResumeResult | 'launching' | null>(null);
  const resumePendingRef = useRef(false);
  const providerLabel = PROVIDER_LABELS[provider];
  const {
    copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon,
    providerSessionId, loadProviderSessionId,
  } = useProviderSessionIdCopy(sessionId, providerLabel);
  const desktopClaude = window.claudeGuiClaude;
  const canResumeInPowerShell = provider === 'claude' && Boolean(desktopClaude);
  const resumeError = resumeState && resumeState !== 'launching' && resumeState.error
    ? t(`sessions.resumeErrors.${resumeState.error}`)
    : null;

  const handleOptionsOpen = useCallback((open: boolean) => {
    setOptionsOpen(open);
    if (open && !resumePendingRef.current) setResumeState(null);
  }, [setOptionsOpen]);

  const resumeInPowerShell = async () => {
    if (!canResumeInPowerShell || !desktopClaude || !projectPath || isProcessing || resumePendingRef.current) return;
    resumePendingRef.current = true;
    setResumeState('launching');
    try {
      const nativeSessionId = providerSessionId ?? await loadProviderSessionId();
      if (!nativeSessionId) {
        setResumeState({ error: 'invalid-session' });
        return;
      }
      setResumeState(await desktopClaude.resumeSession(nativeSessionId, projectPath));
    } catch {
      setResumeState({ error: 'launch-failed' });
    } finally {
      resumePendingRef.current = false;
    }
  };

  // Read from the backend capability matrix rather than branching on the
  // provider id here; the request is cached module-side, so every row shares one.
  const forkableProviders = useSessionForkingProviders();
  const canFork = Boolean(onFork) && forkableProviders.has(provider) && !isProcessing;

  // While editing, dismiss only when the click lands outside the rename panel,
  // matching Escape and the cancel button.
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  const saveRename = () => {
    if (projectId === null) {
      onCancelEditingSession();
      return;
    }
    onSaveEditingSession(projectId, sessionId, renameDraft, provider);
  };

  return (
    <div ref={containerRef} className={cn('flex items-center gap-1', className)}>
      {isEditing ? (
        <>
          <input
            type="text"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                saveRename();
              } else if (event.key === 'Escape') {
                onCancelEditingSession();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
            onClick={(event) => {
              event.stopPropagation();
              saveRename();
            }}
            title={t('tooltips.save')}
          >
            <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
            onClick={(event) => {
              event.stopPropagation();
              onCancelEditingSession();
            }}
            title={t('tooltips.cancel')}
          >
            <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
          </button>
        </>
      ) : (
        <ActionMenu
          label="Session options"
          ariaLabel={`Session options for ${sessionName}`}
          icon={MoreHorizontal}
          iconOnly
          portal
          variant="ghost"
          size="icon"
          onOpenChange={handleOptionsOpen}
          triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
          menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
          header={(
            <div className="mb-1 border-b border-border px-3 py-2">
              <p className="truncate text-xs font-medium text-foreground" title={sessionName}>
                {sessionName}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{providerLabel} session</p>
              {resumeError && (
                <p role="alert" className="mt-2 text-xs text-destructive">{resumeError}</p>
              )}
            </div>
          )}
          items={[
            ...(projectId !== null ? [{
              key: 'rename',
              label: 'Rename session',
              icon: Edit2,
              onSelect: () => onStartEditingSession(projectId, sessionId, sessionName),
            }] : []),
            {
              key: 'copy',
              label: copyLabel,
              description: copyState === 'error' ? 'Click to try again.' : undefined,
              icon: CopyStateIcon,
              loading: isCopyPending,
              closeOnSelect: false,
              onSelect: handleCopyAction,
            },
            ...(canResumeInPowerShell ? [{
              key: 'resume-powershell',
              label: resumeState === 'launching'
                ? t('sessions.resumingInPowerShell')
                : resumeState?.success
                  ? t('sessions.powerShellOpened')
                  : t('sessions.resumeInPowerShell'),
              description: isProcessing
                ? t('sessions.resumeAfterProcessing')
                : !projectPath
                  ? t('sessions.resumeErrors.directory-unavailable')
                  : undefined,
              icon: Terminal,
              loading: resumeState === 'launching' || copyState === 'loading',
              disabled: isProcessing || !projectPath
                || Boolean(resumeState && resumeState !== 'launching' && resumeState.success),
              closeOnSelect: false,
              onSelect: () => { void resumeInPowerShell(); },
            }] : []),
            ...(canFork && onFork ? [{
              key: 'fork',
              label: 'Fork session',
              description: 'Continue from a copy, leaving this one untouched.',
              icon: GitBranch,
              onSelect: onFork,
            }] : []),
            ...(canDelete && !isProcessing ? [{
              key: 'delete',
              label: 'Archive or delete session',
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDeleteSession(sessionId, sessionName),
            }] : []),
          ]}
        />
      )}
    </div>
  );
}
