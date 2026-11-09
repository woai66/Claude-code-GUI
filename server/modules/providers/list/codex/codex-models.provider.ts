import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { readCodexRolloutLines } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError, findLastJsonlLine, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexModelsDependencies = {
  listModels?: (cwd?: string) => Promise<unknown[]>;
  configPath?: string;
  readSession?: (sessionId: string) => {
    provider: string; provider_session_id: string | null; jsonl_path: string | null;
  } | null;
};

function parseTurnSelection(line: string, filePath: string): ProviderCurrentActiveModel | null {
  if (!line.includes('"turn_context"')) return null;
  try {
    const entry = readObjectRecord(JSON.parse(line));
    if (entry?.type !== 'turn_context') return null;
    const payload = readObjectRecord(entry.payload);
    const collaboration = readObjectRecord(readObjectRecord(payload?.collaboration_mode)?.settings);
    const model = readOptionalString(payload?.model) ?? readOptionalString(collaboration?.model);
    if (!model) return null;
    return {
      model,
      effort: readOptionalString(payload?.effort) ?? readOptionalString(payload?.reasoning_effort)
        ?? readOptionalString(collaboration?.reasoning_effort) ?? null,
      source: 'session',
      revision: createHash('sha256').update(filePath).update(line).digest('hex'),
    };
  } catch {
    return null;
  }
}

// Read backwards: opening a long conversation must not load its entire transcript into memory.
function readLatestTurnSelection(filePath: string): Promise<ProviderCurrentActiveModel | null> {
  return findLastJsonlLine(filePath, (line) => parseTurnSelection(line, filePath));
}

/** Used by the provider registry to read Codex's model catalog and active configuration. */
export class CodexProviderModels implements IProviderModels {
  constructor(private readonly dependencies: CodexModelsDependencies = {}) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return { OPTIONS: [], DEFAULT: '' };
  }

  async refreshSupportedModels(cwd?: string): Promise<ProviderModelsDefinition> {
    const models = await (this.dependencies.listModels ?? codexAppServer.listModels)(cwd);
    const options: ProviderModelOption[] = [];
    const seen = new Set<string>();
    let defaultModel = '';
    for (const entry of models) {
      const model = readObjectRecord(entry);
      const value = readOptionalString(model?.model) ?? readOptionalString(model?.id);
      if (!value || model?.hidden === true || seen.has(value)) continue;
      seen.add(value);
      const levels = Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((entry) => {
          const effort = readObjectRecord(entry);
          const value = readOptionalString(effort?.reasoningEffort);
          return value ? [{ value, description: readOptionalString(effort?.description) }] : [];
        })
        : [];
      const defaultEffort = readOptionalString(model?.defaultReasoningEffort);
      options.push({
        value,
        label: readOptionalString(model?.displayName) ?? value,
        description: readOptionalString(model?.description),
        ...(levels.length ? {
          effort: {
            values: levels,
            ...(levels.some((level) => level.value === defaultEffort) ? { default: defaultEffort } : {}),
          },
        } : {}),
      });
      if (model?.isDefault === true) defaultModel ||= value;
    }
    if (!options.length) {
      throw new AppError('Codex returned no models. Check the Codex CLI login and configuration, then try again.', {
        code: 'EMPTY_MODEL_CATALOG', statusCode: 502,
      });
    }
    return { OPTIONS: options, DEFAULT: defaultModel || options[0].value };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId) {
      const session = this.dependencies.readSession
        ? this.dependencies.readSession(sessionId)
        : sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
      if (session?.provider === 'codex' && session.jsonl_path) {
        try {
          const selection = await readLatestTurnSelection(session.jsonl_path);
          if (selection) return selection;
          // A freshly forked paginated rollout may consist solely of a history_base reference.
          let inherited: ProviderCurrentActiveModel | null = null;
          for await (const line of readCodexRolloutLines(session.jsonl_path)) {
            inherited = parseTurnSelection(line, session.jsonl_path) ?? inherited;
          }
          if (inherited) return inherited;
        } catch {
          // An unavailable native transcript is not evidence that global config was used by this session.
        }
      }
      return { model: '', effort: null, source: 'session' };
    }
    try {
      const configPath = this.dependencies.configPath
        ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
      const parsed = readObjectRecord(TOML.parse(await readFile(configPath, 'utf8')));
      return { model: readOptionalString(parsed?.model) ?? '',
        effort: readOptionalString(parsed?.model_reasoning_effort) ?? null, source: 'config' };
    } catch {
      return { model: '' };
    }
  }
}
