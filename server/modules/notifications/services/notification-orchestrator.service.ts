// @ts-expect-error web-push 在本项目中没有类型声明。
import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';

type NotificationEvent = {
  provider: string;
  sessionId?: string | null;
  kind?: string;
  code?: string;
  meta?: Record<string, unknown>;
  severity?: string;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
  createdAt?: string;
};

type RunNotificationOptions = {
  userId: number | string | null;
  provider: string;
  sessionId?: string | null;
  sessionName?: string | null;
};

const KIND_TO_PREF_KEY: Record<string, 'actionRequired' | 'stop' | 'error'> = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  system: 'System'
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(
  preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>,
  event: NotificationEvent,
) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind || 'info'];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event: NotificationEvent) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

/** 设置和各 Agent 运行模块使用此函数创建通知事件。 */
export function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}: NotificationEvent) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error: unknown) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName: unknown) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row: ReturnType<typeof sessionsDb.getSessionById>, provider: string) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId: string | null | undefined, provider: string) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event: NotificationEvent) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event: NotificationEvent) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

/** 通知投递流程和测试使用此函数生成浏览器及桌面的展示内容。 */
export function buildNotificationPayload(event: NotificationEvent) {
  const normalizedEvent = normalizeNotificationSession(event);
  const codeMessages: Record<string, unknown> = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.background_completed': 'Background work finished',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = codeMessages[normalizedEvent.code || 'generic.info'] || 'You have a new notification';

  return {
    title: sessionName || 'Claude GUI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId: number | string, payload: ReturnType<typeof buildNotificationPayload>) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(Number(userId));
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

type NotificationDelivery = {
  userId: number | string;
  payload: ReturnType<typeof buildNotificationPayload>;
};

const notificationChannels = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>) =>
      Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }: NotificationDelivery) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences: ReturnType<typeof notificationPreferencesDb.getPreferences>) =>
      Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }: NotificationDelivery) => sendDesktopNotificationToClients(userId, payload)
  }
];

/** 设置和各 Agent 运行模块使用此函数按用户偏好投递通知。 */
export function notifyUserIfEnabled({ userId, event }: { userId: number | string | null; event: unknown }) {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event as NotificationEvent);
  const preferences = notificationPreferencesDb.getPreferences(Number(userId));
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/** 各 Agent 运行模块使用此函数通知会话已停止。 */
export function notifyRunStopped({
  userId, provider, sessionId = null, stopReason = 'completed', sessionName = null,
}: RunNotificationOptions & { stopReason?: string }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window.
 */
export function notifyBackgroundWorkCompleted({
  userId, provider, sessionId = null, sessionName = null,
}: RunNotificationOptions) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

/** 各 Agent 运行模块使用此函数通知失败的运行。 */
export function notifyRunFailed({
  userId, provider, sessionId = null, error, sessionName = null,
}: RunNotificationOptions & { error: unknown }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}
