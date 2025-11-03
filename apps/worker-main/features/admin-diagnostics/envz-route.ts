import { json } from '../../shared/json-response';
import { hasPromptVariables } from '../../shared/prompt-variables';

export interface CreateEnvzRouteOptions {
  env: Record<string, unknown>;
}

const hasNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const hasValidPromptId = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return /^pmpt_[A-Za-z0-9-]+$/.test(trimmed);
};

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
        openai_model: hasNonEmptyString(env.OPENAI_MODEL),
        openai_prompt_id: hasValidPromptId(env.OPENAI_PROMPT_ID),
        openai_prompt_variables: hasPromptVariables(env.OPENAI_PROMPT_VARIABLES),
        admin_export_token: hasNonEmptyString(env.ADMIN_EXPORT_TOKEN),
        admin_token: hasNonEmptyString(env.ADMIN_TOKEN),
        db_bound: Boolean(env.DB),
        rate_limit_kv_bound: Boolean(env.RATE_LIMIT_KV),
      },
    };

    return json(payload);
  };
