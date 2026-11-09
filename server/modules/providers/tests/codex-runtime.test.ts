import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

type Rpc = { id?: number | string; method?: string; params?: AnyRecord; result?: any; error?: unknown };
function fixture(t: TestContext, onCall?: (request: Rpc, f: ReturnType<typeof fixture>) => boolean | void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: t.mock.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    }),
  });
  const requests: Rpc[] = [];
  const responses: Rpc[] = [];
  const messages: AnyRecord[] = [];
  const send = (data: Rpc) => child.stdout.write(`${JSON.stringify(data)}\n`);
  const notify = (method: string, params: AnyRecord = {}) => send({ method, params: { threadId: 'native', turnId: 'turn', ...params } });
  const reply = (request: Rpc, result: unknown) => send({ id: request.id, result });
  const completed = (status = 'completed') => notify('turn/completed', { turn: { id: 'turn', status } });
  const f = { child, requests, responses, messages, send, notify, reply, completed };
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk)) as Rpc;
    if (!request.method) { responses.push(request); return; }
    requests.push(request);
    if (onCall?.(request, f) === true || request.id === undefined) return;
    if (request.method === 'initialize') reply(request, {});
    else if (request.method === 'thread/start' || request.method === 'thread/resume') reply(request, { thread: { id: 'native' } });
    else if (request.method === 'turn/start') { reply(request, { turn: { id: 'turn', status: 'inProgress' } }); queueMicrotask(() => completed()); }
    else reply(request, {});
  });
  const spawn = t.mock.method(childProcess, 'spawn', (_command: string, args: readonly string[] | undefined, options: childProcess.SpawnOptions | undefined) => {
    assert.deepEqual(args, ['app-server']);
    assert.equal(options?.windowsHide, true);
    assert.equal(options?.shell, undefined);
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return f;
}
const sessions = new CodexSessionsProvider();
function context(resumed = true): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => resumed ? 'native' : null,
    resolveResumeModel: async () => 'gpt-6.1-sol',
    // A stale catalog must never filter native effort or model parameters.
    getProviderModels: async () => ({ DEFAULT: '', OPTIONS: [] }),
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id), isProviderInstalled: async () => true,
  };
}
function run(f: ReturnType<typeof fixture>, options: AnyRecord = {}, resumed = true, command = 'hello') {
  return codexRuntime.run(command, { sessionId: 'app', cwd: process.cwd(), ...options }, {
    isWebSocketWriter: true, send: (message) => f.messages.push(message as AnyRecord),
    setSessionId: (id) => { assert.equal(id, 'native'); },
  }, context(resumed));
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('waits for the native app-server to exit before completing a turn', async (t) => {
  const f = fixture(t);
  let exited = false;
  f.child.once('exit', () => { exited = true; });

  await run(f);

  assert.equal(exited, true);
  assert.equal(f.child.kill.mock.callCount(), 1);
});

test('retries a temporary native writer lock before resuming', async (t) => {
  let attempts = 0;
  const f = fixture(t, (request, fixture) => {
    if (request.method !== 'thread/resume') return;
    attempts += 1;
    if (attempts < 3) {
      fixture.send({ id: request.id, error: { message: 'thread native already has an active writer' } });
    } else {
      fixture.reply(request, { thread: { id: 'native' } });
    }
    return true;
  });

  await run(f);

  assert.equal(attempts, 3);
  assert.equal(f.messages.at(-1)!.success, true);
});

test('reports a persistent native writer lock with an actionable message', async (t) => {
  const f = fixture(t, (request, fixture) => {
    if (request.method !== 'thread/resume') return;
    fixture.send({ id: request.id, error: { message: 'thread native already has an active writer' } });
    return true;
  });

  await run(f);

  const error = f.messages.find((message) => message.kind === 'error');
  assert.match(error!.content, /另一个 Codex 客户端/);
  assert.equal(f.messages.at(-1)!.success, false);
});

for (const resumed of [false, true]) {
  for (const speed of ['fast', 'standard', 'default']) {
    test(`native ${resumed ? 'resume' : 'start'} preserves model, effort and ${speed} speed`, async (t) => {
      const f = fixture(t);
      await run(f, { speed, effort: 'max' }, resumed);
      const thread = f.requests.find((r) => r.method === (resumed ? 'thread/resume' : 'thread/start'))!;
      assert.equal(thread.params!.model, 'gpt-6.1-sol');
      assert.equal(thread.params!.config.model_reasoning_effort, 'max');
      assert.equal(thread.params!.serviceTier, speed === 'fast' ? 'fast' : speed === 'standard' ? 'default' : undefined);
      assert.equal(thread.params!.config['features.fast_mode'], speed === 'default' ? undefined : speed === 'fast');
      assert.equal(thread.params!.threadId, resumed ? 'native' : undefined);
      assert.equal(f.requests.find((r) => r.method === 'turn/start')!.params!.effort, 'max');
      assert.equal(f.messages.filter((m) => m.kind === 'complete').length, 1);
      assert.equal(f.messages.at(-1)!.success, true);
      assert.equal(f.messages.filter((m) => m.kind === 'session_created').length, resumed ? 0 : 1);
      assert.equal(f.child.kill.mock.callCount(), 1);
    });
  }
}

for (const mode of ['default', 'auto', 'acceptEdits', 'bypassPermissions']) {
  test(`native permission policy ${mode} is passed to the CLI`, async (t) => {
    const f = fixture(t);
    await run(f, { permissionMode: mode, effort: 'default' });
    const params = f.requests.find((r) => r.method === 'thread/resume')!.params!;
    assert.equal(params.sandbox, mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
    assert.equal(params.approvalPolicy, mode === 'default' || mode === 'auto' ? 'on-request' : 'never');
    // Matches what Codex Desktop records for "Approve for me"; every other mode resets a reviewer left by another client.
    assert.equal(params.approvalsReviewer, mode === 'auto' ? 'auto_review' : 'user');
    assert.equal(params.config, undefined);
    assert.equal(f.requests.find((r) => r.method === 'turn/start')!.params!.effort, undefined);
  });
}

test('surfaces rejected auto-review decisions and stays quiet on approvals', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.notify('item/autoApprovalReview/completed', { reviewId: 'ok', targetItemId: 'cmd-1', decisionSource: 'agent',
      review: { status: 'approved', riskLevel: 'low', userAuthorization: null, rationale: null },
      action: { type: 'command', source: 'shell', command: 'npm test', cwd: '/repo' } });
    f.notify('item/autoApprovalReview/completed', { reviewId: 'no', targetItemId: null, decisionSource: 'agent',
      review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: 'Deletes files outside the workspace' },
      action: { type: 'command', source: 'shell', command: 'rm -rf ~/x', cwd: '/repo' } });
    f.completed();
    return true;
  });

  await run(f, { permissionMode: 'auto' });

  const notices = f.messages.filter((message) => message.kind === 'task_notification');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, 'warning');
  assert.match(notices[0].summary, /拒绝.*high.*rm -rf ~\/x.*Deletes files outside the workspace/);
  assert.equal(notices[0].autoReviewDenialId, 'no');
  assert.equal(f.messages.at(-1)!.success, true);
});

