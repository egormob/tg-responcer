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
}

interface MessagingJob<Result> {
  task: () => Promise<Result>;
  resolve: (value: Result) => void;
  reject: (reason: unknown) => void;
}

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_RPS = 28;

const createWait = (wait?: (ms: number) => Promise<void>) =>
  wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

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

  const queue: Array<MessagingJob<unknown>> = [];
  let active = 0;
  const recentStarts: number[] = [];

  const reserveRateSlot = async () => {
    while (true) {
      const timestamp = now();
      const windowStart = timestamp - 1000;
      while (recentStarts.length > 0 && recentStarts[0] <= windowStart) {
        recentStarts.shift();
      }

      if (recentStarts.length < maxRps) {
        recentStarts.push(timestamp);
        return;
      }

      const nextAllowedAt = (recentStarts[0] ?? timestamp) + 1000;
      const delayMs = Math.max(1, nextAllowedAt - timestamp);
      logger?.warn?.('messaging quota throttled sendText', {
        delayMs,
        queueSize: queue.length,
        maxParallel,
        maxRps,
      });
      await wait(delayMs);
    }
  };

  const processQueue = () => {
    while (active < maxParallel && queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        return;
      }

      active += 1;
      void (async () => {
        try {
          await reserveRateSlot();
          const result = await job.task();
          job.resolve(result);
        } catch (error) {
          job.reject(error);
        } finally {
          active -= 1;
          processQueue();
        }
      })();
    }
  };

  const schedule = <Result>(task: () => Promise<Result>): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      queue.push({ task, resolve, reject });
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
