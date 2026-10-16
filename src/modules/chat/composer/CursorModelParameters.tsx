import { useTranslation } from 'react-i18next';

import type { CursorModelFamily } from '@/shared/types';
import { selectCursorVariant } from '@/shared/utils';
import { ComposerMenuToggle } from '@/modules/chat/composer/ComposerMenuPrimitives';

/** Used by the chat composer to choose only combinations present in the discovered Cursor catalog. */
export function CursorModelParameters({ family, model, onSelectModel }: {
  family: CursorModelFamily;
  model: string;
  onSelectModel: (model: string) => void;
}) {
  const { t } = useTranslation('chat');
  const current = selectCursorVariant(family, model);
  const contexts = [...new Set(family.variants.map((variant) => variant.context))];
  const thinkingModes = [...new Set(family.variants.filter((variant) => variant.context === current.context)
    .map((variant) => variant.thinking))];
  const compatible = family.variants.filter((variant) =>
    variant.context === current.context && variant.thinking === current.thinking);
  const effortOrder = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const efforts = [...new Set(compatible.map((variant) => variant.effort))]
    .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
  const fastModes = [...new Set(compatible.filter((variant) => variant.effort === current.effort)
    .map((variant) => variant.fast))];
  const selectClass = 'max-w-40 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground';
  const choose = (change: Parameters<typeof selectCursorVariant>[2]) => {
    onSelectModel(selectCursorVariant(family, model, change).option.value);
  };

  return (
    <div className="space-y-3 px-2.5 py-2">
      {efforts.length > 1 && (
        <label className="flex items-center justify-between gap-4 text-xs">
          {t('composer.reasoning', { defaultValue: 'Reasoning' })}
          <select aria-label={t('composer.reasoning', { defaultValue: 'Reasoning' })}
            className={selectClass} value={current.effort} onChange={(event) => choose({ effort: event.target.value })}>
            {efforts.map((effort) => <option key={effort} value={effort}>
              {effort === 'default' ? t('composer.cliDefault', { defaultValue: 'CLI default' }) : effort}
            </option>)}
          </select>
        </label>
      )}
      {contexts.some(Boolean) && (
        <label className="flex items-center justify-between gap-4 text-xs">
          {t('composer.context', { defaultValue: 'Context' })}
          {contexts.length > 1 ? (
            <select aria-label={t('composer.context', { defaultValue: 'Context' })}
              className={selectClass} value={current.context} onChange={(event) => choose({ context: event.target.value })}>
              {contexts.map((context) => <option key={context} value={context}>
                {context.toUpperCase() || t('composer.cliDefault', { defaultValue: 'CLI default' })}
              </option>)}
            </select>
          ) : <span className="text-muted-foreground">{current.context.toUpperCase()}</span>}
        </label>
      )}
      {thinkingModes.length > 1 && (
        <ComposerMenuToggle label="Thinking" checked={current.thinking} onChange={(thinking) => choose({ thinking })} />
      )}
      {fastModes.includes(true) && (
        <div>
          <ComposerMenuToggle label="Fast" checked={current.fast} disabled={fastModes.length < 2}
            onChange={(fast) => choose({ fast })} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('composer.fastUsage', { defaultValue: 'Uses more allowance' })}
          </p>
        </div>
      )}
    </div>
  );
}
