import type { MessagingPort } from '../../ports';
import type { BroadcastJob, BroadcastQueue } from './broadcast-queue';
import type { BroadcastJobProgress, BroadcastProgressStore } from './broadcast-progress-store';

export interface BroadcastRecipient {
  readonly chatId: string;
  readonly threadId?: string;
}

export type ResolveBroadcastRecipients = (
  job: BroadcastJob,
) => Promise<readonly BroadcastRecipient[]> | readonly BroadcastRecipient[];

export interface BroadcastSchedulerLogger {
  debug?(message: string, details?: Record<string, unknown>): void;
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface BroadcastSchedulerOptions {
  queue: BroadcastQueue;
  messaging: MessagingPort;
  resolveRecipients: ResolveBroadcastRecipients;
  progressStore: BroadcastProgressStore;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
  perRecipientDelayMs?: number;
  recipientMaxAttempts?: number;
  maxJobAttempts?: number;
  logger?: BroadcastSchedulerLogger;
}

export interface BroadcastScheduler {
  processPendingJobs(): Promise<void>;
}

const DEFAULT_PER_RECIPIENT_DELAY_MS = 1_000;
const DEFAULT_RECIPIENT_MAX_ATTEMPTS = 3;
const DEFAULT_JOB_MAX_ATTEMPTS = 3;

const createWait = (wait?: (ms: number) => Promise<void>) =>
  wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

const toRecipientKey = (recipient: BroadcastRecipient): string =>
  recipient.threadId ? `${recipient.chatId}:${recipient.threadId}` : recipient.chatId;

const extractRetryAfterMs = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const maybeMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof maybeMs === 'number' && Number.isFinite(maybeMs) && maybeMs > 0) {
    return maybeMs;
  }

  const maybeSeconds = (error as { retry_after?: unknown }).retry_after;
  if (typeof maybeSeconds === 'number' && Number.isFinite(maybeSeconds) && maybeSeconds > 0) {
    return maybeSeconds * 1_000;
  }

  return undefined;
};

export const createBroadcastScheduler = (options: BroadcastSchedulerOptions): BroadcastScheduler => {
  const wait = createWait(options.wait);
  const now = options.now ?? (() => new Date());
  const perRecipientDelayMs = Math.max(0, options.perRecipientDelayMs ?? DEFAULT_PER_RECIPIENT_DELAY_MS);
  const recipientMaxAttempts = Math.max(1, options.recipientMaxAttempts ?? DEFAULT_RECIPIENT_MAX_ATTEMPTS);
  const maxJobAttempts = Math.max(1, options.maxJobAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS);
  const logger = options.logger;

  const runJob = async (job: BroadcastJob) => {
    const claim = options.queue.updateJob(job.id, {
      status: 'processing',
      attempts: job.attempts + 1,
      lastError: null,
      updatedAt: now(),
    });

    if (!claim) {
      logger?.debug?.('broadcast job skipped because it was already claimed', { jobId: job.id });
      return;
    }

    let recipients: readonly BroadcastRecipient[];
    try {
      const resolvedRecipients = await options.resolveRecipients(claim);
      recipients = Array.isArray(resolvedRecipients) ? resolvedRecipients : [resolvedRecipients];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.progressStore.write(claim.id, {
        deliveredTargetKeys: [],
        attempt: claim.attempts,
        updatedAt: now(),
        lastError: message,
      });

      options.queue.updateJob(claim.id, {
        status: 'failed',
        updatedAt: now(),
        lastError: message,
        attempts: claim.attempts,
      });

      logger?.error?.('broadcast job audience resolution failed', { jobId: claim.id, error: message });
      return;
    }

    const initialProgress = await options.progressStore.read(claim.id);
    const delivered = new Set(initialProgress?.deliveredTargetKeys ?? []);
    let lastError = initialProgress?.lastError;
    const attemptRecord = claim.attempts;

    const persistProgress = async (
      update: { delivered?: string[]; lastError?: string | null } = {},
    ) => {
      if (update.lastError !== undefined) {
        lastError = update.lastError === null ? undefined : update.lastError;
      }

      const payload: BroadcastJobProgress = {
        deliveredTargetKeys: update.delivered ?? Array.from(delivered),
        attempt: attemptRecord,
        updatedAt: now(),
        lastError,
      };

      await options.progressStore.write(claim.id, payload);
    };

    if (lastError !== undefined) {
      await persistProgress({ lastError: null });
    } else if (!initialProgress || initialProgress.attempt !== attemptRecord) {
      await persistProgress();
    }

    if (recipients.length === 0) {
      await options.progressStore.delete(claim.id);
      options.queue.updateJob(claim.id, {
        status: 'completed',
        updatedAt: now(),
        lastError: null,
        attempts: claim.attempts,
      });
      logger?.info?.('broadcast job completed with empty audience', { jobId: claim.id });
      return;
    }

    const pendingRecipients = recipients.filter((recipient) => !delivered.has(toRecipientKey(recipient)));

    const sendWithRetries = async (recipient: BroadcastRecipient): Promise<string | undefined> => {
      let attempt = 0;
      let lastError: unknown;

      while (attempt < recipientMaxAttempts) {
        try {
          const result = await options.messaging.sendText({
            chatId: recipient.chatId,
            threadId: recipient.threadId,
            text: claim.payload.text,
          });
          return result?.messageId;
        } catch (error) {
          lastError = error;
          attempt += 1;
          const retryAfterMs = extractRetryAfterMs(error) ?? perRecipientDelayMs;
          if (attempt >= recipientMaxAttempts) {
            throw error instanceof Error ? error : lastError instanceof Error ? lastError : new Error(String(error));
          }

          if (retryAfterMs > 0) {
            await wait(retryAfterMs);
          }
        }
      }

      if (lastError instanceof Error) {
        throw lastError;
      }

      throw new Error('broadcast message delivery failed without explicit error');
    };

    try {
      for (let index = 0; index < pendingRecipients.length; index += 1) {
        const recipient = pendingRecipients[index];
        const key = toRecipientKey(recipient);
        const messageId = await sendWithRetries(recipient);
        delivered.add(key);
        await persistProgress({ delivered: Array.from(delivered) });

        const recipientLogDetails: Record<string, unknown> = { jobId: claim.id, recipient: key };
        if (messageId) {
          recipientLogDetails.messageId = messageId;
        }
        logger?.debug?.('broadcast recipient delivered', recipientLogDetails);

        if (perRecipientDelayMs > 0 && index < pendingRecipients.length - 1) {
          await wait(perRecipientDelayMs);
        }
      }

      await options.progressStore.delete(claim.id);
      options.queue.updateJob(claim.id, {
        status: 'completed',
        updatedAt: now(),
        lastError: null,
        attempts: claim.attempts,
      });
      logger?.info?.('broadcast job completed', { jobId: claim.id, recipients: delivered.size });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextStatus = claim.attempts >= maxJobAttempts ? 'failed' : 'pending';
      await persistProgress({ lastError: message });

      options.queue.updateJob(claim.id, {
        status: nextStatus,
        updatedAt: now(),
        lastError: message,
        attempts: claim.attempts,
      });

      if (nextStatus === 'failed') {
        logger?.error?.('broadcast job failed', { jobId: claim.id, error: message });
      } else {
        logger?.warn?.('broadcast job postponed for retry', { jobId: claim.id, error: message });
      }
    }
  };

  return {
    async processPendingJobs() {
      const snapshot = options.queue.list();
      for (const job of snapshot.jobs) {
        if (job.status !== 'pending') {
          continue;
        }

        await runJob(job);
      }
    },
  };
};
