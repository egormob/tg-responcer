import { json } from '../../shared';
import type { BroadcastTelemetry } from './broadcast-telemetry';
import type { BroadcastProgressCheckpoint, BroadcastProgressKvNamespace } from './minimal-broadcast-service';
import { listBroadcastCheckpoints } from './minimal-broadcast-service';

export interface CreateBroadcastDiagRouteOptions {
  telemetry?: BroadcastTelemetry;
  progressKv?: BroadcastProgressKvNamespace;
  now?: () => number;
}

export const createBroadcastDiagRoute = (
  options: CreateBroadcastDiagRouteOptions,
) => async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') {
    return json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const snapshot = options.telemetry ? await options.telemetry.snapshot() : undefined;
  const checkpoints = options.progressKv
    ? await listBroadcastCheckpoints(options.progressKv)
    : [];

  const mostRecentCheckpoint = checkpoints
    .filter((entry) => entry.checkpoint.status === 'running' || entry.checkpoint.status === 'paused')
    .sort((left, right) =>
      new Date(right.checkpoint.updatedAt).getTime() - new Date(left.checkpoint.updatedAt).getTime(),
    )[0]?.checkpoint;

  const clock = options.now ?? Date.now;

  const buildProgress = (checkpoint: BroadcastProgressCheckpoint | undefined) => {
    if (!checkpoint) {
      return null;
    }

    const expiresAt = checkpoint.expiresAt
      ?? (typeof checkpoint.ttlSeconds === 'number'
        ? new Date(new Date(checkpoint.updatedAt).getTime() + checkpoint.ttlSeconds * 1000).toISOString()
        : undefined);
    const ttlSecondsRemaining = expiresAt
      ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - clock()) / 1000))
      : null;
    const remaining = Math.max(0, checkpoint.total - checkpoint.offset);

    return {
      jobId: checkpoint.jobId,
      status: checkpoint.status,
      reason: checkpoint.reason ?? null,
      delivered: checkpoint.delivered,
      failed: checkpoint.failed,
      throttled429: checkpoint.throttled429,
      total: checkpoint.total,
      offset: checkpoint.offset,
      remaining,
      pool: checkpoint.pool,
      batchSize: checkpoint.batchSize ?? null,
      maxBatchTextBytes: checkpoint.maxBatchTextBytes ?? null,
      updatedAt: checkpoint.updatedAt,
      expiresAt: expiresAt ?? null,
      ttlSeconds: checkpoint.ttlSeconds ?? null,
      ttlSecondsRemaining,
      commands: {
        resume: `/broadcast_resume ${checkpoint.jobId}`,
        pause: `/broadcast_pause ${checkpoint.jobId}`,
        status: `/broadcast_status ${checkpoint.jobId}`,
        end: `/broadcast_end ${checkpoint.jobId}`,
        cancel: '/cancel_broadcast',
      },
    };
  };

  if (!snapshot && !mostRecentCheckpoint) {
    return json({ status: 'disabled', feature: 'broadcast_metrics' });
  }

  const progress = buildProgress(mostRecentCheckpoint);
  const baseSnapshot = snapshot ?? {
    status: 'ok' as const,
    feature: 'broadcast_metrics' as const,
    totalRuns: 0,
    lastRun: null,
    history: [],
  };

  return json({ ...baseSnapshot, progress });
};
