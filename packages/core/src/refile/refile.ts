// Move a heading + its subtree to another location ("org-refile").
//
// Two flavours, both fence-aware so a `# foo` line inside ``` … ``` is
// not mistaken for a heading:
//   1. Same-file refile: subtree is removed and re-inserted in one
//      atomic write.
//   2. Cross-file refile: target is written first, then source. If the
//      source write fails after a successful target write, the subtree
//      will exist in both files — recoverable by hand, never silently
//      lost.
//
// Heading levels in the moved subtree are shifted so the source heading
// becomes a direct child of the target heading. For "top of file"
// targets — where there is no parent heading — the resulting level is
// taken from `RefileConfig.topOfFileLevel`. We refuse a shift that
// would push any heading past level 6.
//
// Refile lives in its own module rather than under `agenda/` because
// it is a generic heading-manipulation feature, not an agenda-specific
// one. It does *interact* with the agenda parser: when the caller
// identifies the source heading by entry-id (typical of the agenda
// view's Shift-R), we resolve the entry inside this function — same
// freshly-read-with-mtime body — so a between-snapshot-and-write file
// change still surfaces as either an `entry-not-found` mismatch or an
// mtime CAS conflict instead of slicing the wrong region. That single
// dependency on `parseAgendaPage` is the entire interaction surface.

import {
  chmod,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { parseAgendaPage } from "../agenda/parse.js";
import type { AgendaConfig } from "../agenda/types.js";
import { nowIsoSecond, withTimestampUpdate } from "../timestamps.js";
import type { OakPage, Vault } from "../types.js";

import type { RefileConfig } from "./config.js";

// Split `raw` into the YAML-frontmatter prefix (including its trailing
// `---\n`) and the body. Mirrors `frontmatterLineCount`'s regex so the
// body line numbering produced by `parseAgendaPage` round-trips through
// `replaceBody` without drift.
function splitFrontmatter(raw: string): { prefix: string; body: string } {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return { prefix: "", body: raw };
  return { prefix: m[0], body: raw.slice(m[0].length) };
}

export class RefileError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "entry-not-found"
      | "heading-not-found"
      | "target-not-found"
      | "self-refile"
      | "descendant-target"
      | "level-overflow"
      | "conflict"
      | "io-error",
  ) {
    super(message);
    this.name = "RefileError";
  }
}

// Identify the source heading to refile.
//   - "entry": look the heading up via parseAgendaPage by its stable
//     entryId. Robust against between-snapshot-and-write drift; required
//     by the agenda view (where the only handle on a heading is its
//     id).
//   - "heading": pin the source by its current body line + level. Used
//     by the editor command, where the cursor already gives us a
//     concrete location and the heading may not be agenda-worthy (no
//     TODO state, no planning line, no active timestamp) so the agenda
//     parser would not yield it.
export type RefileSource =
  | { kind: "entry"; entryId: string }
  | { kind: "heading"; line: number; level: number };

export type RefileTarget = {
  // Vault-relative path of the destination file.
  relPath: string;
  // Absolute path of the destination file.
  filePath: string;
  // Display path: file basename (without `.md`) followed by the heading
  // chain titles. Empty array means "top of file".
  headingPath: string[];
  // Body line (1-based, frontmatter excluded) of the destination
  // heading. null = file root (append after frontmatter, at level 0).
  line: number | null;
  // Heading level of the destination heading. 0 when refiling to file
  // root (so children start at level 1).
  level: number;
};

