/**
 * Convert string to kebab-case (lowercase with hyphens)
 * @param {string} str - String to convert
 * @param {number} [maxLength] - Optional max length (truncates before trimming trailing dashes)
 * @returns {string} Kebab-cased string
 */
export const toKebabCase = (str, maxLength) => {
  let result = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (maxLength !== undefined && result.length > maxLength) {
    result = result.slice(0, maxLength).replace(/-+$/, '');
  }

  return result;
};
