import { json } from '../../shared';
import type { TelegramAdminCommandContext } from '../../http';
import type { MessagingPort } from '../../ports';
import type { AdminAccess } from '../admin-access';
import type {
  BroadcastJob,
  BroadcastMessagePayload,
  BroadcastQueue,
} from './broadcast-queue';
import {
  DEFAULT_MAX_TEXT_LENGTH,
  buildBroadcastPayload,
} from './broadcast-payload';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface CreateTelegramBroadcastCommandHandlerOptions {
  adminAccess: AdminAccess;
  messaging: Pick<MessagingPort, 'sendText'>;
  queue: Pick<BroadcastQueue, 'enqueue'>;
  enqueueBroadcast?: EnqueueBroadcastJob;
  resolveRequestedBy?: (context: TelegramAdminCommandContext) => string | undefined;
  maxTextLength?: number;
  logger?: Logger;
}

interface EnqueueBroadcastJobInput {
  payload: BroadcastMessagePayload;
  requestedBy: string;
}

interface EnqueueBroadcastJobResult {
  jobId: string;
  enqueuedAt: Date;
  payload: BroadcastMessagePayload;
  requestedBy?: string;
}

type EnqueueBroadcastJob = (
  input: EnqueueBroadcastJobInput,
) => Promise<EnqueueBroadcastJobResult>;

interface BroadcastFilters {
  chatIds?: string[];
  userIds?: string[];
  languageCodes?: string[];
}

interface ParsedBroadcastCommand {
  intent: 'help' | 'preview' | 'send' | 'status';
  text?: string;
  filters?: BroadcastFilters;
}

const BROADCAST_HELP_MESSAGE = [
  'Команды рассылок:',
  '- /broadcast help — показать эту подсказку.',
  '- /broadcast preview <текст> — отправить пробное сообщение только вам.',
  '- /broadcast send [--chat=<id>] [--user=<id>] [--lang=<code>] <текст> — поставить рассылку в очередь. Для сложных сценариев используйте HTTP POST /admin/broadcast.',
].join('\n');

const BROADCAST_STATUS_MESSAGE = [
  'Рассылки доступны по HTTP POST /admin/broadcast.',
  'Укажите X-Admin-Token и X-Admin-Actor заголовки и передайте JSON {"text":"...","filters":{"chatIds":["123"]}}.',
  'Команда /broadcast send повторяет этот формат и проверяет фильтры до отправки запроса.',
].join('\n');

const parseListArgument = (value: string | undefined): string[] | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
};

const mergeFilters = (target: BroadcastFilters | undefined, update: Partial<BroadcastFilters>) => {
  const result: BroadcastFilters = { ...target };

  if (update.chatIds?.length) {
    result.chatIds = Array.from(new Set([...(result.chatIds ?? []), ...update.chatIds]));
  }

  if (update.userIds?.length) {
    result.userIds = Array.from(new Set([...(result.userIds ?? []), ...update.userIds]));
  }

  if (update.languageCodes?.length) {
    result.languageCodes = Array.from(new Set([...(result.languageCodes ?? []), ...update.languageCodes]));
  }

  return result;
};

const parseBroadcastCommand = (argument: string | undefined): ParsedBroadcastCommand => {
  if (!argument) {
    return { intent: 'help' };
  }

  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return { intent: 'help' };
  }

  const tokens = trimmed.split(/\s+/);
  const [firstTokenRaw, ...restTokens] = tokens;
  const firstToken = firstTokenRaw.toLowerCase();

  if (firstToken === 'help') {
    return { intent: 'help' };
  }

  if (firstToken === 'status') {
    return { intent: 'status' };
  }

  if (firstToken !== 'preview' && firstToken !== 'send') {
    // Команда без известной подкоманды трактуется как запрос помощи.
    return { intent: 'help' };
  }

  let filters: BroadcastFilters | undefined;
  const textTokens: string[] = [];

  for (const token of restTokens) {
    if (token.startsWith('--chat=')) {
      filters = mergeFilters(filters, { chatIds: parseListArgument(token.slice('--chat='.length)) });
      continue;
    }

    if (token.startsWith('--user=')) {
      filters = mergeFilters(filters, { userIds: parseListArgument(token.slice('--user='.length)) });
      continue;
    }

    if (token.startsWith('--lang=')) {
      filters = mergeFilters(filters, { languageCodes: parseListArgument(token.slice('--lang='.length)) });
      continue;
    }

    textTokens.push(token);
  }

  const text = textTokens.join(' ').trim();

  return {
    intent: firstToken,
    text: text.length > 0 ? text : undefined,
    filters,
  } satisfies ParsedBroadcastCommand;
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

