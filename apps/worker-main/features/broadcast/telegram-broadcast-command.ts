import { json } from '../../shared';
import type { IncomingMessage } from '../../core';
import type { TelegramAdminCommandContext, TransformPayloadContext } from '../../http';
import type { MessagingPort } from '../../ports';
import type { AdminAccess } from '../admin-access';
import type { BroadcastAudienceFilter } from './broadcast-payload';
import {
  type AdminCommandErrorRecorder,
  extractTelegramErrorDetails,
  shouldInvalidateAdminAccess,
} from '../admin-access/admin-messaging-errors';
import type {
  BroadcastSendInput,
  BroadcastSendResult,
  SendBroadcast,
} from './minimal-broadcast-service';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

const DEFAULT_MAX_TEXT_LENGTH = 4096;
const DEFAULT_PENDING_TTL_MS = 60 * 1000;

export const BROADCAST_PROMPT_MESSAGE =
  'Нажмите /cancel если ❌ не хотите отправлять рассылку или пришлите текст';

export const BROADCAST_AUDIENCE_PROMPT =
  'Выберите аудиторию: отправьте all для всех или lang=ru (через запятую). Можно указать chat=ID.';


const BROADCAST_UNSUPPORTED_SUBCOMMAND_MESSAGE =
  'Мгновенная рассылка доступна только через команду /broadcast без аргументов.';

const buildTooLongMessage = (limit: number) =>
  `Текст рассылки превышает лимит ${limit} символов. Отправьте более короткое сообщение.`;

const BROADCAST_EMPTY_MESSAGE =
  'Текст рассылки не может быть пустым. Запустите /broadcast заново и введите сообщение.';

const BROADCAST_FAILURE_MESSAGE =
  'Не удалось отправить рассылку. Попробуйте ещё раз позже или обратитесь к оператору.';
const BROADCAST_CANCEL_MESSAGE =
  '❌ Рассылка отменена. Чтобы отправить новое сообщение, снова выполните /broadcast.';

export const BROADCAST_SUCCESS_MESSAGE = '✅ Рассылка отправлена!';

export interface PendingBroadcast {
  chatId: string;
  threadId?: string;
  expiresAt: number;
  stage: 'audience' | 'text';
  filters?: BroadcastAudienceFilter;
}

const toErrorDetails = (error: unknown) =>
  error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };

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

export interface CreateTelegramBroadcastCommandHandlerOptions {
  adminAccess: AdminAccess;
  messaging: Pick<MessagingPort, 'sendText'>;
  sendBroadcast: SendBroadcast;
  maxTextLength?: number;
  pendingTtlMs?: number;
  now?: () => Date;
  logger?: Logger;
  adminErrorRecorder?: AdminCommandErrorRecorder;
  pendingStore?: Map<string, PendingBroadcast>;
}

export interface TelegramBroadcastCommandHandler {
  handleCommand: (
    context: TelegramAdminCommandContext,
  ) => Promise<Response | void> | Response | void;
  handleMessage: (
    message: IncomingMessage,
    context?: TransformPayloadContext,
  ) => Promise<Response | 'handled' | void> | Response | 'handled' | void;
}

const hasArgument = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isBroadcastCommand = (context: TelegramAdminCommandContext) =>
  context.command.toLowerCase() === '/broadcast' && !hasArgument(context.argument);

const isUnsupportedAdminBroadcast = (context: TelegramAdminCommandContext) => {
  if (context.command.toLowerCase() !== '/admin') {
    return false;
  }

  if (!hasArgument(context.argument)) {
    return false;
  }

  const parts = context.argument.trim().split(/\s+/);
  return parts[0]?.toLowerCase() === 'broadcast';
};

const createBroadcastResponse = (result: BroadcastSendResult) => {
  void result;
  return BROADCAST_SUCCESS_MESSAGE;
};

