import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'steer-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type SteerCall = { provider: string; sessionId: string; command: string; options: Record<string, unknown> };

/**
 * A Codex session whose runtime takes steered messages while `accepts` holds.
 * `running` decides whether the gateway sees a run in progress at all.
 */
async function withGateway(
  { running, accepts }: { running: boolean; accepts: boolean },
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; steers: SteerCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const steers: SteerCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'codex', tempDirectory);
    if (running) {
      chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'codex', providerSessionId: 'native', connection: null, userId: 1 });
    }

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          steer: async (provider: string, sessionId: string, command: string, options: Record<string, unknown>) => {
            steers.push({ provider, sessionId, command, options });
            return accepts;
          },
        } as never,
      },
    );

    await runTest({ socket, steers });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const steerFrame = (content: string) => JSON.stringify({
  type: 'chat.steer', sessionId: SESSION_ID, messageId: 'm-1', content,
  // Not in the upload store, so it must never reach the runtime.
  options: { attachments: [{ path: '/etc/passwd', name: 'passwd' }] },
});

test('chat.steer hands the message to the running turn and acknowledges it by id', async () => {
  await withGateway({ running: true, accepts: true }, async ({ socket, steers }) => {
    socket.emit('message', steerFrame('also run the tests'));
    await settle();

    assert.deepEqual(steers, [{ provider: 'codex', sessionId: SESSION_ID, command: 'also run the tests',
      options: { images: [], files: [] } }]);
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'chat_steer_accepted');
    assert.equal(socket.frames[0].messageId, 'm-1');
  });
});

test('a steer with no running turn is refused by id without reaching the runtime', async () => {
  await withGateway({ running: false, accepts: true }, async ({ socket, steers }) => {
    socket.emit('message', steerFrame('too late'));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.messageId, 'm-1');
  });
});

test('a turn the runtime can no longer steer is refused the same way', async () => {
  await withGateway({ running: true, accepts: false }, async ({ socket, steers }) => {
    socket.emit('message', steerFrame('turn just ended'));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
  });
});

test('an empty steer is refused before the runtime', async () => {
  await withGateway({ running: true, accepts: true }, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, messageId: 'm-1', content: '  ' }));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'MESSAGE_REQUIRED');
  });
});
