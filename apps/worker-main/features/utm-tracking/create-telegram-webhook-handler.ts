import { transformTelegramUpdate, type TelegramWebhookOptions } from '../../http/telegram-webhook';
import { applyTelegramIdLogFields } from '../../http/telegram-ids';
import type {
  HandledWebhookResult,
  MessageWebhookResult,
  TransformPayload,
  TransformPayloadContext,
  TransformPayloadResult,
} from '../../http/router';
import type { StoragePort } from '../../ports';

const applySnapshotIdField = (
  snapshot: Record<string, unknown>,
  field: string,
  value: unknown,
) => {
  if (typeof value === 'string') {
    applyTelegramIdLogFields(snapshot, field, value);
    return;
  }

  if (value !== undefined) {
    snapshot[field] = value;
    snapshot[`${field}Type`] = typeof value;
  }
};

const safePayloadSnapshot = (payload: unknown) => {
  if (typeof payload !== 'object' || payload === null) {
    return { type: typeof payload };
  }

  const record = payload as Record<string, unknown>;
  const message =
    record.message && typeof record.message === 'object' && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const chat =
    message?.chat && typeof message.chat === 'object' && message.chat !== null
      ? (message.chat as Record<string, unknown>)
      : undefined;
  const from =
    message?.from && typeof message.from === 'object' && message.from !== null
      ? (message.from as Record<string, unknown>)
      : undefined;

  const toOptionalSafeInteger = (value: unknown): number | undefined => {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? value : undefined;
    }

    if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }

    return undefined;
  };

  const snapshot: Record<string, unknown> = {
    updateId: toOptionalSafeInteger(record.update_id),
    hasMessage: Boolean(message),
    chatType: typeof chat?.type === 'string' ? chat?.type : undefined,
    hasText: typeof message?.text === 'string',
    hasCaption: typeof message?.caption === 'string',
    hasWebAppData: typeof message?.web_app_data === 'object' && message?.web_app_data !== null,
  };

  applySnapshotIdField(snapshot, 'messageId', message?.message_id);
  applySnapshotIdField(snapshot, 'chatId', chat?.id);
  applySnapshotIdField(snapshot, 'fromId', from?.id);
  applySnapshotIdField(snapshot, 'threadId', message?.message_thread_id);

  return snapshot;
};

interface KnownUser {
  utmSource?: string;
}

export interface CreateTelegramWebhookHandlerOptions extends TelegramWebhookOptions {
  storage: StoragePort;
  now?: () => Date;
}

const isMessageResult = (value: TransformPayloadResult): value is MessageWebhookResult =>
  (value as MessageWebhookResult | undefined)?.kind === 'message';

const handledResult = (response?: Response): HandledWebhookResult => ({
  kind: 'handled',
  response:
    response
    ?? new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 200,
    }),
});

export const createTelegramWebhookHandler = (
  options: CreateTelegramWebhookHandlerOptions,
): TransformPayload => {
  const { storage, now = () => new Date(), ...transformOptions } = options;
  // Кэш хранит только канонические строковые идентификаторы Telegram — никаких
  // принудительных преобразований типов, чтобы не потерять leading zeros и т.п.
  const knownUsers = new Map<string, KnownUser>();

  const forgetUser = (userId: unknown) => {
    if (typeof userId === 'string') {
      knownUsers.delete(userId);
    } else {
      knownUsers.clear();
    }
  };

  const rememberUser = (userId: unknown, utmSource: string | undefined) => {
    if (typeof userId !== 'string') {
      // eslint-disable-next-line no-console
      console.error('[utm-tracking] refused to cache non-string user id', {
        userId,
        userIdType: typeof userId,
      });
      forgetUser(userId);
      return;
    }

    knownUsers.set(userId, { utmSource });
  };

  return async (payload: unknown, context?: TransformPayloadContext) => {
    // eslint-disable-next-line no-console
    console.info('[utm-tracking] incoming payload', safePayloadSnapshot(payload));

    const result = await transformTelegramUpdate(payload, transformOptions);

    if (isMessageResult(result)) {
      const { message } = result;

      const handledByFeature = await transformOptions.features?.handleMessage?.(message);
      if (handledByFeature) {
        if (handledByFeature instanceof Response) {
          return handledResult(handledByFeature);
        }

        return handledResult();
      }

      const userIdRaw: unknown = message.user.userId;

      if (typeof userIdRaw !== 'string') {
        // eslint-disable-next-line no-console
        console.error('[utm-tracking] message with non-string user id', {
          userId: userIdRaw,
          userIdType: typeof userIdRaw,
        });
        forgetUser(userIdRaw);
        return result;
      }

      const userId = userIdRaw;
      const existing = knownUsers.get(userId);
      const incomingUtm = message.user.utmSource;

      if (!existing) {
        rememberUser(userId, incomingUtm);
      }

      if (incomingUtm) {
        if (!existing || !existing.utmSource) {
          rememberUser(userId, incomingUtm);

          const saveTask = (async () => {
            try {
              const saveResult = await storage.saveUser({
                ...message.user,
                updatedAt: now(),
              });
              // eslint-disable-next-line no-console
              console.info('[utm-tracking] saveUser result', {
                userId,
                utmSource: incomingUtm,
                utmDegraded: saveResult.utmDegraded,
              });
            } catch (error) {
              const details =
                error instanceof Error
                  ? { name: error.name, message: error.message }
                  : { error: String(error) };
              // eslint-disable-next-line no-console
              console.error('[utm-tracking] failed to save user', {
                userId,
                utmSource: incomingUtm,
                ...details,
              });
            }
          })();

          if (context?.waitUntil) {
            context.waitUntil(saveTask);
          } else {
            await saveTask;
          }
        }
      } else if (existing?.utmSource) {
        result.message = {
          ...message,
          user: {
            ...message.user,
            utmSource: existing.utmSource,
          },
        };
      }
    }

    return result;
  };
};