test('an auto-review that could not reach its model is one failure notice, not an approvable denial', async (t) => {
  const failure = 'Automatic approval review failed: exceeded retry limit, last status: 429 Too Many Requests';
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.notify('guardianWarning', { message: failure });
    f.notify('item/autoApprovalReview/completed', { reviewId: 'r-429', decisionSource: 'agent',
      review: { status: 'denied', riskLevel: null, userAuthorization: null, rationale: failure },
      action: { type: 'command', source: 'shell', command: 'git pull --ff-only', cwd: '/repo' } });
    f.notify('guardianWarning', { message: 'Strict review is required for the rest of this turn.' });
    f.completed();
    return true;
  });
  await run(f, { permissionMode: 'auto' });

  const notices = f.messages.filter((message) => message.kind === 'task_notification');
  assert.equal(notices.length, 2, 'the failure once, plus the unrelated warning');
  assert.match(notices[0].summary, /没能完成.*git pull --ff-only.*429/);
  assert.doesNotMatch(notices[0].summary, /拒绝/);
  assert.equal(notices[0].autoReviewDenialId, undefined);
  assert.equal(notices[1].summary, 'Strict review is required for the rest of this turn.');
});

test('an approved auto-review denial is handed back in core form before the retry turn, once', async (t) => {
  const denied = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.notify('item/autoApprovalReview/completed', { reviewId: 'deny-1', targetItemId: null, decisionSource: 'agent',
      startedAtMs: 1, completedAtMs: 2,
      review: { status: 'denied', riskLevel: 'high', userAuthorization: 'low', rationale: 'r' },
      action: { type: 'networkAccess', target: 'https://example.com', host: 'example.com', protocol: 'socks5Tcp', port: 443 } });
    f.notify('item/autoApprovalReview/completed', { reviewId: 'stdin-1', decisionSource: 'agent',
      review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: null },
      action: { type: 'writeStdin', approvalId: 'a', processId: 'p', stdin: 'y', cwd: '/repo' } });
    f.completed();
    return true;
  });
  await run(denied, { permissionMode: 'auto' });
  const notices = denied.messages.filter((message) => message.kind === 'task_notification');
  assert.deepEqual(notices.map((notice) => notice.autoReviewDenialId), ['deny-1', undefined]);

  const retry = fixture(t);
  await run(retry, { permissionMode: 'auto', approveAutoReviewDenials: ['deny-1'] });
  const approvals = retry.requests.filter((r) => r.method === 'thread/approveGuardianDeniedAction');
  // The same event the real CLI accepted when probed; a camelCase one is rejected.
  assert.deepEqual(approvals.map((r) => r.params), [{ threadId: 'native', event: {
    id: 'deny-1', turn_id: 'turn', started_at_ms: 1, status: 'denied', risk_level: 'high', user_authorization: 'low',
    rationale: 'r', completed_at_ms: 2, decision_source: 'agent',
    action: { type: 'network_access', target: 'https://example.com', host: 'example.com', protocol: 'socks5_tcp', port: 443 },
  } }]);
  assert.ok(retry.requests.findIndex((r) => r.method === 'thread/approveGuardianDeniedAction')
    < retry.requests.findIndex((r) => r.method === 'turn/start'));

  const again = fixture(t);
  await run(again, { permissionMode: 'auto', approveAutoReviewDenials: ['deny-1'] });
  assert.ok(!again.requests.some((r) => r.method === 'thread/approveGuardianDeniedAction'));
  assert.match(again.messages.find((m) => m.kind === 'task_notification')!.summary, /已失效/);
  assert.ok(again.requests.some((r) => r.method === 'turn/start'));
});

