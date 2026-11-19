/** Collapses line breaks (and the spaces around them) to one space, so a wrapping field stores one line. */
export function singleLine(text: string): string {
  return (text ?? '').replace(/[ \t]*\r?\n[ \t\r\n]*/g, ' ');
}
