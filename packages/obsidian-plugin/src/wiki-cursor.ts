// Pure helper isolated from Obsidian's API surface so it can be
// unit-tested without stubbing the editor.

export function findWikiTargetInLine(line: string, ch: number): string | null {
  let start = -1;
  for (let i = Math.min(ch, line.length); i >= 1; i--) {
    if (line[i - 1] === "[" && line[i] === "[") {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = -1;
  for (let i = start; i < line.length - 1; i++) {
    if (line[i] === "]" && line[i + 1] === "]") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  if (ch < start - 2 || ch > end + 1) return null;
  const inner = line.slice(start, end);
  const pipe = inner.indexOf("|");
  const target = (pipe === -1 ? inner : inner.slice(0, pipe))
    .split("#")[0]!
    .trim();
  return target.length > 0 ? target : null;
}
