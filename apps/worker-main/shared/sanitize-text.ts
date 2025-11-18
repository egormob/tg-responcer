const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
  'g',
);

export const stripControlCharacters = (text: string): string =>
  text.replace(CONTROL_CHARACTER_PATTERN, '');

export const sanitizeVisibleText = (text: string): string =>
  stripControlCharacters(text).trim();

const STRIP_MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\([^)]*\)/gu;
const STRIP_MARKDOWN_ESCAPES_PATTERN = /\\([_*\[\]()~`>#+\-=|{}.!])/gu;
const STRIP_MARKDOWN_CONTROL_PATTERN = /[_*~`>]/gu;
const STRIP_HTML_TAG_PATTERN = /<[^>]+>/gu;

const stripTelegramMarkdown = (text: string): string =>
  text
    .replace(STRIP_MARKDOWN_LINK_PATTERN, '$1')
    .replace(STRIP_MARKDOWN_ESCAPES_PATTERN, '$1')
    .replace(/```[\s\S]*?```/gu, (match) => match.replace(/`/gu, ''))
    .replace(/`([^`]*)`/gu, '$1')
    .replace(STRIP_MARKDOWN_CONTROL_PATTERN, '');

const stripTelegramHtml = (text: string): string => text.replace(STRIP_HTML_TAG_PATTERN, '');

export const getVisibleTextLength = (text: string): number => {
  const sanitized = stripControlCharacters(text);
  const withoutHtml = stripTelegramHtml(sanitized);
  const withoutMarkdown = stripTelegramMarkdown(withoutHtml);

  return withoutMarkdown.length;
};
