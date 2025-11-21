import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastAbortReason } from './minimal-broadcast-service';

export interface BroadcastTelemetryRecordInput {
  requestedBy: string;
  recipients: number;
  delivered: number;
  failed: number;
  throttled429: number;
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
  status: 'ok' | 'aborted';
  abortReason?: BroadcastAbortReason;
  error?: { name: string; message: string } | undefined;
  filters?: BroadcastAudienceFilter;
}

export interface BroadcastTelemetryRecord extends Omit<BroadcastTelemetryRecordInput, 'startedAt' | 'completedAt'> {
  startedAt: string;
  completedAt: string;
}

export interface BroadcastTelemetrySnapshot {
  status: 'ok';
  feature: 'broadcast_metrics';
  totalRuns: number;
  lastRun: BroadcastTelemetryRecord | null;
  history: BroadcastTelemetryRecord[];
}

export interface BroadcastTelemetryOptions {
  maxHistory?: number;
  storage?: {
    kv: Pick<KVNamespace, 'get' | 'put' | 'list' | 'delete'>;
    environment?: string;
    workerId?: string;
    ttlSeconds?: number;
    maxSnapshots?: number;
    now?: () => Date;
  };
  logger?: Pick<Console, 'warn'>;
}

export interface BroadcastTelemetry {
  record(input: BroadcastTelemetryRecordInput): Promise<void>;
  snapshot(): Promise<BroadcastTelemetrySnapshot>;
}

const DEFAULT_MAX_HISTORY = 10;
const DEFAULT_STORAGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_SNAPSHOTS = 20;
const STORAGE_KEY_PREFIX = 'broadcast:telemetry:';
const STORAGE_LIST_PAGE_LIMIT = 10;

const toIsoString = (date: Date): string => date.toISOString();

interface BroadcastTelemetryStoredSnapshot extends BroadcastTelemetrySnapshot {
  workerId: string;
  environment: string;
  updatedAt: string;
}

const safeParseSnapshot = (value: string): BroadcastTelemetryStoredSnapshot | null => {
  try {
    const parsed = JSON.parse(value) as BroadcastTelemetryStoredSnapshot;
    if (
      parsed
      && parsed.workerId
      && parsed.environment
      && parsed.updatedAt
      && parsed.status === 'ok'
      && parsed.feature === 'broadcast_metrics'
    ) {
      return parsed;
    }
  } catch (error) {
    // ignore malformed entries
  }

  return null;
};

const toWorkerKey = (environment: string, workerId: string): string => {
  const envKey = environment.trim() || 'default';
  const workerKey = workerId.trim() || 'unknown';

  return `${STORAGE_KEY_PREFIX}${envKey}:${workerKey}`;
};

