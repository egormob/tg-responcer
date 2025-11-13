import type { AiPort, AiQueueStats } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateAiQueueDiagRouteOptions {
  ai: AiPort;
}

const isAiQueueSupported = (ai: AiPort): ai is AiPort & { getQueueStats: NonNullable<AiPort['getQueueStats']> } =>
  typeof ai.getQueueStats === 'function';

const WARNING_THRESHOLD_RATIO = 0.75;

type QueueStatus = 'ok' | 'warning' | 'degraded';

const computeQueueStatus = (stats: AiQueueStats): QueueStatus => {
  if (stats.droppedSinceBoot > 0) {
    return 'degraded';
  }

  if (stats.maxQueue > 0 && stats.queued >= stats.maxQueue) {
    return 'degraded';
  }

  const warningThreshold = Math.max(1, Math.floor(stats.maxQueue * WARNING_THRESHOLD_RATIO));
  if (stats.queued >= warningThreshold && stats.maxQueue > 0) {
    return 'warning';
  }

  if (stats.active >= stats.maxConcurrency && stats.queued > 0) {
    return 'warning';
  }

  return 'ok';
};

const normalizeLastDropAt = (value: number | null): string | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }

  return null;
};

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

    const status = computeQueueStatus(stats);
    const lastDropAt = normalizeLastDropAt(stats.lastDropAt);

    return json({
      status,
      active: stats.active,
      queued: stats.queued,
      maxConcurrency: stats.maxConcurrency,
      maxQueue: stats.maxQueue,
      droppedSinceBoot: stats.droppedSinceBoot,
      avgWaitMs: stats.avgWaitMs,
      lastDropAt,
      requestTimeoutMs: stats.requestTimeoutMs ?? null,
      retryMax: stats.retryMax ?? null,
      sources: stats.sources ?? null,
    });
  };
