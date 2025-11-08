import { json } from '../../shared/json-response';
import type { CompositionResult } from '../../composition';
import {
  createAdminAccess,
  readAdminWhitelist,
  type AdminAccess,
  type AdminAccessKvNamespace,
} from './admin-access';

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

export const createAccessDiagnosticsRoute = (options: CreateAccessDiagnosticsRouteOptions) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const kv = options.env.ADMIN_TG_IDS;
    const snapshot = kv ? await readAdminWhitelist(kv) : { ids: [], raw: null };
    const adminAccess = options.adminAccess ?? (kv ? createAdminAccess({ kv }) : undefined);
    const whitelist = await filterWhitelistWithAccess(snapshot.ids, adminAccess);

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
    });
  };