const parseList = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const parseAudienceSelection = (value: string): BroadcastAudienceFilter | undefined | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = trimmed.toLowerCase();

  if (normalized === 'all' || normalized === '*' || normalized === 'everyone') {
    return undefined;
  }

  const applyList = (list: string[]): BroadcastAudienceFilter | null => {
    if (list.length === 0) {
      return null;
    }

    return { chatIds: list } satisfies BroadcastAudienceFilter;
  };

  if (normalized.startsWith('chat=')) {
    const ids = parseList(trimmed.slice(trimmed.indexOf('=') + 1));
    const filter = applyList(ids);
    return filter ?? null;
  }

  if (normalized.startsWith('user=')) {
    const ids = parseList(trimmed.slice(trimmed.indexOf('=') + 1));
    if (ids.length === 0) {
      return null;
    }
    return { userIds: ids } satisfies BroadcastAudienceFilter;
  }

  if (normalized.startsWith('lang=') || normalized.startsWith('language=')) {
    const index = trimmed.indexOf('=');
    const codes = parseList(trimmed.slice(index + 1)).map((code) => code.toLowerCase());
    if (codes.length === 0) {
      return null;
    }
    return { languageCodes: codes } satisfies BroadcastAudienceFilter;
  }

  if (normalized.startsWith('segment:')) {
    const code = trimmed.slice(trimmed.indexOf(':') + 1).trim().toLowerCase();
    if (code.length === 0) {
      return null;
    }
    return { languageCodes: [code] } satisfies BroadcastAudienceFilter;
  }

  return null;
};