export type RefileResult = {
  sourceRelPath: string;
  // Stable handle of the source heading when the caller identified it
  // via `{ kind: "entry" }`; null when the caller pinned by line+level
  // (the heading is not necessarily agenda-worthy, so it has no
  // derivable entryId from this code path).
  sourceEntryId: string | null;
  targetRelPath: string;
  targetLine: number | null;
  // 1-based body line of the target heading *after* the write — useful
  // to multi-refile callers that loop over several sources hitting the
  // same destination, since cutting a same-file source above the
  // target shifts the target's line up. Equal to `targetLine` when no
  // shift applies (cross-file, or same-file with target above all
  // sources). Null mirrors `targetLine` for top-of-file refiles.
  targetLineAfter: number | null;
  // 1-based body line of the moved heading in the target file, *after*
  // the write. Lets the UI scroll a peek pane to the actual landing
  // spot instead of just the destination heading (which can be far
  // above the new content for large subtrees) or the file root (which
  // would be wrong for top-of-file refiles that append at EOF).
  insertedBodyLine: number;
  // Number of lines in the moved subtree.
  movedLines: number;
  // Whether source and target are the same file.
  sameFile: boolean;
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;

// Walk `body` lines once, emitting every ATX heading outside fenced
// code blocks. Fence rules mirror parseAgendaPage: open is `>=3` of
// `\`` or `~`, close must be the same character with at least the same
// length.
function scanHeadings(
  body: string,
): { line: number; level: number; title: string }[] {
  const lines = body.split("\n");
  const out: { line: number; level: number; title: string }[] = [];
  let fence: { ch: "`" | "~"; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const run = fenceMatch[2]!;
      const ch = run[0] as "`" | "~";
      if (fence === null) {
        fence = { ch, len: run.length };
        continue;
      }
      if (ch === fence.ch && run.length >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    const h = line.match(HEADING_RE);
    if (h) out.push({ line: i + 1, level: h[1]!.length, title: h[2]!.trim() });
  }
  return out;
}

function basenameNoExt(relPath: string): string {
  const last = relPath.split("/").pop() ?? relPath;
  return last.replace(/\.md$/i, "");
}

// Find the heading whose subtree contains `bodyLine` (1-based, body-
// relative). Returns null when `bodyLine` is at or before the first
// heading. Walks every ATX heading once, fence-aware. Used by the
// editor refile entrypoint to identify the heading at the cursor for
// any heading — including non-agenda ones (no TODO/planning/active
// timestamp) that `parseAgendaPage` would skip.
export function findEnclosingHeading(
  body: string,
  bodyLine: number,
): { line: number; level: number; title: string } | null {
  if (bodyLine < 1) return null;
  const headings = scanHeadings(body);
  let best: { line: number; level: number; title: string } | null = null;
  for (const h of headings) {
    if (h.line > bodyLine) break;
    best = h;
  }
  return best;
}

// Return every "top-level" heading whose subtree intersects the body
// range `[fromBodyLine, toBodyLine]` (1-based, inclusive).
//
// "Top-level" means the heading is not a descendant of another heading
// that is itself in the result — refiling a parent already moves its
// children, so listing both would double-process. The selection model
// is intentionally loose: a body line that sits inside a heading's
// subtree counts the heading as in-range, so a user who selects "from
// somewhere in foo's body to bar's heading" gets both foo and bar.
//
// Used by the editor refile entrypoint when the user has a multi-line
// selection — picking one destination and refiling every selected
// section in one shot.
export function findHeadingsInRange(
  body: string,
  fromBodyLine: number,
  toBodyLine: number,
): { line: number; level: number; title: string }[] {
  if (toBodyLine < 1 || toBodyLine < fromBodyLine) return [];
  const headings = scanHeadings(body);
  if (headings.length === 0) return [];
  const totalLines = body.split("\n").length;

  // Compute each heading's subtree end (1-based, exclusive): the line
  // of the next heading at level <= H.level, or `totalLines + 1` for
  // the last sibling.
  const ends: number[] = headings.map((h, i) => {
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) return headings[j]!.line;
    }
    return totalLines + 1;
  });

  // Candidates: subtree intersects the requested range.
  const inRange = new Set<number>();
  const lowerBound = Math.max(1, fromBodyLine);
  for (let i = 0; i < headings.length; i++) {
    if (headings[i]!.line <= toBodyLine && ends[i]! > lowerBound) {
      inRange.add(i);
    }
  }

  // Filter to top-level. Walk headings in order maintaining an
  // ancestor stack so we can ask "is any of my live ancestors also a
  // candidate?"; if so, drop the current one — it'll come along with
  // its parent's subtree.
  const result: { line: number; level: number; title: string }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < headings.length; i++) {
    while (
      stack.length > 0 &&
      headings[stack[stack.length - 1]!]!.level >= headings[i]!.level
    ) {
      stack.pop();
    }
    if (inRange.has(i) && !stack.some((idx) => inRange.has(idx))) {
      result.push(headings[i]!);
    }
    stack.push(i);
  }
  return result;
}

