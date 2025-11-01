import type { AiPort, MessagingPort } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateSelfTestRouteOptions {
  ai: AiPort;
  messaging: MessagingPort;
  now?: () => number;
}

const defaultNow = () => Date.now();

export const createSelfTestRoute = (options: CreateSelfTestRouteOptions) => {
  const now = options.now ?? defaultNow;

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const url = new URL(request.url);
    const chatIdParam = url.searchParams.get('chatId') ?? url.searchParams.get('chat_id');
    const threadIdParam = url.searchParams.get('threadId') ?? url.searchParams.get('thread_id') ?? undefined;
    const textParam = url.searchParams.get('text') ?? 'Self-test ping';

    const errors: string[] = [];

    let openAiOk = false;
    let openAiLatencyMs: number | undefined;
    let openAiUsedOutputText: boolean | undefined;

    const aiStartedAt = now();
    try {
      const reply = await options.ai.reply({
        userId: 'admin:selftest',
        text: 'ping',
        context: [],
      });
      openAiLatencyMs = Math.max(0, now() - aiStartedAt);
      const metadata = reply.metadata as
        | {
            usedOutputText?: unknown;
            selfTestNoop?: unknown;
          }
        | undefined;
      const usedOutputTextRaw = metadata?.usedOutputText;
      openAiUsedOutputText = usedOutputTextRaw === true;

      if (metadata?.selfTestNoop === true) {
        errors.push('openai: noop adapter response');
      } else if (usedOutputTextRaw !== true) {
        errors.push('openai: missing diagnostic marker');
      } else {
        openAiOk = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`openai: ${message}`);
    }

    let telegramOk = false;
    let telegramLatencyMs: number | undefined;
    let telegramMessageId: string | undefined;

    if (!chatIdParam) {
      errors.push('telegram: chatId query parameter is required');
    } else {
      const telegramStartedAt = now();
      try {
        await options.messaging.sendTyping({
          chatId: chatIdParam,
          threadId: threadIdParam ?? undefined,
        });

        const result = await options.messaging.sendText({
          chatId: chatIdParam,
          threadId: threadIdParam ?? undefined,
          text: textParam,
        });

        telegramOk = true;
        telegramLatencyMs = Math.max(0, now() - telegramStartedAt);
        telegramMessageId = result.messageId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`telegram: ${message}`);
      }
    }

    const responseBody: Record<string, unknown> = {
      openAiOk,
      telegramOk,
      errors,
    };

    if (openAiLatencyMs !== undefined) {
      responseBody.openAiLatencyMs = openAiLatencyMs;
    }

    if (openAiUsedOutputText !== undefined) {
      responseBody.openAiUsedOutputText = openAiUsedOutputText;
    }

    if (telegramLatencyMs !== undefined) {
      responseBody.telegramLatencyMs = telegramLatencyMs;
    }

    if (telegramMessageId !== undefined) {
      responseBody.telegramMessageId = telegramMessageId;
    }

    const hasErrors = errors.length > 0;

    return json(responseBody, { status: hasErrors ? 500 : 200 });
  };
};
