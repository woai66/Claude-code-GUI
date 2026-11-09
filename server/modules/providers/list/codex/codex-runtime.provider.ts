import { randomUUID } from 'node:crypto';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors,
  createCompleteMessage, createNormalizedMessage, readCodexContextUsage,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';
import type { ProviderPermissionDecision } from '@/shared/types.js';

import { codexAppServer } from './codex-app-server.client.js';
import { unifiedDiffToTexts } from './codex-sessions.provider.js';

// Each run owns its process so a failed connection cannot take other sessions down.
type ActiveCodexSession = {
  connection: Awaited<ReturnType<typeof codexAppServer.connect>> | null;
  threadId: string | null;
  turnId: string | null;
  workingDirectory: string;
  aborted: boolean;
  cancel: () => void;
};
type PendingApproval = {
  session: ActiveCodexSession;
  nativeRequestId: number | string;
  sessionId: string;
  toolName: string;
  input: AnyRecord;
  receivedAt: Date;
  allowSession: boolean;
  resolve: (decision: ProviderPermissionDecision) => void;
};
const activeSessions = new Map<string, ActiveCodexSession>();
const pendingApprovals = new Map<string, PendingApproval>();
const WRITER_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1_000];

function sendMessage(writer: ProviderRuntimeWriter, data: unknown): void {
  writer.send(writer.isWebSocketWriter ? data : JSON.stringify(data));
}

