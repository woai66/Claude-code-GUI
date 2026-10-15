import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({ model });

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (
  rows: Record<string, string | null> = {},
  efforts: Record<string, string | null> = {},
) => {
  const sessions = new Map(Object.entries(rows).map(([sessionId, model]) => [
    sessionId,
    { model, effort: efforts[sessionId] ?? null },
  ]));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      sessions.get(sessionId) ?? null,
    setSessionModel: (sessionId: string, model: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
    setSessionEffort: (sessionId: string, effort: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.effort = effort;
      }
    },
  };
};

const createCatalogStore = () => {
  const rows = new Map<LLMProvider, CustomProviderModelRecord[]>();
  let nextRecordId = 1;
  const readRows = (provider: LLMProvider) => rows.get(provider) ?? [];

  return {
    rows,
    listCustomProviderModels(provider: LLMProvider) {
      return [...readRows(provider)];
    },
    getCustomProviderModel(provider: LLMProvider, recordId: number) {
      return readRows(provider).find((record) => record.recordId === recordId) ?? null;
    },
    findCustomProviderModelByModelId(provider: LLMProvider, modelId: string) {
      return readRows(provider).find((record) => record.modelId === modelId) ?? null;
    },
    createCustomProviderModel(provider: LLMProvider, input: CustomProviderModelInput) {
      const record: CustomProviderModelRecord = {
        recordId: nextRecordId++,
        provider,
        modelId: input.id,
        model: input.model,
        sortOrder: readRows(provider).length,
        effort: input.effort ?? null,
      };
      rows.set(provider, [...readRows(provider), record]);
      return record;
    },
    updateCustomProviderModel(
      provider: LLMProvider,
      recordId: number,
      input: CustomProviderModelInput,
    ) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      const updated = {
        ...existing,
        modelId: input.id,
        model: input.model,
        // Mirrors the repository: an omitted effort keeps the stored levels.
        effort: input.effort === undefined ? existing.effort : input.effort,
      };
      rows.set(provider, readRows(provider).map((record) => (
        record.recordId === recordId ? updated : record
      )));
      return updated;
    },
    deleteCustomProviderModel(provider: LLMProvider, recordId: number, _fallbackModelId: string) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      rows.set(provider, readRows(provider).filter((record) => record.recordId !== recordId));
      return existing;
    },
  };
};

const createTestService = (options: {
  catalog?: ReturnType<typeof createCatalogStore>;
  sessions?: ReturnType<typeof createSessionStore>;
  activeModel?: (provider: LLMProvider, sessionId?: string) => string;
  onCatalogRead?: (provider: LLMProvider) => void;
} = {}) => {
  const catalog = options.catalog ?? createCatalogStore();
  const sessions = options.sessions ?? createSessionStore();
  const service = createProviderModelsService({
    catalog,
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          options.onCatalogRead?.(provider);
          return createModels(`${provider}-default`);
        },
        getCurrentActiveModel: async (sessionId) => createCurrentActiveModel(
          options.activeModel?.(provider, sessionId) ?? `${provider}-default`,
        ),
      },
    }),
  });

  return { service, catalog, sessions };
};

test('provider catalogs merge source-controlled defaults with custom persistence rows', async () => {
  const calls: LLMProvider[] = [];
  const { service, catalog } = createTestService({ onCatalogRead: (provider) => calls.push(provider) });

  const models = await service.getProviderModels('codex');

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.DEFAULT, 'codex-default');
  assert.deepEqual(models.OPTIONS[0], {
    value: 'codex-default',
    label: 'codex-default',
    isCustom: false,
  });
  assert.deepEqual(catalog.rows.get('codex'), undefined);
});

