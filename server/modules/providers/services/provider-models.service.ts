import path from 'node:path';

import { appConfigDb, providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  CustomProviderModelInput,
  CodexSpeed,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionModel,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): { model: string | null; effort: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
  setSessionEffort(sessionId: string, effort: string): void;
};

/** SQLite catalog operations used by the Providers service and its unit fakes. */
type ProviderModelsCatalogStore = Pick<
  typeof providerModelsDb,
  | 'listCustomProviderModels'
  | 'getCustomProviderModel'
  | 'findCustomProviderModelByModelId'
  | 'createCustomProviderModel'
  | 'updateCustomProviderModel'
  | 'deleteCustomProviderModel'
>;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  catalog?: ProviderModelsCatalogStore;
  sessions?: ProviderModelsSessionStore;
  modelCache?: Pick<typeof appConfigDb, 'get' | 'set'>;
};

/**
 * Converts a stored custom row into a catalog option.
 *
 * `effort` is emitted in the same shape predefined models use, so the composer
 * and every runtime's effort validation treat declared levels identically.
 * Rows without declared levels omit `effort` on purpose: the composer then
 * hides Reasoning and runtimes send no effort, instead of guessing levels the
 * model might reject.
 */
const toCustomProviderModelOption = (
  record: CustomProviderModelRecord,
): ProviderModelOption => ({
  value: record.modelId,
  label: record.model,
  recordId: record.recordId,
  isCustom: true,
  ...(record.effort
    ? {
      effort: {
        ...(record.effort.default ? { default: record.effort.default } : {}),
        values: record.effort.values.map((value) => ({ value })),
      },
    }
    : {}),
});

/**
 * Effort levels a custom model of this provider may declare, weakest first:
 * the levels its runtime can pass on, from the capability matrix. Empty
 * (Cursor) means no effort support at all.
 *
 * Deliberately not derived from the predefined models: OpenCode narrows its
 * catalog to the upstream providers this machine has connected, and only its
 * OpenCode Go models declare effort, so a catalog-derived set would vanish for
 * Zen, Anthropic, or OpenAI users and change with unrelated credentials.
 */
const readCustomModelEffortLevels = (provider: LLMProvider): string[] => (
  providerCapabilitiesService.getProviderCapabilities(provider).effortLevels
);

const mergeProviderModels = (
  provider: LLMProvider,
  predefined: ProviderModelsDefinition,
  custom: CustomProviderModelRecord[],
): ProviderModelsDefinition => {
  const customIds = new Set(custom.map((model) => model.modelId));
  const options = [
    ...predefined.OPTIONS.filter((option) => !customIds.has(option.value))
      .map((option) => ({ ...option, isCustom: false })),
    ...custom.map(toCustomProviderModelOption),
  ];
  return {
    ...predefined,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === predefined.DEFAULT)
      ? predefined.DEFAULT : options[0]?.value ?? predefined.DEFAULT,
    // Copied so no caller can mutate the shared capability matrix.
    EFFORT_LEVELS: [...readCustomModelEffortLevels(provider)],
  };
};

const normalizeCustomModelInput = (input: CustomProviderModelInput): CustomProviderModelInput => ({
  id: input.id.trim(),
  model: input.model.trim(),
  ...(input.effort === undefined ? {} : { effort: input.effort }),
});

const assertEffortLevelsSupported = (
  provider: LLMProvider,
  input: CustomProviderModelInput,
): void => {
  const declaredLevels = input.effort?.values ?? [];
  if (declaredLevels.length === 0) {
    return;
  }

  const supportedLevels = readCustomModelEffortLevels(provider);
  if (supportedLevels.length === 0) {
    throw new AppError(`${provider} models do not support reasoning effort.`, {
      code: 'MODEL_EFFORT_NOT_SUPPORTED',
      statusCode: 400,
    });
  }

  const unsupportedLevel = declaredLevels.find((level) => !supportedLevels.includes(level));
  if (unsupportedLevel) {
    throw new AppError(
      `"${unsupportedLevel}" is not a ${provider} effort level. Use one of: ${supportedLevels.join(', ')}.`,
      {
        code: 'INVALID_MODEL_EFFORT',
        statusCode: 400,
      },
    );
  }
};

const isUniqueConstraintError = (error: unknown): boolean => (
  error !== null
  && error !== undefined
  && typeof error === 'object'
  && 'code' in error
  && String(error.code).startsWith('SQLITE_CONSTRAINT')
);

