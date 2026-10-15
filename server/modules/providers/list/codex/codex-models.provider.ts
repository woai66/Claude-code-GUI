import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexModelsDependencies = {
  listModels?: (cwd?: string) => Promise<unknown[]>;
  configPath?: string;
};

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

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const configPath = this.dependencies.configPath
        ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
      const parsed = readObjectRecord(TOML.parse(await readFile(configPath, 'utf8')));
      return { model: readOptionalString(parsed?.model) ?? '' };
    } catch {
      return { model: '' };
    }
  }
}