const createDiscoveryService = (
  discover: (cwd?: string) => Promise<ProviderModelsDefinition>,
  stored = new Map<string, string>(),
  customCatalog = createCatalogStore(),
) => {
  const service = createProviderModelsService({
    catalog: customCatalog,
    sessions: createSessionStore(),
    modelCache: {
      get: (key) => stored.get(key) ?? null,
      set: (key, value) => { stored.set(key, value); },
    },
    resolveProvider: () => ({ models: {
      getSupportedModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
      refreshSupportedModels: discover,
      getCurrentActiveModel: async () => ({ model: '' }),
    } }),
  });
  return { service, stored, customCatalog };
};

test('discovered models survive service restarts without querying the CLI again', async () => {
  let calls = 0;
  const first = createDiscoveryService(async () => { calls += 1; return createModels('live-model'); });
  const initial = await first.service.getProviderModels('cursor');
  assert.equal(initial.DISCOVERY?.source, 'cli');
  assert.ok(initial.DISCOVERY?.updatedAt);
  const restarted = createDiscoveryService(async () => { throw new Error('must not run'); }, first.stored);
  const restored = await restarted.service.getProviderModels('cursor');
  assert.equal(restored.OPTIONS[0].value, 'live-model');
  assert.equal(restored.DISCOVERY?.source, 'cache');
  assert.equal(restored.DISCOVERY?.updatedAt, initial.DISCOVERY?.updatedAt);
  assert.equal(calls, 1);
});

test('refresh replaces obsolete CLI choices while retaining custom models without duplicate IDs', async () => {
  let model = 'old-model';
  const { service, customCatalog } = createDiscoveryService(async () => createModels(model));
  await service.getProviderModels('codex');
  customCatalog.createCustomProviderModel('codex', { id: 'new-model', model: 'My model' });
  customCatalog.createCustomProviderModel('codex', { id: 'manual-model', model: 'Manual' });
  model = 'new-model';
  const refreshed = await service.refreshProviderModels('codex');
  assert.deepEqual(refreshed.OPTIONS.map((option) => option.value), ['new-model', 'manual-model']);
  assert.equal(refreshed.OPTIONS[0].label, 'My model');
  assert.equal(refreshed.OPTIONS[0].isCustom, true);
  assert.equal(refreshed.DEFAULT, 'new-model');
  await assert.rejects(service.createCustomModel('codex', { id: 'new-model', model: 'Duplicate' }), /already exists/);
  const edited = await service.updateCustomModel('codex', refreshed.OPTIONS[0].recordId!, {
    id: 'new-model', model: 'Renamed custom model', effort: { values: ['high'] },
  });
  assert.equal(edited.model.label, 'Renamed custom model');
  assert.deepEqual(edited.model.effort?.values, [{ value: 'high' }]);
});

test('failed or empty refresh never overwrites the last successful catalog', async () => {
  let fail = false;
  let empty = false;
  const { service } = createDiscoveryService(async () => {
    if (fail) throw new Error('CLI offline');
    return empty ? { OPTIONS: [], DEFAULT: '' } : createModels('good-model');
  });
  await service.getProviderModels('cursor');
  fail = true;
  await assert.rejects(service.refreshProviderModels('cursor'), /CLI offline/);
  fail = false;
  empty = true;
  await assert.rejects(service.refreshProviderModels('cursor'), /usable model list/);
  assert.equal((await service.getProviderModels('cursor')).OPTIONS[0].value, 'good-model');
});

test('first discovery failure leaves the CLI list empty, keeps manual models and allows retry', async () => {
  let failed = true;
  const { service, customCatalog } = createDiscoveryService(async () => {
    if (failed) throw new Error('Sign in required');
    return createModels('cli-model');
  });
  customCatalog.createCustomProviderModel('cursor', { id: 'manual', model: 'Manual' });
  const initial = await service.getProviderModels('cursor');
  assert.equal(initial.DISCOVERY?.source, 'empty');
  assert.match(initial.DISCOVERY?.error ?? '', /Sign in required/);
  assert.deepEqual(initial.OPTIONS.map((option) => option.value), ['manual']);
  assert.equal(initial.DEFAULT, 'manual');
  failed = false;
  const retried = await service.refreshProviderModels('cursor');
  assert.deepEqual(retried.OPTIONS.map((option) => option.value), ['cli-model', 'manual']);
  assert.equal(retried.DISCOVERY?.error, undefined);
});

