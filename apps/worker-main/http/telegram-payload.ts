import { parseTelegramJson } from './parse-telegram-json';

export const parseTelegramUpdateBody = (rawBody: string): unknown => parseTelegramJson(rawBody);
