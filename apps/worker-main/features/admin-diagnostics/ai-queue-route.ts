import type { AiPort } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateAiQueueDiagRouteOptions {
  ai: AiPort;
}

const isAiQueueSupported = (ai: AiPort): ai is AiPort & { getQueueStats: NonNullable<AiPort['getQueueStats']> } =>
  typeof ai.getQueueStats === 'function';

export const createAiQueueDiagRoute = (options: CreateAiQueueDiagRouteOptions) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if ((query ?? '').toLowerCase() !== 'ai-queue') {
      return json(
        { error: 'Unsupported diagnostics query' },
        { status: 400 },
      );
    }

    if (!isAiQueueSupported(options.ai)) {
      return json(
        { error: 'AI queue metrics are not available' },
        { status: 503 },
      );
    }

    const stats = options.ai.getQueueStats();

    return json({
      active: stats.active,
      queued: stats.queued,
      maxConcurrency: stats.maxConcurrency,
      maxQueue: stats.maxQueue,
      droppedSinceBoot: stats.droppedSinceBoot,
      avgWaitMs: stats.avgWaitMs,
    });
  };
