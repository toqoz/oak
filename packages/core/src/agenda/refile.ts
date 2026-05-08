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
// becomes a direct child of the target heading (or a top-level heading
// when refiled to "top of file"). We refuse a shift that would push any
// heading past level 6.

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

import { parseAgendaPage } from "./parse.js";
import type { AgendaConfig } from "./types.js";
import type { OakPage, Vault } from "../types.js";

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
  sourceEntryId: string;
  targetRelPath: string;
  targetLine: number | null;
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

// Trim trailing empty lines from `subtree` and ensure exactly one
// blank-line separator between the existing body up to `insertAt` and
// the inserted block. Returns the new lines array.
function spliceWithSeparator(
  body: string[],
  insertAt: number,
  subtree: string[],
): string[] {
  // Strip trailing empties from subtree so we don't accumulate them on
  // repeated refiles.
  let end = subtree.length;
  while (end > 0 && subtree[end - 1]!.trim().length === 0) end--;
  const trimmed = subtree.slice(0, end);
  if (trimmed.length === 0) return body.slice();

  // Decide leading separator: a single blank line before the subtree
  // unless we are inserting at index 0 of an empty file.
  const head = body.slice(0, insertAt);
  const tail = body.slice(insertAt);
  const needsLeadingBlank =
    head.length > 0 && head[head.length - 1]!.trim().length !== 0;
  const middle: string[] = [];
  if (needsLeadingBlank) middle.push("");
  middle.push(...trimmed);
  // Trailing blank line so the next sibling/parent content is not glued
  // onto the moved subtree.
  if (tail.length > 0 && tail[0]!.trim().length !== 0) middle.push("");
  return [...head, ...middle, ...tail];
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
  sourceEntryId: string,
  target: RefileLocation,
  config: AgendaConfig,
  sourceRelPath?: string,
): Promise<RefileResult> {
  const src = await readWithStat(sourceFilePath);
  const srcRelPath = sourceRelPath ?? sourceFilePath;
  const srcSplit = splitFrontmatter(src.raw);
  const srcPage = makeOakPage(sourceFilePath, srcSplit.body, srcRelPath);
  const entries = parseAgendaPage(srcPage, config);
  const sourceEntry = entries.find((e) => e.entryId === sourceEntryId);
  if (!sourceEntry) {
    throw new RefileError(
      `entry ${sourceEntryId} not found in ${sourceFilePath}`,
      "entry-not-found",
    );
  }
  const sourceLevel = sourceEntry.level;
  const sourceBodyLine = sourceEntry.line;

  const sameFile = src.resolved === (await safeRealpath(target.filePath));

  // Compute subtree from source body.
  const sourceBodyLines = srcPage.body.split("\n");
  const range = subtreeRange(srcPage.body, sourceBodyLine, sourceLevel);
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

  // Compute level shift: source heading should become level (target.level + 1).
  const newSourceLevel = target.level + 1;
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
    const cutBodyLines = [
      ...sourceBodyLines.slice(0, range.start),
      ...sourceBodyLines.slice(range.end),
    ];
    let insertBodyLine: number;
    if (target.line === null) {
      insertBodyLine = cutBodyLines.length;
    } else {
      // Translate target body line through the cut. Since we refused
      // descendant targets, target.line never falls inside [start,end).
      const adjusted =
        target.line > range.end
          ? target.line - (range.end - range.start)
          : target.line;
      const cutBody = cutBodyLines.join("\n");
      insertBodyLine = insertionRangeForTarget(cutBody, adjusted, target.level);
    }
    const merged = spliceWithSeparator(cutBodyLines, insertBodyLine, shifted);
    const updatedBody = merged.join("\n");
    const updated = replaceBody(src.raw, updatedBody);
    await atomicWrite(src.resolved, updated, src.mtimeMs, src.mode);
    return {
      sourceRelPath: srcRelPath,
      sourceEntryId,
      targetRelPath: target.relPath,
      targetLine: target.line,
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
  const updatedTgt = replaceBody(tgt.raw, mergedTgt.join("\n"));
  await atomicWrite(tgt.resolved, updatedTgt, tgt.mtimeMs, tgt.mode);

  const cutSrcBodyLines = [
    ...sourceBodyLines.slice(0, range.start),
    ...sourceBodyLines.slice(range.end),
  ];
  const updatedSrc = replaceBody(src.raw, cutSrcBodyLines.join("\n"));
  await atomicWrite(src.resolved, updatedSrc, src.mtimeMs, src.mode);

  return {
    sourceRelPath: srcRelPath,
    sourceEntryId,
    targetRelPath: target.relPath,
    targetLine: target.line,
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
