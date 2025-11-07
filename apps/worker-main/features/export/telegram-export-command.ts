import { json } from '../../shared';
import type { TelegramAdminCommandContext } from '../../http';
import type { MessagingPort, RateLimitPort } from '../../ports';
import type { AdminAccess } from '../admin-access';
import type { AdminExportRequest } from './admin-export-route';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface AdminExportRateLimitKvNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export type AdminExportLogKvNamespace = Pick<KVNamespace, 'put'>;

export interface CreateTelegramExportCommandHandlerOptions {
  botToken: string;
  handleExport: (request: AdminExportRequest) => Promise<Response>;
  adminAccess: AdminAccess;
  rateLimit: RateLimitPort;
  messaging: Pick<MessagingPort, 'sendText'>;
  cooldownKv?: AdminExportRateLimitKvNamespace;
  exportLogKv?: AdminExportLogKvNamespace;
  logger?: Logger;
  now?: () => Date;
}

interface ExportArguments {
  from?: Date;
  to?: Date;
}

const parseDateArgument = (value: string, kind: 'from' | 'to'): Date => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${kind} date must not be empty`);
  }

  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${kind} must be a valid date in YYYY-MM-DD format`);
  }

  return date;
};

const parseExportRangeArguments = (argument: string | undefined): ExportArguments => {
  if (!argument) {
    return {};
  }

  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 2) {
    throw new Error('Too many arguments. Usage: /export [from] [to]');
  }

  const from = parts[0] ? parseDateArgument(parts[0], 'from') : undefined;
  const to = parts[1] ? parseDateArgument(parts[1], 'to') : undefined;

  if (from && to && from.getTime() > to.getTime()) {
    throw new Error('`from` must be earlier than or equal to `to`');
  }

  return { from, to };
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

const buildTelegramFormData = (
  chatId: string,
  threadId: string | undefined,
  payload: Uint8Array,
) => {
  const formData = new FormData();
  formData.set('chat_id', chatId);
  if (threadId) {
    formData.set('message_thread_id', threadId);
  }

  const blob = new Blob([payload], { type: 'text/csv; charset=utf-8' });
  formData.set('document', blob, 'dialog-export.csv');

  return formData;
};

const EXPORT_COOLDOWN_KEY_PREFIX = 'rate-limit:';
const EXPORT_COOLDOWN_TTL_SECONDS = 30;
const EXPORT_COOLDOWN_VALUE = '1';
const EXPORT_COOLDOWN_RESPONSE = {
  error: 'Please wait up to 30 seconds before requesting another export.',
};
const EXPORT_LOG_TTL_SECONDS = 60 * 60 * 24 * 30;

const textDecoder = new TextDecoder('utf-8');

const ADMIN_HELP_MESSAGE = [
  'Доступные команды администратора:',
  '- /admin status — проверить, есть ли у вас доступ администратора. Ответ: admin-ok или forbidden.',
  '- /export [from] [to] — выгрузить историю диалогов в CSV. Даты необязательные, формат YYYY-MM-DD.',
].join('\n');

const parseUtmSourcesHeader = (value: string | null): string[] | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const normalized = parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (normalized.length === 0) {
      return undefined;
    }

    return Array.from(new Set(normalized));
  } catch (error) {
    console.warn('failed to parse x-utm-sources header', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return undefined;
  }
};