export const createBroadcastTelemetry = (
  options: BroadcastTelemetryOptions = {},
): BroadcastTelemetry => {
  const maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
  const storage = options.storage;
  const logger = options.logger;
  const environment = storage?.environment ? String(storage.environment) : 'default';
  const workerId = storage?.workerId
    ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `worker-${Math.random().toString(36).slice(2, 10)}`);
  const ttlSeconds = Math.max(60, storage?.ttlSeconds ?? DEFAULT_STORAGE_TTL_SECONDS);
  const maxSnapshots = Math.max(1, storage?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  const now = storage?.now ?? (() => new Date());
  const storageKeyPrefix = STORAGE_KEY_PREFIX + (environment.trim() || 'default') + ':';
  const history: BroadcastTelemetryRecord[] = [];
  let totalRuns = 0;

  const persistSnapshot = async (snapshot: BroadcastTelemetrySnapshot) => {
    if (!storage) {
      return;
    }

    const storageSnapshot: BroadcastTelemetryStoredSnapshot = {
      ...snapshot,
      workerId,
      environment,
      updatedAt: toIsoString(now()),
    };

    try {
      await storage.kv.put(toWorkerKey(environment, workerId), JSON.stringify(storageSnapshot), {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      logger?.warn?.('broadcast_telemetry_persist_failed', { error });
    }
  };

  const record = async (input: BroadcastTelemetryRecordInput): Promise<void> => {
    totalRuns += 1;
    const entry: BroadcastTelemetryRecord = {
      ...input,
      startedAt: toIsoString(input.startedAt),
      completedAt: toIsoString(input.completedAt),
    };

    history.push(entry);
    while (history.length > maxHistory) {
      history.shift();
    }

    const snapshot = {
      status: 'ok' as const,
      feature: 'broadcast_metrics' as const,
      totalRuns,
      lastRun: history.length > 0 ? history[history.length - 1] : null,
      history: [...history],
    } satisfies BroadcastTelemetrySnapshot;

    await persistSnapshot(snapshot);
  };

  const readStoredSnapshots = async (): Promise<BroadcastTelemetryStoredSnapshot[]> => {
    if (!storage) {
      return [];
    }

    let cursor: string | undefined;
    const snapshots: BroadcastTelemetryStoredSnapshot[] = [];

    do {
      const listResult = await storage.kv.list({
        prefix: storageKeyPrefix,
        cursor,
        limit: STORAGE_LIST_PAGE_LIMIT,
      });

      for (const { name } of listResult.keys) {
        if (snapshots.length >= maxSnapshots) {
          return snapshots;
        }

        const value = await storage.kv.get(name, 'text');
        if (!value) {
          continue;
        }

        const parsed = safeParseSnapshot(value);
        if (parsed && parsed.environment === environment) {
          snapshots.push(parsed);
        }
      }

      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor && snapshots.length < maxSnapshots);

    return snapshots;
  };

  const mergeSnapshots = (
    localSnapshot: BroadcastTelemetrySnapshot,
    storedSnapshots: BroadcastTelemetryStoredSnapshot[],
  ): BroadcastTelemetrySnapshot => {
    const snapshotsByWorker = new Map<string, BroadcastTelemetryStoredSnapshot>();
    const localStored: BroadcastTelemetryStoredSnapshot = {
      ...localSnapshot,
      environment,
      workerId,
      updatedAt: toIsoString(now()),
    };

    for (const snapshot of storedSnapshots) {
      const current = snapshotsByWorker.get(snapshot.workerId);
      if (!current || new Date(snapshot.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
        snapshotsByWorker.set(snapshot.workerId, snapshot);
      }
    }

    const existing = snapshotsByWorker.get(workerId);
    if (!existing || new Date(localStored.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
      snapshotsByWorker.set(workerId, localStored);
    }

    const snapshots = Array.from(snapshotsByWorker.values());
    const mergedHistory = snapshots
      .flatMap((snapshot) => snapshot.history)
      .sort((left, right) => new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime());

    while (mergedHistory.length > maxHistory) {
      mergedHistory.shift();
    }

    return {
      status: 'ok',
      feature: 'broadcast_metrics',
      totalRuns: snapshots.reduce((sum, snapshot) => sum + (snapshot.totalRuns ?? 0), 0),
      lastRun: mergedHistory.length > 0 ? mergedHistory[mergedHistory.length - 1] : null,
      history: mergedHistory,
    } satisfies BroadcastTelemetrySnapshot;
  };

  const snapshot = async (): Promise<BroadcastTelemetrySnapshot> => {
    const localSnapshot: BroadcastTelemetrySnapshot = {
      status: 'ok',
      feature: 'broadcast_metrics',
      totalRuns,
      lastRun: history.length > 0 ? history[history.length - 1] : null,
      history: [...history],
    };

    const storedSnapshots = await readStoredSnapshots();

    if (!storage || storedSnapshots.length === 0) {
      return localSnapshot;
    }

    return mergeSnapshots(localSnapshot, storedSnapshots);
  };

  return { record, snapshot };
};

export type BroadcastTelemetryInstance = ReturnType<typeof createBroadcastTelemetry>;
