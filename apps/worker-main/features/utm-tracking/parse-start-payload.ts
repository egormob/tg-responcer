const PAYLOAD_PATTERN = /^src_[a-z0-9-]{1,64}$/;

const normalizeToken = (value: string): string => value.toLowerCase();

export const parseStartPayload = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const [firstToken] = trimmed.split(/\s+/, 1);
  if (!firstToken) {
    return undefined;
  }

  const normalized = normalizeToken(firstToken);
  if (!PAYLOAD_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
};

export type ParseStartPayload = typeof parseStartPayload;