export const createTelegramExportCommandHandler = (
  options: CreateTelegramExportCommandHandlerOptions,
) => {
  const now = options.now ?? (() => new Date());
  const logger = createLogger(options.logger);
  const apiUrl = `https://api.telegram.org/bot${options.botToken}/sendDocument`;

  return async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const command = context.command.toLowerCase();
    const trimmedArgument = context.argument?.trim();

    if (command === '/admin' && (!trimmedArgument || trimmedArgument.length === 0)) {
      const userId = context.from.userId;
      const isAdmin = await options.adminAccess.isAdmin(userId);

      if (!isAdmin) {
        return undefined;
      }

      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: ADMIN_HELP_MESSAGE,
        });

        logger.info('admin help sent', {
          userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
        });
      } catch (error) {
        logger.error('failed to send admin help response', {
          userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
        });

        return json({ error: 'Failed to send admin help response' }, { status: 502 });
      }

      return json({ help: 'sent' }, { status: 200 });
    }

    if (command === '/admin' && trimmedArgument?.toLowerCase() === 'status') {
      const userId = context.from.userId;
      const isAdmin = await options.adminAccess.isAdmin(userId);
      const statusText = isAdmin ? 'admin-ok' : 'forbidden';

      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: statusText,
        });

        if (isAdmin) {
          logger.info('admin status confirmed', {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          });
        } else {
          logger.warn('admin status denied', {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          });
        }
      } catch (error) {
        logger.error('failed to send admin status response', {
          userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
        });

        return json({ error: 'Failed to send admin status response' }, { status: 502 });
      }

      return json({ status: statusText }, { status: 200 });
    }

    let rangeArgument: string | undefined;

    if (command === '/export') {
      rangeArgument = trimmedArgument;
    } else if (command === '/admin') {
      if (!trimmedArgument) {
        return undefined;
      }

      const [firstToken, ...restTokens] = trimmedArgument.split(/\s+/);
      if (firstToken?.toLowerCase() !== 'export') {
        return undefined;
      }

      rangeArgument = restTokens.join(' ').trim();
      if (rangeArgument.length === 0) {
        rangeArgument = undefined;
      }
    } else {
      return undefined;
    }

    let args: ExportArguments;

    try {
      args = parseExportRangeArguments(rangeArgument);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid arguments';
      logger.warn('invalid export arguments', { message, chatId: context.chat.id });
      return json({ error: message }, { status: 400 });
    }

    const { from, to } = args;
    const userId = context.from.userId;

    const isAdmin = await options.adminAccess.isAdmin(userId);
    if (!isAdmin) {
      logger.warn('admin export denied', { userId, chatId: context.chat.id });
      return json({ error: 'Admin access required' }, { status: 403 });
    }

    const rateLimitResult = await options.rateLimit.checkAndIncrement({
      userId,
      context: {
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        scope: 'admin_export',
      },
    });

    if (rateLimitResult === 'limit') {
      logger.warn('admin export rate limited', { userId, chatId: context.chat.id });
      return json({ error: 'Too many export requests' }, { status: 429 });
    }

    if (options.cooldownKv) {
      const cooldownKey = `${EXPORT_COOLDOWN_KEY_PREFIX}${userId}`;

      try {
        const existing = await options.cooldownKv.get(cooldownKey, 'text');

        if (existing !== null) {
          logger.warn('admin export cooldown active', {
            userId,
            chatId: context.chat.id,
          });
          return json(EXPORT_COOLDOWN_RESPONSE, { status: 429 });
        }

        await options.cooldownKv.put(cooldownKey, EXPORT_COOLDOWN_VALUE, {
          expirationTtl: EXPORT_COOLDOWN_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn('failed to update admin export cooldown kv', {
          userId,
          chatId: context.chat.id,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
      }
    }

    const abortController = new AbortController();

    let exportResponse: Response;
    try {
      exportResponse = await options.handleExport({
        from,
        to,
        cursor: undefined,
        limit: undefined,
        signal: abortController.signal,
      });
    } catch (error) {
      logger.error('failed to execute export handler', {
        userId,
        chatId: context.chat.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return json({ error: 'Failed to create export' }, { status: 500 });
    }

    if (!exportResponse.ok) {
      logger.warn('export handler returned non-ok response', {
        status: exportResponse.status,
        userId,
        chatId: context.chat.id,
      });
      return exportResponse;
    }

    const utmSources = parseUtmSourcesHeader(exportResponse.headers.get('x-utm-sources'));
    const data = new Uint8Array(await exportResponse.arrayBuffer());
    const csvText = textDecoder.decode(data);
    const newlineMatches = csvText.match(/\n/g) ?? [];
    const rowCount = Math.max(newlineMatches.length - 1, 0);
    const formData = buildTelegramFormData(context.chat.id, context.chat.threadId, data);

    const requestTimestamp = now();
    const exportLogDetails: Record<string, unknown> = {
      chatId: context.chat.id,
      threadId: context.chat.threadId,
      userId,
      from: from?.toISOString(),
      to: to?.toISOString(),
      requestedAt: requestTimestamp.toISOString(),
    };
    if (utmSources) {
      exportLogDetails.utmSources = utmSources;
    }
    logger.info('sending export to telegram', exportLogDetails);

    let telegramResponse: Response;
    try {
      telegramResponse = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
      });
    } catch (error) {
      logger.error('failed to upload export to telegram', {
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        userId,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return json({ error: 'Failed to send export to Telegram' }, { status: 502 });
    }

    if (!telegramResponse.ok) {
      logger.error('failed to upload export to telegram', {
        status: telegramResponse.status,
        statusText: telegramResponse.statusText,
      });
      return json({ error: 'Failed to send export to Telegram' }, { status: 502 });
    }

    if (options.exportLogKv) {
      const completedAt = now();
      const logKey = `log:${completedAt.toISOString()}:${userId}`;
      const payload: Record<string, unknown> = {
        userId,
        chatId: context.chat.id,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        rowCount,
      };
      if (utmSources) {
        payload.utmSources = utmSources;
      }

      try {
        await options.exportLogKv.put(logKey, JSON.stringify(payload), {
          expirationTtl: EXPORT_LOG_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn('failed to write admin export log', {
          userId,
          chatId: context.chat.id,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        });
      }
    }

    return json({ status: 'ok' }, { status: 200 });
  };
};