// Build the full list of refile targets across `vault`. For every page
// we emit a "top of file" sentinel plus one entry per heading. Headings
// are returned with their full ancestor chain (titles only) so the UI
// can render `file ▸ Parent ▸ Heading`.
export function collectRefileTargets(vault: Vault): RefileTarget[] {
  const out: RefileTarget[] = [];
  for (const page of vault.pages.values()) {
    const fileLabel = basenameNoExt(page.relPath);
    out.push({
      relPath: page.relPath,
      filePath: page.filePath,
      headingPath: [fileLabel],
      line: null,
      level: 0,
    });
    const headings = scanHeadings(page.body);
    const stack: { level: number; title: string }[] = [];
    for (const h of headings) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
        stack.pop();
      }
      const path = [fileLabel, ...stack.map((s) => s.title), h.title];
      out.push({
        relPath: page.relPath,
        filePath: page.filePath,
        headingPath: path,
        line: h.line,
        level: h.level,
      });
      stack.push({ level: h.level, title: h.title });
    }
  }
  return out;
}

function makeOakPage(
  filePath: string,
  body: string,
  relPath: string,
): OakPage {
  return {
    type: "page",
    id: "refile:tmp",
    title: "refile",
    aliases: [],
    visibility: "private",
    slug: "",
    llm: "deny",
    filePath,
    relPath,
    basename: filePath.split(/[\\/]/).pop() ?? filePath,
    body,
    rawFrontmatter: {},
    created: null,
    modified: null,
    links: [],
    parseIssues: [],
  };
}

// Find the body-line range `[start, endExclusive)` that covers a
// heading at body-line `headingBodyLine` and everything beneath it
// until the next heading at level <= sourceLevel (or EOF). Fence-aware.
function subtreeRange(
  body: string,
  headingBodyLine: number,
  sourceLevel: number,
): { start: number; end: number } {
  const lines = body.split("\n");
  const start = headingBodyLine - 1;
  let end = lines.length;
  let fence: { ch: "`" | "~"; len: number } | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const run = fenceMatch[2]!;
      const ch = run[0] as "`" | "~";
      if (fence === null) {
        fence = { ch, len: run.length };
        continue;
      }
      if (ch === fence.ch && run.length >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    const h = line.match(HEADING_RE);
    if (h && h[1]!.length <= sourceLevel) {
      end = i;
      break;
    }
  }
  // Trailing blank lines belong to the separator between siblings, not
  // to the subtree itself. Leaving them in the source keeps the visual
  // gap between the cut point and the next heading; the destination
  // gets its own blank-line padding via `spliceWithSeparator`.
  while (end > start + 1 && lines[end - 1]!.trim().length === 0) end--;
  return { start, end };
}

// Find where a new child of the heading at `targetBodyLine` (with
// level `targetLevel`) should be inserted: the line after the
// heading's own subtree (i.e. where the next sibling/uncle would
// start). For top-of-file targets (line=null, level=0), this is the
// end of the body.
function insertionRangeForTarget(
  body: string,
  targetBodyLine: number | null,
  targetLevel: number,
): number {
  if (targetBodyLine === null) {
    return body.split("\n").length;
  }
  const r = subtreeRange(body, targetBodyLine, targetLevel);
  return r.end;
}

// Apply a level delta to every heading line in `lines` (in place).
// Returns true on success, false if any heading would exceed level 6.
function shiftHeadingLevels(lines: string[], delta: number): boolean {
  if (delta === 0) return true;
  let fence: { ch: "`" | "~"; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const run = fenceMatch[2]!;
      const ch = run[0] as "`" | "~";
      if (fence === null) {
        fence = { ch, len: run.length };
        continue;
      }
      if (ch === fence.ch && run.length >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    const h = line.match(HEADING_RE);
    if (!h) continue;
    const newLevel = h[1]!.length + delta;
    if (newLevel < 1 || newLevel > 6) return false;
    lines[i] = `${"#".repeat(newLevel)} ${h[2]}`;
  }
  return true;
}

// Cut [range.start, range.end) out of `lines`, then clean up the two
// kinds of blank-line debris that the trim in `subtreeRange` (which
// keeps a trailing blank in the source as a sibling separator) leaves
// behind:
//
//   - Top-of-file cuts (range.start === 0) have no "previous heading"
//     to separate from, so the kept blank becomes an orphan leading
//     blank in the new body.
//
//   - Mid-file cuts can leave the boundary with two consecutive
//     blanks: the separator that *preceded* the cut subtree and the
//     separator that *followed* it. With the subtree gone, both
//     separators end up adjacent and read as a stray paragraph break.
//
// Returns the cleaned lines plus how many blanks each cleanup removed
// — same-file callers fold those counts into their target-line
// arithmetic so the post-write line numbering still lines up.
function cutWithBlankCleanup(
  lines: string[],
  range: { start: number; end: number },
): { lines: string[]; leadingStripped: number; boundaryStripped: number } {
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end);

  let boundaryStripped = 0;
  if (
    before.length > 0 &&
    after.length > 0 &&
    before[before.length - 1]!.trim().length === 0 &&
    after[0]!.trim().length === 0
  ) {
    after.shift();
    boundaryStripped = 1;
  }

  const merged = [...before, ...after];

  let leadingStripped = 0;
  if (range.start === 0) {
    while (merged.length > 0 && merged[0]!.trim().length === 0) {
      merged.shift();
      leadingStripped += 1;
    }
  }

  return { lines: merged, leadingStripped, boundaryStripped };
}

