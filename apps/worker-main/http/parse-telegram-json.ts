import { parseJsonWithLargeIntegers, quoteIntegerTokens } from './parse-json-with-large-integers';

export const parseTelegramJson = (raw: string): unknown => parseJsonWithLargeIntegers(raw);

export { quoteIntegerTokens };
