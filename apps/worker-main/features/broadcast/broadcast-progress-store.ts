export interface BroadcastJobProgress {
  readonly deliveredTargetKeys: readonly string[];
  readonly attempt: number;
  readonly updatedAt: Date;
  readonly lastError?: string;
}

export interface BroadcastProgressStore {
  read(jobId: string): Promise<BroadcastJobProgress | undefined>;
  write(jobId: string, progress: BroadcastJobProgress): Promise<void>;
  delete(jobId: string): Promise<void>;
}

const cloneProgress = (progress: BroadcastJobProgress): BroadcastJobProgress => ({
  deliveredTargetKeys: [...progress.deliveredTargetKeys],
  attempt: progress.attempt,
  updatedAt: new Date(progress.updatedAt.getTime()),
  lastError: progress.lastError,
});

export const createInMemoryBroadcastProgressStore = (): BroadcastProgressStore => {
  const store = new Map<string, BroadcastJobProgress>();

  return {
    async read(jobId) {
      const progress = store.get(jobId);
      return progress ? cloneProgress(progress) : undefined;
    },

    async write(jobId, progress) {
      store.set(jobId, cloneProgress(progress));
    },

    async delete(jobId) {
      store.delete(jobId);
    },
  };
};
