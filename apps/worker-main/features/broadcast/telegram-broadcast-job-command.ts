import { json } from '../../shared';
import type { TelegramAdminCommandContext } from '../../http';
import { toTelegramIdString } from '../../http/telegram-ids';
import type { MessagingPort } from '../../ports';
import type { AdminAccess } from '../admin-access';
import {
  type AdminCommandErrorRecorder,
  extractTelegramErrorDetails,
  shouldInvalidateAdminAccess,
} from '../admin-access/admin-messaging-errors';
import type { BroadcastJob, BroadcastQueue } from './broadcast-queue';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface CreateTelegramBroadcastJobCommandHandlerOptions {
  adminAccess: AdminAccess;
  queue: Pick<BroadcastQueue, 'getJob'>;
  messaging: Pick<MessagingPort, 'editMessageText' | 'deleteMessage'>;
  logger?: Logger;
  now?: () => Date;
  adminErrorRecorder?: AdminCommandErrorRecorder;
}

interface BroadcastJobMessageTarget {
  chatId: string;
  messageId: string;
  threadId?: string;
  sentAt?: Date;
}

type BroadcastJobCommand =
  | { kind: 'edit'; jobId: string; text: string }
  | { kind: 'cancel'; jobId: string };

const MAX_EDITABLE_AGE_MS = 48 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toIdString = (value: unknown): string | undefined => {
  const asString = toTelegramIdString(value);
  if (typeof asString !== 'string') {
    return undefined;
  }

  const trimmed = asString.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseTimestamp = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Telegram timestamps обычно передаются в секундах.
    if (value > 9_999_999_999) {
      return new Date(value);
    }

    return new Date(value * 1000);
  }

  return undefined;
};

const pickTargetCandidate = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) {
    return undefined;
  }

  if (isRecord(metadata.targetMessage)) {
    return metadata.targetMessage;
  }

  if (isRecord(metadata.telegramMessage)) {
    return metadata.telegramMessage;
  }

  if (isRecord(metadata.message)) {
    return metadata.message;
  }

  if (isRecord(metadata.telegram)) {
    return metadata.telegram;
  }

  if (metadata.chatId || metadata.chat_id) {
    return metadata;
  }

  return undefined;
};

const extractTargetFromJob = (job: BroadcastJob): BroadcastJobMessageTarget | undefined => {
  const metadata = job.payload.metadata;
  const candidate = pickTargetCandidate(metadata);

  if (!candidate) {
    return undefined;
  }

  const chatId = toIdString(candidate.chatId ?? candidate.chat_id);
  const messageId = toIdString(candidate.messageId ?? candidate.message_id);
  if (!chatId || !messageId) {
    return undefined;
  }

  const threadId = toIdString(candidate.threadId ?? candidate.message_thread_id);
  const sentAt =
    parseTimestamp(candidate.sentAt ?? candidate.sent_at ?? candidate.timestamp ?? candidate.date) ??
    undefined;

  return { chatId, messageId, threadId, sentAt } satisfies BroadcastJobMessageTarget;
};

const parseCommandArgument = (argument: string | undefined): BroadcastJobCommand | undefined => {
  if (!argument) {
    return undefined;
  }

  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const tokens = trimmed.split(/\s+/);
  const [actionTokenRaw, jobId, ...rest] = tokens;
  const actionToken = actionTokenRaw?.toLowerCase();

  if (!jobId) {
    return undefined;
  }

  if (actionToken === 'edit') {
    const text = rest.join(' ').trim();
    return { kind: 'edit', jobId, text } satisfies BroadcastJobCommand;
  }

  if (actionToken === 'cancel') {
    return { kind: 'cancel', jobId } satisfies BroadcastJobCommand;
  }

  return undefined;
};

const createLogger = (logger?: Logger) => ({
  info(message: string, details?: Record<string, unknown>) {
    logger?.info?.(message, details);
  },
  warn(message: string, details?: Record<string, unknown>) {
    logger?.warn?.(message, details);
  },
  error(message: string, details?: Record<string, unknown>) {
    logger?.error?.(message, details);
  },
});

const toErrorDetails = (error: unknown) =>
  error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };

export const createTelegramBroadcastJobCommandHandler = (
  options: CreateTelegramBroadcastJobCommandHandlerOptions,
) => {
  const logger = createLogger(options.logger);
  const now = options.now ?? (() => new Date());

  const handleMessagingFailure = async (
    userId: string | number | bigint,
    commandLabel: string,
    error: unknown,
  ) => {
    const details = extractTelegramErrorDetails(error);

    if (shouldInvalidateAdminAccess(details)) {
      options.adminAccess.invalidate?.(userId);
    }

    await options.adminErrorRecorder?.record({
      userId: String(userId),
      command: commandLabel,
      error,
      details,
    });
  };

  return async (context: TelegramAdminCommandContext) => {
    const normalizedCommand = context.command.toLowerCase();
    if (normalizedCommand !== '/broadcast' && normalizedCommand !== '/admin') {
      return undefined;
    }

    const isAdminCommand = normalizedCommand === '/admin';
    let argument = context.argument;

    if (isAdminCommand) {
      const trimmed = argument?.trim();
      if (!trimmed) {
        return undefined;
      }

      const [namespace, ...rest] = trimmed.split(/\s+/);
      if (namespace.toLowerCase() !== 'broadcast') {
        return undefined;
      }

      argument = rest.join(' ').trim();
    }

    const isAdmin = await options.adminAccess.isAdmin(context.from.userId);
    if (!isAdmin) {
      return undefined;
    }

    const parsed = parseCommandArgument(argument);
    if (!parsed) {
      return undefined;
    }

    const job = options.queue.getJob(parsed.jobId);
    if (!job) {
      logger.warn('broadcast job not found for admin command', { jobId: parsed.jobId });
      return json({ error: `Рассылка ${parsed.jobId} не найдена.` }, { status: 404 });
    }

    const target = extractTargetFromJob(job);
    if (!target) {
      logger.warn('broadcast job missing message metadata', { jobId: job.id });
      return json({ error: 'Для рассылки отсутствуют данные о сообщении.' }, { status: 400 });
    }

    const sentAt = target.sentAt ?? job.updatedAt ?? job.createdAt;
    const ageMs = Math.max(0, now().getTime() - sentAt.getTime());
    if (ageMs > MAX_EDITABLE_AGE_MS) {
      logger.warn('broadcast job command rejected due to age limit', {
        jobId: job.id,
        messageId: target.messageId,
        action: parsed.kind,
        ageMs,
      });

      const actionLabel = parsed.kind === 'edit' ? 'редактировать' : 'удалить';
      return json(
        {
          error: `Нельзя ${actionLabel} сообщение рассылки старше 48 часов.`,
        },
        { status: 409 },
      );
    }

    if (parsed.kind === 'edit') {
      if (!parsed.text || parsed.text.trim().length === 0) {
        return json(
          { error: 'Укажите новый текст после идентификатора рассылки.' },
          { status: 400 },
        );
      }

      try {
        await options.messaging.editMessageText({
          chatId: target.chatId,
          threadId: target.threadId,
          messageId: target.messageId,
          text: parsed.text,
        });

        logger.info('broadcast job message edited', {
          jobId: job.id,
          messageId: target.messageId,
          chatId: target.chatId,
          threadId: target.threadId ?? null,
        });

        return json({ status: 'edited', jobId: job.id, messageId: target.messageId }, { status: 200 });
      } catch (error) {
        logger.error('broadcast job edit failed', {
          jobId: job.id,
          messageId: target.messageId,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(context.from.userId, 'broadcast_job_edit', error);

        return json({ error: 'Не удалось обновить сообщение рассылки.' }, { status: 502 });
      }
    }

    try {
      await options.messaging.deleteMessage({
        chatId: target.chatId,
        threadId: target.threadId,
        messageId: target.messageId,
      });

      logger.info('broadcast job message deleted', {
        jobId: job.id,
        messageId: target.messageId,
        chatId: target.chatId,
        threadId: target.threadId ?? null,
      });

      return json({ status: 'cancelled', jobId: job.id, messageId: target.messageId }, { status: 200 });
    } catch (error) {
      logger.error('broadcast job delete failed', {
        jobId: job.id,
        messageId: target.messageId,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(context.from.userId, 'broadcast_job_delete', error);

      return json({ error: 'Не удалось удалить сообщение рассылки.' }, { status: 502 });
    }
  };
};
