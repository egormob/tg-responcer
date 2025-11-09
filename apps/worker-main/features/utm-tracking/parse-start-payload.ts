const PAYLOAD_PATTERN = /^src(?:_|\.)[a-zA-Z0-9._+\-]{1,60}$/;

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

  if (!PAYLOAD_PATTERN.test(firstToken)) {
    return undefined;
  }

  return firstToken;
};

export type ParseStartPayload = typeof parseStartPayload;
