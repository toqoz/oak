// Pure helpers that resolve an Obsidian editor selection to the set
// of refile-target headings in the file. Kept in their own module
// (rather than `commands.ts`) so the unit tests can exercise them
// without pulling in the `obsidian` runtime, which is only resolvable
// inside the actual plugin host.

import { findHeadingsInRange, frontmatterLineCount } from "@oak/core";

// Top-level headings whose subtree intersects the editor selection
// (file lines, 0-based — Obsidian convention). Returns an empty list
// when the selection sits entirely in frontmatter or contains no
// heading subtree.
//
// `from`/`to` are Obsidian `EditorPosition` values. CodeMirror treats
// `to` as exclusive, so a selection that ends at column 0 of line N
// has not actually consumed any content on line N. We collapse that
// boundary to the previous line before resolving headings; otherwise
// a user who selects "everything in `## A`" by extending the
// selection up to the start of `## B` would silently refile B too.
export function findHeadingsInEditorSelection(
  raw: string,
  from: { line: number; ch: number },
  to: { line: number; ch: number },
): { line: number; level: number; title: string }[] {
  const inclusiveToLine =
    to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
  const fmLines = frontmatterLineCount(raw);
  const fromBody = from.line - fmLines + 1;
  const toBody = inclusiveToLine - fmLines + 1;
  if (toBody < 1) return [];
  const body = raw.split("\n").slice(fmLines).join("\n");
  return findHeadingsInRange(body, Math.max(1, fromBody), toBody);
}
