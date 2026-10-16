import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { CursorModelParameters } from '@/modules/chat/composer/CursorModelParameters';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { groupCursorModels, selectCursorVariant } from '@/shared/utils';
import type { ProviderModelOption } from '@/shared/types';

const options: ProviderModelOption[] = [
  { value: 'gpt-example-high', label: 'GPT Example 1M High' },
  { value: 'gpt-example-high-fast', label: 'GPT Example High Fast' },
  { value: 'gpt-example-xhigh', label: 'GPT Example 1M Extra High' },
  { value: 'gpt-example-xhigh-fast', label: 'GPT Example Extra High Fast' },
  { value: 'claude-example-high', label: 'Claude Example 1M High' },
  { value: 'claude-example-thinking-high', label: 'Claude Example 1M Thinking' },
];

beforeEach(async () => { await i18n.changeLanguage('en'); });

test('Cursor combines variants without losing exact IDs, distinct models or custom entries', () => {
  const families = groupCursorModels([...options,
    { value: 'gpt-example', label: 'My GPT', isCustom: true },
    { value: 'new-model[unknown=true]', label: 'Unrecognized' },
  ]);
  assert.equal(families.length, 4);
  assert.equal(families[0].label, 'GPT Example');
  assert.deepEqual(families[0].variants.map((variant) => variant.option.value), options.slice(0, 4).map((o) => o.value));
  assert.ok(families[0].variants.every((variant) => variant.context === '1m'));
  assert.equal(families[2].label, 'My GPT');
  assert.equal(families[3].variants[0].option.value, 'new-model[unknown=true]');
});

test('changing effort preserves Fast and only selects combinations returned by the CLI', () => {
  const family = groupCursorModels(options)[0];
  assert.equal(selectCursorVariant(family, 'gpt-example-high-fast', { effort: 'xhigh' }).option.value,
    'gpt-example-xhigh-fast');
  const partial = groupCursorModels(options.filter((option) => option.value !== 'gpt-example-xhigh-fast'))[0];
  assert.equal(selectCursorVariant(partial, 'gpt-example-high-fast', { effort: 'xhigh' }).option.value,
    'gpt-example-xhigh');
});

test('parameterized CLI entries expose context choices and preserve exact override syntax', () => {
  const family = groupCursorModels([
    { value: 'model[context=200k,effort=high,fast=false]', label: 'Model 200K High' },
    { value: 'model[context=1m,effort=high,fast=false]', label: 'Model 1M High' },
  ])[0];
  assert.equal(family.variants.length, 2);
  const select = vi.fn();
  render(<CursorModelParameters family={family} model={family.variants[0].option.value} onSelectModel={select} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Context' }), { target: { value: '1m' } });
  assert.equal(select.mock.calls[0]?.[0], 'model[context=1m,effort=high,fast=false]');
});

test('Cursor parameter controls send the exact ID and show one fixed context as text', () => {
  const family = groupCursorModels(options)[0];
  const select = vi.fn();
  render(<CursorModelParameters family={family} model="gpt-example-high" onSelectModel={select} />);
  assert.equal(screen.queryByRole('combobox', { name: 'Context' }), null);
  assert.ok(screen.getByText('1M'));
  fireEvent.click(screen.getByRole('switch', { name: 'Fast' }));
  assert.equal(select.mock.calls[0]?.[0], 'gpt-example-high-fast');
  fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning' }), { target: { value: 'xhigh' } });
  assert.equal(select.mock.calls[1]?.[0], 'gpt-example-xhigh');
});

test('the Codex composer exposes Fast, follows CLI explicitly, and preserves reasoning choices', () => {
  const select = vi.fn();
  render(<ComposerModelMenu provider="codex" speed="default" onSelectSpeed={select}
    model="codex-model" modelOptions={[{ value: 'codex-model', label: 'Codex Model' }]}
    effort="high" effortOptions={[{ value: 'high' }, { value: 'low' }]}
    onSelectEffort={() => {}} onSelectModel={() => {}} modelsLoading={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  assert.equal((screen.getByRole('switch', { name: 'Fast' }) as HTMLInputElement).checked, false);
  fireEvent.click(screen.getByRole('switch', { name: 'Fast' }));
  assert.equal(select.mock.calls[0]?.[0], 'fast');
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Follow CLI settings' }));
  assert.equal(select.mock.calls[1]?.[0], 'default');
  assert.equal(screen.getByRole('menuitemradio', { name: 'high' }).getAttribute('aria-checked'), 'true');
});
