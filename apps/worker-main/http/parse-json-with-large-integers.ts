const isDigit = (char: string | undefined): char is string =>
  typeof char === 'string' && char >= '0' && char <= '9';

const quoteIntegerTokens = (input: string): string => {
  let result = '';
  let index = 0;
  const length = input.length;
  let inString = false;
  let isEscaped = false;

  while (index < length) {
    const char = input[index] ?? '';

    if (inString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      index += 1;
      continue;
    }

    if (char === '-' || isDigit(char)) {
      const start = index;
      let end = index;

      if (char === '-') {
        end += 1;
        const nextChar = input[end];
        if (!isDigit(nextChar)) {
          result += char;
          index += 1;
          continue;
        }
      }

      while (isDigit(input[end])) {
        end += 1;
      }

      const nextChar = input[end];
      const prevChar = start > 0 ? input[start - 1] : undefined;
      if (
        nextChar === '.'
        || nextChar === 'e'
        || nextChar === 'E'
        || prevChar === '.'
        || prevChar === 'e'
        || prevChar === 'E'
      ) {
        result += input.slice(start, end);
        index = end;
        continue;
      }

      const numberText = input.slice(start, end);
      if (numberText === '-' || numberText.length === 0) {
        result += numberText;
        index = end;
        continue;
      }

      result += `"${numberText}"`;
      index = end;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
};

export const parseJsonWithLargeIntegers = (raw: string): unknown => {
  const prepared = quoteIntegerTokens(raw);
  const parsed = JSON.parse(prepared);
  validateTelegramNumericTokens(parsed);
  return parsed;
};

export { quoteIntegerTokens };

const LARGE_INTEGER_MIN_LENGTH = 10;

const TELEGRAM_ID_PARENT_KEYS = new Set([
  'user',
  'from',
  'sender_chat',
  'chat',
  'new_chat_member',
  'new_chat_members',
  'left_chat_member',
  'via_bot',
  'forward_from',
  'forward_from_chat',
  'forward_sender_name',
]);

const TELEGRAM_ID_FIELD_KEYS = new Set(['chat_id']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const createUnsafeTelegramIdError = (path: string): Error => {
  const error = new Error('UNSAFE_TELEGRAM_ID');
  (error as { path?: string }).path = path;
  return error;
};

const toJsonPath = (segments: Array<string | number>): string => {
  if (segments.length === 0) {
    return '$';
  }

  return segments
    .map((segment, index) => {
      if (typeof segment === 'number') {
        return `[${segment}]`;
      }

      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
};

const isLargeIntegerNumber = (value: number): boolean => {
  if (!Number.isInteger(value)) {
    return false;
  }

  const asString = Math.abs(value).toString();
  return asString.length >= LARGE_INTEGER_MIN_LENGTH;
};

const findParentObjectKey = (path: Array<string | number>): string | undefined => {
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const segment = path[index];
    if (typeof segment === 'string') {
      return segment;
    }
  }

  return undefined;
};

const shouldRejectTelegramIdNumber = (
  key: string,
  parentKey: string | undefined,
): boolean => {
  if (TELEGRAM_ID_FIELD_KEYS.has(key)) {
    return true;
  }

  if (key === 'id' && parentKey && TELEGRAM_ID_PARENT_KEYS.has(parentKey)) {
    return true;
  }

  return false;
};

const validateTelegramNumericTokens = (
  value: unknown,
  path: Array<string | number> = [],
): void => {
  if (typeof value === 'number') {
    const currentKey = path[path.length - 1];
    const parentKey = findParentObjectKey(path);

    if (typeof currentKey === 'string' && shouldRejectTelegramIdNumber(currentKey, parentKey)) {
      throw createUnsafeTelegramIdError(toJsonPath(path));
    }

    if (
      typeof currentKey === 'string'
      && currentKey !== 'update_id'
      && isLargeIntegerNumber(value)
    ) {
      throw new Error(`LOSSY_INTEGER_TOKEN:${toJsonPath(path)}`);
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateTelegramNumericTokens(item, [...path, index]);
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (TELEGRAM_ID_FIELD_KEYS.has(key)) {
      if (typeof child !== 'string') {
        throw createUnsafeTelegramIdError(toJsonPath([...path, key]));
      }
    }

    if (key === 'id') {
      const parentKey = findParentObjectKey([...path, key]);
      if (parentKey && TELEGRAM_ID_PARENT_KEYS.has(parentKey) && typeof child !== 'string') {
        throw createUnsafeTelegramIdError(toJsonPath([...path, key]));
      }
    }

    validateTelegramNumericTokens(child, [...path, key]);
  }
};