// Trim trailing empty lines from `subtree` and ensure exactly one
// blank-line separator between the existing body up to `insertAt` and
// the inserted block. Returns the new lines array along with the
// 0-based index of the first inserted line (the heading itself) inside
// the new array — callers use it to compute where to scroll.
function spliceWithSeparator(
  body: string[],
  insertAt: number,
  subtree: string[],
): { lines: string[]; headingIdx: number } {
  // Strip trailing empties from subtree so we don't accumulate them on
  // repeated refiles.
  let end = subtree.length;
  while (end > 0 && subtree[end - 1]!.trim().length === 0) end--;
  const trimmed = subtree.slice(0, end);
  if (trimmed.length === 0) {
    return { lines: body.slice(), headingIdx: insertAt };
  }

  // Trim trailing blanks from `head` (the body up to `insertAt`). They
  // would otherwise sit between the prior content and the inserted
  // subtree, producing more blank lines than the single separator we
  // add below. This collapses three edge cases at once:
  //   - Empty body (split → `[""]`): head becomes `[]` and we skip
  //     the separator entirely, so a top-of-file refile into an empty
  //     file lands at column 1, not after a leading blank.
  //   - Trailing-newline body (`"text\n"` → `["text", ""]`): the
  //     stray empty trailing slot is folded away, so we emit exactly
  //     one separator instead of two consecutive blanks.
  //   - Standard well-formed body: head's last line is non-blank
  //     content, so the trim is a no-op and behavior is unchanged.
  const headRaw = body.slice(0, insertAt);
  let headEnd = headRaw.length;
  while (headEnd > 0 && headRaw[headEnd - 1]!.trim().length === 0) headEnd--;
  const head = headRaw.slice(0, headEnd);
  const tail = body.slice(insertAt);

  // One blank line of separation when there is real prior content;
  // none when head is empty (start of file, or empty/blank-only body).
  const needsLeadingBlank = head.length > 0;
  const middle: string[] = [];
  if (needsLeadingBlank) middle.push("");
  middle.push(...trimmed);
  // Trailing blank line so the next sibling/parent content is not glued
  // onto the moved subtree.
  if (tail.length > 0 && tail[0]!.trim().length !== 0) middle.push("");
  return {
    lines: [...head, ...middle, ...tail],
    headingIdx: head.length + (needsLeadingBlank ? 1 : 0),
  };
}

async function readWithStat(
  filePath: string,
): Promise<{ resolved: string; raw: string; mtimeMs: number; mode: number }> {
  let resolved: string;
  try {
    resolved = await realpath(filePath);
  } catch {
    resolved = filePath;
  }
  try {
    const st = await stat(resolved);
    const raw = await readFile(resolved, "utf8");
    return { resolved, raw, mtimeMs: st.mtimeMs, mode: st.mode };
  } catch (err) {
    throw new RefileError(
      `failed to read ${filePath}: ${(err as Error).message}`,
      "io-error",
    );
  }
}

async function atomicWrite(
  target: string,
  content: string,
  expectedMtimeMs: number,
  mode: number | undefined,
): Promise<void> {
  try {
    const cur = await stat(target);
    if (Math.abs(cur.mtimeMs - expectedMtimeMs) > 0.5) {
      throw new RefileError(
        `${target} was modified externally between read and write`,
        "conflict",
      );
    }
  } catch (err) {
    if (err instanceof RefileError) throw err;
    throw new RefileError(
      `failed to stat ${target}: ${(err as Error).message}`,
      "io-error",
    );
  }
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const tmp = join(dirname(target), `.${basename(target)}.oak-tmp.${suffix}`);
  try {
    await writeFile(tmp, content, "utf8");
    if (mode !== undefined) {
      try {
        await chmod(tmp, mode & 0o7777);
      } catch {
        // best-effort: a chmod failure shouldn't block the write.
      }
    }
    await rename(tmp, target);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // ignore: tmp may already be gone.
    }
    if (err instanceof RefileError) throw err;
    throw new RefileError(
      `failed to write ${target}: ${(err as Error).message}`,
      "io-error",
    );
  }
}