// `auto` is Codex Desktop's "Approve for me": requests still go out on demand, but
// Codex's auto_review subagent rules on them first. The reviewer is always sent so a
// thread last run under another client's reviewer cannot leak into this run.
function permissions(permissionMode: string): { sandbox: string; approvalPolicy: string; approvalsReviewer: string } {
  if (permissionMode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
  if (permissionMode === 'acceptEdits') return { sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' };
  if (permissionMode === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
}

const AUTO_REVIEW_FAILURES: Record<string, string> = { denied: '拒绝', timedOut: '超时', aborted: '中止' };
// A reviewer Codex could not reach (rate limits, outages) comes back as a denial with this
// rationale, also sent as a guardianWarning. Nothing was judged, so it is reported once, as a
// failure, and not offered for approval: the retry would go through the same reviewer.
const AUTO_REVIEW_UNAVAILABLE_PREFIX = 'Automatic approval review failed';

function describeAutoReviewAction(action: AnyRecord | undefined): string {
  switch (action?.type) {
    case 'command': return action.command;
    case 'execve': return [action.program, ...(action.argv || []).slice(1)].join(' ');
    case 'applyPatch': return `修改 ${(action.files || []).join(', ')}`;
    case 'networkAccess': return `访问网络 ${action.host}`;
    case 'mcpToolCall': return `MCP ${action.server}/${action.toolName}`;
    case 'requestPermissions': return action.reason || '申请额外权限';
    default: return action?.type || '未知操作';
  }
}

// Auto-review denials the person may still approve, per native thread. Like Codex's own
// TUI, only the latest few are kept; they live in memory, so a restart forgets them.
const deniedAutoReviews = new Map<string, Map<string, AnyRecord>>();
const MAX_DENIED_AUTO_REVIEWS = 10;
// writeStdin and requestPermissions carry nested paths and profiles whose core form
// differs from the app-server one, so only these actions can be handed back verbatim.
const APPROVABLE_AUTO_REVIEW_ACTIONS = new Set(['command', 'execve', 'applyPatch', 'networkAccess', 'mcpToolCall']);

const toSnakeCase = (value: string) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// `thread/approveGuardianDeniedAction` takes the core GuardianAssessmentEvent, which is the
// snake_case form of the app-server notification (the conversion Codex's TUI performs).
function toGuardianAssessmentEvent(params: AnyRecord): AnyRecord | null {
  const action = params.action;
  if (!params.reviewId || !APPROVABLE_AUTO_REVIEW_ACTIONS.has(action?.type)) return null;
  const coreAction = Object.fromEntries(Object.entries(action).map(([key, value]) => [toSnakeCase(key),
    ['type', 'source', 'protocol'].includes(key) && typeof value === 'string' ? toSnakeCase(value) : value]));
  const optional = { risk_level: params.review?.riskLevel, user_authorization: params.review?.userAuthorization,
    rationale: params.review?.rationale, completed_at_ms: params.completedAtMs, decision_source: params.decisionSource };
  return {
    id: params.reviewId, turn_id: params.turnId || '', started_at_ms: params.startedAtMs || 0, status: 'denied',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null && value !== undefined)),
    action: coreAction,
  };
}

function rememberDeniedAutoReview(threadId: string, event: AnyRecord): void {
  const reviews = deniedAutoReviews.get(threadId) ?? new Map<string, AnyRecord>();
  reviews.set(event.id, event);
  for (const id of reviews.keys()) {
    if (reviews.size <= MAX_DENIED_AUTO_REVIEWS) break;
    reviews.delete(id);
  }
  deniedAutoReviews.set(threadId, reviews);
}

// The client's McpElicitation panel answers form and URL requests from MCP servers.
const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

// Codex also routes MCP tool-call approvals through elicitation: a field-less request
// tagged `mcp_tool_call` is a yes/no approval and is shown like any other tool approval.
function isMcpToolApproval(params: AnyRecord): boolean {
  const properties = params.requestedSchema?.properties;
  const fieldless = !properties || (typeof properties === 'object' && !Object.keys(properties).length);
  return params._meta?.codex_approval_kind === 'mcp_tool_call' && params.mode !== 'url' && fieldless;
}

// The answer comes from the browser; keep only the flat values an MCP form can hold.
function readElicitationContent(updatedInput: unknown): Record<string, string | number | boolean | string[]> {
  const content = (updatedInput as AnyRecord | undefined)?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  return Object.fromEntries(Object.entries(content as AnyRecord).filter(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'))));
}

// Same input items for a new turn and for a message steered into a running one.
function buildTurnInput(command: string, files: unknown, images: unknown, workingDirectory: string): AnyRecord[] {
  const prompt = appendFilesInputTag(command, files);
  const normalizedImages = normalizeImageDescriptors(images);
  const inputItems = buildCodexInputItems(prompt.trim() || (normalizedImages.length ? 'Please analyze the attached image(s).' : prompt), normalizedImages, workingDirectory);
  return inputItems.map((item) => item.type === 'local_image'
    ? { type: 'localImage', path: item.path }
    : { type: 'text', text: item.text, text_elements: [] });
}

// Whether the CLI accepts "approve for the rest of the session" for this request. Plain
// commands get it only when the CLI lists it, which by default it does for network access.
function offersSessionApproval(method: string, params: AnyRecord, isToolApproval: boolean): boolean {
  if (isToolApproval) {
    const persist = params._meta?.persist;
    return persist === 'session' || (Array.isArray(persist) && persist.includes('session'));
  }
  if (method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval') return true;
  if (method !== 'item/commandExecution/requestApproval' || params.kind === 'writeStdin') return false;
  return Array.isArray(params.availableDecisions)
    ? params.availableDecisions.includes('acceptForSession')
    : Boolean(params.networkApprovalContext);
}

function isActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has an active writer/i.test(message);
}

async function resumeCodexThread(
  connection: NonNullable<ActiveCodexSession['connection']>,
  threadId: string,
  params: AnyRecord,
): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await connection.call('thread/resume', { threadId, excludeTurns: true, ...params });
    } catch (error) {
      if (!isActiveWriterError(error)) throw error;
      const delay = WRITER_LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new Error(
          '该 Codex 会话正在被另一个 Codex 客户端写入，请先结束那个窗口中的任务或关闭该会话，然后重试。',
          { cause: error },
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function queryCodex(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
  const { sessionId, sessionSummary, effort, speed, images, files } = options;
  const nativeId = context.resolveProviderSessionId(sessionId);
  const workingDirectory = options.cwd || options.projectPath || process.cwd();
  const isCompact = /^\/compact(?:\s|$)/.test(command.trim());
  let finishTurn!: (error?: Error) => void;
  const turnDone = new Promise<void>((resolve, reject) => { finishTurn = (error) => error ? reject(error) : resolve(); });
  // The CLI can finish before turn/start's response arrives.
  void turnDone.catch(() => {});
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  const session: ActiveCodexSession = { connection: null, threadId: nativeId, turnId: null, workingDirectory, aborted: false, cancel };
  const key = () => sessionId || session.threadId || '';
  if (key()) activeSessions.set(key(), session);
  const sessionIdentity = () => session.threadId || sessionId || null;
  const emit = (fields: AnyRecord) => sendMessage(writer, createNormalizedMessage({
    ...fields, kind: fields.kind, provider: 'codex', sessionId: sessionIdentity(),
  }));
  const normalize = (raw: AnyRecord) => {
    for (const message of context.normalizeMessage(raw, sessionIdentity())) sendMessage(writer, message);
  };
  const items = new Map<string, AnyRecord>();
  const reasoningParts = new Map<string, Map<number, string>>();
  let compactionId: string | null = null;
  let compactionCompleted = false;
  let failure: Error | null = null;

  const renderItem = (item: AnyRecord, completed: boolean) => {
    const status = item.status === 'inProgress' ? 'in_progress' : item.status;
    const raw: AnyRecord = { type: 'item', itemId: item.id, status, timestamp: item.timestamp };
    switch (item.type) {
      case 'agentMessage':
      case 'plan':
        if (item.text) normalize({ ...raw, itemType: 'agent_message', message: { content: item.text } });
        return;
      case 'reasoning': {
        const text = (item.summary?.length ? item.summary : item.content || []).join('\n\n');
        if (text) normalize({ ...raw, itemType: 'reasoning', message: { content: text } });
        return;
      }
      case 'commandExecution':
        normalize({ ...raw, itemType: 'command_execution', command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode });
        return;
      case 'fileChange':
        for (const [index, change] of (item.changes || []).entries()) {
          const { oldText, newText } = unifiedDiffToTexts(change.diff || '');
          emit({ id: `${item.id}_${index}`, kind: 'tool_use', toolId: `${item.id}_${index}`, timestamp: item.timestamp,
            toolName: change.kind?.type === 'add' ? 'Write' : 'Edit', status,
            toolInput: { file_path: change.path, old_string: oldText, new_string: newText } });
        }
        return;
      case 'mcpToolCall':
        normalize({ ...raw, itemType: 'mcp_tool_call', server: item.server, tool: item.tool,
          arguments: item.arguments, result: item.result, error: item.error });
        return;
      case 'webSearch':
        normalize({ ...raw, itemType: 'web_search', query: item.query || item.action?.query || '' });
        return;
      case 'contextCompaction':
        compactionId = isCompact ? compactionId || item.id : item.id;
        compactionCompleted = completed;
        emit({ id: compactionId, kind: 'text', role: 'assistant', content: '', compact: { phase: completed ? 'done' : 'running' } });
        return;
      case 'userMessage': return;
      default:
        normalize({ ...raw, itemType: item.type, item });
    }
  };

  // Batch cumulative snapshots; native deltas can arrive faster than the UI can paint them.
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const dirtyItems = new Set<string>();
  const flushProgress = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const id of dirtyItems) { const item = items.get(id); if (item) renderItem(item, false); }
    dirtyItems.clear();
  };
  const queueProgress = (item: AnyRecord) => {
    dirtyItems.add(item.id);
    flushTimer ??= setTimeout(flushProgress, 80);
  };

  const onNotification = (method: string, params: AnyRecord) => {
    if (session.aborted || (params.threadId && params.threadId !== session.threadId)) return;
    if (method === 'turn/started') session.turnId = params.turn?.id || session.turnId;
    if (method === 'turn/completed') {
      flushProgress();
      session.turnId = params.turn?.id || session.turnId;
      if (params.turn?.status === 'failed') finishTurn(new Error(params.turn.error?.message || 'Codex turn failed.'));
      else if (params.turn?.status === 'interrupted') finishTurn(new Error('Codex turn was interrupted.'));
      else finishTurn();
    } else if (method === 'error' && !params.willRetry) {
      finishTurn(new Error(params.error?.message || 'Codex app-server reported an error.'));
    } else if (method === 'thread/status/changed' && params.status?.type === 'systemError') {
      finishTurn(new Error('Codex thread entered an error state.'));
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item?.id) return;
      flushProgress();
      item.timestamp = items.get(item.id)?.timestamp || new Date().toISOString();
      items.set(item.id, item);
      renderItem(item, method === 'item/completed');
    } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      const item = items.get(params.itemId) || { id: params.itemId, type: 'agentMessage', text: '', timestamp: new Date().toISOString() };
      item.text = (item.text || '') + (params.delta || '');
      items.set(item.id, item);
      queueProgress(item);
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const item = items.get(params.itemId) || { id: params.itemId, type: 'reasoning', timestamp: new Date().toISOString() };
      // Prefer summaries when both public summary and raw reasoning streams are present.
      const summary = method === 'item/reasoning/summaryTextDelta';
      const partKey = `${item.id}:${summary ? 'summary' : 'content'}`;
      const parts = reasoningParts.get(partKey) || new Map<number, string>();
      const index = params.summaryIndex ?? params.contentIndex ?? 0;
      parts.set(index, (parts.get(index) || '') + (params.delta || ''));
      reasoningParts.set(partKey, parts);
      item[summary ? 'summary' : 'content'] = [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);
      items.set(item.id, item);
      queueProgress(item);
    } else if (method === 'item/commandExecution/outputDelta') {
      const item = items.get(params.itemId);
      if (item) { item.aggregatedOutput = (item.aggregatedOutput || '') + (params.delta || ''); queueProgress(item); }
    } else if (method === 'turn/plan/updated') {
      emit({ id: `${params.turnId}_plan`, kind: 'tool_use', toolName: 'TodoWrite', toolId: `${params.turnId}_plan`,
        toolInput: { todos: (params.plan || []).map((step: AnyRecord) => ({ content: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) } });
    } else if (method === 'item/autoApprovalReview/completed') {
      // Approvals stay silent; a rejected action is otherwise only visible through the model's reply.
      const outcome = AUTO_REVIEW_FAILURES[params.review?.status];
      if (outcome && String(params.review.rationale ?? '').startsWith(AUTO_REVIEW_UNAVAILABLE_PREFIX)) {
        emit({ kind: 'task_notification', status: 'warning',
          summary: `Codex 自动审核没能完成，「${describeAutoReviewAction(params.action)}」没有执行：${params.review.rationale}。`
            + '审核模型恢复前，可先切到“默认模式”手动审批。' });
      } else if (outcome) {
        const risk = params.review.riskLevel ? `（风险：${params.review.riskLevel}）` : '';
        const rationale = params.review.rationale ? `：${params.review.rationale}` : '';
        // Only a denial can be overridden; a timeout or abort was never ruled on.
        const event = params.review.status === 'denied' ? toGuardianAssessmentEvent(params) : null;
        if (event && session.threadId) rememberDeniedAutoReview(session.threadId, event);
        emit({ kind: 'task_notification', status: 'warning',
          summary: `Codex 自动审批${outcome}${risk}「${describeAutoReviewAction(params.action)}」${rationale}`,
          ...(event ? { autoReviewDenialId: event.id } : {}) });
      }
    } else if (method === 'guardianWarning' && params.message && !params.message.startsWith(AUTO_REVIEW_UNAVAILABLE_PREFIX)) {
      emit({ kind: 'task_notification', status: 'warning', summary: params.message });
    } else if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.last) {
      emit({ kind: 'status', text: 'token_budget', tokenBudget: readCodexContextUsage(params.tokenUsage) });
    } else if (method === 'serverRequest/resolved') {
      for (const approval of pendingApprovals.values()) {
        if (approval.session === session && approval.nativeRequestId === params.requestId) approval.resolve({ allow: false });
      }
    }
  };

  const onRequest = async (method: string, params: AnyRecord, nativeRequestId: number | string): Promise<unknown> => {
    if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (params.threadId && params.threadId !== session.threadId) throw new Error('Codex request belongs to another thread.');
    const isQuestion = method === 'item/tool/requestUserInput';
    const isCommand = method === 'item/commandExecution/requestApproval';
    const isFile = method === 'item/fileChange/requestApproval';
    const isPermissions = method === 'item/permissions/requestApproval';
    const isElicitation = method === 'mcpServer/elicitation/request';
    if (!isQuestion && !isCommand && !isFile && !isPermissions && !isElicitation) {
      emit({ kind: 'task_notification', status: 'warning',
        summary: `Unsupported Codex interaction: ${method}. Use the official CLI for this interaction.` });
      throw new Error(`Unsupported Codex client request: ${method}`);
    }
    const isToolApproval = isElicitation && isMcpToolApproval(params);
    const requestId = `codex:${randomUUID()}`;
    let toolName = isQuestion ? 'AskUserQuestion' : isCommand ? 'Bash' : isFile ? 'Edit' : 'CodexPermissions';
    let input: AnyRecord = params;
    if (isQuestion) {
      input = { questions: (params.questions || []).map((q: AnyRecord) => ({
        id: q.id, question: q.question, header: q.header, options: q.options || [], multiSelect: false,
        isSecret: q.isSecret, allowOther: q.isOther || !q.options?.length,
      })) };
    } else if (isToolApproval) {
      const tool = params._meta.tool_name;
      toolName = tool ? `mcp__${params.serverName}__${tool}` : `mcp__${params.serverName}`;
      input = { message: params.message, ...(params._meta.tool_params ? { arguments: params._meta.tool_params } : {}) };
    } else if (isElicitation) {
      toolName = MCP_ELICITATION_TOOL_NAME;
      // `openai/form` variants carry a JSON schema too; the panel draws whatever fields it can read.
      input = { serverName: params.serverName, message: params.message, mode: params.mode === 'url' ? 'url' : 'form',
        requestedSchema: params.requestedSchema, url: params.url, elicitationId: params.elicitationId };
    }
    const allowSession = offersSessionApproval(method, params, isToolApproval);
    const decision = await new Promise<ProviderPermissionDecision>((resolve) => {
      let resolved = false;
      const settle = (value: ProviderPermissionDecision) => {
        if (resolved) return;
        resolved = true;
        pendingApprovals.delete(requestId);
        emit({ kind: 'permission_resolved', requestId });
        resolve(value);
      };
      if (session.aborted) { settle({ allow: false }); return; }
      pendingApprovals.set(requestId, { session, nativeRequestId, sessionId: key(), toolName, input, receivedAt: new Date(), allowSession, resolve: settle });
      emit({ kind: 'permission_request', requestId, toolName, input, context: { provider: 'codex', method, allowSession, allowOnce: !params.availableDecisions || params.availableDecisions.includes('accept') } });
    });
    // A session grant lives in this run's app-server process, which closes when the run ends.
    const forSession = decision.allow && decision.scope === 'session' && allowSession;
    if (isQuestion) {
      const supplied = (decision.updatedInput as AnyRecord | undefined)?.answers || {};
      return { answers: Object.fromEntries((params.questions || []).map((q: AnyRecord) => {
        const value = decision.allow ? supplied[q.id] ?? supplied[q.question] : undefined;
        return [q.id, { answers: typeof value === 'string' && value ? [value] : [] }];
      })) };
    }
    if (isElicitation) {
      // A stopped run leaves the request unanswered rather than declined by the person.
      if (session.aborted) {
        return { action: 'cancel', content: null,
          _meta: isToolApproval ? { codex_approval_cancellation_reason: 'interrupted' } : null };
      }
      // Codex's own UI cancels, rather than declines, a tool call the person refuses.
      if (isToolApproval) {
        return decision.allow
          ? { action: 'accept', content: null, _meta: forSession ? { persist: 'session' } : null }
          : { action: 'cancel', content: null, _meta: { codex_approval_cancellation_reason: 'user' } };
      }
      if (!decision.allow) return { action: 'decline', content: null, _meta: null };
      // Accepting a URL request is consent to open the page; the server learns the rest from it.
      return { action: 'accept', content: params.mode === 'url' ? null : readElicitationContent(decision.updatedInput), _meta: null };
    }
    if (isPermissions) {
      const requested = params.permissions || {};
      return { permissions: decision.allow ? {
        ...(requested.network ? { network: requested.network } : {}),
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
      } : {}, scope: forSession ? 'session' : 'turn' };
    }
    // GUI grants never write persistent CLI policies (exec-policy amendments, config).
    if (forSession) return { decision: 'acceptForSession' };
    const approved = decision.allow && (!params.availableDecisions || params.availableDecisions.includes('accept'));
    return { decision: approved ? 'accept' : 'decline' };
  };

  try {
    if (isCompact && (!nativeId || command.trim() !== '/compact')) {
      throw new Error(nativeId ? 'Codex /compact does not accept extra instructions here.' : 'Start a Codex conversation before using /compact.');
    }
    const model = await context.resolveResumeModel(sessionId, options.model);
    if (session.aborted) return;
    session.connection = await codexAppServer.connect({ cwd: workingDirectory, onNotification, onRequest });
    if (session.aborted) return;
    const permissionOptions = permissions(options.permissionMode || 'default');
    const config: AnyRecord = {};
    if (effort && effort !== 'default') config.model_reasoning_effort = effort;
    if (speed === 'fast' || speed === 'standard') config['features.fast_mode'] = speed === 'fast';
    const threadParams = {
      cwd: workingDirectory, ...permissionOptions, ...(model ? { model } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(speed === 'fast' || speed === 'standard' ? { serviceTier: speed === 'fast' ? 'fast' : 'default' } : {}),
    };
    const thread = nativeId
      ? await resumeCodexThread(session.connection, nativeId, threadParams)
      : await session.connection.call('thread/start', threadParams);
    if (!thread?.thread?.id) throw new Error('Codex returned no thread identity.');
    session.threadId = thread.thread.id;
    if (key()) activeSessions.set(key(), session);
    if (!nativeId) {
      writer.setSessionId?.(session.threadId!);
      emit({ kind: 'session_created', newSessionId: session.threadId });
    }
    if (session.aborted) return;
    // A retry the person approved: record the approval before the turn that retries it,
    // as Codex's TUI does; the retried action still goes through auto-review.
    for (const reviewId of Array.isArray(options.approveAutoReviewDenials) ? options.approveAutoReviewDenials : []) {
      const event = deniedAutoReviews.get(session.threadId!)?.get(reviewId);
      if (!event) {
        emit({ kind: 'task_notification', status: 'warning',
          summary: '这条自动审批拒绝记录已失效（服务重启过或已批准过），本轮不会带上放行授权。' });
        continue;
      }
      await session.connection.call('thread/approveGuardianDeniedAction', { threadId: session.threadId, event });
      deniedAutoReviews.get(session.threadId!)?.delete(reviewId);
    }
    if (isCompact) {
      compactionId = `codex_compact_${randomUUID()}`;
      emit({ id: compactionId, kind: 'text', role: 'assistant', content: '', compact: { phase: 'running' } });
      await session.connection.call('thread/compact/start', { threadId: session.threadId });
    } else {
      const result = await session.connection.call('turn/start', {
        threadId: session.threadId, input: buildTurnInput(command, files, images, workingDirectory), ...(effort && effort !== 'default' ? { effort } : {}),
      });
      session.turnId = result.turn?.id || session.turnId;
      if (result.turn?.status === 'failed') throw new Error(result.turn.error?.message || 'Codex turn failed.');
    }
    await Promise.race([turnDone, cancelled, session.connection.closed.then(() => { throw new Error('Codex disconnected before completing the turn.'); })]);
    if (isCompact && !session.aborted && !compactionCompleted) throw new Error('Codex did not confirm context compaction.');
  } catch (error) {
    if (!session.aborted) {
      failure = error instanceof Error ? error : new Error(String(error));
      emit({ kind: 'error', content: failure.message });
      notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: sessionId || sessionIdentity(), sessionName: sessionSummary, error: failure });
    }
  } finally {
    flushProgress();
    if (compactionId && !compactionCompleted) {
      emit({ id: compactionId, kind: 'text', role: 'assistant', content: '', compact: {
        phase: 'failed',
      } });
    }
    for (const approval of pendingApprovals.values()) {
      if (approval.session === session) approval.resolve({ allow: false });
    }
    try {
      await session.connection?.closeAndWait();
    } catch (error) {
      const closeFailure = error instanceof Error ? error : new Error(String(error));
      if (!failure) {
        failure = closeFailure;
        emit({ kind: 'error', content: closeFailure.message });
        notifyRunFailed({
          userId: writer.userId || null,
          provider: 'codex',
          sessionId: sessionId || sessionIdentity(),
          sessionName: sessionSummary,
          error: closeFailure,
        });
      } else {
        console.error('[Codex] app-server cleanup failed', { sessionId, error: closeFailure.message });
      }
    }
    if (activeSessions.get(key()) === session) activeSessions.delete(key());
    // The gateway owns the aborted completion; all other exits emit exactly one terminal event.
    if (!session.aborted) {
      sendMessage(writer, createCompleteMessage({ provider: 'codex', sessionId: sessionIdentity(), exitCode: failure ? 1 : 0 }));
      if (!failure) notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: sessionId || sessionIdentity(), sessionName: sessionSummary, stopReason: 'completed' });
    }
  }
}

