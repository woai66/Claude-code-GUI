import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

const renderProviderStateForSession = async (selectedSession: ProjectSession) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('canonical Claude IDs retain their stored selection and inherit the CLI alias effort capabilities', async () => {
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'models').mockImplementation(async (provider) => ({
    ok: true,
    json: async () => ({ success: true, data: { models: {
      DEFAULT: 'default', OPTIONS: provider === 'claude' ? [
        { value: 'default', label: 'Default', resolvedModel: 'claude-opus-5-5' },
        { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', effort: {
          values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }],
        } },
      ] : [{ value: 'default', label: 'Default' }],
    } } }),
  }) as Response);
  localStorage.setItem('claude-model', 'claude-opus-5-5');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.currentProviderModelOptions.length, 2));
  assert.equal(result.current.currentProviderModel, 'claude-opus-5-5');
  assert.deepEqual(result.current.currentProviderEffortOptions.map((option) => option.value), ['low', 'high', 'xhigh']);
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

test('an external Claude session restores the permission mode recorded by Claude CLI', async () => {
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'capabilities').mockImplementation(async () => okJson({
    success: true,
    data: {
      providers: [{
        provider: 'claude',
        permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'],
        defaultPermissionMode: 'default',
      }],
    },
  }) as unknown as Response);
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(async () => okJson({
    success: true,
    data: {
      provider: 'claude',
      sessionId: 'external-claude-session',
      model: 'default',
      source: 'default',
      permissionMode: 'auto',
    },
  }) as unknown as Response);

  const { result } = await renderProviderStateForSession({
    id: 'external-claude-session',
    __provider: 'claude',
  });

  await waitFor(() => assert.equal(result.current.permissionMode, 'auto'));
});

test('a local mode choice for a session overrides its external Claude mode', async () => {
  localStorage.setItem('permissionMode-external-claude-session', 'plan');
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'capabilities').mockImplementation(async () => okJson({
    success: true,
    data: {
      providers: [{
        provider: 'claude',
        permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'],
        defaultPermissionMode: 'default',
      }],
    },
  }) as unknown as Response);
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(async () => okJson({
    success: true,
    data: {
      provider: 'claude',
      sessionId: 'external-claude-session',
      model: 'default',
      source: 'default',
      permissionMode: 'auto',
    },
  }) as unknown as Response);

  const { result } = await renderProviderStateForSession({
    id: 'external-claude-session',
    __provider: 'claude',
  });

  await waitFor(() => assert.equal(result.current.permissionMode, 'plan'));
});
