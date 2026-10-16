import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { CursorModelFamily, CursorModelVariant, Project, ProjectSession, ProviderModelOption, QuickSettingsTab, SlashCommand } from '@/shared/types';

//----------------- PROVIDER MODEL LOOKUP ------------

/** Matches a CLI selector or canonical ID; exact and named choices take precedence over Default. */
export function findProviderModelOption(options: ProviderModelOption[], model: string): ProviderModelOption | null {
  return options.find((option) => option.value === model)
    ?? options.find((option) => option.value !== 'default' && option.resolvedModel === model)
    ?? options.find((option) => option.resolvedModel === model)
    ?? null;
}

/** Groups CLI-discovered Cursor variants for both pickers, preserving custom and unfamiliar IDs verbatim. */
export function groupCursorModels(options: ProviderModelOption[]): CursorModelFamily[] {
  const families = new Map<string, CursorModelFamily>();
  for (const option of options) {
    let base = option.value;
    const variant: CursorModelVariant = { option, effort: 'default', context: '', thinking: false, fast: false };
    const label = option.label.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    let recognized = false;
    const parameterized = option.isCustom ? null : base.match(/^([^\[\]]+)\[([^\[\]]+)\]$/);
    const parameters = parameterized?.[2].split(',').map((pair) => pair.trim().split('='));
    const validParameters = parameters?.every(([key, value, extra]) => !extra && (
      (key === 'context' && /^\d+(?:\.\d+)?[km]$/i.test(value ?? ''))
      || (key === 'effort' && /^(none|minimal|low|medium|high|xhigh|max)$/.test(value ?? ''))
      || ((key === 'fast' || key === 'thinking') && /^(true|false)$/.test(value ?? ''))
    ));
    if (parameterized && validParameters) {
      base = parameterized[1];
      recognized = true;
      for (const [key, value] of parameters!) {
        if (key === 'context') variant.context = value.toLowerCase();
        if (key === 'effort') variant.effort = value;
        if (key === 'thinking') variant.thinking = value === 'true';
        if (key === 'fast') variant.fast = value === 'true';
      }
    }
    if (!option.isCustom && !base.includes('[')) {
      // Strip only known parameter suffixes; version numbers and model names remain intact.
      const suffix = /-(extra-high|xhigh|minimal|none|low|medium|high|max|thinking|fast|\d+(?:\.\d+)?[km])$/i;
      let match: RegExpMatchArray | null;
      while ((match = base.match(suffix))) {
        const token = match[1].toLowerCase();
        base = base.slice(0, -match[0].length);
        recognized = true;
        if (token === 'fast') variant.fast = true;
        else if (token === 'thinking') variant.thinking = true;
        else if (/^\d/.test(token)) variant.context = token;
        else variant.effort = token === 'extra-high' ? 'xhigh' : token;
      }
      const context = label.match(/\b(\d+(?:\.\d+)?[KM])\b/i)?.[1];
      variant.context ||= context?.toLowerCase() ?? '';
    }
    const key = option.isCustom ? `custom:${option.value}` : base.includes('[') ? `raw:${option.value}` : base;
    const familyLabel = recognized
      ? label.replace(/\b(?:No Thinking|Extra High|Thinking|Fast|Minimal|None|Low|Medium|High|Max|\d+(?:\.\d+)?[KM])\b/gi, '')
        .replace(/\s+/g, ' ').trim()
      : label;
    const family = families.get(key);
    if (family) family.variants.push(variant);
    else families.set(key, { value: key, label: familyLabel || label, variants: [variant] });
  }
  return [...families.values()].map((family) => {
    // Some Fast labels omit a context that every other variant in that family shares.
    const contexts = [...new Set(family.variants.map((variant) => variant.context).filter(Boolean))];
    if (contexts.length === 1) {
      for (const variant of family.variants) variant.context ||= contexts[0];
    }
    return family.variants.length === 1
      ? { ...family, label: family.variants[0].option.label }
      : family;
  });
}

/** Picks a real Cursor variant, preserving other settings where available; never constructs model IDs. */
export function selectCursorVariant(
  family: CursorModelFamily,
  currentModel: string,
  change: Partial<Omit<CursorModelVariant, 'option'>> = {},
): CursorModelVariant {
  const current = family.variants.find((variant) => variant.option.value === currentModel) ?? family.variants[0];
  const desired = { ...current, ...change };
  const candidates = family.variants.filter((variant) => Object.entries(change).every(
    ([key, value]) => variant[key as keyof typeof change] === value,
  ));
  return (candidates.length ? candidates : [current]).reduce((best, candidate) => {
    const score = (variant: CursorModelVariant) =>
      Number(variant.context === desired.context) * 8 + Number(variant.thinking === desired.thinking) * 4
      + Number(variant.effort === desired.effort) * 2 + Number(variant.fast === desired.fast);
    return score(candidate) > score(best) ? candidate : best;
  });
}

// ---------------------------

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'Claude GUI';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;
