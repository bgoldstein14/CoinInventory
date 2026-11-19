/* The CAC sticker only applies to a graded coin. */

import { CoinRecord } from './coin.model';

/** True when the grade has any text. */
export function hasGrade(grade: string | null | undefined): boolean {
  return (grade ?? '').trim().length > 0;
}

/** The save for a grade edit: clearing the grade also clears a CAC sticker. */
export function gradeEdit(grade: string, hasCacSticker: boolean | undefined): Partial<CoinRecord> {
  return !hasGrade(grade) && hasCacSticker ? { grade, hasCacSticker: false } : { grade };
}

/** Whether a coin keeps its CAC sticker: only when it has a grade. */
export function cacStickerFor(grade: string | null | undefined, hasCacSticker: unknown): boolean {
  return Boolean(hasCacSticker) && hasGrade(grade);
}
