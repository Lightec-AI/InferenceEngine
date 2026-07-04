/**
 * Take up to `maxUtf16Units` code units from `text` without splitting a UTF-16
 * surrogate pair. Splitting pairs and then `Buffer.from(piece, "utf8")` permanently
 * replaces emoji / other non-BMP chars with U+FFFD (��), which is then stored in
 * chat history and fed back to the model on later turns.
 */
export function takeUtf16SafePrefix(
  text: string,
  maxUtf16Units: number,
): { piece: string; rest: string } {
  if (maxUtf16Units <= 0 || text.length === 0) {
    return { piece: "", rest: text };
  }
  if (text.length <= maxUtf16Units) {
    return { piece: text, rest: "" };
  }

  let end = maxUtf16Units;
  const last = text.charCodeAt(end - 1);
  // High surrogate at the cut — back up so the pair stays with `rest`.
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  // Budget too small for a leading supplementary char — emit the full code point.
  if (end <= 0) {
    const cp = text.codePointAt(0)!;
    end = cp > 0xffff ? 2 : 1;
  }
  return { piece: text.slice(0, end), rest: text.slice(end) };
}