test('streams stable text, reasoning, command output, file diffs and current context; completes once', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.notify('item/started', { item: { type: 'agentMessage', id: 'text', text: '' } });
    f.notify('item/agentMessage/delta', { itemId: 'text', delta: 'hello ' });
    f.notify('item/agentMessage/delta', { itemId: 'text', delta: 'world' });
    f.notify('item/completed', { item: { type: 'agentMessage', id: 'text', text: 'hello world' } });
    f.notify('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: 'thinking' });
    f.notify('item/started', { item: { type: 'commandExecution', id: 'cmd', command: 'pwd', status: 'inProgress' } });
    f.notify('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'output' });
    f.notify('item/completed', { item: { type: 'commandExecution', id: 'cmd', command: 'pwd', status: 'completed', aggregatedOutput: 'output', exitCode: 0 } });
    f.notify('item/completed', { item: { type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] } });
    f.notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 99999 }, last: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, modelContextWindow: 400000 } });
    f.completed();
    return true;
  });
  await run(f);
  assert.equal(f.messages.find((m) => m.id === 'text')!.content, 'hello world');
  assert.equal(f.messages.find((m) => m.id === 'reason')!.content, 'thinking');
  assert.equal(f.messages.find((m) => m.id === 'cmd_result')!.content, 'output');
  assert.equal(f.messages.find((m) => m.id === 'edit_0')!.toolInput.new_string, 'new');
  assert.equal(f.messages.find((m) => m.text === 'token_budget')!.tokenBudget.used, 120);
  assert.equal(f.messages.find((m) => m.text === 'token_budget')!.tokenBudget.total, 400000);
  assert.equal(f.messages.filter((m) => m.kind === 'complete').length, 1);
});

for (const allow of [false, true]) {
  test(`native approvals wait for a user decision (${allow}), replay by app ID, then retract`, async (t) => {
    const f = fixture(t, (r, f) => {
      if (r.method !== 'turn/start') return;
      f.reply(r, { turn: { id: 'turn' } });
      // Server IDs may collide with already-used client request IDs.
      f.send({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'native', command: 'npm test', reason: 'Run tests' } });
      return true;
    });
    const running = run(f);
    await tick();
    const [pending] = codexRuntime.permissions.listPending('app');
    assert.ok(pending);
    assert.equal(codexRuntime.permissions.listPending('native').length, 0);
    assert.equal(f.responses.length, 0);
    codexRuntime.permissions.resolve(pending.requestId, { allow });
    await tick();
    assert.deepEqual(f.responses.at(-1), { id: 1, result: { decision: allow ? 'accept' : 'decline' } });
    assert.equal(codexRuntime.permissions.listPending('app').length, 0);
    assert.ok(f.messages.some((m) => m.kind === 'permission_resolved'));
    f.completed();
    await running;
  });
}

