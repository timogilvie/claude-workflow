/**
 * Shared text redaction helpers for data that may leave the local machine.
 *
 * The goal here is conservative anonymization rather than semantic cleanup:
 * obvious identifiers are replaced with placeholders while surrounding text
 * remains intact for downstream analysis.
 *
 * @module text-redaction
 */

const EMAIL_PATTERN =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const URL_PATTERN =
  /https?:\/\/[^\s"'<>)}\]]+/g;

const ABSOLUTE_PATH_PATTERN =
  /(?:\/[a-zA-Z0-9._-]+){2,}/g;

const USERNAME_PATTERN =
  /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{1,39})\b/g;

const REPO_PATTERN =
  /(^|[^a-zA-Z0-9_.-])([a-zA-Z0-9_.-]*[a-zA-Z_.-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_.-]*[a-zA-Z_.-][a-zA-Z0-9_.-]*)(?=$|[^a-zA-Z0-9_.-])/g;

/**
 * Replace common PII and repo-identifying text patterns with placeholders.
 */
export function redactText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  let result = text;

  result = result.replace(EMAIL_PATTERN, '[EMAIL]');
  result = result.replace(URL_PATTERN, '[URL]');
  result = result.replace(ABSOLUTE_PATH_PATTERN, '[PATH]');
  result = result.replace(USERNAME_PATTERN, (_match, prefix: string) => `${prefix}[USERNAME]`);
  result = result.replace(REPO_PATTERN, (_match, prefix: string) => `${prefix}[REPO]`);

  return result;
}
