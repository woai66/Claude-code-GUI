import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      getFirstUser: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      getFirstUser: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      getFirstUser: () => ({ id: 1, username: 'alice' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('desktop session creates a local user once and issues a normal token', async () => {
  let user: { id: number; username: string } | undefined;
  let createdUsers = 0;
  const service = createAuthService(createDependencies({
    desktopSessionSecret: 'a'.repeat(64),
    hashPassword: async (password) => {
      assert.equal(password.length, 64);
      return 'random-password-hash';
    },
    users: {
      hasUsers: () => Boolean(user),
      getFirstUser: () => user,
      createUser: (username, passwordHash) => {
        assert.equal(passwordHash, 'random-password-hash');
        createdUsers += 1;
        user = { id: 1, username };
        return user;
      },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
  }));

  const first = await service.getDesktopSession('a'.repeat(64), '127.0.0.1');
  const second = await service.getDesktopSession('a'.repeat(64), '::ffff:127.0.0.1');
  assert.deepEqual(first.user, { id: 1, username: 'local-user' });
  assert.equal(first.token, 'signed-token');
  assert.deepEqual(second.user, first.user);
  assert.equal(createdUsers, 1);
});

test('desktop session preserves the existing account without changing its password', async () => {
  const service = createAuthService(createDependencies({
    desktopSessionSecret: 'a'.repeat(64),
    users: {
      hasUsers: () => true,
      getFirstUser: () => ({ id: 8, username: 'existing-user' }),
      createUser: () => { throw new Error('Must reuse the existing user'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    hashPassword: async () => { throw new Error('Must preserve the password'); },
  }));

  const session = await service.getDesktopSession('a'.repeat(64), '::1');
  assert.deepEqual(session.user, { id: 8, username: 'existing-user' });
});

test('desktop session refuses missing credentials, wrong credentials and remote clients', async () => {
  const disabled = createAuthService(createDependencies());
  await assert.rejects(disabled.getDesktopSession('a'.repeat(64), '127.0.0.1'),
    (error: unknown) => error instanceof AppError && error.statusCode === 404);

  const service = createAuthService(createDependencies({ desktopSessionSecret: 'a'.repeat(64) }));
  for (const [secret, address] of [
    [undefined, '127.0.0.1'], ['b'.repeat(64), '127.0.0.1'],
    ['a'.repeat(64), '192.168.1.20'], ['a'.repeat(64), undefined],
  ]) {
    await assert.rejects(service.getDesktopSession(secret, address),
      (error: unknown) => error instanceof AppError && error.statusCode === 403);
  }
});