test('native question IDs and answers pass through the existing question UI contract', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.send({ id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 'native', questions: [{ id: 'choice', question: 'Choose', header: 'Choice', options: [{ label: 'A', description: 'Option A' }], isOther: true }] } });
    return true;
  });
  const running = run(f);
  await tick();
  const [pending] = codexRuntime.permissions.listPending('app');
  assert.equal(pending.input.questions[0].id, 'choice');
  codexRuntime.permissions.resolve(pending.requestId, { allow: true, updatedInput: { answers: { choice: 'A' } } });
  await tick();
  assert.deepEqual(f.responses.at(-1), { id: 'q1', result: { answers: { choice: { answers: ['A'] } } } });
  f.completed();
  await running;
});

const formElicitation = { threadId: 'native', turnId: 'turn', serverName: 'deploy', mode: 'form', _meta: null, message: 'Pick a target',
  requestedSchema: { type: 'object', properties: { target: { type: 'string', enum: ['staging', 'prod'] } }, required: ['target'] } };
const toolApproval = { threadId: 'native', turnId: 'turn', serverName: 'github', mode: 'form', message: 'Allow github to run tool "create_issue"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_name: 'create_issue', tool_params: { title: 'Bug' } } };
for (const [label, params, allow, toolName, expected] of [
  ['form answer is accepted with only flat values', formElicitation, true, 'McpElicitation',
    { action: 'accept', content: { target: 'prod' }, _meta: null }],
  ['form refusal is a decline', formElicitation, false, 'McpElicitation', { action: 'decline', content: null, _meta: null }],
  ['tool approval runs the tool once', toolApproval, true, 'mcp__github__create_issue', { action: 'accept', content: null, _meta: null }],
  ['tool refusal cancels the call as the person', toolApproval, false, 'mcp__github__create_issue',
    { action: 'cancel', content: null, _meta: { codex_approval_cancellation_reason: 'user' } }],
] as const) {
  test(`MCP elicitation: ${label}`, async (t) => {
    const f = fixture(t, (r, f) => {
      if (r.method !== 'turn/start') return;
      f.reply(r, { turn: { id: 'turn' } });
      f.send({ id: 'e1', method: 'mcpServer/elicitation/request', params });
      return true;
    });
    const running = run(f);
    await tick();
    const [pending] = codexRuntime.permissions.listPending('app');
    assert.equal(pending.toolName, toolName);
    codexRuntime.permissions.resolve(pending.requestId, { allow,
      updatedInput: { content: { target: 'prod', nested: { not: 'allowed' }, list: [1] } } });
    await tick();
    assert.deepEqual(f.responses.at(-1), { id: 'e1', result: expected });
    assert.ok(!f.messages.some((m) => m.kind === 'task_notification'));
    f.completed();
    await running;
  });
}

for (const [label, method, params, offered, expected] of [
  ['network command', 'item/commandExecution/requestApproval',
    { threadId: 'native', command: 'curl x', networkApprovalContext: { host: 'x', protocol: 'https' } }, true, { decision: 'acceptForSession' }],
  ['plain command (not offered: allowed once)', 'item/commandExecution/requestApproval',
    { threadId: 'native', command: 'npm test' }, false, { decision: 'accept' }],
  ['file change', 'item/fileChange/requestApproval', { threadId: 'native', itemId: 'edit' }, true, { decision: 'acceptForSession' }],
  ['permission profile', 'item/permissions/requestApproval',
    { threadId: 'native', permissions: { network: { enabled: true } } }, true, { permissions: { network: { enabled: true } }, scope: 'session' }],
  ['MCP tool', 'mcpServer/elicitation/request', toolApproval, true, { action: 'accept', content: null, _meta: { persist: 'session' } }],
] as const) {
  test(`allow for this turn uses the CLI's session grant only where offered: ${label}`, async (t) => {
    const f = fixture(t, (r, f) => {
      if (r.method !== 'turn/start') return;
      f.reply(r, { turn: { id: 'turn' } });
      f.send({ id: 's1', method, params });
      return true;
    });
    const running = run(f);
    await tick();
    const [pending] = codexRuntime.permissions.listPending('app') as Array<{ requestId: string; context: AnyRecord }>;
    assert.equal(pending.context.allowSession, offered);
    codexRuntime.permissions.resolve(pending.requestId, { allow: true, scope: 'session' });
    await tick();
    assert.deepEqual(f.responses.at(-1), { id: 's1', result: expected });
    f.completed();
    await running;
  });
}

test('a message steered into the running turn uses turn/steer pinned to that turn', async (t) => {
  let finish!: () => void;
  const f = fixture(t, (r, f) => {
    if (r.method === 'turn/start') {
      f.reply(r, { turn: { id: 'turn', status: 'inProgress' } });
      finish = () => f.completed();
      return true;
    }
    if (r.method === 'turn/steer') {
      if (r.params!.expectedTurnId === 'turn') f.reply(r, { turnId: 'turn' });
      else f.send({ id: r.id, error: { code: -32600, message: 'turn mismatch' } });
      return true;
    }
  });
  assert.equal(await codexRuntime.steer('app', 'too early', {}), false);
  const running = run(f);
  await tick();
  assert.equal(await codexRuntime.steer('app', 'also check the tests', {}), true);
  assert.deepEqual(f.requests.find((r) => r.method === 'turn/steer')!.params, {
    threadId: 'native', expectedTurnId: 'turn', input: [{ type: 'text', text: 'also check the tests', text_elements: [] }],
  });
  finish();
  await running;
  assert.equal(await codexRuntime.steer('app', 'after the turn', {}), false);
});

test('MCP elicitation left open by a stopped run is cancelled, not declined', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.send({ id: 'e1', method: 'mcpServer/elicitation/request', params: toolApproval });
    return true;
  });
  const running = run(f);
  await tick();
  assert.equal(codexRuntime.permissions.listPending('app').length, 1);
  await codexRuntime.abort('app');
  await running;
  assert.deepEqual(f.responses.find((r) => r.id === 'e1')?.result,
    { action: 'cancel', content: null, _meta: { codex_approval_cancellation_reason: 'interrupted' } });
});

