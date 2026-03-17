const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]+/gu;
const LINE_SEPARATOR_REGEX = /[\u2028\u2029]+/gu;
const BIDI_CONTROL_REGEX = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;
const COLLAPSE_WHITESPACE_REGEX = /\s+/gu;

export const MAX_SESSION_TITLE_LENGTH = 160;

export function sanitizeSessionTitleInput(value: string | null | undefined): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(CONTROL_CHARS_REGEX, " ")
    .replace(LINE_SEPARATOR_REGEX, " ")
    .replace(BIDI_CONTROL_REGEX, "")
    .replace(COLLAPSE_WHITESPACE_REGEX, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.slice(0, MAX_SESSION_TITLE_LENGTH).trim();
}

export function normalizeSessionTitle(value: string | null | undefined): string | null {
  const sanitized = sanitizeSessionTitleInput(value);
  return sanitized ? sanitized : null;
}
