import { json } from '../../shared';
import type { BroadcastTelemetry } from './broadcast-telemetry';

export interface CreateBroadcastDiagRouteOptions {
  telemetry?: BroadcastTelemetry;
}

export const createBroadcastDiagRoute = (
  options: CreateBroadcastDiagRouteOptions,
) => async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') {
    return json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const snapshot = options.telemetry ? await options.telemetry.snapshot() : undefined;
  if (!snapshot) {
    return json({ status: 'disabled', feature: 'broadcast_metrics' });
  }

  return json(snapshot);
};