test('native compact uses its RPC and lifecycle, never sends a model prompt', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'thread/compact/start') return;
    f.reply(r, {});
    f.notify('turn/started', { turn: { id: 'compact-turn' } });
    f.notify('item/started', { item: { type: 'contextCompaction', id: 'compact-item' } });
    f.notify('item/completed', { item: { type: 'contextCompaction', id: 'compact-item' } });
    f.completed();
    return true;
  });
  await run(f, {}, true, '/compact');
  assert.ok(!f.requests.some((r) => r.method === 'turn/start'));
  const rows = f.messages.filter((m) => m.compact);
  assert.equal(new Set(rows.map((m) => m.id)).size, 1);
  assert.equal(rows.at(-1)!.compact.phase, 'done');
  assert.equal(f.messages.at(-1)!.success, true);
});

test('interrupt stops the native turn, clears pending approvals and leaves completion to the gateway', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.send({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'native', itemId: 'edit' } });
    return true;
  });
  const running = run(f);
  await tick();
  assert.equal(codexRuntime.permissions.listPending('app').length, 1);
  assert.equal(await codexRuntime.abort('app'), true);
  await running;
  assert.equal(codexRuntime.permissions.listPending('app').length, 0);
  assert.deepEqual(f.requests.find((r) => r.method === 'turn/interrupt')!.params, { threadId: 'native', turnId: 'turn' });
  assert.equal(f.messages.filter((m) => m.kind === 'complete').length, 0);
  assert.equal(f.child.kill.mock.callCount(), 1);
  assert.equal(await codexRuntime.abort('app'), false);
});

