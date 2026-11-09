import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import readline from 'node:readline';

import { AppError } from '@/shared/utils.js';
import { resolveCodexExecutablePath } from '@/shared/index.js';

/** Duplex stdio transport for the user's installed Codex CLI. No shell or listening port is needed. */
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 3_000;

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type ConnectionOptions = {
  cwd?: string;
  onNotification?: (method: string, params: Record<string, any>) => void;
  onRequest?: (method: string, params: Record<string, any>, id: number | string) => Promise<unknown>;
};

/** Used by Codex branching to retain the native thread identity and authoritative rollout path. */
export type CodexThreadFork = { threadId: string; path: string };

/** Used by the Codex runtime and discovery/fork operations for one isolated CLI connection. */
export class CodexAppServerConnection {
  private child;
  private reader;
  private stderr = '';
  private nextId = 1;
  private ended = false;
  private serverRequests = new Set<number | string>();
  private pending = new Map<number, { reject: (error: Error) => void; finish: (reply: RpcMessage) => void }>();
  private finishClosed!: () => void;
  private failClosed!: (error: Error) => void;
  private childExited: Promise<void>;
  private closePromise: Promise<void> | null = null;
  readonly closed: Promise<void>;

  constructor(private options: ConnectionOptions = {}) {
    this.closed = new Promise((resolve, reject) => { this.finishClosed = resolve; this.failClosed = reject; });
    // Discovery callers only await RPCs; still observe process failures on the lifecycle promise.
    void this.closed.catch(() => {});
    this.child = spawn(resolveCodexExecutablePath(), ['app-server'], {
      env: process.env, cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.childExited = new Promise((resolve) => { this.child.once('exit', () => resolve()); });
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    this.child.stderr.on('error', () => {});
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', (line) => this.receive(line));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(
      `codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})${this.stderr ? `: ${this.stderr.trim().split('\n').at(-1)}` : ''}`,
    )));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('error', (error) => this.fail(error));
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    // Server requests have their own ID namespace; route by method before inspecting IDs.
    if (message.method) {
      const params = message.params ?? {};
      if (message.id !== undefined) {
        const id = message.id;
        this.serverRequests.add(id);
        let response: Promise<unknown>;
        try {
          // Register interactive requests before the next notification can resolve/cancel them.
          response = this.options.onRequest
            ? Promise.resolve(this.options.onRequest(message.method, params, id))
            : Promise.reject(new Error(`Unsupported Codex request: ${message.method}`));
        } catch (error) { response = Promise.reject(error); }
        void response.then(
          (result) => { if (this.serverRequests.delete(id)) this.write({ id, result }); },
          (error) => {
            if (this.serverRequests.delete(id)) this.write({ id, error: { code: -32601, message: String(error?.message ?? error) } });
          },
        );
      } else {
        if (message.method === 'serverRequest/resolved') this.serverRequests.delete(params.requestId);
        try { this.options.onNotification?.(message.method, params); } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    if (typeof message.id === 'number') this.pending.get(message.id)?.finish(message);
  }

  private write(message: unknown): void {
    if (this.ended) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.serverRequests.clear();
    this.failClosed(error);
    this.reader.close();
    this.child.kill();
  }

  async initialize(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'claude_gui', title: 'Claude GUI', version: '1' },
      // User-input questions and newer permission requests are opt-in protocol surfaces.
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }

  call(method: string, params: unknown): Promise<any> {
    if (this.ended) return Promise.reject(new Error('Codex app-server connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const rejectRequest = (error: Error) => { clearTimeout(timer); this.pending.delete(id); reject(error); };
      const timer = setTimeout(() => rejectRequest(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
        code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504,
      })), REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        reject: rejectRequest,
        finish: (reply) => {
          clearTimeout(timer);
          this.pending.delete(id);
          if (reply.error) reject(new AppError(reply.error.message || `Codex rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR', statusCode: 502, details: { method, rpcCode: reply.error.code },
          }));
          else resolve(reply.result);
        },
      });
      this.write({ id, method, params });
    });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server connection closed.'));
    this.pending.clear();
    this.serverRequests.clear();
    this.reader.close();
    this.child.kill();
    this.finishClosed();
  }

  /**
   * Used by the Codex runtime before releasing a conversation for another turn.
   *
   * The CLI keeps a cross-process thread writer lock until its app-server
   * process exits. Waiting here prevents the next turn from starting while the
   * previous writer is still shutting down.
   */
  closeAndWait(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    this.closePromise ??= this.performCloseAndWait(timeoutMs);
    return this.closePromise;
  }

  private async performCloseAndWait(timeoutMs: number): Promise<void> {
    if (!this.ended) this.close();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.childExited.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      throw new AppError(`Codex app-server did not exit within ${timeoutMs}ms.`, {
        code: 'CODEX_APP_SERVER_CLOSE_TIMEOUT',
        statusCode: 504,
      });
    }
    this.finishClosed();
  }
}

async function withAppServer<T>(run: (call: CodexAppServerConnection['call']) => Promise<T>, cwd?: string): Promise<T> {
  const connection = await codexAppServer.connect({ cwd });
  try { return await run(connection.call.bind(connection)); } finally { connection.close(); }
}

/** Used by Codex runtime, session branching and discovery to access the installed CLI. */
export const codexAppServer = {
  async connect(options: ConnectionOptions = {}): Promise<CodexAppServerConnection> {
    const connection = new CodexAppServerConnection(options);
    try { await connection.initialize(); return connection; } catch (error) { connection.close(); throw error; }
  },
  /** Reads every visible model page from the same Codex binary used by the chat runtime. */
  async listModels(cwd?: string): Promise<unknown[]> {
    return withAppServer(async (call) => {
      const models: unknown[] = [];
      const visitedCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await call('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }) as { data?: unknown; nextCursor?: unknown } | undefined;
        if (!Array.isArray(result?.data)) {
          throw new AppError('Codex returned an invalid model list.', {
            code: 'INVALID_MODEL_CATALOG', statusCode: 502,
          });
        }
        models.push(...result.data);
        cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (cursor && (visitedCursors.has(cursor) || visitedCursors.size >= 50)) {
          throw new AppError('Codex model list pagination did not finish.', {
            code: 'INVALID_MODEL_CATALOG', statusCode: 502,
          });
        }
        if (cursor) visitedCursors.add(cursor);
      } while (cursor);
      return models;
    }, cwd);
  },
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },
};
