const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
  'g',
);

export const stripControlCharacters = (text: string): string =>
  text.replace(CONTROL_CHARACTER_PATTERN, '');

export const sanitizeVisibleText = (text: string): string =>
  stripControlCharacters(text).trim();