for (const reason of ['exit', 'pipe', 'turn', 'unsupported']) {
  test(`handles ${reason} failure without hanging or auto-approving`, async (t) => {
    const f = fixture(t, (r, f) => {
      if (r.method !== 'turn/start') return;
      f.reply(r, { turn: { id: 'turn' } });
      queueMicrotask(() => {
        if (reason === 'exit') f.child.emit('exit', 1, null);
        else if (reason === 'pipe') f.child.stdin.emit('error', new Error('broken pipe'));
        else if (reason === 'unsupported') {
          f.send({ id: 88, method: 'future/approval', params: { threadId: 'native' } });
          setImmediate(() => f.notify('turn/completed', { turn: { status: 'failed', error: { message: 'unsupported request' } } }));
        } else f.notify('turn/completed', { turn: { status: 'failed', error: { message: 'API error' } } });
      });
      return true;
    });
    await run(f);
    assert.equal(f.messages.filter((m) => m.kind === 'error').length, 1);
    assert.equal(f.messages.filter((m) => m.kind === 'complete').length, 1);
    assert.equal(f.messages.at(-1)!.success, false);
    if (reason === 'unsupported') assert.equal((f.responses.at(-1)!.error as AnyRecord).code, -32601);
  });
}

test('image-only messages use native localImage input with a nonempty text prompt', async (t) => {
  const f = fixture(t);
  const imagePath = path.join(process.cwd(), 'public/favicon.png');
  await run(f, { images: [{ path: imagePath, mimeType: 'image/png' }] }, false, '  ');
  assert.deepEqual(f.requests.find((r) => r.method === 'turn/start')!.params!.input, [
    { type: 'text', text: 'Please analyze the attached image(s).', text_elements: [] },
    { type: 'localImage', path: imagePath },
  ]);
});

test('transport rejects pending RPCs and lifecycle on a spawn failure', async (t) => {
  const f = fixture(t, (r, f) => { if (r.method === 'initialize') { queueMicrotask(() => f.child.emit('error', new Error('spawn failed'))); return true; } });
  await assert.rejects(codexAppServer.connect(), /spawn failed/);
  assert.equal(f.child.kill.mock.callCount(), 1);
});


test('server-resolved approvals retract without sending a second response', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.send({ id: 'remote', method: 'item/fileChange/requestApproval', params: { threadId: 'native', itemId: 'edit' } });
    f.notify('serverRequest/resolved', { requestId: 'remote' });
    return true;
  });
  const running = run(f);
  await tick();
  assert.equal(codexRuntime.permissions.listPending('app').length, 0);
  assert.equal(f.responses.length, 0);
  assert.ok(f.messages.some((message) => message.kind === 'permission_resolved'));
  f.completed();
  await running;
});

for (const allow of [true, false]) {
  test(`permission-profile approval grants only the requested scope (${allow})`, async (t) => {
    const requested = { network: { enabled: true }, fileSystem: null };
    const f = fixture(t, (r, f) => {
      if (r.method !== 'turn/start') return;
      f.reply(r, { turn: { id: 'turn' } });
      f.send({ id: 'profile', method: 'item/permissions/requestApproval', params: { threadId: 'native', permissions: requested } });
      return true;
    });
    const running = run(f);
    await tick();
    const [pending] = codexRuntime.permissions.listPending('app');
    codexRuntime.permissions.resolve(pending.requestId, { allow });
    await tick();
    assert.deepEqual(f.responses.at(-1)!.result, { permissions: allow ? { network: { enabled: true } } : {}, scope: 'turn' });
    f.completed();
    await running;
  });
}

test('text becomes visible before the native turn finishes and timers are cleaned up', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'turn/start') return;
    f.reply(r, { turn: { id: 'turn' } });
    f.notify('item/agentMessage/delta', { itemId: 'text', delta: 'still running' });
    return true;
  });
  const running = run(f);
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const snapshot = [...f.messages];
  f.completed();
  await running;
  assert.equal(snapshot.find((m) => m.id === 'text')!.content, 'still running');
  assert.ok(!snapshot.some((m) => m.kind === 'complete'));
});

test('compact RPC rejection marks the row failed and does not send a synthetic summary', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.method !== 'thread/compact/start') return;
    f.send({ id: r.id, error: { code: -32601, message: 'Method not supported by this CLI' } });
    return true;
  });
  await run(f, {}, true, '/compact');
  assert.equal(f.messages.filter((m) => m.compact).at(-1)!.compact.phase, 'failed');
  assert.equal(f.messages.at(-1)!.success, false);
  assert.ok(!f.requests.some((r) => r.method === 'turn/start'));
});

test('abort while model resolution is pending prevents starting the native process', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ctx = { ...context(), resolveResumeModel: async () => { await waiting; return 'gpt-6.1-sol'; } };
  const running = codexRuntime.run('hello', { sessionId: 'app' }, { send: () => {} }, ctx);
  assert.equal(await codexRuntime.abort('app'), true);
  release();
  await running;
  assert.equal(f.requests.length, 0);
});
