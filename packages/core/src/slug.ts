// Generate a URL-safe slug from a title or filename.
//
// Rules:
//   - lowercase
//   - keep ASCII letters, digits, hyphen
//   - replace whitespace and `_` with `-`
//   - strip everything else
//   - collapse repeated `-`
//   - trim leading/trailing `-`
//
// Non-ASCII characters (e.g. CJK) are preserved unchanged so titles like
// `知識` still produce a meaningful slug. Only ASCII punctuation/symbols
// are stripped.

export function slugify(input: string): string {
  const lowered = input.normalize("NFC").toLowerCase();
  let out = "";
  for (const ch of lowered) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    const isAsciiAlnum =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x61 && code <= 0x7a); // a-z
    if (isAsciiAlnum) {
      out += ch;
    } else if (ch === "-") {
      out += "-";
    } else if (code < 0x80) {
      // ASCII punctuation/whitespace -> separator
      out += "-";
    } else {
      // Preserve non-ASCII characters (CJK, etc.)
      out += ch;
    }
  }
  return out.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeKey(input: string): string {
  return input.normalize("NFC").trim().toLowerCase();
}
