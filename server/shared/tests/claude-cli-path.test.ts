import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveClaudeCodeExecutablePath,
  type ResolveClaudeCodeExecutablePathDependencies,
} from '@/shared/claude-cli-path.js';

test('resolveClaudeCodeExecutablePath resolves the npm Claude wrapper to its native exe on Windows', () => {
  const wrapperDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${wrapperDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => '') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicit JavaScript launcher path unchanged', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
  });

  assert.equal(resolved, scriptPath);
});

test('resolveClaudeCodeExecutablePath can parse a wrapper file path containing letters r and n before claude.exe', () => {
  const wrapperPath = 'C:\\tools\\claude';
  const nativePath = 'C:\\tools\\custom\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const readFileSync = (() => `exec "$basedir/custom/bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"`) as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(wrapperPath, {
    platform: 'win32',
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicitly configured command when PATH lookup fails', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
  });

  assert.equal(resolved, 'claude');
});

test('resolveClaudeCodeExecutablePath refuses SDK fallback when no installed CLI exists', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  assert.throws(() => resolveClaudeCodeExecutablePath(undefined, {
    platform: 'win32',
    execFileSync,
    existsSync: () => false,
  }), /installed Claude Code CLI/);
});

test('resolveClaudeCodeExecutablePath reports unsupported wrappers instead of using the SDK runtime', () => {
  // An older global install ships cli.js and no bin/claude.exe, so nothing on
  // PATH maps to a native binary the SDK can spawn.
  const wrapperDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => 'exec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  assert.throws(() => resolveClaudeCodeExecutablePath(undefined, {
    platform: 'win32',
    execFileSync,
    existsSync: () => false,
    readFileSync,
  }), /installed Claude Code CLI/);
});

test('resolveClaudeCodeExecutablePath still resolves the native exe when both installs are on PATH', () => {
  const staleDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const nativeDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${nativeDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${staleDir}\\claude\r\n${nativeDir}\\claude\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => 'exec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(undefined, {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath resolves an absolute local entry on non-Windows platforms', () => {
  const resolved = resolveClaudeCodeExecutablePath(undefined, {
    platform: 'linux', env: { PATH: '.:/usr/local/bin:/usr/bin' },
    existsSync: (file) => file === '/usr/bin/claude',
  });

  assert.equal(resolved, '/usr/bin/claude');
});
