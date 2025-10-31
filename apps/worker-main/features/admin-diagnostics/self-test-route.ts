import type { AiPort } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateSelfTestRouteOptions {
  ai: AiPort;
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

    const startedAt = now();

    try {
      const reply = await options.ai.reply({
        userId: 'admin:selftest',
        text: 'ping',
        context: [],
      });
      const latencyMs = Math.max(0, now() - startedAt);
      const usedOutputTextRaw = (reply.metadata as { usedOutputText?: unknown } | undefined)?.usedOutputText;
      const usedOutputText = usedOutputTextRaw === true;

      return json({
        ok: true,
        latency_ms: latencyMs,
        used_output_text: usedOutputText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const snippetSource = error instanceof Error ? error.stack ?? error.message : String(error);
      const snippet = snippetSource.slice(0, 500);

      return json(
        {
          ok: false,
          error: message,
          snippet,
        },
        { status: 500 },
      );
    }
  };
};
