import type { MessagingPort } from '../ports';

export interface MessagingQuotaLogger {
  warn?(message: string, details?: Record<string, unknown>): void;
}

export interface MessagingQuotaOptions {
  maxParallel?: number;
  maxRps?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  logger?: MessagingQuotaLogger;
  priority?: 'high' | 'normal';
  sharedState?: MessagingQuotaSharedState;
}

interface MessagingJob<Result> {
  task: () => Promise<Result>;
  resolve: (value: Result) => void;
  reject: (reason: unknown) => void;
}

export interface MessagingQuotaSharedState {
  queue: {
    high: Array<MessagingJob<unknown>>;
    normal: Array<MessagingJob<unknown>>;
  };
  active: number;
  recentStarts: number[];
  observedMaxQueue: number;
  limits?: { maxParallel: number; maxRps: number };
}

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_RPS = 28;

const createWait = (wait?: (ms: number) => Promise<void>) =>
  wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

const createSharedState = (): MessagingQuotaSharedState => ({
  queue: { high: [], normal: [] },
  active: 0,
  recentStarts: [],
  observedMaxQueue: 0,
});

const sanitizeLimit = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
};

export const createQueuedMessagingPort = (
  messaging: MessagingPort,
  options: MessagingQuotaOptions,
): MessagingPort => {
  const maxParallel = sanitizeLimit(options.maxParallel, DEFAULT_MAX_PARALLEL);
  const maxRps = sanitizeLimit(options.maxRps, DEFAULT_MAX_RPS);
  const now = options.now ?? (() => Date.now());
  const wait = createWait(options.wait);
  const logger = options.logger;
  const state = options.sharedState ?? createSharedState();
  const priority = options.priority ?? 'normal';

  if (!state.limits) {
    state.limits = { maxParallel, maxRps };
  } else if (state.limits.maxParallel !== maxParallel || state.limits.maxRps !== maxRps) {
    logger?.warn?.('messaging quota shared limits mismatch', {
      previous: state.limits,
      next: { maxParallel, maxRps },
    });
  }

  const resolvedMaxParallel = state.limits.maxParallel;
  const resolvedMaxRps = state.limits.maxRps;

  const reserveRateSlot = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const timestamp = now();
      const windowStart = timestamp - 1000;
      while (state.recentStarts.length > 0 && state.recentStarts[0] <= windowStart) {
        state.recentStarts.shift();
      }

      if (state.recentStarts.length < resolvedMaxRps) {
        state.recentStarts.push(timestamp);
        return;
      }

      const nextAllowedAt = (state.recentStarts[0] ?? timestamp) + 1000;
      const delayMs = Math.max(1, nextAllowedAt - timestamp);
      logger?.warn?.('messaging quota throttled sendText', {
        delayMs,
        queueSize: state.queue.high.length + state.queue.normal.length,
        maxParallel: resolvedMaxParallel,
        maxRps: resolvedMaxRps,
      });
      await wait(delayMs);
    }
  };

  const processQueue = () => {
    while (state.active < resolvedMaxParallel) {
      const job = state.queue.high.shift() ?? state.queue.normal.shift();
      if (!job) {
        return;
      }

      state.active += 1;
      void (async () => {
        try {
          await reserveRateSlot();
          const result = await job.task();
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          state.active -= 1;
          processQueue();
        }
      })();
    }
  };

  const schedule = <Result>(task: () => Promise<Result>): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      state.queue[priority].push({ task, resolve, reject });
      const queueSize = state.queue.high.length + state.queue.normal.length;

      if (queueSize > state.observedMaxQueue && queueSize >= resolvedMaxParallel) {
        state.observedMaxQueue = queueSize;
        logger?.warn?.('messaging quota queue backlog', {
          queueSize,
          active: state.active,
          maxParallel: resolvedMaxParallel,
          maxRps: resolvedMaxRps,
        });
      }

      processQueue();
    });

  return {
    async sendTyping(input) {
      return messaging.sendTyping(input);
    },
    async sendText(input) {
      return schedule(() => messaging.sendText(input));
    },
    async editMessageText(input) {
      return messaging.editMessageText(input);
    },
    async deleteMessage(input) {
      return messaging.deleteMessage(input);
    },
  } satisfies MessagingPort;
};

export type QueuedMessagingPort = ReturnType<typeof createQueuedMessagingPort>;
