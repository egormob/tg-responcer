import { parseJsonWithLargeIntegers } from './parse-json-with-large-integers';

export const parseTelegramUpdateBody = (rawBody: string): unknown =>
  parseJsonWithLargeIntegers(rawBody);
