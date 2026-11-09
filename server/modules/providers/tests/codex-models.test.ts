import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
      assert.match(command, /\/codex$/);
      assert.deepEqual(args, ['app-server']);
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

test('Codex restores the last native turn settings and notices later CLI changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-selection-'));
  const transcript = path.join(directory, 'rollout.jsonl');
  const config = path.join(directory, 'config.toml');
  const row = (model: string, effort: string) => `${JSON.stringify({
    type: 'turn_context', payload: { model, effort },
  })}\n`;
  try {
    await writeFile(config, 'model="global-default"\nmodel_reasoning_effort="low"');
    await writeFile(transcript, row('first-model', 'low') + row('last-model', 'ultra')
      + `${JSON.stringify({ type: 'response_item', payload: { text: '中'.repeat(70_000) } })}\n`
      + '{"type":"turn_context","payload":');
    const adapter = new CodexProviderModels({ configPath: config, readSession: (id) => {
      assert.equal(id, 'gui-session');
      return { provider: 'codex', provider_session_id: 'native-id', jsonl_path: transcript };
    } });
    const first = await adapter.getCurrentActiveModel('gui-session');
    assert.equal(first.model, 'last-model');
    assert.equal(first.effort, 'ultra');
    assert.equal(first.source, 'session');
    await appendFile(transcript, `\n${row('new-cli-model', 'max')}`);
    const second = await adapter.getCurrentActiveModel('gui-session');
    assert.equal(second.model, 'new-cli-model');
    assert.equal(second.effort, 'max');
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(await adapter.getCurrentActiveModel(), {
      model: 'global-default', effort: 'low', source: 'config',
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex does not mistake global config for the model of a missing native session', async () => {
  const adapter = new CodexProviderModels({ readSession: () => null });
  assert.deepEqual(await adapter.getCurrentActiveModel('unknown'), { model: '', effort: null, source: 'session' });
});
