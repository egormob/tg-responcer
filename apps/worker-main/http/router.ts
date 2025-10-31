import { DialogEngine, type IncomingMessage } from '../core/DialogEngine';
import type { MessagingPort } from '../ports';
import type { TypingIndicator } from './typing-indicator';
import { safeWebhookHandler } from './safe-webhook';

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isIncomingMessageCandidate = (value: unknown): value is IncomingMessage => {
  if (!isRecord(value)) {
    return false;
  }

  const { user, chat, text, receivedAt } = value;

  if (!isRecord(user) || typeof user.userId !== 'string') {
    return false;
  }

  if (!isRecord(chat) || typeof chat.id !== 'string') {
    return false;
  }

  if (typeof text !== 'string') {
    return false;
  }

  return receivedAt instanceof Date;
};

export interface HandledWebhookResult {
  kind: 'handled';
  response?: Response;
}

export interface MessageWebhookResult {
  kind: 'message';
  message: IncomingMessage;
}

export type TransformPayloadResult =
  | IncomingMessage
  | HandledWebhookResult
  | MessageWebhookResult;

export type TransformPayload = (
  payload: unknown,
) => TransformPayloadResult | Promise<TransformPayloadResult>;

const isHandledWebhookResult = (value: unknown): value is HandledWebhookResult =>
  isRecord(value) && value.kind === 'handled';

const isMessageWebhookResult = (value: unknown): value is MessageWebhookResult =>
  isRecord(value) && value.kind === 'message' && isIncomingMessageCandidate(value.message);

const toOptionalString = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.length > 0 ? value : undefined);

const parseDate = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
};

export const parseIncomingMessage = (payload: unknown): IncomingMessage => {
  if (!isRecord(payload)) {
    throw new Error('Payload must be an object');
  }

  const { user, chat, text } = payload;

  if (!isRecord(user) || typeof user.userId !== 'string') {
    throw new Error('Invalid user payload');
  }

  if (!isRecord(chat) || typeof chat.id !== 'string') {
    throw new Error('Invalid chat payload');
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text is required');
  }

  const threadId = toOptionalString(chat.threadId);
  const messageId = toOptionalString(payload.messageId);
  const receivedAt = parseDate(payload.receivedAt);

  return {
    user: {
      userId: user.userId,
      username: toOptionalString(user.username),
      firstName: toOptionalString(user.firstName),
      lastName: toOptionalString(user.lastName),
      languageCode: toOptionalString(user.languageCode),
      metadata: isRecord(user.metadata) ? user.metadata : undefined,
    },
    chat: {
      id: chat.id,
      threadId,
    },
    text,
    messageId,
    receivedAt,
  };
};

export interface RouterOptions {
  dialogEngine: DialogEngine;
  messaging: MessagingPort;
  webhookSecret?: string;
  transformPayload?: TransformPayload;
  typingIndicator?: TypingIndicator;
  rateLimitNotifier?: {
    notify(input: { userId: string; chatId: string; threadId?: string }): Promise<void>;
  };
  admin?: {
    export?: (request: Request) => Promise<Response>;
  };
}

const normalizePath = (pathname: string) => pathname.replace(/\/$/, '');

const extractWebhookSecret = (pathname: string): string | undefined => {
  const segments = normalizePath(pathname)
    .split('/')
    .filter(Boolean);

  if (segments.length === 2 && segments[0] === 'webhook') {
    return decodeURIComponent(segments[1] ?? '');
  }

  return undefined;
};

export const createRouter = (options: RouterOptions) => {
  const transformPayload = options.transformPayload ?? (async (payload: unknown) => parseIncomingMessage(payload));

  const handleHealthz = () => jsonResponse({ status: 'ok' });

  const handleWebhook = async (request: Request, url: URL) => {
    if (!options.webhookSecret) {
      return new Response('Webhook secret is not configured', { status: 500 });
    }

    const providedSecret = extractWebhookSecret(url.pathname);

    if (!providedSecret) {
      return new Response('Not Found', { status: 404 });
    }

    if (providedSecret !== options.webhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      return new Response('Invalid JSON payload', { status: 400 });
    }

    let message: IncomingMessage;
    try {
      const transformed = await transformPayload(payload);

      if (isHandledWebhookResult(transformed)) {
        return (
          transformed.response ?? jsonResponse({ status: 'ignored' }, { status: 200 })
        );
      }

      if (isMessageWebhookResult(transformed)) {
        message = transformed.message;
      } else if (isIncomingMessageCandidate(transformed)) {
        message = transformed;
      } else {
        throw new Error('Transform payload returned invalid result');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid payload';
      return new Response(reason, { status: 400 });
    }

    const runDialog = async () => {
      const executeDialog = () => options.dialogEngine.handleMessage(message);

      const dialogResult = options.typingIndicator
        ? await options.typingIndicator.runWithTyping(
            { chatId: message.chat.id, threadId: message.chat.threadId },
            executeDialog,
          )
        : await executeDialog();

      if (dialogResult.status === 'rate_limited' && options.rateLimitNotifier) {
        try {
          await options.rateLimitNotifier.notify({
            userId: message.user.userId,
            chatId: message.chat.id,
            threadId: message.chat.threadId,
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] rate limit notifier failed', error);
        }
      }

      return dialogResult;
    };

    return safeWebhookHandler({
      chat: { id: message.chat.id, threadId: message.chat.threadId },
      messaging: options.messaging,
      run: runDialog,
      mapResult: async (result) => {
        if (result.status === 'rate_limited') {
          return { body: { status: 'rate_limited' } };
        }

        return {
          body: {
            status: 'ok',
            messageId: result.response.messageId ?? null,
          },
        };
      },
    });
  };

  const handleNotFound = () => new Response('Not Found', { status: 404 });

  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const pathname = normalizePath(url.pathname);

      if (request.method === 'GET' && pathname === '/healthz') {
        return handleHealthz();
      }

      if (pathname.startsWith('/webhook')) {
        return handleWebhook(request, url);
      }

      if (pathname === '/admin/export') {
        if (!options.admin?.export) {
          return handleNotFound();
        }

        return options.admin.export(request);
      }

      return handleNotFound();
    },
  };
};
