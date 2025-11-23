import type { StoragePort } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateD1StressRouteOptions {
  storage: StoragePort;
  uuid?: () => string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  logger?: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
  };
}

type StressOperation = 'saveUser' | 'appendMessage';

interface StressTotals {
  ops: Record<StressOperation | 'all', number>;
  success: number;
  successAfterRetryGe3: number;
  maxRetriesExceeded: number;
  nonRetryable: number;
}

const DEFAULT_DURATION_SEC = 120;
const MAX_DURATION_SEC = 300;
const AUTO_CONCURRENCY_MIN = 8;
const AUTO_CONCURRENCY_MAX = 32;
const MAX_CONCURRENCY = 32;
const MAX_RETRY_ATTEMPTS = 6;

const defaultUuid = () => crypto.randomUUID();
const defaultNow = () => Date.now();
const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultLogger: Required<CreateD1StressRouteOptions['logger']> = {
  info: (message, details) => {
    console.info(message, details);
  },
  warn: (message, details) => {
    console.warn(message, details);
  },
  error: (message, details) => {
    console.error(message, details);
  },
};

const getErrorCode = (error: unknown): string => {
  if (!error) {
    return 'UnknownError';
  }

  if (typeof error === 'object' && error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code.trim();
    }

    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim();
    }
  }

  if (error instanceof Error) {
    return error.name || error.constructor.name;
  }

  return typeof error;
};

const getErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return undefined;
};

const NON_RETRYABLE_ERROR_PATTERNS = [
  /SQLITE_CONSTRAINT/i,
  /constraint failed/i,
  /no such table/i,
  /no such column/i,
  /has no column named/i,
  /syntax error/i,
  /wrong number of arguments/i,
  /malformed/i,
  /schema/i,
];

const isRetryableError = (error: unknown): boolean => {
  if (!error) {
    return true;
  }

  const message = getErrorMessage(error);
  if (typeof message === 'string') {
    if (NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return false;
    }
  }

  if (typeof error === 'object' && error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (/SQLITE_CONSTRAINT/i.test(code) || /VALIDATION/i.test(code)) {
        return false;
      }
    }

    const status = (error as { status?: unknown }).status;
    if (status === 400 || status === 422) {
      return false;
    }
  }

  return true;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const parseDurationSeconds = (value: string | null | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return clamp(parsed, 1, MAX_DURATION_SEC);
};

type ConcurrencySetting = { mode: 'auto' } | { mode: 'manual'; size: number };

const parseConcurrency = (value: string | null | undefined): ConcurrencySetting => {
  if (!value || value.trim().length === 0) {
    return { mode: 'auto' };
  }

  if (value.toLowerCase() === 'auto') {
    return { mode: 'auto' };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { mode: 'auto' };
  }

  return { mode: 'manual', size: clamp(parsed, 1, MAX_CONCURRENCY) };
};

const createAttemptsDistribution = () => ({
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
});

