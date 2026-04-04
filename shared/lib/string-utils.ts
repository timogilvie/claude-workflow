/**
 * Convert string to kebab-case (lowercase with hyphens)
 * @param str - String to convert
 * @param maxLength - Optional max length (truncates before trimming trailing dashes)
 * @returns Kebab-cased string
 */
export const toKebabCase = (str: string, maxLength?: number): string => {
  let result = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (maxLength !== undefined && result.length > maxLength) {
    result = result.slice(0, maxLength).replace(/-+$/, '');
  }

  return result;
};
