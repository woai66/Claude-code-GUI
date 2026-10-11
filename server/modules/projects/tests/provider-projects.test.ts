import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  getProjectSessionsPage,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { parseOptionalProviderFilter } from '@/shared/index.js';

test('project agent filters find older sessions and count each scoped page', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'provider-projects-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const mixed = path.join(directory, 'mixed');
    for (let index = 0; index < 25; index += 1) {
      sessionsDb.createSession(`codex-${index}`, 'codex', mixed, 'Codex',
        '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z');
    }
    sessionsDb.createSession('claude-a', 'claude', mixed, 'Claude',
      '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z');
    sessionsDb.createSession('claude-b', 'claude', mixed, 'Claude',
      '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z');
    sessionsDb.createSession('cursor-only', 'cursor', path.join(directory, 'cursor'), 'Cursor');
    const projects = await getProjectsWithSessions({ provider: 'claude', sessionsLimit: 1, skipSynchronization: true });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].sessions[0].provider, 'claude');
    assert.deepEqual(projects[0].sessionMeta, { total: 2, hasMore: true });
    const second = await getProjectSessionsPage(projects[0].projectId, { provider: 'claude', limit: 1, offset: 1 });
    assert.notEqual(second.sessions[0].id, projects[0].sessions[0].id);
    assert.deepEqual(second.sessionMeta, { total: 2, hasMore: false });
    assert.equal((await getProjectsWithSessions({ provider: 'opencode', skipSynchronization: true })).length, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider query validation accepts all agents and rejects ambiguous or unknown input', () => {
  for (const input of [undefined, '', 'all']) {
    assert.equal(parseOptionalProviderFilter(input), undefined);
  }
  assert.equal(parseOptionalProviderFilter('claude'), 'claude');
  assert.equal(parseOptionalProviderFilter('codex'), 'codex');
  for (const input of [['claude', 'codex'], 'unknown', 42]) {
    assert.throws(() => parseOptionalProviderFilter(input), { code: 'INVALID_PROVIDER', statusCode: 400 });
  }
});
