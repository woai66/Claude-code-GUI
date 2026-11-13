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
