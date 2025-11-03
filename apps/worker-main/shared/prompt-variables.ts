const getTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
};

export const parsePromptVariables = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) {
      return value as Record<string, unknown>;
    }
  }

  const raw = getTrimmedString(value);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[config] OPENAI_PROMPT_VARIABLES must be a JSON object', {
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
      });
      throw new Error('OPENAI_PROMPT_VARIABLES must be a JSON object');
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[config] failed to parse OPENAI_PROMPT_VARIABLES', {
      error: message,
    });
    throw new Error('OPENAI_PROMPT_VARIABLES must be valid JSON');
  }
};

export const hasPromptVariables = (value: unknown): boolean => {
  try {
    const parsed = parsePromptVariables(value);
    return parsed !== undefined;
  } catch {
    return false;
  }
};
