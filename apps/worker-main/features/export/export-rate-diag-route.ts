import { json } from '../../shared';
import type { ExportRateTelemetry } from './export-rate-telemetry';

export interface CreateExportRateDiagRouteOptions {
  telemetry?: ExportRateTelemetry;
}

export const createExportRateDiagRoute = (
  options: CreateExportRateDiagRouteOptions,
) => async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') {
    return json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const snapshot = options.telemetry?.snapshot();
  if (!snapshot) {
    return json({ status: 'disabled', feature: 'admin_export_rate_limit' });
  }

  return json(snapshot);
};
