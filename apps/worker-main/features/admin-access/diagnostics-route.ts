import { json } from '../../shared/json-response';
import type { CompositionResult } from '../../composition';
import {
  createAdminAccess,
  readAdminWhitelist,
  type AdminAccess,
  type AdminAccessKvNamespace,
} from './admin-access';
import {
  type AdminCommandErrorRecorder,
  type AdminDiagnosticsKvNamespace,
  type AdminMessagingErrorSource,
  readAdminMessagingErrors,
} from './admin-messaging-errors';

const SAFE_MESSAGE_TEXT = 'Access diagnostics ping. Please ignore this message.';

type HealthStatus = 'ok' | 'skipped' | number | 'error';

interface AccessHealthEntry {
  userId: string;
  status: HealthStatus;
  lastError?: string;
}

export interface CreateAccessDiagnosticsRouteOptions {
  env: { ADMIN_TG_IDS?: AdminAccessKvNamespace };
  composition: CompositionResult;
  adminAccess?: AdminAccess;
  adminErrorRecorder?: Pick<AdminCommandErrorRecorder, 'namespace' | 'source'>;
  adminErrorKv?: AdminDiagnosticsKvNamespace;
  adminErrorSource?: AdminMessagingErrorSource;
}

const getErrorStatus = (error: unknown): { status: HealthStatus; lastError?: string } => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const statusValue = (error as { status?: unknown }).status;
    if (typeof statusValue === 'number' && Number.isFinite(statusValue)) {
      return { status: statusValue, lastError: error instanceof Error ? error.message : undefined };
    }
  }

  return {
    status: 'error',
    lastError: error instanceof Error ? error.message : String(error ?? 'unknown error'),
  };
};

const filterWhitelistWithAccess = async (
  whitelist: string[],
  adminAccess: AdminAccess | undefined,
): Promise<string[]> => {
  if (!adminAccess) {
    return whitelist;
  }

  const checks = await Promise.all(
    whitelist.map(async (userId) => ({ userId, ok: await adminAccess.isAdmin(userId) })),
  );

  return checks.filter((item) => item.ok).map((item) => item.userId);
};

interface CacheControlInfo {
  invalidateRequested: boolean;
  invalidateApplied?: boolean;
  targetUserId?: string | null;
  reason?: string;
}

const normalizeInvalidateTarget = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (trimmed === '*' || trimmed.toLowerCase() === 'all') {
    return '';
  }

  return trimmed;
};

export const createAccessDiagnosticsRoute = (options: CreateAccessDiagnosticsRouteOptions) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const url = new URL(request.url);

    const kv = options.env.ADMIN_TG_IDS;
    const snapshot = kv ? await readAdminWhitelist(kv) : { ids: [], raw: null };
    const adminAccess = options.adminAccess ?? (kv ? createAdminAccess({ kv }) : undefined);

    const invalidateParamPresent = url.searchParams.has('invalidate');
    const invalidateTargetRaw = invalidateParamPresent ? url.searchParams.get('invalidate') : null;
    const invalidateTarget = normalizeInvalidateTarget(invalidateTargetRaw);
    const cacheControl: CacheControlInfo = { invalidateRequested: invalidateParamPresent };

    if (invalidateParamPresent && !adminAccess?.invalidate) {
      cacheControl.invalidateApplied = false;
      cacheControl.reason = 'admin_access_unavailable';
    }

    if (invalidateParamPresent && adminAccess?.invalidate) {
      if (invalidateTarget === '') {
        adminAccess.invalidate();
      } else {
        adminAccess.invalidate(invalidateTarget);
      }
      cacheControl.invalidateApplied = true;
      cacheControl.targetUserId = invalidateTarget && invalidateTarget.length > 0 ? invalidateTarget : null;
    }

    const whitelist = await filterWhitelistWithAccess(snapshot.ids, adminAccess);

    const adminErrorNamespace =
      options.adminErrorKv
      ?? options.adminErrorRecorder?.namespace
      ?? kv;
    const adminErrorSource = options.adminErrorSource
      ?? options.adminErrorRecorder?.source
      ?? (adminErrorNamespace && adminErrorNamespace === kv ? 'primary' : 'none');

    const adminMessagingErrors = adminErrorNamespace
      ? await readAdminMessagingErrors(adminErrorNamespace, { limit: 50 })
      : { entries: [], total: 0, topByCode: [] };

    const health: AccessHealthEntry[] = [];
    const messaging = options.composition?.ports.messaging;

    if (!messaging) {
      for (const userId of whitelist) {
        health.push({
          userId,
          status: 'skipped',
          lastError: 'messaging port unavailable',
        });
      }
    } else {
      for (const userId of whitelist) {
        try {
          await messaging.sendTyping({ chatId: userId });
          await messaging.sendText({ chatId: userId, text: SAFE_MESSAGE_TEXT });
          health.push({ userId, status: 'ok' });
        } catch (error) {
          const details = getErrorStatus(error);
          health.push({
            userId,
            status: details.status,
            lastError: details.lastError,
          });
        }
      }
    }

    return json({
      whitelist,
      health,
      kvRaw: snapshot.raw,
      cacheControl,
      adminMessagingErrors: {
        source: adminErrorNamespace ? adminErrorSource : 'none',
        entries: adminMessagingErrors.entries,
        total: adminMessagingErrors.total,
        topByCode: adminMessagingErrors.topByCode,
      },
    });
  };
