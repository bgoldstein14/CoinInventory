/**
 * routes/param-utils.ts — tiny helpers for reading values out of an Express
 * request.
 *
 * Express types `req.params['id']` as `string | string[] | undefined` because a
 * route pattern *can* produce repeated parameters. Ours never do, but
 * TypeScript does not know that, so every route module used to carry its own
 * private copy of the same two-line converter. There is now exactly one copy,
 * here.
 */

/**
 * Collapses an Express route/query parameter down to a single string.
 * An array yields its first element; a missing value yields ''.
 */
export function toSingleValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
