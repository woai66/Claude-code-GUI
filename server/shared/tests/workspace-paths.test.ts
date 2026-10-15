import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'workspace-path-fixture-')));
const allowedRoot = path.join(fixtureRoot, 'allowed');
const outsideProject = path.join(fixtureRoot, 'outside', '中文项目');
await mkdir(allowedRoot);
await mkdir(outsideProject, { recursive: true });

const envKeys = ['WORKSPACES_ROOT', 'HOST', 'CLOUDCLI_DESKTOP_SESSION_SECRET'] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.WORKSPACES_ROOT = allowedRoot;
const { validateWorkspacePath } = await import('@/shared/utils.js');

beforeEach(() => {
  process.env.HOST = '0.0.0.0';
  delete process.env.CLOUDCLI_DESKTOP_SESSION_SECRET;
});
afterEach(() => {
  for (const key of ['HOST', 'CLOUDCLI_DESKTOP_SESSION_SECRET'] as const) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
after(async () => {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  assert.ok(fixtureRoot.startsWith(await realpath(testDirectory) + path.sep));
  await rm(fixtureRoot, { recursive: true, force: true });
});

function useLocalDesktop() {
  process.env.HOST = '127.0.0.1';
  process.env.CLOUDCLI_DESKTOP_SESSION_SECRET = 'a'.repeat(64);
}

test('a server deployment still confines project paths to the configured workspace', async () => {
  assert.equal((await validateWorkspacePath(allowedRoot)).valid, true);
  assert.equal((await validateWorkspacePath(path.join(allowedRoot, 'new', 'nested'))).valid, true);
  const outside = await validateWorkspacePath(outsideProject);
  assert.equal(outside.valid, false);
  assert.match(outside.error ?? '', /allowed workspace root/);
});

test('the private desktop accepts existing local projects outside the default workspace', async () => {
  useLocalDesktop();
  assert.deepEqual(await validateWorkspacePath(outsideProject), { valid: true, resolvedPath: outsideProject });
});

test('the private desktop accepts new nested project directories outside the workspace', async () => {
  useLocalDesktop();
  const newProject = path.join(outsideProject, 'new', 'nested');
  assert.deepEqual(await validateWorkspacePath(newProject), { valid: true, resolvedPath: newProject });
});

test('loopback binding alone does not enable desktop directory access', async () => {
  process.env.HOST = '127.0.0.1';
  assert.equal((await validateWorkspacePath(outsideProject)).valid, false);
  process.env.CLOUDCLI_DESKTOP_SESSION_SECRET = 'invalid';
  assert.equal((await validateWorkspacePath(outsideProject)).valid, false);
});

test('a desktop secret cannot relax paths on a network-bound backend', async () => {
  process.env.CLOUDCLI_DESKTOP_SESSION_SECRET = 'a'.repeat(64);
  assert.equal((await validateWorkspacePath(outsideProject)).valid, false);
});

test('the desktop rejects relative paths and filesystem roots', async () => {
  useLocalDesktop();
  assert.equal((await validateWorkspacePath('relative-project')).valid, false);
  assert.equal((await validateWorkspacePath('')).valid, false);
  assert.equal((await validateWorkspacePath(path.parse(outsideProject).root)).valid, false);
});

test('system directories remain blocked in the desktop, including Windows case variations', async () => {
  useLocalDesktop();
  const systemPaths = process.platform === 'win32'
    ? ['C:\\Windows', 'c:\\windows\\Temp', 'C:\\Program Files\\project']
    : ['/etc', '/etc/project', '/usr/local/project'];
  for (const systemPath of systemPaths) {
    assert.equal((await validateWorkspacePath(systemPath)).valid, false);
  }
});

test('resolves linked parent directories before checking new project paths', async () => {
  const linkPath = path.join(allowedRoot, 'outside-link');
  await symlink(outsideProject, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  const requestedProject = path.join(linkPath, 'new', 'nested');
  assert.equal((await validateWorkspacePath(requestedProject)).valid, false);
  useLocalDesktop();
  assert.deepEqual(await validateWorkspacePath(requestedProject), {
    valid: true, resolvedPath: path.join(outsideProject, 'new', 'nested'),
  });
});

test('a directory link cannot turn a system folder into a desktop workspace', async () => {
  useLocalDesktop();
  const systemPath = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
  const linkPath = path.join(fixtureRoot, 'system-link');
  await symlink(systemPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await validateWorkspacePath(linkPath)).valid, false);
  assert.equal((await validateWorkspacePath(path.join(linkPath, 'new', 'nested'))).valid, false);
});
