import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveCodexExecutablePath, resolveCursorCliLaunch } from '@/shared/index.js';

const win = path.win32;
const hasFiles = (...files: string[]) => {
  const existing = new Set(files.map((file) => win.normalize(file).toLowerCase()));
  return (file: string) => existing.has(win.normalize(file).toLowerCase());
};

test('Cursor honors a custom PATH installation and sorts version dates and build times', () => {
  const root = 'D:/tools/Cursor Agent';
  const versions = ['2026.9.30-aaaa', '2026.10.1-bbbb', '2026.10.1-12-01-01-cccc', '2026.10.2-dddd'];
  const newest = win.join(root, 'versions', versions[2]);
  const launch = resolveCursorCliLaunch({
    platform: 'win32', env: { Path: `.;relative;"${root}";C:/other-install` },
    exists: hasFiles(
      win.join(root, 'cursor-agent.cmd'),
      ...versions.map((version) => win.join(root, 'versions', version, 'node.exe')),
      ...versions.slice(0, -1).map((version) => win.join(root, 'versions', version, 'index.js')),
    ),
    readDirectories: (directory) => {
      assert.equal(directory, win.join(root, 'versions'));
      return [...versions, 'invalid-version'];
    },
  });
  assert.deepEqual(launch, { command: win.join(newest, 'node.exe'), args: [win.join(newest, 'index.js')] });
});

test('Cursor falls back to LOCALAPPDATA and supports a direct Node entry', () => {
  const root = 'D:/用户/App Data/cursor-agent';
  assert.deepEqual(resolveCursorCliLaunch({
    platform: 'win32', env: { LOCALAPPDATA: 'D:/用户/App Data' },
    exists: hasFiles(win.join(root, 'node.exe'), win.join(root, 'index.js')),
  }), { command: win.join(root, 'node.exe'), args: [win.join(root, 'index.js')] });
});

test('Cursor keeps PATH priority when an earlier install has an unknown wrapper layout', () => {
  assert.equal(resolveCursorCliLaunch({
    platform: 'win32', env: { PATH: 'C:/first;C:/second', LOCALAPPDATA: 'C:/local' },
    exists: hasFiles('C:/first/cursor-agent.cmd', 'C:/second/cursor-agent.exe'),
    readDirectories: () => [],
  }), null);
});

const bundledLauncher = 'C:/app/node_modules/@openai/codex/bin/codex.js';
const bundledBinary = 'C:/app/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const installedLauncher = 'C:/npm/node_modules/@openai/codex/bin/codex.js';
const installedBinary = 'C:/npm/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';

test('Codex skips npm-run bundled shims and uses the user CLI before a later native installation', () => {
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: bundledLauncher,
    env: { PATH: 'C:/app/node_modules/.bin;C:/npm;C:/desktop', APPDATA: 'C:/empty' },
    exists: hasFiles(bundledLauncher, bundledBinary, installedLauncher, installedBinary,
      'C:/app/node_modules/.bin/codex.cmd', 'C:/npm/codex.cmd', 'C:/desktop/codex.exe'),
  }), win.normalize(installedBinary));
});

test('Codex uses a native PATH install without requiring the bundled package', () => {
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: null,
    env: { PATH: '.;relative;C:/native' }, exists: hasFiles('C:/native/codex.exe'),
  }), win.normalize('C:/native/codex.exe'));
});

test('Codex resolves nested npm platform packages before a later native installation', () => {
  const nestedBinary = 'C:/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: null,
    env: { PATH: 'C:/npm;C:/desktop' },
    exists: hasFiles('C:/npm/codex.cmd', installedLauncher, nestedBinary, 'C:/desktop/codex.exe'),
  }), win.normalize(nestedBinary));
});

test('Codex skips an app-local npm shim after bundled executables have been excluded', () => {
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: bundledLauncher,
    env: { PATH: 'C:/app/node_modules/.bin;C:/native' },
    exists: hasFiles(bundledLauncher, 'C:/app/node_modules/.bin/codex.cmd', 'C:/native/codex.exe'),
  }), win.normalize('C:/native/codex.exe'));
});

test('Codex reports a broken first installation instead of silently choosing another version', () => {
  assert.throws(() => resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: null,
    env: { PATH: 'C:/broken;C:/desktop' },
    exists: hasFiles('C:/broken/codex.cmd', 'C:/desktop/codex.exe'),
  }), /C:\\broken\\codex.cmd/);
});

test('Codex refuses the bundled binary when no user CLI exists', () => {
  assert.throws(() => resolveCodexExecutablePath({
    platform: 'win32', arch: 'x64', bundledCodexLauncher: bundledLauncher,
    env: { PATH: 'C:/empty', APPDATA: 'C:/empty' }, exists: hasFiles(bundledBinary),
  }), /installed Codex CLI/);
});

test('Codex supports a global npm install outside PATH and the legacy ARM64 package layout', () => {
  const binary = 'C:/global/npm/node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/bin/codex.exe';
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', arch: 'arm64', bundledCodexLauncher: null, env: { APPDATA: 'C:/global' },
    exists: hasFiles('C:/global/npm/codex.ps1', 'C:/global/npm/node_modules/@openai/codex/bin/codex.js', binary),
  }), win.normalize(binary));
});

test('non-Windows hosts keep normal CLI lookup', () => {
  assert.equal(resolveCursorCliLaunch({ platform: 'linux' }), null);
  assert.equal(resolveCodexExecutablePath({
    platform: 'linux', env: { PATH: '.:/usr/local/bin:/usr/bin' }, exists: (file) => file === '/usr/bin/codex',
  }), '/usr/bin/codex');
});

test('Codex honors an explicit executable and fails instead of choosing another installation', () => {
  assert.equal(resolveCodexExecutablePath({
    platform: 'win32', env: { CODEX_CLI_PATH: 'D:/custom/codex.exe' }, exists: hasFiles('D:/custom/codex.exe'),
  }), 'D:/custom/codex.exe');
  assert.throws(() => resolveCodexExecutablePath({
    platform: 'win32', env: { CODEX_CLI_PATH: 'D:/missing/codex.exe', PATH: 'C:/native' },
    exists: hasFiles('C:/native/codex.exe'),
  }), /CODEX_CLI_PATH/);
});
