import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

/**
 * While a turn runs, follow-ups wait in one queued message. Each one used to
 * replace the one waiting, so only the last reached the next turn. They are
 * appended now, and a Codex queued message can instead be steered into the
 * running turn, going back to the queue if that turn has already ended.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const submitEvent = () => ({ preventDefault: () => undefined }) as never;

const renderRunningComposer = () => {
  const sent: Array<Record<string, unknown>> = [];
  const added: ChatMessage[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: true,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: (message: ChatMessage) => { added.push(message); },
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  const queue = async (text: string) => {
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent()); });
  };
  return { view, sent, added, queue };
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('follow-ups queued during one turn are all kept, in order', async () => {
  const { view, sent, queue } = renderRunningComposer();
  await queue('first');
  await queue('second');

  assert.equal(view.result.current.queuedDraft?.content, 'first\n\nsecond');
  assert.equal(readQueuedMessage('session-a')?.content, 'first\n\nsecond');
  assert.equal(sent.length, 0, 'nothing is sent while the turn runs');
});

test('a steered message leaves the queue at once and shows in the transcript when taken', async () => {
  const { view, sent, added, queue } = renderRunningComposer();
  await queue('also run the tests');
  await act(async () => { view.result.current.steerQueuedDraft(); });

  assert.equal(view.result.current.queuedDraft, null);
  assert.equal(readQueuedMessage('session-a'), null, 'the dispatcher must not send it a second time');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'chat.steer');
  assert.equal(sent[0].content, 'also run the tests');

  await act(async () => {
    view.result.current.handleSteerOutcome('session-a', sent[0].messageId as string, 'accepted');
  });
  assert.deepEqual(added.map((message) => [message.type, message.content]), [['user', 'also run the tests']]);
});

test('a steer the ended turn refused goes back to the queue ahead of later follow-ups', async () => {
  const { view, sent, added, queue } = renderRunningComposer();
  await queue('steer me');
  await act(async () => { view.result.current.steerQueuedDraft(); });
  await queue('typed afterwards');

  await act(async () => {
    view.result.current.handleSteerOutcome('session-a', sent[0].messageId as string, 'refused');
  });
  assert.equal(view.result.current.queuedDraft?.content, 'steer me\n\ntyped afterwards');
  assert.equal(readQueuedMessage('session-a')?.content, 'steer me\n\ntyped afterwards');
  assert.equal(added.length, 0);
});
