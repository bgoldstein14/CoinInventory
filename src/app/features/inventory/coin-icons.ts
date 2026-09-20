/**
 * Image assets that more than one coin view needs.
 *
 * WHY THIS FILE EXISTS
 * The CAC "green bean" sticker is drawn in two places — next to the grade in
 * the inventory table, and in the badge row of the detail panel. The path used
 * to be a constant exported from app.ts, which meant two components had to
 * import the root component just to find a filename. It lives here instead.
 *
 * (The file itself is served from `public/`, so the path is relative to the
 * site root.)
 */
export const cacGreenBeanIconPath = 'CACGreenBean-trimmed.png';
