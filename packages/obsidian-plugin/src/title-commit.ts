// Helpers for editing the body's title heading.
//
// The title lives at the top of the file as a `# ...` heading. The
// home view's import flow uses `applyTitleEdit` to insert a heading
// into a legacy file that doesn't have one yet (without disturbing
// the rest of the body).

const FRONTMATTER_FENCE = /^---\r?\n/;

// Splice a new h1 into the source text. Replaces the first existing
// `# ...` heading; inserts one after the frontmatter (or at the very
// top) when none is present.
export function applyTitleEdit(source: string, newTitle: string): string {
  const fmEnd = findFrontmatterEnd(source);
  const bodyStart = fmEnd;
  const body = source.slice(bodyStart);

  const h1 = findFirstH1Line(body);
  if (h1) {
    const before = body.slice(0, h1.start);
    const after = body.slice(h1.end);
    return source.slice(0, bodyStart) + before + `# ${newTitle}` + after;
  }

  // Insert: skip leading blank lines so the heading sits next to the
  // frontmatter fence with exactly one blank between them.
  const trimmedBody = body.replace(/^\s*\n/, "");
  const sep = bodyStart === 0 ? "" : "\n";
  const trailing = trimmedBody.length === 0 ? "\n" : "\n\n";
  return (
    source.slice(0, bodyStart) +
    sep +
    `# ${newTitle}` +
    trailing +
    trimmedBody
  );
}

function findFrontmatterEnd(source: string): number {
  if (!FRONTMATTER_FENCE.test(source)) return 0;
  // Find closing `---` line.
  const closeRe = /\r?\n---[ \t]*\r?\n/;
  const m = closeRe.exec(source);
  if (!m) return 0;
  return m.index + m[0].length;
}

function findFirstH1Line(
  body: string,
): { start: number; end: number; text: string } | null {
  // Skip fenced code blocks. Mirrors the parser-side rule in slug.ts.
  const lines = body.split("\n");
  let inFence = false;
  let offset = 0;
  for (const line of lines) {
    const lineLen = line.length;
    if (/^(?:`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = /^#\s+(.*)$/.exec(line);
      if (m) {
        const text = m[1]!.replace(/\s+#+\s*$/, "").trim();
        if (text.length > 0) {
          return { start: offset, end: offset + lineLen, text };
        }
      }
    }
    offset += lineLen + 1; // account for `\n`
  }
  return null;
}
