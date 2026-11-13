import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Zap } from 'lucide-react';

import type { CodexSpeed, LLMProvider, ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { findProviderModelOption } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
  ComposerMenuToggle,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  provider?: LLMProvider;
  speed?: CodexSpeed;
  onSelectSpeed?: (speed: CodexSpeed) => void;
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  provider,
  speed = 'default',
  onSelectSpeed,
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  // Menu visibility is local so typing in the composer does not reopen a dismissed popover.
  const [isOpen, setIsOpen] = useState(false);
  // The long model list stays collapsed until the user explicitly opens it.
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const selectedModelOption = useMemo(
    () => findProviderModelOption(modelOptions, model),
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;
  const showSpeed = provider === 'codex' && Boolean(onSelectSpeed);
  const fastEnabled = showSpeed && speed === 'fast';
  const modelRows = modelOptions.map((option) => ({ ...option, selected: option.value === selectedModelOption?.value }));

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection && !showSpeed) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {fastEnabled && <Zap className="h-3 w-3 shrink-0" aria-label="Fast" />}
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {showSpeed && (
            <>
              <div className="space-y-2 px-2.5 py-2">
                <ComposerMenuToggle label="Fast" checked={speed === 'fast'}
                  onChange={(checked) => onSelectSpeed?.(checked ? 'fast' : 'standard')} />
                <p className="text-[11px] text-muted-foreground">
                  {t('composer.fastUsage', { defaultValue: 'Uses more allowance' })}
                </p>
              </div>
              {/* Kept outside the padded block so it lines up with the other menu rows. */}
              <ComposerMenuItem label={t('composer.followCli', { defaultValue: 'Follow CLI settings' })}
                isSelected={speed === 'default'} onSelect={() => onSelectSpeed?.('default')} />
              <ComposerMenuSeparator />
            </>
          )}
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  // Capitalize only the raw effort id; the CLI's descriptions are sentences.
                  label={<span className="capitalize">{option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}</span>}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                />
              ))}
            </>
          )}

          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('composer.model', { defaultValue: 'Model' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {modelRows.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      isSelected={option.selected}
                      onSelect={() => {
                        onSelectModel(option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
