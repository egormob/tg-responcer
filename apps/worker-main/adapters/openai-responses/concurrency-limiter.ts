export interface AiLimiterConfig {
  maxConcurrency: number;
  maxQueueSize: number;
  now?: () => number;
}

export interface AiLimiterStats {
  active: number;
  queued: number;
  dropped: number;
  maxConcurrency: number;
  maxQueueSize: number;
}

export interface AcquireRequestContext {
  onQueue?: (stats: AiLimiterStats) => void;
  onAcquire?: (stats: AiLimiterStats & { queueWaitMs: number }) => void;
  onDrop?: (stats: AiLimiterStats) => void;
}

interface QueueEntry {
  ctx: AcquireRequestContext;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
}

const toInteger = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.floor(value);
};

export const createAiLimiter = (config: AiLimiterConfig) => {
  const maxConcurrency = Math.max(1, toInteger(config.maxConcurrency, 1));
  const maxQueueSize = Math.max(0, toInteger(config.maxQueueSize, 0));
  const now = config.now ?? (() => Date.now());

  let active = 0;
  let dropped = 0;
  const queue: QueueEntry[] = [];

  const getStats = (): AiLimiterStats => ({
    active,
    queued: queue.length,
    dropped,
    maxConcurrency,
    maxQueueSize,
  });

  const drain = () => {
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        break;
      }

      active += 1;
      const queueWaitMs = Math.max(0, now() - entry.enqueuedAt);
      entry.ctx.onAcquire?.({ ...getStats(), queueWaitMs });
      entry.resolve(createRelease());
    }
  };

  const createRelease = (): (() => void) => {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  };

  const acquire = (ctx: AcquireRequestContext = {}): Promise<() => void> => {
    const startedAt = now();

    if (active < maxConcurrency) {
      active += 1;
      ctx.onAcquire?.({ ...getStats(), queueWaitMs: 0 });
      return Promise.resolve(createRelease());
    }

    if (queue.length >= maxQueueSize) {
      dropped += 1;
      const stats = getStats();
      ctx.onDrop?.(stats);
      return Promise.reject(new Error('AI_QUEUE_FULL'));
    }

    return new Promise<() => void>((resolve) => {
      const entry: QueueEntry = {
        ctx,
        enqueuedAt: startedAt,
        resolve,
      };

      queue.push(entry);
      ctx.onQueue?.(getStats());
      drain();
    });
  };

  return {
    acquire,
    getStats,
  };
};
