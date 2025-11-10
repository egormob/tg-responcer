const wrapLargeIntegers = (input: string): string => {
  let result = '';
  let index = 0;
  const length = input.length;
  let inString = false;
  let isEscaped = false;

  const isDigit = (char: string | undefined) =>
    typeof char === 'string' && char >= '0' && char <= '9';

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

      const digits = end - (input[start] === '-' ? start + 1 : start);
      if (digits <= 0) {
        result += input.slice(start, end);
        index = end;
        continue;
      }

      const nextChar = input[end];
      const prevChar = start > 0 ? input[start - 1] : undefined;
      if (nextChar === '.' || nextChar === 'e' || nextChar === 'E' || prevChar === 'e' || prevChar === 'E') {
        result += input.slice(start, end);
        index = end;
        continue;
      }

      const numberText = input.slice(start, end);
      if (digits >= 15) {
        result += `"${numberText}"`;
      } else {
        result += numberText;
      }
      index = end;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
};

export const parseTelegramUpdateBody = (rawBody: string): unknown => {
  const prepared = wrapLargeIntegers(rawBody);
  return JSON.parse(prepared);
};
