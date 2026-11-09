import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const CLAUDE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CLAUDE_WRAPPER_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

export type ResolveClaudeCodeExecutablePathDependencies = {
  execFileSync?: typeof execFileSync;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
  readFileSync?: typeof fs.readFileSync;
  env?: NodeJS.ProcessEnv;
};

function getPathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveClaudeWrapperBinary(
  wrapperPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const directCandidate = pathApi.resolve(pathApi.dirname(wrapperPath), ...CLAUDE_WRAPPER_SEGMENTS);

  if (deps.existsSync(directCandidate)) {
    return directCandidate;
  }
  const scriptCandidate = pathApi.resolve(
    pathApi.dirname(wrapperPath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js',
  );
  if (deps.existsSync(scriptCandidate)) return scriptCandidate;

  let content: string;
  try {
    content = deps.readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }

  const matches = content.matchAll(/["']([^"'\\\r\n]*claude\.exe)["']/gi);
  for (const match of matches) {
    const rawTarget = match[1]
      .replace(/^\$basedir[\\/]/i, '')
      .replace(/^%dp0%[\\/]/i, '')
      .replace(/^%~dp0[\\/]/i, '');
    const normalizedTarget = rawTarget.replace(/[\\/]/g, pathApi.sep);
    const candidate = pathApi.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : pathApi.resolve(pathApi.dirname(wrapperPath), normalizedTarget);

    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Windows has no PATH lookup to fall back on: the SDK spawns the path we hand
 * it with a raw `child_process.spawn`, which never consults PATH or PATHEXT.
 * A bare `claude` therefore fails with "native binary not found at claude"
 * even on a machine where the CLI is installed and on PATH. A missing default
 * must fail explicitly rather than letting the SDK use its bundled runtime.
 */
function resolveWindowsClaudeExecutablePath(
  configuredPath: string,
  configuredExplicitly: boolean,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | undefined {
  const pathApi = getPathApi(deps.platform);
  const extension = pathApi.extname(configuredPath).toLowerCase();
  const explicitPath = isPathLike(configuredPath) || pathApi.isAbsolute(configuredPath);
  // An explicit CLAUDE_CLI_PATH is the operator's call even when we cannot
  // verify it; the default must resolve to an installed executable.
  const unresolved = configuredExplicitly ? configuredPath : undefined;

  if (CLAUDE_SCRIPT_EXTENSIONS.has(extension)) {
    return configuredPath;
  }

  if (explicitPath && extension === '.exe') {
    return configuredPath;
  }

  if (explicitPath) {
    return resolveClaudeWrapperBinary(configuredPath, deps) ?? unresolved;
  }

  try {
    const stdout = deps.execFileSync('where.exe', [configuredPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (pathApi.extname(candidate).toLowerCase() === '.exe') {
        return candidate;
      }
    }

    for (const candidate of candidates) {
      const resolved = resolveClaudeWrapperBinary(candidate, deps);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // The native installer may have updated the user PATH after Electron started.
  }

  if (configuredExplicitly) return unresolved;
  const native = pathApi.join(deps.env.USERPROFILE ?? os.homedir(), '.local', 'bin', 'claude.exe');
  return deps.existsSync(native) ? native : unresolved;
}

/**
 * Resolves the Claude Code executable to hand the SDK.
 *
 * Throws when no local executable can be found, preventing implicit SDK fallback.
 */
export function resolveClaudeCodeExecutablePath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies = {},
): string | undefined {
  const deps: Required<ResolveClaudeCodeExecutablePathDependencies> = {
    execFileSync: dependencies.execFileSync ?? execFileSync,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    platform: dependencies.platform ?? process.platform,
    readFileSync: dependencies.readFileSync ?? fs.readFileSync,
    env: dependencies.env ?? process.env,
  };

  const configuredExplicitly = Boolean(stripWrappingQuotes(configuredPath || ''));
  const normalizedPath = stripWrappingQuotes(configuredPath || DEFAULT_CLAUDE_COMMAND);
  if (deps.platform !== 'win32') {
    if (isPathLike(normalizedPath)) return normalizedPath;
    const candidate = (deps.env.PATH ?? '').split(':').filter((entry) => path.posix.isAbsolute(entry))
      .map((entry) => path.posix.join(entry, normalizedPath)).find(deps.existsSync);
    if (candidate) return candidate;
  } else {
    const resolved = resolveWindowsClaudeExecutablePath(normalizedPath, configuredExplicitly, deps);
    if (resolved) return resolved;
  }

  throw new AppError(
    'Cannot find your installed Claude Code CLI. Install Claude Code or set CLAUDE_CLI_PATH to its executable.',
    { code: 'CLAUDE_CLI_NOT_FOUND', statusCode: 503 },
  );
}
