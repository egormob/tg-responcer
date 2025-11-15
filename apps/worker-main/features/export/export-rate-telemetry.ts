import type { RateLimitPort } from '../../ports';

export interface ExportRateTelemetryRecordInput {
  decision: Awaited<ReturnType<RateLimitPort['checkAndIncrement']>>;
  userIdHash?: string;
  timestamp?: Date;
}

export interface ExportRateTelemetryRecordResult {
  decision: Awaited<ReturnType<RateLimitPort['checkAndIncrement']>>;
  bucket?: number;
  limit?: number;
  remaining?: number;
  windowMs?: number;
  timestamp: Date;
  userIdHash?: string;
}

export interface ExportRateTelemetrySnapshot {
  status: 'ok';
  feature: 'admin_export_rate_limit';
  limit?: number;
  windowMs?: number;
  totals: { ok: number; limit: number };
  buckets: Array<{
    bucket: number;
    ok: number;
    limit: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastUserIdHash?: string;
  }>;
  lastLimit?: {
    at: string;
    bucket?: number;
    userIdHash?: string;
    remaining?: number;
  } | null;
}

export interface ExportRateTelemetryOptions {
  limit?: number;
  windowMs?: number;
  now?: () => Date;
  maxBuckets?: number;
}

export interface ExportRateTelemetry {
  record(input: ExportRateTelemetryRecordInput): ExportRateTelemetryRecordResult;
  snapshot(): ExportRateTelemetrySnapshot;
}

interface BucketStats {
  bucket: number;
  ok: number;
  limit: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastUserIdHash?: string;
}

const DEFAULT_MAX_BUCKETS = 24;

export const createExportRateTelemetry = (
  options: ExportRateTelemetryOptions = {},
): ExportRateTelemetry => {
  const limit = options.limit;
  const windowMs = options.windowMs;
  const maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
  const now = options.now ?? (() => new Date());

  const totals = { ok: 0, limit: 0 };
  const buckets = new Map<number, BucketStats>();
  const bucketOrder: number[] = [];

  let lastLimitEvent: ExportRateTelemetryRecordResult['timestamp'] | undefined;
  let lastLimitSnapshot: ExportRateTelemetrySnapshot['lastLimit'] = null;

  const computeBucket = (timestampMs: number): number | undefined => {
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      return undefined;
    }

    return Math.floor(timestampMs / windowMs);
  };

  const pruneBuckets = () => {
    while (bucketOrder.length > maxBuckets) {
      const oldest = bucketOrder.shift();
      if (typeof oldest === 'number') {
        buckets.delete(oldest);
      }
    }
  };

  const getOrCreateBucket = (bucket: number, timestampMs: number): BucketStats => {
    const existing = buckets.get(bucket);
    if (existing) {
      return existing;
    }

    const stats: BucketStats = {
      bucket,
      ok: 0,
      limit: 0,
      firstSeenAt: timestampMs,
      lastSeenAt: timestampMs,
    };
    buckets.set(bucket, stats);
    bucketOrder.push(bucket);
    pruneBuckets();
    return stats;
  };

  const record = (
    input: ExportRateTelemetryRecordInput,
  ): ExportRateTelemetryRecordResult => {
    const timestamp = input.timestamp ?? now();
    const timestampMs = timestamp.getTime();
    const bucket = computeBucket(timestampMs);

    if (input.decision === 'ok') {
      totals.ok += 1;
    } else if (input.decision === 'limit') {
      totals.limit += 1;
    }

    let bucketStats: BucketStats | undefined;
    if (typeof bucket === 'number') {
      bucketStats = getOrCreateBucket(bucket, timestampMs);
      bucketStats.lastSeenAt = timestampMs;
      bucketStats.lastUserIdHash = input.userIdHash ?? bucketStats.lastUserIdHash;
      if (input.decision === 'ok') {
        bucketStats.ok += 1;
      } else if (input.decision === 'limit') {
        bucketStats.limit += 1;
      }
    }

    const remaining =
      typeof limit === 'number' && bucketStats
        ? Math.max(0, limit - bucketStats.ok)
        : undefined;

    const recordResult: ExportRateTelemetryRecordResult = {
      decision: input.decision,
      bucket,
      limit,
      remaining,
      windowMs,
      timestamp,
      userIdHash: input.userIdHash,
    };

    if (input.decision === 'limit') {
      lastLimitEvent = timestamp;
      lastLimitSnapshot = {
        at: timestamp.toISOString(),
        bucket,
        userIdHash: input.userIdHash,
        remaining,
      };
    }

    return recordResult;
  };

  const snapshot = (): ExportRateTelemetrySnapshot => {
    const bucketSnapshots = Array.from(buckets.values())
      .sort((a, b) => a.bucket - b.bucket)
      .map((stats) => ({
        bucket: stats.bucket,
        ok: stats.ok,
        limit: stats.limit,
        firstSeenAt: new Date(stats.firstSeenAt).toISOString(),
        lastSeenAt: new Date(stats.lastSeenAt).toISOString(),
        lastUserIdHash: stats.lastUserIdHash,
      }));

    return {
      status: 'ok',
      feature: 'admin_export_rate_limit',
      limit,
      windowMs,
      totals: { ...totals },
      buckets: bucketSnapshots,
      lastLimit: lastLimitEvent ? lastLimitSnapshot : null,
    };
  };

  return { record, snapshot };
};