const hasAnyFilter = (filters: BroadcastFilters | undefined) =>
  Boolean(filters?.chatIds?.length || filters?.userIds?.length || filters?.languageCodes?.length);

const toEnqueueResult = (job: BroadcastJob): EnqueueBroadcastJobResult => ({
  jobId: job.id,
  enqueuedAt: job.createdAt,
  payload: job.payload,
  requestedBy: job.requestedBy,
});

export const createTelegramBroadcastCommandHandler = (
  options: CreateTelegramBroadcastCommandHandlerOptions,
) => {
  const logger = createLogger(options.logger);

  const sendHelpMessage = async (context: TelegramAdminCommandContext, text: string) => {
    try {
      await options.messaging.sendText({
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        text,
      });

      logger.info('broadcast help sent', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId,
      });
    } catch (error) {
      logger.error('failed to send broadcast help message', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });

      return json({ error: 'Failed to send broadcast help response' }, { status: 502 });
    }

    return json({ help: 'sent' }, { status: 200 });
  };

  return async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const normalizedCommand = context.command.toLowerCase();
    let parsed: ParsedBroadcastCommand | undefined;

    if (normalizedCommand === '/broadcast') {
      parsed = parseBroadcastCommand(context.argument);
    } else if (normalizedCommand === '/admin') {
      const trimmedArgument = context.argument?.trim();
      if (!trimmedArgument) {
        return undefined;
      }

      const [firstToken, ...rest] = trimmedArgument.split(/\s+/);
      if (firstToken.toLowerCase() !== 'broadcast') {
        return undefined;
      }

      parsed = parseBroadcastCommand(rest.join(' '));
    } else {
      return undefined;
    }

    const isAdmin = await options.adminAccess.isAdmin(context.from.userId);
    if (!isAdmin) {
      return undefined;
    }

    if (!parsed) {
      return undefined;
    }

    if (parsed.intent === 'help') {
      return sendHelpMessage(context, BROADCAST_HELP_MESSAGE);
    }

    if (parsed.intent === 'status') {
      return sendHelpMessage(context, BROADCAST_STATUS_MESSAGE);
    }

    if (parsed.intent === 'preview') {
      if (!parsed.text) {
        return json({ error: 'Broadcast text must not be empty' }, { status: 400 });
      }

      try {
        const result = await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: parsed.text,
        });

        logger.info('broadcast preview sent', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          messageId: result?.messageId ?? null,
        });

        return json({ preview: 'sent', messageId: result?.messageId ?? null }, { status: 200 });
      } catch (error) {
        logger.error('failed to send broadcast preview', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });

        return json({ error: 'Failed to send broadcast preview' }, { status: 502 });
      }
    }

    if (parsed.intent === 'send') {
      if (!parsed.text) {
        return json({ error: 'Broadcast text must not be empty' }, { status: 400 });
      }

      if (!hasAnyFilter(parsed.filters)) {
        return json(
          {
            error: 'Укажите хотя бы один фильтр (--chat, --user или --lang), чтобы ограничить аудиторию.',
          },
          { status: 400 },
        );
      }
      const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

      let payload: BroadcastMessagePayload;
      try {
        payload = buildBroadcastPayload(
          {
            text: parsed.text,
            filters: parsed.filters,
          },
          { maxTextLength },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid broadcast payload';
        return json({ error: message }, { status: 400 });
      }

      const requestedBy = options.resolveRequestedBy?.(context) ?? context.from.userId;
      if (!requestedBy) {
        return json({ error: 'Failed to determine broadcast requester' }, { status: 400 });
      }

      const enqueue = options.enqueueBroadcast
        ?? ((input: EnqueueBroadcastJobInput) =>
          Promise.resolve(toEnqueueResult(options.queue.enqueue(input))));

      let job: EnqueueBroadcastJobResult;
      try {
        job = await enqueue({ payload, requestedBy });
      } catch (error) {
        logger.error('failed to enqueue broadcast job from telegram command', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });

        return json({ error: 'Failed to enqueue broadcast job' }, { status: 503 });
      }

      const confirmationMessage = [
        '📣 Рассылка поставлена в очередь.',
        `ID задачи: ${job.jobId}`,
        'Проверить статус: /broadcast status',
      ].join('\n');

      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: confirmationMessage,
        });

        logger.info('broadcast job enqueued via telegram command', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          jobId: job.jobId,
        });
      } catch (error) {
        logger.error('failed to send broadcast confirmation message', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          jobId: job.jobId,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
      }

      return json(
        {
          status: 'queued',
          jobId: job.jobId,
          enqueuedAt: job.enqueuedAt.toISOString(),
          requestedBy: job.requestedBy ?? requestedBy,
          filters: job.payload.filters ?? null,
        },
        { status: 202 },
      );
    }

    return undefined;
  };
};
