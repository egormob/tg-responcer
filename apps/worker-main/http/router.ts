import { DialogEngine, type IncomingMessage } from '../core';
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
    token: string;
    exportToken?: string;
    export?: (request: Request) => Promise<Response>;
    selfTest?: (request: Request) => Promise<Response>;
    envz?: (request: Request) => Promise<Response>;
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

export const createRouter = (options: RouterOptions) => {
  const transformPayload = options.transformPayload ?? (async (payload: unknown) => parseIncomingMessage(payload));

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

      return handleNotFound();
    },
  };
};