test('simultaneous model requests share discovery and workspace catalogs stay separate', async () => {
  let calls = 0;
  const { service } = createDiscoveryService(async (cwd) => {
    calls += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return createModels(cwd?.endsWith('other') ? 'other-model' : 'shared-model');
  });
  await Promise.all([service.getProviderModels('codex', 'workspace'), service.refreshProviderModels('codex', 'workspace')]);
  assert.equal(calls, 1);
  assert.equal((await service.getProviderModels('codex', 'other')).DEFAULT, 'other-model');
  assert.equal((await service.getProviderModels('codex', 'workspace')).DEFAULT, 'shared-model');
  assert.equal(calls, 2);
});

test('invalid stored catalogs are rediscovered instead of breaking model menus', async () => {
  const { service, stored } = createDiscoveryService(async () => createModels('valid-model'));
  await service.getProviderModels('codex');
  const key = [...stored.keys()][0];
  stored.set(key, '{"OPTIONS":[null],"DEFAULT":"invalid"}');
  assert.equal((await service.getProviderModels('codex')).DEFAULT, 'valid-model');
});

test('custom models can be created, edited, and deleted', async () => {
  const { service } = createTestService();
  const created = await service.createCustomModel('claude', {
    model: 'My Claude',
    id: 'claude-my-model',
  });
  const recordId = created.model.recordId as number;

  assert.equal(created.model.isCustom, true);
  assert.equal(created.models.OPTIONS.at(-1)?.value, 'claude-my-model');

  const updated = await service.updateCustomModel('claude', recordId, {
    model: 'My Better Claude',
    id: 'claude-my-model-v2',
  });
  assert.equal(updated.model.label, 'My Better Claude');
  assert.equal(updated.model.value, 'claude-my-model-v2');

  const removed = await service.deleteCustomModel('claude', recordId);
  assert.equal(removed.model.value, 'claude-my-model-v2');
  assert.equal(removed.models.OPTIONS.some((option) => option.recordId === recordId), false);
});

test('custom models carry declared effort levels into the merged catalog', async () => {
  const { service } = createTestService();

  const created = await service.createCustomModel('claude', {
    model: 'My Custom Model',
    id: 'my-custom-model',
    effort: { values: ['low', 'max'], default: 'max' },
  });
  const expectedEffort = { default: 'max', values: [{ value: 'low' }, { value: 'max' }] };
  assert.deepEqual(created.model.effort, expectedEffort);

  const catalog = await service.getProviderModels('claude');
  const merged = catalog.OPTIONS.find((option) => option.value === 'my-custom-model');
  assert.deepEqual(merged?.effort, expectedEffort);

  // A rename that does not mention effort (an older client) keeps the levels.
  const renamed = await service.updateCustomModel('claude', created.model.recordId as number, {
    model: 'Renamed',
    id: 'my-custom-model',
  });
  assert.deepEqual(renamed.model.effort, expectedEffort);

  const cleared = await service.updateCustomModel('claude', created.model.recordId as number, {
    model: 'Renamed',
    id: 'my-custom-model',
    effort: null,
  });
  assert.equal('effort' in cleared.model, false);
});

test('custom models without declared effort levels expose no effort', async () => {
  const { service } = createTestService();

  const created = await service.createCustomModel('codex', { model: 'Plain', id: 'plain-model' });

  assert.equal('effort' in created.model, false);
});

