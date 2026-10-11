import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { findProviderModelOption, resolveClaudeCodeExecutablePath } from '@/shared/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Enable workflow orchestration at xhigh effort.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};

/** Used by the Claude runtime to validate effort for both CLI aliases and canonical session model IDs. */
export function resolveClaudeEffort(
  model: string | undefined,
  effort: string | undefined,
  models: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): string | undefined {
  const option = findProviderModelOption(models.OPTIONS, model ?? '');
  return effort && effort !== 'default' && option?.effort?.values.some((level) => level.value === effort)
    ? effort
    : undefined;
}
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

type ClaudeModelsDependencies = {
  query?: typeof query;
  resolveExecutable?: typeof resolveClaudeCodeExecutablePath;
  now?: () => number;
  timeoutMs?: number;
};

const MODEL_CACHE_TTL_MS = 5 * 60_000;
const FALLBACK_CACHE_TTL_MS = 15_000;

function buildClaudeModelsDefinition(models: ModelInfo[]): ProviderModelsDefinition {
  const options = models.map((model): ProviderModelOption => {
    // Older SDK declarations omit resolvedModel even when the installed CLI returns it.
    const resolvedModel = (model as ModelInfo & { resolvedModel?: string }).resolvedModel;
    const levels = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [];
    return {
      value: model.value,
      label: model.displayName,
      description: model.description,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(levels.length ? {
        effort: {
          values: [
            ...levels.map((value) => ({ value })),
            ...(levels.includes('xhigh') ? [ULTRACODE_EFFORT_OPTION] : []),
          ],
        },
      } : {}),
    };
  });
  if (!options.length) {
    throw new Error('Claude returned an empty model catalogue.');
  }
  return { OPTIONS: options, DEFAULT: options.some((option) => option.value === 'default') ? 'default' : options[0].value };
}

/** Used by the provider registry to discover account and workspace model capabilities without creating chats. */
export class ClaudeProviderModels implements IProviderModels {
  private readonly cache = new Map<string, { models: ProviderModelsDefinition; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<ProviderModelsDefinition>>();

  constructor(private readonly dependencies: ClaudeModelsDependencies = {}) {}

  async getSupportedModels(cwd?: string): Promise<ProviderModelsDefinition> {
    const workspace = path.resolve(cwd || process.cwd());
    const executable = (this.dependencies.resolveExecutable ?? resolveClaudeCodeExecutablePath)();
    const key = `${executable ?? 'bundled'}:${workspace}`;
    const now = this.dependencies.now ?? Date.now;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.models;
    }
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    const request = this.discoverModels(workspace, executable).then(({ models, ttl }) => {
      const availableModels = models === CLAUDE_PREDEFINED_MODELS ? cached?.models ?? models : models;
      this.cache.set(key, { models: availableModels, expiresAt: now() + ttl });
      return availableModels;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async discoverModels(cwd: string, executable?: string) {
    let releaseInput = () => {};
    const inputFinished = new Promise<void>((resolve) => { releaseInput = resolve; });
    const noMessages: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await inputFinished;
            return { done: true, value: undefined };
          },
        };
      },
    };
    let instance: ReturnType<typeof query> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      instance = (this.dependencies.query ?? query)({
        prompt: noMessages,
        options: {
          cwd,
          pathToClaudeCodeExecutable: executable,
          persistSession: false,
          settingSources: ['project', 'user', 'local'],
          settings: '{"disableAllHooks":true,"syncClaudeAiPlugins":false}',
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
        },
      });
      // Keep stdin open for the handshake, but never send a model request or persist a transcript.
      const models = await Promise.race([
        instance.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Claude model discovery timed out.')),
            this.dependencies.timeoutMs ?? 15_000,
          );
        }),
      ]);
      return { models: buildClaudeModelsDefinition(models), ttl: MODEL_CACHE_TTL_MS };
    } catch {
      return { models: CLAUDE_PREDEFINED_MODELS, ttl: FALLBACK_CACHE_TTL_MS };
    } finally {
      clearTimeout(timer);
      instance?.close();
      releaseInput();
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
