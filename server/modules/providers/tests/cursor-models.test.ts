import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorProviderModels } from '@/modules/providers/list/cursor/cursor-models.provider.js';

test('Cursor starts with an empty catalog and delegates the default to its CLI', async () => {
  assert.deepEqual(await new CursorProviderModels().getSupportedModels(), { OPTIONS: [], DEFAULT: 'auto' });
});

test('Cursor reads colored CLI output, exact variant IDs and its declared default', async () => {
  let queriedCwd: string | undefined;
  const adapter = new CursorProviderModels({
    runCli: async (cwd) => {
      queriedCwd = cwd;
      return '\u001b[1mAvailable models\u001b[0m\r\n\r\nauto - Auto\r\n'
        + 'future-model-high-fast - Future Model High Fast (default)\r\n'
        + 'future-model-high-fast - Duplicate\r\n'
        + 'custom[effort=high,fast=true] - Configurable Model\r\n'
        + 'Tip: use --model <id> to choose a model.\r\n';
    },
  });
  const catalog = await adapter.refreshSupportedModels('/project');
  assert.equal(queriedCwd, '/project');
  assert.equal(catalog.DEFAULT, 'future-model-high-fast');
  assert.deepEqual(catalog.OPTIONS, [
    { value: 'auto', label: 'Auto' },
    { value: 'future-model-high-fast', label: 'Future Model High Fast' },
    { value: 'custom[effort=high,fast=true]', label: 'Configurable Model' },
  ]);
});

test('Cursor uses auto when available and otherwise the first reported model', async () => {
  const adapter = new CursorProviderModels({ runCli: async () => 'fast - Fast\nauto - Auto (current)' });
  assert.equal((await adapter.refreshSupportedModels()).DEFAULT, 'auto');
  const withoutAuto = new CursorProviderModels({ runCli: async () => 'fast - Fast' });
  assert.equal((await withoutAuto.refreshSupportedModels()).DEFAULT, 'fast');
});

test('Cursor refuses malformed or empty output instead of returning preset models', async () => {
  const adapter = new CursorProviderModels({ runCli: async () => 'Please log in to continue.' });
  await assert.rejects(adapter.refreshSupportedModels(), /no models/);
  const failed = new CursorProviderModels({ runCli: async () => { throw new Error('CLI offline'); } });
  await assert.rejects(failed.refreshSupportedModels(), /CLI offline/);
});
