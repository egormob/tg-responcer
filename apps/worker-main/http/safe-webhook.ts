import type { MessagingPort } from '../ports';
import { REQUEST_RETRY_PROMPT } from '../shared/fallback-messages';
import { noteTelegramSnapshot, recordTelegramSnapshotAction } from './telegram-webhook';
import { applyTelegramIdLogFields } from './telegram-ids';

const extractFallbackReason = (error: unknown): { reason: string; name?: string } => {
  if (error instanceof Error) {
    const reason = error.message && error.message.trim().length > 0 ? error.message : error.toString();
    return { reason, name: error.name };
  }

  const normalized = String(error);
  return { reason: normalized };
};

const shouldSkipSafeFallback = (error: unknown): boolean =>
  Boolean(
    error
    && typeof error === 'object'
    && ((error as { skipSafeFallback?: unknown }).skipSafeFallback === true
      || (error as { safeFallback?: unknown }).safeFallback === false),
  );

const DEFAULT_FALLBACK_TEXT = REQUEST_RETRY_PROMPT;

interface SafeWebhookHandlerOptions<T> {
  chat: {
    id?: string;
    threadId?: string;
  };
  messaging: MessagingPort;
  run: () => Promise<T>;
  mapResult: (result: T) => { body: unknown; headers?: HeadersInit } | Promise<{ body: unknown; headers?: HeadersInit }>;
  fallbackText?: string;
}

const toHeaders = (headers?: HeadersInit) => {
  if (!headers) {
    return new Headers();
  }

  if (headers instanceof Headers) {
    return new Headers(headers);
  }

  return new Headers(headers);
};

export async function safeWebhookHandler<T>(
  options: SafeWebhookHandlerOptions<T>,
): Promise<Response> {
  const { chat, messaging, run, mapResult, fallbackText } = options;
  const chatId = chat.id ?? null;
  // eslint-disable-next-line no-console
  console.info('[safe] incoming', { chatId });

  try {
    const result = await run();
    // eslint-disable-next-line no-console
    console.info('[safe] done');
    const success = await mapResult(result);
    const headers = toHeaders(success.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }

    return new Response(JSON.stringify(success.body), {
      status: 200,
      headers,
    });
  } catch (error) {
    const { reason, name } = extractFallbackReason(error);
    const skipFallback = shouldSkipSafeFallback(error);

    // eslint-disable-next-line no-console
    console.error('[safe][error]', {
      message: reason,
      name: name ?? undefined,
      skipFallback,
    });
    const fallback = fallbackText ?? DEFAULT_FALLBACK_TEXT;

    const snapshotContext: {
      route: 'safe';
      failSoft: boolean;
      chatIdRaw?: string;
      chatIdUsed?: string;
    } = { route: 'safe', failSoft: true };

    if (chat.id) {
      snapshotContext.chatIdRaw = chat.id;
      snapshotContext.chatIdUsed = chat.id;
    }

    noteTelegramSnapshot({
      ...snapshotContext,
    });

    if (chat.id && !skipFallback) {
      const fallbackLog: Record<string, unknown> = { route: 'safe_webhook_fallback', reason };
      if (name) {
        fallbackLog.errorName = name;
      }
      applyTelegramIdLogFields(fallbackLog, 'chatId', chat.id, { includeValue: false });
      if (chat.threadId) {
        applyTelegramIdLogFields(fallbackLog, 'threadId', chat.threadId, { includeValue: false });
      }

      try {
        await messaging.sendText({
          chatId: chat.id,
          threadId: chat.threadId,
          text: fallback,
        });
        recordTelegramSnapshotAction({
          route: 'safe',
          chatIdRaw: chat.id,
          chatIdUsed: chat.id,
          action: 'sendText',
          ok: true,
          statusCode: 200,
          description: 'OK',
        });
        // eslint-disable-next-line no-console
        console.info('[safe] fallback sent', fallbackLog);
      } catch (sendError) {
        // eslint-disable-next-line no-console
        console.error('[safe][fallback][sendText][error]', {
          ...fallbackLog,
          error: String(sendError),
        });
        const statusCandidate = (sendError as { status?: unknown }).status;
        const descriptionCandidate = (sendError as { description?: unknown }).description;
        recordTelegramSnapshotAction({
          route: 'safe',
          chatIdRaw: chat.id,
          chatIdUsed: chat.id,
          action: 'sendText',
          ok: false,
          statusCode: typeof statusCandidate === 'number' ? statusCandidate : null,
          description:
            typeof descriptionCandidate === 'string' && descriptionCandidate.trim().length > 0
              ? descriptionCandidate
              : undefined,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      }
    } else if (skipFallback) {
      // eslint-disable-next-line no-console
      console.info('[safe] fallback skipped', {
        route: 'safe_webhook_fallback',
        reason,
        errorName: name ?? undefined,
      });
    }

    const body = JSON.stringify({ status: 'ok' });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });
  }
}