export const createTelegramBroadcastCommandHandler = (
  options: CreateTelegramBroadcastCommandHandlerOptions,
): TelegramBroadcastCommandHandler => {
  const logger = createLogger(options.logger);
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const pendingTtlMs = Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
  const now = options.now ?? (() => new Date());

  const pending = options.pendingStore ?? new Map<string, PendingBroadcast>();

  const handleAudienceSelection = async (
    message: IncomingMessage,
    entry: PendingBroadcast,
    selection: BroadcastAudienceFilter | undefined,
  ): Promise<'handled'> => {
    const text = message.text ?? '';

    const updatedEntry: PendingBroadcast = {
      ...entry,
      stage: 'text',
      filters: selection ?? undefined,
      expiresAt: now().getTime() + pendingTtlMs,
    };

    pending.set(message.user.userId, updatedEntry);

    try {
      await options.messaging.sendText({
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        text: BROADCAST_PROMPT_MESSAGE,
      });

      logger.info('broadcast awaiting text', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        filters: updatedEntry.filters ?? null,
      });
    } catch (error) {
      pending.delete(message.user.userId);

      logger.error('failed to send broadcast text prompt', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(message.user.userId, 'broadcast_text_prompt', error);
    }

    return 'handled';
  };

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

  const cleanupExpired = (timestamp: number) => {
    for (const [key, entry] of pending.entries()) {
      if (entry.expiresAt <= timestamp) {
        pending.delete(key);
      }
    }
  };

  const handleCommand = async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const currentTime = now().getTime();
    cleanupExpired(currentTime);

    const broadcastRequested = isBroadcastCommand(context);
    const unsupportedAdminBroadcast = !broadcastRequested && isUnsupportedAdminBroadcast(context);

    if (!broadcastRequested && !unsupportedAdminBroadcast) {
      const entry = pending.get(context.from.userId);
      if (entry) {
        pending.delete(context.from.userId);

        logger.info('broadcast pending cleared before non-broadcast command', {
          userId: context.from.userId,
          chatId: entry.chatId,
          threadId: entry.threadId ?? null,
          command: context.command,
          argument: context.argument ?? null,
        });
      }

      return undefined;
    }

    const isAdmin = await options.adminAccess.isAdmin(context.from.userId);
    if (!isAdmin) {
      return undefined;
    }

    if (unsupportedAdminBroadcast) {
      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: BROADCAST_UNSUPPORTED_SUBCOMMAND_MESSAGE,
        });

        logger.warn('unsupported broadcast subcommand', {
          userId: context.from.userId,
          command: context.command,
          argument: context.argument ?? null,
        });
      } catch (error) {
        logger.error('failed to send unsupported broadcast subcommand notice', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(context.from.userId, 'broadcast_unsupported_subcommand', error);

        return json({ error: 'Failed to send unsupported broadcast notice' }, { status: 502 });
      }

      return json({ status: 'unsupported_broadcast_subcommand' }, { status: 200 });
    }

    const timestamp = now().getTime();
    cleanupExpired(timestamp);

    pending.set(context.from.userId, {
      chatId: context.chat.id,
      threadId: context.chat.threadId,
      expiresAt: timestamp + pendingTtlMs,
      stage: 'audience',
    });

    try {
      await options.messaging.sendText({
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        text: BROADCAST_AUDIENCE_PROMPT,
      });

      logger.info('broadcast awaiting audience selection', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId ?? null,
      });
    } catch (error) {
      pending.delete(context.from.userId);

      logger.error('failed to send broadcast prompt', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId ?? null,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(context.from.userId, 'broadcast_prompt', error);

      return json({ error: 'Failed to send broadcast prompt' }, { status: 502 });
    }

    return json({ status: 'awaiting_audience' }, { status: 200 });
  };

  const handleMessage = async (
    message: IncomingMessage,
    context?: TransformPayloadContext,
  ): Promise<'handled' | void> => {
    const currentTime = now().getTime();
    cleanupExpired(currentTime);

    const entry = pending.get(message.user.userId);
    if (!entry) {
      return undefined;
    }

    pending.delete(message.user.userId);

    if (entry.chatId !== message.chat.id) {
      return undefined;
    }

    const entryThreadId = entry.threadId ?? null;
    const messageThreadId = message.chat.threadId ?? null;

    if (entryThreadId !== messageThreadId) {
      return undefined;
    }

    const text = message.text ?? '';
    const trimmed = text.trim();
    const normalized = trimmed.toLowerCase();

    if (normalized === '/cancel') {
      logger.info('broadcast cancelled via telegram command', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_CANCEL_MESSAGE,
        });
      } catch (error) {
        logger.error('failed to send broadcast cancel notice', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_cancel_notice', error);
      }

      return 'handled';
    }

    if (entry.stage === 'audience') {
      const selection = parseAudienceSelection(trimmed);
      if (selection !== null) {
        return handleAudienceSelection(message, entry, selection);
      }

      entry.filters = undefined;
    }

    if (trimmed.length === 0) {
      logger.warn('broadcast text rejected', {
        userId: message.user.userId,
        reason: 'empty',
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_EMPTY_MESSAGE,
        });
      } catch (error) {
        logger.error('failed to send broadcast empty warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_empty_warning', error);
      }

      return 'handled';
    }

    if (text.length > maxTextLength) {
      logger.warn('broadcast text rejected', {
        userId: message.user.userId,
        reason: 'too_long',
        length: text.length,
        limit: maxTextLength,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildTooLongMessage(maxTextLength),
        });
      } catch (error) {
        logger.error('failed to send broadcast length warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_length_warning', error);
      }

      return 'handled';
    }

    const requestedBy = message.user.userId;

    logger.info('broadcast dispatch scheduled via telegram command', {
      userId: requestedBy,
      chatId: message.chat.id,
      threadId: message.chat.threadId ?? null,
    });

    const payload: BroadcastSendInput = {
      text,
      requestedBy,
      filters: entry.filters,
    };

    const runBroadcast = async () => {
      try {
        const result: BroadcastSendResult = await options.sendBroadcast(payload);

        logger.info('broadcast sent via telegram command', {
          userId: requestedBy,
          delivered: result.delivered,
          failed: result.failed,
        });

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: createBroadcastResponse(result),
          });
        } catch (error) {
          logger.error('failed to send broadcast confirmation', {
            userId: requestedBy,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(error),
          });

          await handleMessagingFailure(requestedBy, 'broadcast_confirmation', error);
        }
      } catch (error) {
        logger.error('broadcast send failed via telegram command', {
          userId: requestedBy,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: BROADCAST_FAILURE_MESSAGE,
          });
        } catch (sendError) {
          logger.error('failed to send broadcast failure message', {
            userId: requestedBy,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(sendError),
          });

          await handleMessagingFailure(requestedBy, 'broadcast_failure_notice', sendError);
        }
      }
    };

    const broadcastPromise = runBroadcast();

    if (context?.waitUntil) {
      context.waitUntil(broadcastPromise);
    } else {
      await broadcastPromise;
    }

    return 'handled';
  };

  return {
    handleCommand,
    handleMessage,
  } satisfies TelegramBroadcastCommandHandler;
};
