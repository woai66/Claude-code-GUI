import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';
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
      refreshModels: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      setSessionActiveSpeed: () => okJson({ success: true, data: null }),
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

test('new Codex chats remember speed while existing sessions retain their own settings', async () => {
  localStorage.setItem('codex-speed', 'fast');
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(async () => okJson({
    success: true, data: { model: 'session-model', speed: 'standard', source: 'session' },
  }) as unknown as Response);
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ session }: { session: ProjectSession | null }) =>
    useChatProviderState({ selectedSession: session, selectedProject: null }),
  { initialProps: { session: null as ProjectSession | null } });
  assert.equal(view.result.current.currentProviderSpeed, 'fast');
  view.rerender({ session: { id: 'existing', __provider: 'codex' } });
  await waitFor(() => assert.equal(view.result.current.currentProviderModel, 'session-model'));
  assert.equal(view.result.current.currentProviderSpeed, 'standard');
});

test('Codex native model and effort survive a stale catalog and refresh after returning from the CLI', async () => {
  localStorage.setItem('codex-model', 'new-chat-model');
  localStorage.setItem('codex-effort', 'low');
  const { api } = await import('@/shared/api');
  let selection = { model: 'native-model', effort: 'future-effort', source: 'provider' };
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(async () => okJson({
    success: true, data: selection,
  }) as unknown as Response);
  const { result } = await renderProviderStateForSession({ id: 'external-codex', __provider: 'codex' });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'native-model'));
  assert.equal(result.current.currentProviderEffort, 'future-effort');
  assert.ok(result.current.currentProviderModelOptions.some((option) => option.value === 'native-model'));
  assert.ok(result.current.currentProviderEffortOptions.some((option) => option.value === 'future-effort'));
  selection = { model: 'changed-in-cli', effort: 'ultra', source: 'provider' };
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'changed-in-cli'));
  assert.equal(result.current.currentProviderEffort, 'ultra');
});

test('Codex never substitutes another chat defaults while native settings are loading or unavailable', async () => {
  localStorage.setItem('codex-model', 'unrelated-default');
  localStorage.setItem('codex-effort', 'max');
  const { result } = await renderProviderStateForSession({ id: 'missing-codex', __provider: 'codex' });
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderModel, '');
  assert.equal(result.current.currentProviderEffort, 'default');
});

test('a resumed send waits for an effort click to persist and focus does not overwrite the pending choice', async () => {
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(async () => okJson({
    success: true, data: { model: 'native-model', effort: 'low', source: 'provider' },
  }) as unknown as Response);
  let finish: (value: Response) => void = () => {};
  vi.spyOn(api.providers, 'setSessionActiveEffort').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = await renderProviderStateForSession({ id: 'persisting-codex', __provider: 'codex' });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'native-model'));
  let selection: Promise<unknown>;
  act(() => { selection = result.current.selectProviderEffort('codex', 'max', 'persisting-codex'); });
  let sendReady = false;
  const ready = result.current.waitForSessionSelection('codex', 'persisting-codex').then(() => { sendReady = true; });
  act(() => window.dispatchEvent(new Event('focus')));
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.equal(sendReady, false);
  await act(async () => {
    finish(await okJson({ success: true, data: { effort: 'max' } }) as Response);
    await selection!;
    await ready;
  });
  assert.equal(sendReady, true);
  assert.equal(result.current.currentProviderEffort, 'max');
});

test('a late session read restores model without overwriting a newer speed click', async () => {
  const { api } = await import('@/shared/api');
  let finish: (value: Response) => void = () => {};
  vi.spyOn(api.providers, 'sessionActiveModel').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const persist = vi.spyOn(api.providers, 'setSessionActiveSpeed');
  const { result } = await renderProviderStateForSession({ id: 'pending-session', __provider: 'codex' });
  await act(async () => { await result.current.selectCodexSpeed('fast', 'pending-session'); });
  await act(async () => { finish(await okJson({ success: true, data: {
    model: 'external-model', effort: 'high', speed: 'standard', source: 'provider',
  } }) as Response); });
  assert.equal(result.current.currentProviderModel, 'external-model');
  assert.equal(result.current.currentProviderSpeed, 'fast');
  assert.equal(persist.mock.calls[0]?.[2], 'fast');
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
    assert.equal(result.current.providerModelsLoading, false);
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
