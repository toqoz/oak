// Pure helper: ensure the YAML frontmatter is followed by a blank
// line. The blank is the standard Obsidian convention; oak relies on
// it being present so the styles.css rule that hides it in Live
// Preview keeps a stable target. If the user (or some other tool)
// removes the blank, this function puts it back.
//
// No-ops when the file has no frontmatter, ends right at the closing
// fence, has malformed frontmatter, or already has the blank.

export function ensureBlankAfterFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  // Match the opening fence plus the closing fence that ends a line.
  // The lazy quantifier ensures we stop at the first closing `---`,
  // not at any later `---` that might appear inside the body as a
  // horizontal rule.
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) return text;
  const after = m[0].length;
  if (after >= text.length) return text;
  if (text[after] === "\n") return text;
  return text.slice(0, after) + "\n" + text.slice(after);
}
