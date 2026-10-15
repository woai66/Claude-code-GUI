import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import type { LLMProvider, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';

const synced: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'live-cursor-model', label: 'Live Cursor model' }],
  DEFAULT: 'live-cursor-model',
  DISCOVERY: { source: 'cli', updatedAt: '2026-10-15T10:00:00.000Z' },
};

const actionsFor = (refresh: ProviderModelActions['refresh']): ProviderModelActions => ({
  refresh, create: async () => {}, update: async () => {}, remove: async () => {},
});

beforeEach(async () => { await i18n.changeLanguage('en'); });

test('the model library fetches CLI choices and disables repeat requests while discovery runs', async () => {
  let finish: (models: ProviderModelsDefinition) => void = () => {};
  const refresh = vi.fn((_provider: LLMProvider) => new Promise<ProviderModelsDefinition>((resolve) => { finish = resolve; }));
  const actions = actionsFor(refresh);
  const view = render(<ModelLibraryPanel initialProvider="cursor" providerModelCatalog={{
    cursor: { OPTIONS: [], DEFAULT: 'auto', DISCOVERY: { source: 'empty' } },
  }} actions={actions} />);
  assert.ok(screen.getByText(/No models fetched yet/));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch model list' }));
  assert.equal(refresh.mock.calls[0]?.[0], 'cursor');
  assert.equal((screen.getByRole('button', { name: 'Fetching…' }) as HTMLButtonElement).disabled, true);
  await act(async () => { finish(synced); });
  view.rerender(<ModelLibraryPanel initialProvider="cursor" providerModelCatalog={{ cursor: synced }} actions={actions} />);
  await waitFor(() => assert.ok(screen.getByRole('status').textContent?.includes('1 CLI models')));
  assert.ok(screen.getByText('Live Cursor model'));
  assert.ok(screen.getByText('live-cursor-model'));
  assert.equal(screen.queryByText('Built-in models'), null);
});

test('a failed refresh shows an error and keeps the last synchronized choices visible', async () => {
  render(<ModelLibraryPanel initialProvider="cursor" providerModelCatalog={{ cursor: synced }} actions={actionsFor(
    async () => { throw new Error('CLI login required'); },
  )} />);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch model list' }));
  await waitFor(() => assert.equal(screen.getByRole('alert').textContent, 'CLI login required'));
  assert.ok(screen.getByText('Live Cursor model'));
  assert.equal((screen.getByRole('button', { name: 'Fetch model list' }) as HTMLButtonElement).disabled, false);
});
