import { DialogEngine, type IncomingMessage } from '../core';
import type { MessagingPort } from '../ports';
import type { TypingIndicator } from './typing-indicator';
import { safeWebhookHandler } from './safe-webhook';
import {
  recordTelegramSnapshotAction,
  type TelegramSnapshotRoute,
} from './telegram-webhook';
import { applyTelegramIdLogFields } from './telegram-ids';
import { parseTelegramUpdateBody } from './telegram-payload';

export const RATE_LIMIT_FALLBACK_TEXT = '🥶⌛️ Лимит ответов исчерпан. Попробуйте позже.';

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
  chatIdRaw?: unknown;
  chatIdNormalized?: string;
  fromId?: unknown;
  messageId?: string;
  route?: string;
}

export interface NonTextWebhookResult {
  kind: 'non_text';
  chat: { id: string; threadId?: string };
  reply: 'media' | 'voice';
}

export type TransformPayloadResult =
  | IncomingMessage
  | HandledWebhookResult
  | MessageWebhookResult
  | NonTextWebhookResult;

export interface TransformPayloadContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export type TransformPayload = (
  payload: unknown,
  context?: TransformPayloadContext,
) => TransformPayloadResult | Promise<TransformPayloadResult>;

const isHandledWebhookResult = (value: unknown): value is HandledWebhookResult =>
  isRecord(value) && value.kind === 'handled';

const isMessageWebhookResult = (value: unknown): value is MessageWebhookResult =>
  isRecord(value) && value.kind === 'message' && isIncomingMessageCandidate(value.message);

const isNonTextWebhookResult = (value: unknown): value is NonTextWebhookResult =>
  isRecord(value) &&
  value.kind === 'non_text' &&
  isRecord(value.chat) &&
  typeof value.chat.id === 'string' &&
  (value.chat.threadId === undefined || typeof value.chat.threadId === 'string') &&
  (value.reply === 'media' || value.reply === 'voice');

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

const extractUpdateId = (payload: unknown): string | number | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const raw = (payload as Record<string, unknown>).update_id;

  if (typeof raw === 'string') {
    return raw;
  }

  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    return raw;
  }

  return undefined;
};

type MessagingAction = 'sendText' | 'sendTyping';

interface MessagingLogDetails {
  action: MessagingAction;
  route: string;
  updateId?: string | number;
  chatIdRaw?: unknown;
  chatIdNormalized?: string;
  fromId?: unknown;
  messageId?: string;
  snapshotRoute?: TelegramSnapshotRoute;
}

const createMessagingLogFields = (details: MessagingLogDetails) => {
  const log: Record<string, unknown> = {
    action: details.action,
    route: details.route,
  };

  if (details.updateId !== undefined) {
    log.updateId = details.updateId;
  }

  if (details.chatIdRaw !== undefined) {
    log.chatIdRawType = typeof details.chatIdRaw;
    if (typeof details.chatIdRaw === 'string' || typeof details.chatIdRaw === 'bigint') {
      applyTelegramIdLogFields(log, 'chatIdRaw', details.chatIdRaw, { includeValue: false });
    }
  }

  if (details.chatIdNormalized) {
    applyTelegramIdLogFields(log, 'chatIdNormalized', details.chatIdNormalized, {
      includeValue: false,
    });
  }

  if (details.fromId !== undefined) {
    applyTelegramIdLogFields(log, 'fromId', details.fromId, { includeValue: false });
  }

  if (details.messageId !== undefined) {
    applyTelegramIdLogFields(log, 'messageId', details.messageId, { includeValue: false });
  }

  return log;
};