/**
 * Creates the provider model application service used by Providers routes,
 * Commands, and provider runtimes.
 *
 * CLI-discovered catalogs are saved separately from custom models and reused
 * until an explicit refresh. This avoids launching CLI processes on every
 * project change and preserves the last successful list across restarts.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const catalog = dependencies.catalog ?? providerModelsDb;
  const sessions = dependencies.sessions ?? sessionsDb;
  const modelCache = dependencies.modelCache ?? appConfigDb;
  const pendingDiscovery = new Map<string, Promise<ProviderModelsDefinition>>();
  const failedDiscovery = new Map<string, { models: ProviderModelsDefinition; retryAt: number }>();

  /** Persists speed separately from the model without changing externally managed CLI configuration. */
  const setSessionSpeed = (provider: LLMProvider, sessionId: string, speed: CodexSpeed): void => {
    if (provider !== 'codex') {
      throw new AppError('Speed overrides are only supported for Codex.', { statusCode: 400 });
    }
    modelCache.set(`session-speed:${provider}:${sessionId}`, speed);
  };

  /** Unset sessions inherit their native CLI resume/config behavior instead of silently forcing Standard. */
  const getSessionSpeed = (provider: LLMProvider, sessionId: string): CodexSpeed => {
    const value = modelCache.get(`session-speed:${provider}:${sessionId}`);
    return value === 'fast' || value === 'standard' ? value : 'default';
  };

  const catalogCacheKey = (provider: LLMProvider, cwd?: string) => (
    `provider-model-catalog:${provider}:${path.resolve(cwd || process.cwd())}`
  );

  const readCachedCatalog = (key: string): ProviderModelsDefinition | null => {
    try {
      const value = modelCache.get(key);
      if (!value) return null;
      const cached = JSON.parse(value) as ProviderModelsDefinition;
      if (!cached || !Array.isArray(cached.OPTIONS) || !cached.OPTIONS.length
        || typeof cached.DEFAULT !== 'string'
        || !cached.OPTIONS.every((option) => option && typeof option.value === 'string' && option.value.trim()
          && typeof option.label === 'string')
        || !cached.OPTIONS.some((option) => option.value === cached.DEFAULT)) return null;
      return { ...cached, DISCOVERY: { ...cached.DISCOVERY, source: 'cache' } };
    } catch {
      return null;
    }
  };

  const refreshCatalog = (provider: LLMProvider, cwd?: string): Promise<ProviderModelsDefinition> => {
    const key = catalogCacheKey(provider, cwd);
    const pending = pendingDiscovery.get(key);
    if (pending) return pending;
    const adapter = resolveProvider(provider).models;
    const request = (async () => {
      if (!adapter.refreshSupportedModels) {
        throw new AppError('This provider does not support explicit model discovery.', {
          code: 'MODEL_DISCOVERY_UNSUPPORTED', statusCode: 400,
        });
      }
      const models = await adapter.refreshSupportedModels(cwd);
      if (!models.OPTIONS.length || !models.OPTIONS.some((option) => option.value === models.DEFAULT)) {
        throw new AppError('The CLI did not return a usable model list.', {
          code: 'EMPTY_MODEL_CATALOG', statusCode: 502,
        });
      }
      const discovered: ProviderModelsDefinition = {
        ...models,
        DISCOVERY: { source: 'cli', updatedAt: new Date().toISOString() },
      };
      modelCache.set(key, JSON.stringify(discovered));
      failedDiscovery.delete(key);
      return discovered;
    })().finally(() => pendingDiscovery.delete(key));
    pendingDiscovery.set(key, request);
    return request;
  };

  const getBaseModels = async (provider: LLMProvider, cwd?: string): Promise<ProviderModelsDefinition> => {
    const adapter = resolveProvider(provider).models;
    if (!adapter.refreshSupportedModels) return adapter.getSupportedModels(cwd);
    const key = catalogCacheKey(provider, cwd);
    const cached = readCachedCatalog(key);
    if (cached) return cached;
    const failed = failedDiscovery.get(key);
    if (failed && failed.retryAt > Date.now()) return failed.models;
    try {
      return await refreshCatalog(provider, cwd);
    } catch (error) {
      const models: ProviderModelsDefinition = {
        ...await adapter.getSupportedModels(cwd),
        DISCOVERY: {
          source: 'empty',
          error: error instanceof Error ? error.message : 'Unable to fetch models from the CLI.',
        },
      };
      failedDiscovery.set(key, { models, retryAt: Date.now() + 15_000 });
      return models;
    }
  };

  const getProviderModels = async (provider: LLMProvider, cwd?: string): Promise<ProviderModelsDefinition> => {
    const predefined = await getBaseModels(provider, cwd);
    return mergeProviderModels(provider, predefined, catalog.listCustomProviderModels(provider));
  };

  const refreshProviderModels = async (provider: LLMProvider, cwd?: string): Promise<ProviderModelsDefinition> => (
    mergeProviderModels(provider, await refreshCatalog(provider, cwd), catalog.listCustomProviderModels(provider))
  );

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const readCustomModel = (
    provider: LLMProvider,
    recordId: number,
  ): CustomProviderModelRecord => {
    const existing = catalog.getCustomProviderModel(provider, recordId);
    if (!existing) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return existing;
  };

  const assertModelIdAvailable = (
    provider: LLMProvider,
    predefined: ProviderModelsDefinition,
    modelId: string,
    currentRecordId?: number,
  ): void => {
    const duplicate = catalog.findCustomProviderModelByModelId(provider, modelId);
    // CLI refresh may discover an ID the user had already added; that row stays editable.
    if (predefined.OPTIONS.some((option) => option.value === modelId)
      && (!duplicate || duplicate.recordId !== currentRecordId)) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }

    if (duplicate && duplicate.recordId !== currentRecordId) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }
  };

  const createCustomModel = async (
    provider: LLMProvider,
    input: CustomProviderModelInput,
    cwd?: string,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await getBaseModels(provider, cwd);
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id);
    assertEffortLevelsSupported(provider, normalized);

    try {
      const created = catalog.createCustomProviderModel(provider, normalized);
      return {
        model: toCustomProviderModelOption(created),
        models: mergeProviderModels(provider, predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const updateCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
    cwd?: string,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await getBaseModels(provider, cwd);
    readCustomModel(provider, recordId);
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id, recordId);
    assertEffortLevelsSupported(provider, normalized);

    try {
      const updated = catalog.updateCustomProviderModel(provider, recordId, normalized);
      if (!updated) {
        throw new AppError('Model not found.', {
          code: 'MODEL_NOT_FOUND',
          statusCode: 404,
        });
      }

      return {
        model: toCustomProviderModelOption(updated),
        models: mergeProviderModels(provider, predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const deleteCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    cwd?: string,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await getBaseModels(provider, cwd);
    readCustomModel(provider, recordId);
    const removed = catalog.deleteCustomProviderModel(provider, recordId, predefined.DEFAULT);
    if (!removed) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      model: toCustomProviderModelOption(removed),
      models: mergeProviderModels(provider, predefined, catalog.listCustomProviderModels(provider)),
    };
  };

  const readRecordedSessionSelection = (
    sessionId: string,
  ): { model: string | null; effort: string | null } | null => {
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
    };
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
    if (!recordedSelection) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      effort: recordedSelection.effort,
      source: 'session',
    };
  };

  /**
   * Records the reasoning effort one session runs with.
   *
   * Like `setSessionModel`, this ignores an id that has not been allocated by
   * the session gateway yet. The websocket send path records it once the row
   * exists, so a pre-session composer choice is not lost.
   */
  const setSessionEffort = (
    provider: LLMProvider,
    sessionId: string,
    effort: string,
  ): { provider: LLMProvider; sessionId: string; effort: string; source: 'session' } | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedEffort = effort.trim();
    if (!normalizedSessionId || !normalizedEffort) {
      return null;
    }

    if (!readRecordedSessionSelection(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionEffort(normalizedSessionId, normalizedEffort);
    return {
      provider,
      sessionId: normalizedSessionId,
      effort: normalizedEffort,
      source: 'session',
    };
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. the model recorded on the session row;
   *   2. the provider's own session state for externally-created sessions;
   *   3. `requestedModel`, the client's current default;
   *   4. the source-controlled provider catalog default.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
      if (recordedSelection?.model) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedSelection.model,
          effort: recordedSelection.effort,
          source: 'session',
        };
      }

      const providerCatalog = await getProviderModels(provider);
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== providerCatalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          effort: recordedSelection?.effort ?? null,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || providerCatalog.DEFAULT,
        effort: recordedSelection?.effort ?? null,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        effort: null,
        source: 'session',
      };
    }

    const providerCatalog = await getProviderModels(provider);
    return {
      provider,
      sessionId: null,
      model: providerCatalog.DEFAULT,
      effort: null,
      source: 'default',
    };
  };

  /**
   * Picks the model one resumed provider run should use.
   *
   * Provider-global state is deliberately ignored because it must never
   * override the model explicitly selected in the composer.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionSelection(normalizedSessionId)?.model;
    return recordedModel || normalizedRequestedModel || undefined;
  };

  return {
    getSessionSpeed,
    setSessionSpeed,
    getProviderModels,
    refreshProviderModels,
    createCustomModel,
    updateCustomModel,
    deleteCustomModel,
    setSessionModel,
    setSessionEffort,
    resolveSessionModel,
    resolveResumeModel,
  };
};

/** Shared Providers service used by routes, Commands, and provider runtimes. */
export const providerModelsService = createProviderModelsService();