test('custom effort levels must be levels the provider supports', async () => {
  const { service } = createTestService();

  await assert.rejects(
    () => service.createCustomModel('codex', {
      model: 'Unknown level',
      id: 'unknown-level',
      effort: { values: ['low', 'turbo'] },
    }),
    (error) => error instanceof AppError
      && error.code === 'INVALID_MODEL_EFFORT'
      && error.statusCode === 400,
  );

  await assert.rejects(
    () => service.createCustomModel('cursor', {
      model: 'Cursor effort',
      id: 'cursor-effort',
      effort: { values: ['low'] },
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_EFFORT_NOT_SUPPORTED'
      && error.statusCode === 400,
  );
});

test('allowed effort levels come from the provider, not from the built-in models this machine sees', async () => {
  // The fake adapters' built-in models declare no effort at all, which is what
  // the real OpenCode adapter returns once it narrows its catalog to OpenCode
  // Zen, Anthropic, or OpenAI: only its OpenCode Go models declare effort.
  const { service } = createTestService();

  const created = await service.createCustomModel('opencode', {
    model: 'Router model',
    id: 'openrouter/router-model',
    effort: { values: ['none', 'high'] },
  });
  assert.deepEqual(created.model.effort, { values: [{ value: 'none' }, { value: 'high' }] });

  // Every merged catalog carries the provider's levels for the model library,
  // weakest first, and an empty list where effort is unsupported.
  const expectedLevels: Record<LLMProvider, string[]> = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    cursor: [],
    opencode: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking'],
  };
  for (const [provider, levels] of Object.entries(expectedLevels) as Array<[LLMProvider, string[]]>) {
    assert.deepEqual((await service.getProviderModels(provider)).EFFORT_LEVELS, levels, provider);
  }
  assert.deepEqual(created.models.EFFORT_LEVELS, expectedLevels.opencode);
});

test('duplicate model ids are rejected within one provider', async () => {
  const { service } = createTestService();
  await service.createCustomModel('cursor', { model: 'First', id: 'custom-id' });

  await assert.rejects(
    () => service.createCustomModel('cursor', { model: 'Second', id: 'custom-id' }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );

  await assert.rejects(
    () => service.createCustomModel('cursor', {
      model: 'Duplicate built-in',
      id: 'cursor-default',
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
});

test('predefined models have no database record or mutation target', async () => {
  const { service, catalog } = createTestService();
  const models = await service.getProviderModels('opencode');
  assert.equal(models.OPTIONS[0]?.recordId, undefined);
  assert.equal(models.OPTIONS[0]?.isCustom, false);
  assert.deepEqual(catalog.rows.get('opencode'), undefined);

  await assert.rejects(
    () => service.updateCustomModel('opencode', 999, { model: 'Changed', id: 'changed' }),
    (error) => error instanceof AppError && error.code === 'MODEL_NOT_FOUND',
  );
});

test('resolveSessionModel asks the provider adapter for the requested session', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-123': null }),
    activeModel: (provider, sessionId) => {
      calls.push({ provider, sessionId });
      return `${provider}-${sessionId}`;
    },
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});

test('setSessionModel records the model on the session row', () => {
  const sessions = createSessionStore({ 'session-1': null });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    effort: null,
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.model, 'opus');
});

test('setSessionModel ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('setSessionEffort records an explicit effort on the session row', () => {
  const sessions = createSessionStore({ 'session-1': 'gpt-5.6-sol' });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionEffort('codex', 'session-1', 'ultra');

  assert.deepEqual(stored, {
    provider: 'codex',
    sessionId: 'session-1',
    effort: 'ultra',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.effort, 'ultra');
});

test('setSessionEffort ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionEffort('codex', 'missing-session', 'high'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel prefers the recorded session model', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': 'haiku' }, { 'session-1': 'high' }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.effort, 'high');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel uses provider session state for unrecorded external sessions', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when provider reports the catalog default', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel returns a requested model before a session exists', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the provider adapter default', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-default');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never consults provider-global state', async () => {
  let providerLookups = 0;
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': null }),
    activeModel: () => {
      providerLookups += 1;
      return 'global-config-model';
    },
  });

  const model = await service.resolveResumeModel('codex', 'session-456', 'gpt-5.5');

  assert.equal(model, 'gpt-5.5');
  assert.equal(providerLookups, 0);
});