const logMessagingCall = async <T>(
  details: MessagingLogDetails,
  call: () => Promise<T>,
): Promise<T> => {
  const log = createMessagingLogFields(details);
  const snapshotRoute: TelegramSnapshotRoute = details.snapshotRoute ?? 'user';
  try {
    const result = await call();
    // eslint-disable-next-line no-console
    console.info(`[router][${details.action}] success`, { ...log, status: 'ok' });
    const successSnapshot: Parameters<typeof recordTelegramSnapshotAction>[0] = {
      action: details.action,
      route: snapshotRoute,
      updateId: details.updateId,
      ok: true,
      statusCode: 200,
      description: 'OK',
    };
    if (details.chatIdRaw !== undefined) {
      successSnapshot.chatIdRaw = details.chatIdRaw;
    }
    if (details.chatIdNormalized !== undefined) {
      successSnapshot.chatIdUsed = details.chatIdNormalized;
    }
    recordTelegramSnapshotAction(successSnapshot);
    return result;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[router][${details.action}] error`, {
      ...log,
      status: 'error',
      error: String(error),
    });
    const statusCandidate = (error as { status?: unknown }).status;
    const descriptionCandidate = (error as { description?: unknown }).description;
    const failureSnapshot: Parameters<typeof recordTelegramSnapshotAction>[0] = {
      action: details.action,
      route: snapshotRoute,
      updateId: details.updateId,
      ok: false,
      statusCode: typeof statusCandidate === 'number' ? statusCandidate : null,
      description:
        typeof descriptionCandidate === 'string' && descriptionCandidate.trim().length > 0
          ? descriptionCandidate
          : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
    if (details.chatIdRaw !== undefined) {
      failureSnapshot.chatIdRaw = details.chatIdRaw;
    }
    if (details.chatIdNormalized !== undefined) {
      failureSnapshot.chatIdUsed = details.chatIdNormalized;
    }
    recordTelegramSnapshotAction(failureSnapshot);
    throw error;
  }
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
    token: string;
    exportToken?: string;
    export?: (request: Request) => Promise<Response>;
    selfTest?: (request: Request) => Promise<Response>;
    envz?: (request: Request) => Promise<Response>;
    accessDiagnostics?: (request: Request) => Promise<Response>;
    diag?: (request: Request) => Promise<Response>;
    knownUsersClear?: (request: Request) => Promise<Response>;
    broadcastToken?: string;
    broadcast?: (request: Request) => Promise<Response>;
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

export interface RouterHandleContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export const createRouter = (options: RouterOptions) => {
  const transformPayload =
    options.transformPayload ??
    (async (payload: unknown) => parseIncomingMessage(payload));

  const handleHealthz = () => jsonResponse({ status: 'ok' });
  const handleNotFound = () => new Response('Not Found', { status: 404 });

  const unauthorizedResponse = (message: string, status: number) =>
    jsonResponse(
      { error: message },
      { status },
    );

  const ensureAdminAuthorization = (
    request: Request,
    url: URL,
    allowedTokens: string[] = [options.admin?.token ?? ''],
  ):
  | { ok: true; request: Request }
  | { ok: false; response: Response } => {
    if (!options.admin?.token) {
      return { ok: false, response: handleNotFound() };
    }

    const headerToken = request.headers.get('x-admin-token');
    const queryToken = url.searchParams.get('token');

    const validTokens = allowedTokens.filter((token) => token && token.length > 0);

    if (validTokens.length === 0) {
      return { ok: false, response: unauthorizedResponse('Invalid admin token', 403) };
    }

    if (!headerToken && !queryToken) {
      return { ok: false, response: unauthorizedResponse('Missing admin token', 401) };
    }

    if (headerToken && validTokens.includes(headerToken)) {
      return { ok: true, request };
    }

    if (queryToken && validTokens.includes(queryToken)) {
      if (headerToken === queryToken) {
        return { ok: true, request };
      }

      const headers = new Headers(request.headers);
      headers.set('x-admin-token', queryToken);
      const authorizedRequest = new Request(request, { headers });
      return { ok: true, request: authorizedRequest };
    }

    return { ok: false, response: unauthorizedResponse('Invalid admin token', 403) };
  };

  const handleWebhook = async (
    request: Request,
    url: URL,
    context?: RouterHandleContext,
  ) => {
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
    let updateId: string | number | undefined;
    try {
      const rawBody = await request.text();
      payload = parseTelegramUpdateBody(rawBody);
      updateId = extractUpdateId(payload);
    } catch (error) {
      return new Response('Invalid JSON payload', { status: 400 });
    }

    let message: IncomingMessage;
    let messageLogDetails: MessagingLogDetails | undefined;
    try {
      const transformed = await transformPayload(payload, context);

      if (isHandledWebhookResult(transformed)) {
        return (
          transformed.response ?? jsonResponse({ status: 'ignored' }, { status: 200 })
        );
      }

      if (isNonTextWebhookResult(transformed)) {
        const text = transformed.reply === 'voice' ? '🔇  👉📝' : '🖼️❌  👉📝';
        try {
          await logMessagingCall(
            {
              action: 'sendText',
              route: transformed.reply === 'voice' ? 'non_text_voice' : 'non_text_media',
              updateId,
              chatIdNormalized: transformed.chat.id,
            },
            () =>
              options.messaging.sendText({
                chatId: transformed.chat.id,
                threadId: transformed.chat.threadId,
                text,
              }),
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] failed to send non-text reminder', error);
        }
        return jsonResponse({ status: 'ignored' }, { status: 200 });
      }

      if (isMessageWebhookResult(transformed)) {
        message = transformed.message;
        messageLogDetails = {
          action: 'sendText',
          route: transformed.route ?? 'message',
          updateId,
          chatIdRaw: transformed.chatIdRaw,
          chatIdNormalized: transformed.chatIdNormalized ?? transformed.message.chat.id,
          fromId: transformed.fromId ?? transformed.message.user.userId,
          messageId: transformed.messageId ?? transformed.message.messageId,
        };
      } else if (isIncomingMessageCandidate(transformed)) {
        message = transformed;
        messageLogDetails = {
          action: 'sendText',
          route: 'incoming_message',
          updateId,
          chatIdNormalized: transformed.chat.id,
          fromId: transformed.user.userId,
          messageId: transformed.messageId,
        };
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

      if (dialogResult.status === 'rate_limited') {
        if (options.rateLimitNotifier) {
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

        try {
          await logMessagingCall(
            {
              ...(messageLogDetails ?? {
                action: 'sendText',
                route: 'rate_limit_fallback',
                updateId,
                chatIdNormalized: message.chat.id,
                fromId: message.user.userId,
                messageId: message.messageId,
              }),
              route: 'rate_limit_fallback',
            },
            () =>
              options.messaging.sendText({
                chatId: message.chat.id,
                threadId: message.chat.threadId,
                text: RATE_LIMIT_FALLBACK_TEXT,
              }),
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] failed to send rate limit fallback', error);
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

  return {
    async handle(request: Request, context?: RouterHandleContext): Promise<Response> {
      const url = new URL(request.url);
      const pathname = normalizePath(url.pathname);

      if (request.method === 'GET' && pathname === '/healthz') {
        return handleHealthz();
      }

      if (pathname.startsWith('/webhook')) {
        return handleWebhook(request, url, context);
      }

      if (pathname === '/admin/export') {
        if (!options.admin?.export) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(
          request,
          url,
          [options.admin.exportToken, options.admin.token].filter(
            (token): token is string => typeof token === 'string' && token.length > 0,
          ),
        );
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.export(auth.request);
      }

      if (pathname === '/admin/broadcast') {
        if (!options.admin?.broadcast) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(
          request,
          url,
          [options.admin.broadcastToken, options.admin.token].filter(
            (token): token is string => typeof token === 'string' && token.length > 0,
          ),
        );
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.broadcast(auth.request);
      }

      if (pathname === '/admin/selftest') {
        if (!options.admin?.selfTest) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.selfTest(auth.request);
      }

      if (pathname === '/admin/access') {
        if (!options.admin?.accessDiagnostics) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.accessDiagnostics(auth.request);
      }

      if (pathname === '/admin/envz') {
        if (!options.admin?.envz) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.envz(auth.request);
      }

      if (pathname === '/admin/known-users/clear') {
        if (!options.admin?.knownUsersClear) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.knownUsersClear(auth.request);
      }

      if (pathname === '/admin/diag') {
        if (!options.admin?.diag) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.diag(auth.request);
      }

      return handleNotFound();
    },
  };
};
