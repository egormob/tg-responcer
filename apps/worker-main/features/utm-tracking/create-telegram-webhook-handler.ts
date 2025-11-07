import { transformTelegramUpdate, type TelegramWebhookOptions } from '../../http/telegram-webhook';
import type { MessageWebhookResult, TransformPayload, TransformPayloadResult } from '../../http/router';
import type { StoragePort } from '../../ports';

interface KnownUser {
  utmSource?: string;
}

export interface CreateTelegramWebhookHandlerOptions extends TelegramWebhookOptions {
  storage: StoragePort;
  now?: () => Date;
}

const isMessageResult = (value: TransformPayloadResult): value is MessageWebhookResult =>
  (value as MessageWebhookResult | undefined)?.kind === 'message';

export const createTelegramWebhookHandler = (
  options: CreateTelegramWebhookHandlerOptions,
): TransformPayload => {
  const { storage, now = () => new Date(), ...transformOptions } = options;
  const knownUsers = new Map<string, KnownUser>();

  const rememberUser = (userId: string, utmSource: string | undefined) => {
    knownUsers.set(userId, { utmSource });
  };

  return async (payload: unknown) => {
    const result = await transformTelegramUpdate(payload, transformOptions);

    if (isMessageResult(result)) {
      const { message } = result;
      const userId = message.user.userId;
      const existing = knownUsers.get(userId);
      const incomingUtm = message.user.utmSource;

      if (!existing) {
        rememberUser(userId, incomingUtm);
      }

      if (incomingUtm) {
        if (!existing || !existing.utmSource) {
          await storage.saveUser({
            ...message.user,
            updatedAt: now(),
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
