import { json } from '../../shared';
import type { TelegramAdminCommandContext } from '../../http';
import type { RateLimitPort } from '../../ports';
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

const parseExportArguments = (argument: string | undefined): ExportArguments | undefined => {
  if (!argument) {
    return undefined;
  }

  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) {
    return undefined;
  }

  if (parts[0].toLowerCase() !== 'export') {
    return undefined;
  }

  const args = parts.slice(1);
  if (args.length > 2) {
    throw new Error('Too many arguments. Usage: /admin export [from] [to]');
  }

  const from = args[0] ? parseDateArgument(args[0], 'from') : undefined;
  const to = args[1] ? parseDateArgument(args[1], 'to') : undefined;

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

export const createTelegramExportCommandHandler = (
  options: CreateTelegramExportCommandHandlerOptions,
) => {
  const now = options.now ?? (() => new Date());
  const logger = createLogger(options.logger);
  const apiUrl = `https://api.telegram.org/bot${options.botToken}/sendDocument`;

  return async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    let args: ExportArguments | undefined;

    try {
      args = parseExportArguments(context.argument);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid arguments';
      logger.warn('invalid export arguments', { message, chatId: context.chat.id });
      return json({ error: message }, { status: 400 });
    }

    if (!args) {
      return undefined;
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

    const data = new Uint8Array(await exportResponse.arrayBuffer());
    const csvText = textDecoder.decode(data);
    const newlineMatches = csvText.match(/\n/g) ?? [];
    const rowCount = Math.max(newlineMatches.length - 1, 0);
    const formData = buildTelegramFormData(context.chat.id, context.chat.threadId, data);

    const requestTimestamp = now();
    logger.info('sending export to telegram', {
      chatId: context.chat.id,
      threadId: context.chat.threadId,
      userId,
      from: from?.toISOString(),
      to: to?.toISOString(),
      requestedAt: requestTimestamp.toISOString(),
    });

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
      const payload = JSON.stringify({
        userId,
        chatId: context.chat.id,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        rowCount,
      });

      try {
        await options.exportLogKv.put(logKey, payload, {
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
