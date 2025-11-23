import type { AiPort, AiQueueStats } from '../../ports';
import type { AiBackpressureGuardStats } from '../../http';
import { json } from '../../shared/json-response';

export interface CreateAiQueueDiagRouteOptions {
  ai: AiPort;
  guard?: {
    getStats(): AiBackpressureGuardStats;
    getAggregatedStats?(): Promise<AiBackpressureGuardStats> | AiBackpressureGuardStats;
  };
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

    const body: Record<string, unknown> = {
      status,
      active: stats.active,
      queued: stats.queued,
      maxConcurrency: stats.maxConcurrency,
      maxQueue: stats.maxQueue,
      requestTimeoutMs: stats.requestTimeoutMs,
      retryMax: stats.retryMax,
      droppedSinceBoot: stats.droppedSinceBoot,
      avgWaitMs: stats.avgWaitMs,
      lastDropAt,
      endpoints: {
        activeBaseUrl: stats.endpoints.activeBaseUrl,
        backupBaseUrls: stats.endpoints.backupBaseUrls,
        failoverCounts: stats.endpoints.failoverCounts,
      },
      sources: {
        maxConcurrency: stats.sources.maxConcurrency,
        maxQueueSize: stats.sources.maxQueueSize,
        requestTimeoutMs: stats.sources.requestTimeoutMs,
        retryMax: stats.sources.retryMax,
        baseUrls: stats.sources.baseUrls,
        endpointFailoverThreshold: stats.sources.endpointFailoverThreshold,
        kvConfig: stats.sources.kvConfig,
      },
    };

    if (options.guard) {
      const guardStats = typeof options.guard.getAggregatedStats === 'function'
        ? await options.guard.getAggregatedStats()
        : options.guard.getStats();
      body.guard = {
        activeChats: guardStats.activeChats,
        bufferedChats: guardStats.bufferedChats,
        blockedSinceBoot: guardStats.blockedSinceBoot,
        mergedSinceBoot: guardStats.mergedSinceBoot,
        truncatedSinceBoot: guardStats.truncatedSinceBoot,
        kvErrorsSinceBoot: guardStats.kvErrorsSinceBoot,
        lastBlockedAt: guardStats.lastBlockedAt
          ? new Date(guardStats.lastBlockedAt).toISOString()
          : null,
      };
    }

    return json(body);
  };
