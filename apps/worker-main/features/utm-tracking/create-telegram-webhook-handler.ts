import { transformTelegramUpdate, type TelegramWebhookOptions } from '../../http/telegram-webhook';
import type {
  HandledWebhookResult,
  MessageWebhookResult,
  TransformPayload,
  TransformPayloadResult,
} from '../../http/router';
import type { StoragePort } from '../../ports';

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

  const toIdString = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value).toString(10);
    }

    if (typeof value === 'bigint') {
      return value.toString(10);
    }

    return undefined;
  };

  return {
    updateId: typeof record.update_id === 'number' ? record.update_id : undefined,
    hasMessage: Boolean(message),
    messageId: toIdString(message?.message_id),
    chatId: toIdString(chat?.id),
    chatType: typeof chat?.type === 'string' ? chat?.type : undefined,
    fromId: toIdString(from?.id),
    hasText: typeof message?.text === 'string',
    hasCaption: typeof message?.caption === 'string',
    hasWebAppData: typeof message?.web_app_data === 'object' && message?.web_app_data !== null,
  };
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
  const knownUsers = new Map<string, KnownUser>();

  const rememberUser = (userId: string, utmSource: string | undefined) => {
    knownUsers.set(userId, { utmSource });
  };

  return async (payload: unknown) => {
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

      const userId = message.user.userId;
      const existing = knownUsers.get(userId);
      const incomingUtm = message.user.utmSource;

      if (!existing) {
        rememberUser(userId, incomingUtm);
      }

      if (incomingUtm) {
        if (!existing || !existing.utmSource) {
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
          rememberUser(userId, incomingUtm);
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
