export type BroadcastJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface BroadcastAudienceFilter {
  readonly chatIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly languageCodes?: readonly string[];
}

export interface BroadcastMessagePayload {
  readonly text: string;
  readonly filters?: BroadcastAudienceFilter;
  readonly metadata?: Record<string, unknown>;
}

export interface BroadcastJob {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly requestedBy?: string;
  readonly status: BroadcastJobStatus;
  readonly attempts: number;
  readonly payload: BroadcastMessagePayload;
  readonly lastError?: string;
}

export interface EnqueueBroadcastJobOptions {
  readonly payload: BroadcastMessagePayload;
  readonly requestedBy?: string;
}

export interface BroadcastQueueSnapshot {
  readonly jobs: BroadcastJob[];
}

export interface BroadcastQueue {
  enqueue(options: EnqueueBroadcastJobOptions): BroadcastJob;
  getJob(jobId: string): BroadcastJob | undefined;
  list(): BroadcastQueueSnapshot;
  updateJob(jobId: string, updates: UpdateBroadcastJobOptions): BroadcastJob | undefined;
}

export interface CreateBroadcastQueueOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly maxPending?: number;
}

export interface UpdateBroadcastJobOptions {
  readonly status?: BroadcastJobStatus;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly requestedBy?: string | null;
  readonly updatedAt?: Date;
}

const cloneDate = (value: Date): Date => new Date(value.getTime());

const cloneFilters = (filters: BroadcastAudienceFilter | undefined): BroadcastAudienceFilter | undefined => {
  if (!filters) {
    return undefined;
  }

  return {
    chatIds: filters.chatIds ? [...filters.chatIds] : undefined,
    userIds: filters.userIds ? [...filters.userIds] : undefined,
    languageCodes: filters.languageCodes ? [...filters.languageCodes] : undefined,
  } satisfies BroadcastAudienceFilter;
};

const cloneMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) {
    return undefined;
  }

  return { ...metadata };
};

const clonePayload = (payload: BroadcastMessagePayload): BroadcastMessagePayload => ({
  text: payload.text,
  filters: cloneFilters(payload.filters),
  metadata: cloneMetadata(payload.metadata),
});

const cloneJob = (job: BroadcastJob): BroadcastJob => ({
  id: job.id,
  createdAt: cloneDate(job.createdAt),
  updatedAt: cloneDate(job.updatedAt),
  requestedBy: job.requestedBy,
  status: job.status,
  attempts: job.attempts,
  payload: clonePayload(job.payload),
  lastError: job.lastError,
});

const defaultGenerateId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (error) {
    void error;
  }

  return `job_${Math.random().toString(36).slice(2, 12)}`;
};

const defaultNow = () => new Date();

export const createInMemoryBroadcastQueue = (
  options: CreateBroadcastQueueOptions = {},
): BroadcastQueue => {
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? defaultNow;
  const jobs = new Map<string, BroadcastJob>();

  const countPending = () =>
    Array.from(jobs.values()).reduce(
      (accumulator, job) => (job.status === 'pending' ? accumulator + 1 : accumulator),
      0,
    );

  const ensureCapacity = () => {
    if (typeof options.maxPending !== 'number') {
      return;
    }

    if (countPending() >= options.maxPending) {
      throw new Error('Broadcast queue is full');
    }
  };

  const recordJob = (job: BroadcastJob) => {
    jobs.set(job.id, job);
    return cloneJob(job);
  };

  return {
    enqueue({ payload, requestedBy }) {
      ensureCapacity();

      const timestamp = now();
      const job: BroadcastJob = {
        id: generateId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        requestedBy,
        status: 'pending',
        attempts: 0,
        payload,
      };

      return recordJob(job);
    },

    getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? cloneJob(job) : undefined;
    },

    list() {
      return {
        jobs: Array.from(jobs.values())
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((job) => cloneJob(job)),
      } satisfies BroadcastQueueSnapshot;
    },

    updateJob(jobId, updates) {
      const job = jobs.get(jobId);
      if (!job) {
        return undefined;
      }

      if (updates.status === 'processing' && job.status !== 'pending') {
        return undefined;
      }

      const resolvedUpdatedAt = updates.updatedAt ? cloneDate(updates.updatedAt) : now();

      const nextJob: BroadcastJob = {
        ...job,
        status: updates.status ?? job.status,
        attempts: typeof updates.attempts === 'number' ? updates.attempts : job.attempts,
        requestedBy:
          updates.requestedBy === undefined
            ? job.requestedBy
            : updates.requestedBy === null
              ? undefined
              : updates.requestedBy,
        lastError:
          updates.lastError === undefined
            ? job.lastError
            : updates.lastError === null
              ? undefined
              : updates.lastError,
        updatedAt: resolvedUpdatedAt,
      };

      jobs.set(jobId, nextJob);
      return cloneJob(nextJob);
    },
  };
};
