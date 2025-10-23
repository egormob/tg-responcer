import type { IncomingMessage } from '../core/DialogEngine';
import { DialogEngine } from '../core/DialogEngine';

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
  webhookSecret?: string;
  transformPayload?: (payload: unknown) => IncomingMessage;
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
  const transformPayload = options.transformPayload ?? parseIncomingMessage;

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
      message = transformPayload(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid payload';
      return new Response(reason, { status: 400 });
    }

    try {
      const result = await options.dialogEngine.handleMessage(message);

      if (result.status === 'rate_limited') {
        return jsonResponse({ status: 'rate_limited' }, { status: 429 });
      }

      return jsonResponse(
        {
          status: 'ok',
          messageId: result.response.messageId ?? null,
        },
        { status: 200 },
      );
    } catch (error) {
      return new Response('Internal Server Error', { status: 500 });
    }
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

      return handleNotFound();
    },
  };
};
