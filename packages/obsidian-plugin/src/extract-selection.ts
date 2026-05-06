// Pure helpers for the "extract selection to a new oak page" flow.
// No Obsidian imports — keep them unit-testable.
//
// Given the user's editor selection, we return:
//   - title:       a clean, decoration-stripped form of the first line
//   - body:        the remaining lines, dedented to the minimum indent
//                  so a sub-list pulled out becomes a top-level list
//                  in the new page
//   - replacement: the string to put back in the source page in place
//                  of the selection. We preserve the first line's
//                  block-level prefix (indent, bullet, heading marker,
//                  blockquote marker, …) so structural context stays
//                  intact, and replace only the title text with a
//                  wikilink. The body lines are dropped (they live in
//                  the new page now).
//
// Concretely:
//
//     "    - a\n        - b\n        - c\n            - d"
//
// produces:
//
//     title:       "a"
//     body:        "- b\n- c\n    - d"
//     replacement: "    - [[a]]"

export type ExtractedSelection = {
  title: string;
  body: string;
  replacement: string;
};

export function extractFromSelection(text: string): ExtractedSelection {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  if (i >= lines.length) return { title: "", body: "", replacement: "" };

  const firstLine = lines[i]!;
  const { prefix, title } = parseFirstLine(firstLine);
  // Line-based selections (triple-click, shift-down) end with a
  // trailing newline. We need to put it back in the replacement so
  // the line that came after the selection in the source page stays
  // on its own line — otherwise it gets glued onto the wikilink.
  const trailing = text.endsWith("\n") ? "\n" : "";
  const replacement =
    title.length > 0 ? `${prefix}[[${title}]]${trailing}` : firstLine;

  // Trim blank lines on both ends of the body slice so the new page
  // starts on its first content line (regression target: the body
  // must never begin with a blank line) and doesn't accumulate
  // stray trailing blanks if the user's selection ran past the
  // intended end.
  let j = i + 1;
  while (j < lines.length && lines[j]!.trim().length === 0) j++;
  let k = lines.length;
  while (k > j && lines[k - 1]!.trim().length === 0) k--;
  const body = dedent(lines.slice(j, k));

  return { title, body, replacement };
}

// Split the first line into a structural prefix (leading whitespace
// plus block-level markdown markers) and a clean title. Inline
// emphasis and link wrappers around the title are stripped so the
// title is plain visible text.
function parseFirstLine(line: string): { prefix: string; title: string } {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  // Iteratively peel block markers so nested forms like
  // `> - ## Foo` reduce in one call.
  for (;;) {
    const rest = line.slice(i);
    const advance = matchBlockMarker(rest);
    if (advance === 0) break;
    i += advance;
  }
  const prefix = line.slice(0, i);
  const title = stripInline(line.slice(i)).trim();
  return { prefix, title };
}

function matchBlockMarker(s: string): number {
  const patterns: RegExp[] = [
    /^#{1,6}[ \t]+/,
    /^>[ \t]+/,
    /^[-*+][ \t]+/,
    /^\d+[.)][ \t]+/,
    /^\[[ xX]\][ \t]+/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[0].length;
  }
  return 0;
}

function stripInline(s: string): string {
  let out = s;
  out = out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  out = out.replace(/\[\[([^\]]+)\]\]/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  out = out.replace(/__([^_\n]+)__/g, "$1");
  out = out.replace(/~~([^~\n]+)~~/g, "$1");
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  out = out.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");
  return out;
}

// Strip the largest common leading-whitespace prefix from `lines`,
// counting whitespace characters (tabs and spaces alike). Blank lines
// are normalised to empty strings so they don't constrain the
// minimum.
function dedent(lines: string[]): string {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    let n = 0;
    while (n < l.length && (l[n] === " " || l[n] === "\t")) n++;
    if (n < min) min = n;
  }
  if (!isFinite(min) || min === 0) {
    return lines.map((l) => (l.trim().length === 0 ? "" : l)).join("\n");
  }
  return lines
    .map((l) => {
      if (l.trim().length === 0) return "";
      let n = 0;
      while (n < min && n < l.length && (l[n] === " " || l[n] === "\t")) n++;
      return l.slice(n);
    })
    .join("\n");
}
