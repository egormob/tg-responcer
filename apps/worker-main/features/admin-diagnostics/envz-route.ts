import { json } from '../../shared/json-response';

export interface CreateEnvzRouteOptions {
  env: Record<string, unknown>;
}

const hasNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

export const createEnvzRoute = (options: CreateEnvzRouteOptions) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const { env } = options;

    const payload = {
      ok: true,
      env: {
        telegram_webhook_secret: hasNonEmptyString(env.TELEGRAM_WEBHOOK_SECRET),
        telegram_bot_token: hasNonEmptyString(env.TELEGRAM_BOT_TOKEN),
        telegram_bot_username: hasNonEmptyString(env.TELEGRAM_BOT_USERNAME),
        openai_api_key: hasNonEmptyString(env.OPENAI_API_KEY),
        openai_assistant_id: hasNonEmptyString(env.OPENAI_ASSISTANT_ID),
        admin_export_token: hasNonEmptyString(env.ADMIN_EXPORT_TOKEN),
        admin_token: hasNonEmptyString(env.ADMIN_TOKEN),
        db_bound: Boolean(env.DB),
        rate_limit_kv_bound: Boolean(env.RATE_LIMIT_KV),
      },
    };

    return json(payload);
  };
