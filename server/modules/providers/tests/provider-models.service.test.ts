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
  nativeSelection?: () => ProviderCurrentActiveModel;
  onCatalogRead?: (provider: LLMProvider) => void;
} = {}) => {
  const catalog = options.catalog ?? createCatalogStore();
  const sessions = options.sessions ?? createSessionStore();
  const preferences = new Map<string, string>();
  const service = createProviderModelsService({
    catalog,
    sessions,
    modelCache: { get: (key) => preferences.get(key) ?? null, set: (key, value) => { preferences.set(key, value); } },
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          options.onCatalogRead?.(provider);
          return createModels(`${provider}-default`);
        },
        getCurrentActiveModel: async (sessionId) => options.nativeSelection?.() ?? createCurrentActiveModel(
          options.activeModel?.(provider, sessionId) ?? (provider === 'codex' && sessionId ? '' : `${provider}-default`)),
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

test('Codex native state wins over stale GUI cache even if it equals the catalog default', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ external: 'old-gui-model' }, { external: 'low' }),
    nativeSelection: () => ({ model: 'codex-default', effort: 'ultra', source: 'session', revision: 'turn-1' }),
  });
  const selection = await service.resolveSessionModel('codex', { sessionId: 'external', requestedModel: 'new-chat' });
  assert.equal(selection.model, 'codex-default');
  assert.equal(selection.effort, 'ultra');
  assert.equal(selection.source, 'provider');
  assert.equal(selection.pending, false);
});

test('Codex pending choices survive reopening until a newer native turn supersedes them', async () => {
  let native: ProviderCurrentActiveModel = { model: 'cli-model', effort: 'high', revision: 'turn-1' };
  const { service } = createTestService({
    sessions: createSessionStore({ external: 'old-gui-model' }), nativeSelection: () => native,
  });
  await service.selectSessionModel('codex', 'external', 'next-model');
  await service.selectSessionEffort('codex', 'external', 'max');
  const pending = await service.resolveSessionModel('codex', { sessionId: 'external' });
  assert.equal(pending.model, 'next-model');
  assert.equal(pending.effort, 'max');
  assert.equal(pending.pending, true);
  assert.deepEqual(pending.lastUsed, { model: 'cli-model', effort: 'high' });
  native = { model: 'updated-in-cli', effort: 'ultra', revision: 'turn-2' };
  const refreshed = await service.resolveSessionModel('codex', { sessionId: 'external' });
  assert.equal(refreshed.model, 'updated-in-cli');
  assert.equal(refreshed.effort, 'ultra');
  assert.equal(refreshed.pending, false);
  assert.equal(await service.resolveResumeModel('codex', 'external'), 'updated-in-cli');
});
