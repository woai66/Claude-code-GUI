import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import spawn from 'cross-spawn';

import { resolveCursorCliLaunch } from '@/shared/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

const EMPTY_CURSOR_MODELS: ProviderModelsDefinition = { OPTIONS: [], DEFAULT: 'auto' };

type CursorModelsDependencies = {
  runCli?: (cwd?: string) => Promise<string>;
};

function readCursorModelsOutput(cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const launch = resolveCursorCliLaunch();
    const child = spawn(launch?.command ?? 'cursor-agent', [...(launch?.args ?? []), '--list-models'], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        // Windows CLI shims launch PowerShell children; stop that whole tree on timeout.
        if (process.platform === 'win32' && child.pid) {
          const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore',
          });
          cleanup.on('error', () => { child.kill(); });
        } else {
          child.kill();
        }
      }
      reject(new AppError(message, { code: 'CURSOR_MODEL_DISCOVERY_FAILED', statusCode: 502 }));
    };
    const timer = setTimeout(() => fail('Cursor model discovery timed out. Check the CLI login and try again.'), 20_000);
    child.on('error', () => fail('Cannot start Cursor CLI. Install cursor-agent and sign in, then try again.'));
    child.stdout?.on('error', () => fail('Could not read the Cursor model list.'));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 1_048_576) fail('Cursor returned an unexpectedly large model list.');
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail('Cursor CLI could not list models. Check its login and network connection, then try again.');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(output);
    });
  });
}

const CURSOR_CHATS_ROOT = path.join(os.homedir(), '.cursor', 'chats');

const resolveCursorSessionStorePath = async (sessionId: string): Promise<string | null> => {
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, 'cursor session id');

  try {
    const workspaceEntries = await readdir(CURSOR_CHATS_ROOT, { withFileTypes: true });
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) {
        continue;
      }

      const storeDbPath = path.join(CURSOR_CHATS_ROOT, workspaceEntry.name, safeSessionId, 'store.db');
      try {
        await access(storeDbPath);
        return storeDbPath;
      } catch {
        // Keep scanning sibling workspaces until the matching session directory is found.
      }
    }
  } catch {
    return null;
  }

  return null;
};

/** Used by the provider registry to discover Cursor CLI models and read session metadata. */
export class CursorProviderModels implements IProviderModels {
  constructor(private readonly dependencies: CursorModelsDependencies = {}) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return EMPTY_CURSOR_MODELS;
  }

  async refreshSupportedModels(cwd?: string): Promise<ProviderModelsDefinition> {
    const output = await (this.dependencies.runCli ?? readCursorModelsOutput)(cwd);
    const options: ProviderModelOption[] = [];
    const seen = new Set<string>();
    let defaultModel = '';
    for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
      const match = line.trim().match(/^([a-zA-Z0-9][\w.:[\]/,=-]*)\s+-\s+(.+)$/);
      if (!match || seen.has(match[1])) continue;
      const [, value, displayName] = match;
      const isDefault = /\s*\(default\)\s*$/i.test(displayName);
      const label = displayName.replace(/\s*\((?:default|current)\)\s*$/i, '').trim();
      options.push({ value, label: label || value });
      seen.add(value);
      if (isDefault) defaultModel ||= value;
    }
    if (!options.length) {
      throw new AppError('Cursor returned no models. Sign in to Cursor CLI and try again.', {
        code: 'EMPTY_MODEL_CATALOG', statusCode: 502,
      });
    }
    return {
      OPTIONS: options,
      DEFAULT: defaultModel || (seen.has('auto') ? 'auto' : options[0].value),
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(EMPTY_CURSOR_MODELS);
    }

    try {
      const storeDbPath = await resolveCursorSessionStorePath(sessionId);
      if (!storeDbPath) {
        return buildDefaultProviderCurrentActiveModel(EMPTY_CURSOR_MODELS);
      }

      const { default: Database } = await import('better-sqlite3');
      const db = new Database(storeDbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`SELECT value FROM meta WHERE key='0' LIMIT 1;`).get() as {
          value?: Buffer | string;
        } | undefined;
        const metadataText = Buffer.isBuffer(row?.value)
          ? row.value.toString('utf8')
          : typeof row?.value === 'string' && row.value.trim()
            ? Buffer.from(row.value.trim(), 'hex').toString('utf8')
            : '';
        if (!metadataText) {
          return buildDefaultProviderCurrentActiveModel(EMPTY_CURSOR_MODELS);
        }

        const metadata = JSON.parse(metadataText) as { lastUsedModel?: string };
        if (typeof metadata.lastUsedModel === 'string' && metadata.lastUsedModel.trim()) {
          return {
            model: metadata.lastUsedModel.trim(),
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the CLI default when Cursor metadata cannot be read.
    }

    return buildDefaultProviderCurrentActiveModel(EMPTY_CURSOR_MODELS);
  }
}
