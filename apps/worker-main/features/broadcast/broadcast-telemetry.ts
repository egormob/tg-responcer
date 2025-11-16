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
}

export interface BroadcastTelemetry {
  record(input: BroadcastTelemetryRecordInput): void;
  snapshot(): BroadcastTelemetrySnapshot;
}

const DEFAULT_MAX_HISTORY = 10;

const toIsoString = (date: Date): string => date.toISOString();

export const createBroadcastTelemetry = (
  options: BroadcastTelemetryOptions = {},
): BroadcastTelemetry => {
  const maxHistory = Math.max(1, options.maxHistory ?? DEFAULT_MAX_HISTORY);
  const history: BroadcastTelemetryRecord[] = [];
  let totalRuns = 0;

  const record = (input: BroadcastTelemetryRecordInput) => {
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
  };

  const snapshot = (): BroadcastTelemetrySnapshot => ({
    status: 'ok',
    feature: 'broadcast_metrics',
    totalRuns,
    lastRun: history.length > 0 ? history[history.length - 1] : null,
    history: [...history],
  });

  return { record, snapshot };
};

export type BroadcastTelemetryInstance = ReturnType<typeof createBroadcastTelemetry>;
