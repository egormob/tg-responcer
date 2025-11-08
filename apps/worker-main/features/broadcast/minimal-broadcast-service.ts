import type { MessagingPort } from '../../ports';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface BroadcastRecipient {
  chatId: string;
  threadId?: string;
}

export interface BroadcastSendInput {
  text: string;
  requestedBy: string;
}

export interface BroadcastSendResultDelivery {
  recipient: BroadcastRecipient;
  messageId?: string;
  error?: { name: string; message: string };
}

export interface BroadcastSendResult {
  delivered: number;
  failed: number;
  deliveries: ReadonlyArray<BroadcastSendResultDelivery>;
}

export type SendBroadcast = (input: BroadcastSendInput) => Promise<BroadcastSendResult>;

export interface CreateImmediateBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  recipients: readonly BroadcastRecipient[];
  logger?: Logger;
}

const toErrorDetails = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  const message = typeof error === 'string' ? error : JSON.stringify(error);
  return { name: 'Error', message };
};

export const createImmediateBroadcastSender = (
  options: CreateImmediateBroadcastSenderOptions,
): SendBroadcast => {
  const recipients = options.recipients.filter((recipient) => recipient.chatId.trim().length > 0);

  return async ({ text, requestedBy }) => {
    const deliveries: BroadcastSendResultDelivery[] = [];

    for (const recipient of recipients) {
      try {
        const result = await options.messaging.sendText({
          chatId: recipient.chatId,
          threadId: recipient.threadId,
          text,
        });

        options.logger?.info?.('broadcast delivered', {
          requestedBy,
          chatId: recipient.chatId,
          threadId: recipient.threadId ?? null,
          messageId: result?.messageId ?? null,
        });

        deliveries.push({
          recipient,
          messageId: result?.messageId,
        });
      } catch (error) {
        const details = toErrorDetails(error);

        options.logger?.error?.('broadcast delivery failed', {
          requestedBy,
          chatId: recipient.chatId,
          threadId: recipient.threadId ?? null,
          error: details,
        });

        deliveries.push({
          recipient,
          error: details,
        });
      }
    }

    const delivered = deliveries.filter((entry) => !entry.error).length;
    const failed = deliveries.length - delivered;

    return {
      delivered,
      failed,
      deliveries,
    } satisfies BroadcastSendResult;
  };
};
