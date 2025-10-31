import type { MessagingPort } from '../ports';

const DEFAULT_FALLBACK_TEXT =
  '🤖 Я на секунду задумался. Повторите, пожалуйста, вопрос одним предложением.';

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
    // eslint-disable-next-line no-console
    console.error('[safe][error]', String(error));
    const fallback = fallbackText ?? DEFAULT_FALLBACK_TEXT;

    if (chat.id) {
      void messaging
        .sendText({
          chatId: chat.id,
          threadId: chat.threadId,
          text: fallback,
        })
        .then(() => {
          // eslint-disable-next-line no-console
          console.info('[safe] fallback sent');
        })
        .catch((sendError) => {
          // eslint-disable-next-line no-console
          console.error('[safe][fallback][sendText][error]', String(sendError));
        });
    }

    return new Response('ok', { status: 200 });
  }
}
