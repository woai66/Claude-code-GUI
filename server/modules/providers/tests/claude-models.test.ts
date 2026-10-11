import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelInfo, query } from '@anthropic-ai/claude-agent-sdk';

import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
  extractClaudeEventModel,
  resolveClaudeEffort,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

const CLI_MODELS: (ModelInfo & { resolvedModel: string })[] = [
  {
    value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)',
    description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5',
    description: 'Complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5',
    description: 'Quick tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'],
  },
];

test('discovers CLI names and effort capabilities without sending a prompt or saving a session', async () => {
  let closeCount = 0;
  const models = new ClaudeProviderModels({
    resolveExecutable: () => 'claude.exe',
    query: ((params: Parameters<typeof query>[0]) => {
      assert.equal(params.options?.persistSession, false);
      assert.equal(params.options?.pathToClaudeCodeExecutable, 'claude.exe');
      assert.notEqual(typeof params.prompt, 'string');
      assert.deepEqual(params.options?.tools, []);
      return { supportedModels: async () => CLI_MODELS, close: () => { closeCount += 1; } };
    }) as unknown as typeof query,
  });
  const catalog = await models.getSupportedModels();
  assert.equal(closeCount, 1);
  assert.equal(catalog.OPTIONS[1].label, 'Opus 5.5');
  assert.equal(resolveClaudeEffort('claude-opus-5-5', 'high', catalog), 'high');
  assert.equal(resolveClaudeEffort('claude-haiku-5-5', 'medium', catalog), 'medium');
  assert.equal(resolveClaudeEffort('haiku', 'xhigh', catalog), undefined);
  assert.equal(resolveClaudeEffort('opus', 'default', catalog), undefined);
  assert.equal(resolveClaudeEffort('opus', 'ultracode', catalog), 'ultracode');
  assert.ok(!catalog.OPTIONS[2].effort?.values.some((level) => level.value === 'ultracode'));
});

test('coalesces discovery and caches it per workspace, refreshing after expiry', async () => {
  let calls = 0;
  let now = 0;
  const models = new ClaudeProviderModels({
    now: () => now,
    resolveExecutable: () => undefined,
    query: (() => {
      calls += 1;
      return { supportedModels: async () => CLI_MODELS, close() {} };
    }) as unknown as typeof query,
  });
  await Promise.all([models.getSupportedModels('/one'), models.getSupportedModels('/one')]);
  await models.getSupportedModels('/one');
  assert.equal(calls, 1);
  await models.getSupportedModels('/two');
  assert.equal(calls, 2);
  now = 300_001;
  await models.getSupportedModels('/one');
  assert.equal(calls, 3);
});

test('times out, closes discovery, and retries the fallback after its shorter expiry', async () => {
  let now = 0;
  let calls = 0;
  let closes = 0;
  const models = new ClaudeProviderModels({
    timeoutMs: 5,
    now: () => now,
    resolveExecutable: () => undefined,
    query: (() => {
      calls += 1;
      return {
        supportedModels: () => new Promise<ModelInfo[]>(() => {}),
        close: () => { closes += 1; },
      };
    }) as unknown as typeof query,
  });
  assert.equal(await models.getSupportedModels(), CLAUDE_PREDEFINED_MODELS);
  assert.equal(await models.getSupportedModels(), CLAUDE_PREDEFINED_MODELS);
  assert.equal(calls, 1);
  assert.equal(closes, 1);
  now = 15_001;
  await models.getSupportedModels();
  assert.equal(calls, 2);
  assert.equal(closes, 2);
});

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});