export type RefileLocation = {
  filePath: string;
  relPath: string;
  // null = top of file; level 0 in that case.
  line: number | null;
  level: number;
};

export async function refile(
  sourceFilePath: string,
  source: RefileSource,
  target: RefileLocation,
  config: RefileConfig,
  agendaConfig: AgendaConfig,
  sourceRelPath?: string,
): Promise<RefileResult> {
  const src = await readWithStat(sourceFilePath);
  const srcRelPath = sourceRelPath ?? sourceFilePath;
  const srcSplit = splitFrontmatter(src.raw);

  let sourceLevel: number;
  let sourceBodyLine: number;
  let resolvedEntryId: string | null = null;
  if (source.kind === "entry") {
    const srcPage = makeOakPage(sourceFilePath, srcSplit.body, srcRelPath);
    const entries = parseAgendaPage(srcPage, agendaConfig);
    const sourceEntry = entries.find((e) => e.entryId === source.entryId);
    if (!sourceEntry) {
      throw new RefileError(
        `entry ${source.entryId} not found in ${sourceFilePath}`,
        "entry-not-found",
      );
    }
    sourceLevel = sourceEntry.level;
    sourceBodyLine = sourceEntry.line;
    resolvedEntryId = source.entryId;
  } else {
    // Verify a heading actually sits at the requested (line, level) so
    // a stale caller does not silently slice the wrong region. This is
    // the line+level analogue of the entryId existence check above.
    const headings = scanHeadings(srcSplit.body);
    const ok = headings.some(
      (h) => h.line === source.line && h.level === source.level,
    );
    if (!ok) {
      throw new RefileError(
        `no heading at ${sourceFilePath}:${source.line} (level ${source.level})`,
        "heading-not-found",
      );
    }
    sourceLevel = source.level;
    sourceBodyLine = source.line;
  }

  const sameFile = src.resolved === (await safeRealpath(target.filePath));

  // Compute subtree from source body.
  const srcBody = srcSplit.body;
  const sourceBodyLines = srcBody.split("\n");
  const range = subtreeRange(srcBody, sourceBodyLine, sourceLevel);
  const subtree = sourceBodyLines.slice(range.start, range.end);

  // Refuse refiling onto self or into own descendant.
  if (sameFile && target.line !== null) {
    if (target.line >= sourceBodyLine && target.line < range.end + 1) {
      throw new RefileError(
        target.line === sourceBodyLine
          ? "cannot refile a heading onto itself"
          : "cannot refile a heading into its own subtree",
        target.line === sourceBodyLine ? "self-refile" : "descendant-target",
      );
    }
  }

  // Verify the target heading still exists where we expect it (the
  // caller may have collected targets from an older snapshot). For
  // top-of-file we only require the file exists.
  if (target.line !== null) {
    const tgtRaw = sameFile
      ? src.raw
      : (await readWithStat(target.filePath)).raw;
    const tgtBody = splitFrontmatter(tgtRaw).body;
    const tgtHeadings = scanHeadings(tgtBody);
    const ok = tgtHeadings.some(
      (h) => h.line === target.line && h.level === target.level,
    );
    if (!ok) {
      throw new RefileError(
        `target heading at ${target.relPath}:${target.line} no longer matches`,
        "target-not-found",
      );
    }
  }

  // Compute level shift. For an in-file target the source becomes a
  // direct child of the target heading (target.level + 1). For a
  // "top of file" target there *is* no parent, so we fall back to the
  // configured root level — defaults to `2` (oak's body convention
  // starts at `##`); users on the emacs org-refile clamp-to-level-1
  // convention can set `topOfFileLevel: 1` in `.oak/refile.yml`.
  const newSourceLevel =
    target.line === null ? config.topOfFileLevel : target.level + 1;
  const delta = newSourceLevel - sourceLevel;
  const shifted = subtree.slice();
  if (!shiftHeadingLevels(shifted, delta)) {
    throw new RefileError(
      "refile would push a heading past level 6",
      "level-overflow",
    );
  }

  if (sameFile) {
    // Cut subtree, then insert into the post-cut body. Insertion index
    // must be recomputed against the post-cut line numbering.
    const cut = cutWithBlankCleanup(sourceBodyLines, range);
    const cutBodyLines = cut.lines;
    const leadingStripped = cut.leadingStripped;
    const boundaryStripped = cut.boundaryStripped;
    let insertBodyLine: number;
    if (target.line === null) {
      insertBodyLine = cutBodyLines.length;
    } else {
      // Translate target body line through the cut. Since we refused
      // descendant targets, target.line never falls inside [start,end).
      const adjusted =
        target.line > range.end
          ? target.line -
            (range.end - range.start) -
            leadingStripped -
            boundaryStripped
          : target.line;
      const cutBody = cutBodyLines.join("\n");
      insertBodyLine = insertionRangeForTarget(cutBody, adjusted, target.level);
    }
    const merged = spliceWithSeparator(cutBodyLines, insertBodyLine, shifted);
    const updatedBody = merged.lines.join("\n");
    const updated = replaceBody(src.raw, updatedBody);
    // Refile mutates body lines; bump `modified` per the standard rule.
    const stamped = withTimestampUpdate(src.raw, updated, nowIsoSecond());
    await atomicWrite(src.resolved, stamped, src.mtimeMs, src.mode);
    // Same-file: cutting [range.start, range.end) shifts every later
    // line up by the cut size. The insertion happens *after* the
    // target heading, so the target line itself moves only when it
    // sat below the cut. The orphan-blank strip and boundary collapse
    // each apply the same kind of shift whenever they ran.
    let targetLineAfter: number | null = target.line;
    if (target.line !== null && target.line - 1 >= range.end) {
      targetLineAfter =
        target.line -
        (range.end - range.start) -
        leadingStripped -
        boundaryStripped;
    }
    return {
      sourceRelPath: srcRelPath,
      sourceEntryId: resolvedEntryId,
      targetRelPath: target.relPath,
      targetLine: target.line,
      targetLineAfter,
      insertedBodyLine: merged.headingIdx + 1,
      movedLines: range.end - range.start,
      sameFile: true,
    };
  }

  // Cross-file: target write first, then source write. If source fails
  // afterwards, the subtree will exist in both files — recoverable.
  const tgt = await readWithStat(target.filePath);
  const tgtSplit = splitFrontmatter(tgt.raw);
  const tgtBody = tgtSplit.body;
  const tgtBodyLines = tgtBody.split("\n");
  const insertBodyLine = insertionRangeForTarget(
    tgtBody,
    target.line,
    target.level,
  );
  const mergedTgt = spliceWithSeparator(tgtBodyLines, insertBodyLine, shifted);
  const updatedTgt = replaceBody(tgt.raw, mergedTgt.lines.join("\n"));
  // Single timestamp shared between the two writes so the pair has a
  // consistent `modified` value when both files end up bumped.
  const writeIso = nowIsoSecond();
  const stampedTgt = withTimestampUpdate(tgt.raw, updatedTgt, writeIso);
  await atomicWrite(tgt.resolved, stampedTgt, tgt.mtimeMs, tgt.mode);

  const { lines: cutSrcBodyLines } = cutWithBlankCleanup(
    sourceBodyLines,
    range,
  );
  const updatedSrc = replaceBody(src.raw, cutSrcBodyLines.join("\n"));
  const stampedSrc = withTimestampUpdate(src.raw, updatedSrc, writeIso);
  await atomicWrite(src.resolved, stampedSrc, src.mtimeMs, src.mode);

  return {
    sourceRelPath: srcRelPath,
    sourceEntryId: resolvedEntryId,
    targetRelPath: target.relPath,
    targetLine: target.line,
    // Cross-file: the target file isn't cut, so the target heading
    // stays where it was.
    targetLineAfter: target.line,
    insertedBodyLine: mergedTgt.headingIdx + 1,
    movedLines: range.end - range.start,
    sameFile: false,
  };
}

// Replace the body portion (everything after frontmatter) of `raw`
// with `newBody`. Round-trips exactly: `splitFrontmatter` returns the
// frontmatter block including its trailing `---\n`, so concatenating
// with `newBody` reproduces the original when the body is unchanged.
function replaceBody(raw: string, newBody: string): string {
  const { prefix } = splitFrontmatter(raw);
  return `${prefix}${newBody}`;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}