export const createD1StressRoute = (options: CreateD1StressRouteOptions) => {
  const uuid = options.uuid ?? defaultUuid;
  const now = options.now ?? defaultNow;
  const wait = options.wait ?? defaultWait;
  const logger = options.logger ?? defaultLogger;

  const logEvent = (
    level: 'info' | 'warn' | 'error',
    tag: string,
    runId: string,
    details: Record<string, unknown>,
  ) => {
    const parts: string[] = [tag];
    if (details.op) {
      parts.push(`op=${details.op}`);
    }
    if (typeof details.attempt === 'number') {
      parts.push(`attempt=${details.attempt}`);
    }
    if (typeof details.attempts === 'number') {
      parts.push(`attempts=${details.attempts}`);
    }
    if (details.error) {
      parts.push(`error=${details.error}`);
    }
    if (typeof details.durationSec === 'number') {
      parts.push(`durationSec=${details.durationSec}`);
    }
    if (typeof details.concurrency === 'number') {
      parts.push(`concurrency=${details.concurrency}`);
    }

    const message = parts.join(' ');
    const payload = {
      ...details,
      runId,
      $metadata: { message },
    };

    switch (level) {
      case 'info':
        logger.info(message, payload);
        break;
      case 'warn':
        logger.warn(message, payload);
        break;
      case 'error':
        logger.error(message, payload);
        break;
      default:
        logger.info(message, payload);
    }
  };

  const runStress = async (
    durationSec: number,
    concurrencySetting: ConcurrencySetting,
  ) => {
    const runId = uuid();
    const durationMs = durationSec * 1000;
    const startedAt = now();
    const deadline = startedAt + durationMs;
    const totals: StressTotals = {
      ops: { saveUser: 0, appendMessage: 0, all: 0 },
      success: 0,
      successAfterRetryGe3: 0,
      maxRetriesExceeded: 0,
      nonRetryable: 0,
    };
    const attemptsDistribution = createAttemptsDistribution();

    const messageCounters: number[] = [];
    const nextOperation: StressOperation[] = [];

    const getNextOperation = (threadIndex: number): StressOperation => {
      if (!nextOperation[threadIndex]) {
        nextOperation[threadIndex] = 'saveUser';
      }

      const op = nextOperation[threadIndex];
      nextOperation[threadIndex] = op === 'saveUser' ? 'appendMessage' : 'saveUser';
      return op;
    };

    const recordAttemptsDistribution = (attempts: number) => {
      const key = clamp(attempts, 1, MAX_RETRY_ATTEMPTS) as keyof typeof attemptsDistribution;
      attemptsDistribution[key] += 1;
    };

    const userIdForThread = (threadIndex: number) => `stress:${runId}:${threadIndex}`;
    const chatIdForThread = (threadIndex: number) => `stress:${runId}:${threadIndex}`;

    const executeOperation = async (threadIndex: number, op: StressOperation) => {
      totals.ops[op] += 1;
      totals.ops.all += 1;

      let attempt = 0;
      const metadata = { stress: true, runId, op } satisfies Record<string, unknown>;

      while (attempt < MAX_RETRY_ATTEMPTS) {
        attempt += 1;

        try {
          if (op === 'saveUser') {
            await options.storage.saveUser({
              userId: userIdForThread(threadIndex),
              username: `stress_user_${threadIndex}`,
              firstName: 'Stress',
              lastName: `Thread ${threadIndex}`,
              languageCode: 'en',
              utmSource: 'stress_test',
              metadata,
              updatedAt: new Date(now()),
            });
          } else {
            const current = messageCounters[threadIndex] ?? 0;
            const next = current + 1;
            messageCounters[threadIndex] = next;
            await options.storage.appendMessage({
              userId: userIdForThread(threadIndex),
              chatId: chatIdForThread(threadIndex),
              role: next % 2 === 0 ? 'assistant' : 'user',
              text: `stress-run ${runId} thread=${threadIndex} seq=${next}`,
              timestamp: new Date(now()),
              metadata,
            });
          }

          totals.success += 1;
          recordAttemptsDistribution(attempt);

          if (attempt >= 3) {
            totals.successAfterRetryGe3 += 1;
            logEvent('info', '[d1-stress][success_after_retry]', runId, {
              op,
              attempts: attempt,
            });
          }

          return;
        } catch (error) {
          const retryable = isRetryableError(error);
          const errorCode = getErrorCode(error);
          const errorMessage = getErrorMessage(error);

          if (!retryable) {
            totals.nonRetryable += 1;
            recordAttemptsDistribution(attempt);
            logEvent('error', '[d1-stress][non_retryable]', runId, {
              op,
              attempt,
              error: errorCode,
              errorMessage,
            });
            return;
          }

          if (attempt >= MAX_RETRY_ATTEMPTS) {
            totals.maxRetriesExceeded += 1;
            recordAttemptsDistribution(attempt);
            logEvent('error', '[d1-stress][max_retries_exceeded]', runId, {
              op,
              attempts: attempt,
              error: errorCode,
              errorMessage,
            });
            return;
          }

          logEvent('warn', '[d1-stress][retry]', runId, {
            op,
            attempt,
            error: errorCode,
            errorMessage,
          });
        }
      }
    };

    logEvent('info', '[d1-stress][start]', runId, {
      durationSec,
      concurrency: concurrencySetting.mode === 'manual' ? concurrencySetting.size : AUTO_CONCURRENCY_MIN,
    });

    const workers: Promise<void>[] = [];
    const manualConcurrency = concurrencySetting.mode === 'manual' ? concurrencySetting.size : undefined;
    const maxWorkers = manualConcurrency ?? AUTO_CONCURRENCY_MAX;
    let currentAutoConcurrency = AUTO_CONCURRENCY_MIN;
    let maxObservedConcurrency = manualConcurrency ?? currentAutoConcurrency;
    let adjusting = true;

    const shouldStop = () => now() >= deadline;

    const updateAutoConcurrency = async () => {
      if (concurrencySetting.mode !== 'auto') {
        return;
      }

      while (!shouldStop()) {
        const elapsed = now() - startedAt;
        const progress = durationMs > 0 ? clamp(elapsed / durationMs, 0, 1) : 1;
        const target = Math.round(
          AUTO_CONCURRENCY_MIN + progress * (AUTO_CONCURRENCY_MAX - AUTO_CONCURRENCY_MIN),
        );
        currentAutoConcurrency = clamp(target, AUTO_CONCURRENCY_MIN, AUTO_CONCURRENCY_MAX);
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentAutoConcurrency);
        await wait(1000);
      }

      adjusting = false;
    };

    const getEffectiveConcurrency = () => {
      if (manualConcurrency !== undefined) {
        return manualConcurrency;
      }

      return currentAutoConcurrency;
    };

    const worker = async (threadIndex: number) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (shouldStop()) {
          break;
        }

        const activeConcurrency = getEffectiveConcurrency();
        if (threadIndex >= activeConcurrency) {
          await wait(25);
          continue;
        }

        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrency);

        const op = getNextOperation(threadIndex);
        await executeOperation(threadIndex, op);

        await wait(0);
      }
    };

    if (concurrencySetting.mode === 'auto') {
      workers.push(updateAutoConcurrency());
    }

    for (let thread = 0; thread < maxWorkers; thread += 1) {
      workers.push(worker(thread));
    }

    await Promise.all(workers);

    if (adjusting) {
      adjusting = false;
    }

    const finishedAt = now();
    const actualDuration = Math.max(0, finishedAt - startedAt);

    const result = {
      runId,
      durationMs: actualDuration,
      concurrency: manualConcurrency ?? maxObservedConcurrency,
      totals,
      attemptsDistribution,
    };

    logEvent('info', '[d1-stress][done]', runId, {
      totals,
      attemptsDistribution,
      durationSec: Math.round(actualDuration / 1000),
      concurrency: result.concurrency,
    });

    return result;
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return json({ error: 'Method Not Allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
    const durationParam = parseDurationSeconds(url.searchParams.get('durationSec'))
      ?? DEFAULT_DURATION_SEC;
    const concurrencySetting = parseConcurrency(url.searchParams.get('concurrency'));

    const result = await runStress(durationParam, concurrencySetting);

    return json({
      runId: result.runId,
      durationMs: result.durationMs,
      concurrency: result.concurrency,
      totals: {
        ops: result.totals.ops,
        success: result.totals.success,
        successAfterRetryGe3: result.totals.successAfterRetryGe3,
        maxRetriesExceeded: result.totals.maxRetriesExceeded,
        nonRetryable: result.totals.nonRetryable,
      },
      attemptsDistribution: result.attemptsDistribution,
    });
  };
};