// Codex takes the message into the running turn; `expectedTurnId` makes a turn that has
// already finished (or a compaction, which cannot be steered) refuse it instead.
async function steerCodexSession(sessionId: string, command: string, options: AnyRecord): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session || session.aborted || !session.connection || !session.threadId || !session.turnId) return false;
  try {
    await session.connection.call('turn/steer', {
      threadId: session.threadId, expectedTurnId: session.turnId,
      input: buildTurnInput(command, options.files, options.images, session.workingDirectory),
    });
    return true;
  } catch {
    // The caller keeps the message for the next turn, so a refusal loses nothing.
    return false;
  }
}

async function abortCodexSession(sessionId: string): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session || session.aborted) return false;
  session.aborted = true;
  // Settle outstanding questions before interrupting the CLI.
  for (const approval of pendingApprovals.values()) {
    if (approval.session === session) approval.resolve({ allow: false });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (session.connection && session.turnId) await Promise.race([
      session.connection.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
  } catch { /* A closed connection already stopped the run. */ }
  finally {
    clearTimeout(timer);
    session.cancel();
    try { await session.connection?.closeAndWait(); } catch { /* The runtime reports any cleanup timeout with the turn. */ }
  }
  return true;
}

/** Used by CodexProvider for native streaming turns, interruption and interactive approvals. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  steer: steerCodexSession,
  permissions: {
    resolve(requestId: string, decision: ProviderPermissionDecision) { pendingApprovals.get(requestId)?.resolve(decision); },
    listPending(sessionId: string) {
      return [...pendingApprovals.entries()].filter(([, request]) => request.sessionId === sessionId).map(([requestId, request]) => ({
        requestId, toolName: request.toolName, input: request.input, sessionId, receivedAt: request.receivedAt,
        context: { provider: 'codex', allowSession: request.allowSession, allowOnce: !request.input.availableDecisions || request.input.availableDecisions.includes('accept') },
      }));
    },
  },
};
