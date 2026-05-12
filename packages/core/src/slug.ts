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

// Reduce a raw Markdown title fragment to plain visible text — the form
// used as a lookup key, sort key, html `<title>` text, and search match
// target. Decorations (emphasis, inline code, strikethrough) are
// unwrapped to their inner text; wikilinks and markdown links collapse
// to their display label (or target when no label is set).
//
// The raw form (`# *Foo* about [[Bar|baz]]`) is preserved on the page
// so renderers that want active links and visible emphasis can still
// render the body's `<h1>` directly.
export function plainTextTitle(raw: string): string {
  let s = raw;
  // Wiki embeds/links: ![[t]], [[t]], [[t|label]], [[t#heading]]
  s = s.replace(/!?\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
    const pipe = inner.indexOf("|");
    if (pipe !== -1) return inner.slice(pipe + 1).trim();
    const hash = inner.indexOf("#");
    if (hash !== -1) {
      const before = inner.slice(0, hash).trim();
      const after = inner.slice(hash + 1).trim();
      return before.length > 0 ? before : after;
    }
    return inner.trim();
  });
  // Markdown links and images: [label](url), ![alt](url)
  s = s.replace(
    /!?\[([^\]\n]*)\]\([^)\s]+(?:\s+"[^"]*")?\)/g,
    (_m, label: string) => label,
  );
  // Inline code: `code` or ``co`de``
  s = s.replace(/`+([^`]+)`+/g, "$1");
  // Strong, em, strikethrough — longest delimiters first
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(?:\*|_)([^*_]+?)(?:\*|_)/g, "$1");
  s = s.replace(/~~(.+?)~~/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

// Locate the first ATX `# ...` heading in a markdown body, skipping
// content inside fenced code blocks. Returns the raw heading text
// (everything after the `#` marker, with trailing `#`s trimmed) and the
// 1-based line number.
export function extractFirstH1(
  body: string,
): { raw: string; line: number } | null {
  const lines = body.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(?:`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // ATX h1: a single `#` (not `##`) followed by whitespace + content.
    // `\s+` matches space/tab; the leading `#` requires no indent so a
    // code-style indented `# ...` doesn't qualify.
    const m = /^#\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1]!.replace(/\s+#+\s*$/, "").trim();
    if (text.length === 0) continue;
    return { raw: text, line: i + 1 };
  }
  return null;
}
