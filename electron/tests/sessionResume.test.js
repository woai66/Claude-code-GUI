import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { registerSessionResumeHandler } from '../sessionResume.js';

const SESSION_ID = 'b7eb0d3f-93b9-4e53-9682-346f67098bc8';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-gui-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "中文 O'Brien $project [folder]; code");
  await fs.mkdir(projectPath);
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'fixture');
  const launches = [];
  const trustedEvent = {};
  let handler;
  registerSessionResumeHandler({
    ipcMain: { handle: (channel, callback) => {
      assert.equal(channel, 'claude-gui:resume-claude-session');
      handler = callback;
    } },
    assertLocalPage: (event) => { if (event !== trustedEvent) throw new Error('Untrusted page'); },
    platform: 'win32',
    spawnProcess: (executable, args, options) => {
      const child = new EventEmitter();
      launches.push({ executable, args, options, child });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
    ...overrides,
  });
  return {
    root, projectPath, file, launches,
    resume: (id = SESSION_ID, directory = projectPath, event = trustedEvent) => handler(event, id, directory),
  };
}

test('launches an independent persistent PowerShell in the requested project', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.resume(), { success: true });
  assert.equal(f.launches.length, 1);
  const launch = f.launches[0];
  assert.equal(path.basename(launch.executable).toLowerCase(), 'powershell.exe');
  assert.deepEqual(launch.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(launch.options.cwd, f.projectPath);
  assert.equal(launch.options.stdio, 'ignore');
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.shell, undefined);
  const launcher = Buffer.from(launch.args[4], 'base64').toString('utf16le');
  assert.match(launcher, /Start-Process .* -WindowStyle Normal/);
  assert.match(launcher, /'-NoLogo', '-NoExit', '-EncodedCommand'/);
});

test('rejects session IDs that could be names, flags or commands without spawning', async (t) => {
  const f = await fixture(t);
  for (const id of [undefined, null, '', 'gui-id', '--help', `${SESSION_ID}; whoami`, `${SESSION_ID}\n`, {}]) {
    // undefined must bypass the fixture's convenient default argument.
    const result = id === undefined ? await f.resume(null) : await f.resume(id);
    assert.deepEqual(result, { error: 'invalid-session' });
  }
  assert.equal(f.launches.length, 0);
});

test('rejects missing, relative and non-directory paths without spawning', async (t) => {
  const f = await fixture(t);
  for (const directory of [null, '', 'relative', f.file, path.join(f.root, 'missing'), `${f.projectPath}\0`]) {
    assert.deepEqual(await f.resume(SESSION_ID, directory), { error: 'directory-unavailable' });
  }
  assert.equal(f.launches.length, 0);
});

test('rejects untrusted pages and unsupported platforms before spawning', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.resume(SESSION_ID, f.projectPath, {}), /Untrusted page/);
  assert.equal(f.launches.length, 0);
  const unsupported = await fixture(t, { platform: 'linux' });
  assert.deepEqual(await unsupported.resume(), { error: 'unsupported' });
  assert.equal(unsupported.launches.length, 0);
});

test('reports synchronous and asynchronous PowerShell startup failures', async (t) => {
  const failedSync = await fixture(t, { spawnProcess: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await failedSync.resume(), { error: 'launch-failed' });
  const failedAsync = await fixture(t, { spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('EACCES')));
    return child;
  } });
  assert.deepEqual(await failedAsync.resume(), { error: 'launch-failed' });
  const failedLauncher = await fixture(t, { spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  } });
  assert.deepEqual(await failedLauncher.resume(), { error: 'launch-failed' });
});

test('the generated script restores the exact ID and literal directory in real PowerShell', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const f = await fixture(t);
  await f.resume();
  const launch = f.launches[0];
  const resultFile = path.join(f.root, 'result.json').replaceAll("'", "''");
  const launcher = Buffer.from(launch.args[4], 'base64').toString('utf16le');
  const encodedCommand = launcher.match(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/)[1];
  const command = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  // 用本地函数替代 Claude，仅记录参数，完全不调用订阅或真实会话。
  const probe = `function claude {
    $result = @{ cwd = (Get-Location).Path; arguments = @($args) }
    [IO.File]::WriteAllText('${resultFile}', ($result | ConvertTo-Json -Compress))
  }\n${command}`;
  const child = spawnSync(launch.executable, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64'),
  ], { cwd: f.root, windowsHide: true, timeout: 15000, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(await fs.readFile(path.join(f.root, 'result.json'), 'utf8'));
  assert.equal(result.cwd, f.projectPath);
  assert.deepEqual(result.arguments, ['--resume', SESSION_ID]);

  // 在真正的 PowerShell 中验证外层参数解析，替代 Start-Process 以免单测弹出窗口。
  const launcherResultPath = path.join(f.root, 'launcher.json').replaceAll("'", "''");
  const launcherProbe = `function Start-Process {
    [CmdletBinding()] param($FilePath, $WorkingDirectory, [string[]] $ArgumentList, $WindowStyle)
    $result = @{ file = $FilePath; directory = $WorkingDirectory; arguments = $ArgumentList; style = $WindowStyle }
    [IO.File]::WriteAllText('${launcherResultPath}', ($result | ConvertTo-Json -Compress))
  }\n${launcher}`;
  const dispatched = spawnSync(launch.executable, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcherProbe, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.error?.message);
  const launcherResult = JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8'));
  assert.equal(launcherResult.file, launch.executable);
  assert.equal(launcherResult.directory, f.projectPath);
  assert.equal(launcherResult.style, 'Normal');
  assert.deepEqual(launcherResult.arguments, ['-NoLogo', '-NoExit', '-EncodedCommand', encodedCommand]);
});
