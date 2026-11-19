/** Helpers for reading values out of an Express request. */

/**
 * Collapses an Express route/query parameter down to a single string.
 * An array yields its first element; a missing value yields ''.
 */
export function toSingleValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
