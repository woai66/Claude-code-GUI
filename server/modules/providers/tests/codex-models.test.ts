import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';

test('Codex discovery uses one hidden process and closes it after reading all model pages', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: mock.fn(() => true),
  });
  const requests: { method: string; params: { cursor?: string } }[] = [];
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as {
      id?: number; method: string; params: { cursor?: string };
    };
    requests.push(request);
    if (!request.id) return;
    const result = request.method === 'initialize' ? {}
      : request.params.cursor ? { data: [{ model: 'second' }] }
        : { data: [{ model: 'first' }], nextCursor: 'page-2' };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
  });
  const spawn = mock.method(childProcess, 'spawn', (
    command: string,
    args: readonly string[] | undefined,
    options: childProcess.SpawnOptions | undefined,
  ) => {
    if (process.platform === 'win32') {
      // A hidden node launcher still starts a visible codex.exe grandchild.
      assert.match(command, /[\\/]codex\.exe$/);
      assert.deepEqual(args, ['app-server']);
    } else {
      assert.equal(command, process.execPath);
      assert.equal(args?.at(-1), 'app-server');
    }
    assert.equal(options?.windowsHide, true);
    assert.equal(options?.cwd, '/workspace/中文项目');
    assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
  syncBuiltinESMExports();
  try {
    const models = await codexAppServer.listModels('/workspace/中文项目');
    assert.deepEqual(models, [{ model: 'first' }, { model: 'second' }]);
    assert.deepEqual(requests.map((request) => request.method), [
      'initialize', 'initialized', 'model/list', 'model/list',
    ]);
    assert.equal(requests.at(-1)?.params.cursor, 'page-2');
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(child.kill.mock.callCount(), 1);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test('Codex has no fixed model choices before the CLI is queried', async () => {
  const adapter = new CodexProviderModels();
  assert.deepEqual(await adapter.getSupportedModels(), { OPTIONS: [], DEFAULT: '' });
});

test('Codex preserves CLI model IDs, defaults and per-model reasoning capabilities', async () => {
  let queriedCwd: string | undefined;
  const adapter = new CodexProviderModels({
    listModels: async (cwd) => {
      queriedCwd = cwd;
      return [
        { id: 'internal', model: 'future-codex', displayName: 'Future Codex', isDefault: true,
          defaultReasoningEffort: 'ultra',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'ultra' },
          ] },
        { model: 'hidden', hidden: true },
        { model: 'future-codex', displayName: 'Duplicate' },
        { model: 'fast-codex', displayName: 'Fast Codex' },
        null,
      ];
    },
  });
  const catalog = await adapter.refreshSupportedModels('/project');
  assert.equal(queriedCwd, '/project');
  assert.equal(catalog.DEFAULT, 'future-codex');
  assert.deepEqual(catalog.OPTIONS.map((option) => option.value), ['future-codex', 'fast-codex']);
  assert.equal(catalog.OPTIONS[0].label, 'Future Codex');
  assert.equal(catalog.OPTIONS[0].effort?.default, 'ultra');
  assert.deepEqual(catalog.OPTIONS[0].effort?.values.map((level) => level.value), ['low', 'ultra']);
  assert.equal(catalog.OPTIONS[1].effort, undefined);
});

test('Codex does not invent reasoning levels or defaults omitted by the CLI', async () => {
  const adapter = new CodexProviderModels({
    listModels: async () => [{
      id: 'future-model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    }],
  });
  const catalog = await adapter.refreshSupportedModels();
  assert.equal(catalog.DEFAULT, 'future-model');
  assert.equal(catalog.OPTIONS[0].effort?.default, undefined);
});

test('Codex discovery rejects empty results and propagates CLI failures', async () => {
  await assert.rejects(new CodexProviderModels({ listModels: async () => [] }).refreshSupportedModels(), /no models/);
  await assert.rejects(new CodexProviderModels({
    listModels: async () => { throw new Error('CLI offline'); },
  }).refreshSupportedModels(), /CLI offline/);
});

test('the bundled Codex CLI supports the model discovery protocol', () => {
  const require = createRequire(import.meta.url);
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, 'bundled Codex must preserve the current model and effort protocol');
});
