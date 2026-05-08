// DONE-transition file rewrite.
//
// Two flavors:
//   1. Repeater present: leave the keyword as TODO, advance the
//      SCHEDULED/DEADLINE timestamps, and prepend a state-change line
//      to the :LOGBOOK: drawer (created if missing). Newest entry
//      sits at the top so a user reading the drawer top-to-bottom
//      sees the most recent transition first.
//   2. No repeater: rewrite the keyword to the configured DONE keyword
//      (first one in config.doneKeywords) and insert/replace a CLOSED
//      planning line on the line after the heading.

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
import matter from "gray-matter";

import { parseAgendaPage, parsePlanningLine } from "./parse.js";
import {
  advanceRepeater,
  formatTimestamp,
  nowIsoMinute,
} from "./timestamp.js";
import type { AgendaConfig, AgendaEntry, AgendaTimestamp } from "./types.js";
import type { OakPage } from "../types.js";

export class WriteBackError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "entry-not-found"
      | "no-todo-state"
      | "already-done"
      | "conflict"
      | "io-error",
  ) {
    super(message);
    this.name = "WriteBackError";
  }
}

export type MarkDoneResult = {
  filePath: string;
  entryId: string;
  // True if the entry was a repeater; false if a one-shot DONE.
  repeated: boolean;
  // The new agenda entry as it now exists in the file (for callers
  // that want to update their UI without re-parsing the whole vault).
  next: AgendaEntry;
};

function makeOakPage(
  filePath: string,
  raw: string,
  relPath: string,
): OakPage {
  const parsed = matter(raw);
  return {
    type: "page",
    id: "writeback:tmp",
    title: "writeback",
    aliases: [],
    visibility: "private",
    slug: "",
    llm: "deny",
    filePath,
    relPath,
    basename: filePath.split(/[\\/]/).pop() ?? filePath,
    body: parsed.content,
    rawFrontmatter: parsed.data ?? {},
    links: [],
    parseIssues: [],
  };
}

function indexBodyLineToFileLine(
  raw: string,
  bodyLine: number,
): number {
  return bodyLine + frontmatterLineCount(raw);
}

// Number of newlines a YAML frontmatter block consumes at the top of
// `raw`. Returns 0 when no frontmatter is present, otherwise the count
// of `\n` between the opening `---` and the first body line. Tolerates
// both LF and CRLF line endings so plugin-side and core-side line
// arithmetic agree on Windows-authored files.
//
// Exported so the Obsidian plugin's body-line → file-line conversion
// can stay in lock-step with `markDone`'s. Two implementations would
// rot apart and silently misnavigate / miswrite once they diverge.
export function frontmatterLineCount(raw: string): number {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return 0;
  return (m[0].match(/\n/g) ?? []).length;
}

export async function markDone(
  filePath: string,
  entryId: string,
  config: AgendaConfig,
  now: Date = new Date(),
  relPath?: string,
): Promise<MarkDoneResult> {
  // Resolve symlinks once and use the realpath for both the read and
  // the conflict check so the mtime comparison is meaningful even when
  // the caller passed a vault-relative symlink target.
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    resolvedPath = filePath;
  }
  let raw: string;
  let preMtimeMs: number;
  try {
    const st = await stat(resolvedPath);
    preMtimeMs = st.mtimeMs;
    raw = await readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new WriteBackError(
      `failed to read ${filePath}: ${(err as Error).message}`,
      "io-error",
    );
  }

  // The entryId is derived from `relPath + heading-path`. To find the
  // entry again we MUST re-parse with the same relPath the original
  // parse used. Fall back to filePath if the caller doesn't have it.
  const page = makeOakPage(filePath, raw, relPath ?? filePath);
  const entries = parseAgendaPage(page, config);
  const target = entries.find((e) => e.entryId === entryId);
  if (!target) {
    throw new WriteBackError(
      `entry ${entryId} not found in ${filePath}`,
      "entry-not-found",
    );
  }
  if (target.todoState === null) {
    throw new WriteBackError(
      `entry ${entryId} has no TODO state to mark DONE`,
      "no-todo-state",
    );
  }
  const doneSet = new Set(config.doneKeywords);
  if (doneSet.has(target.todoState)) {
    // Repeaters stay in TODO state, so we shouldn't get here for them.
    throw new WriteBackError(
      `entry ${entryId} is already in DONE state \`${target.todoState}\``,
      "already-done",
    );
  }

  const hasRepeater =
    (target.scheduled?.repeater !== undefined) ||
    (target.deadline?.repeater !== undefined);

  const fileLine = indexBodyLineToFileLine(raw, target.line);
  const lines = raw.split("\n");
  const headingIdx = fileLine - 1;
  const headingLine = lines[headingIdx];
  if (!headingLine) {
    throw new WriteBackError(
      `internal: heading line ${fileLine} out of range`,
      "io-error",
    );
  }
  const nowIso = nowIsoMinute(now);

  let next: AgendaEntry;

  // Locate the planning line below the heading. We require the line
  // to actually parse as a planning line (only SCHEDULED/DEADLINE/
  // CLOSED tokens, nothing else) to avoid clobbering body prose that
  // happens to contain one of the keywords.
  const planningIdx = findPlanningLineIdx(lines, headingIdx);

  if (hasRepeater) {
    // 1. Advance timestamps in their planning lines.
    const newSched = target.scheduled
      ? target.scheduled.repeater
        ? advanceRepeater(target.scheduled, nowIso)
        : target.scheduled
      : undefined;
    const newDead = target.deadline
      ? target.deadline.repeater
        ? advanceRepeater(target.deadline, nowIso)
        : target.deadline
      : undefined;

    if (planningIdx !== -1) {
      lines[planningIdx] = rewritePlanningLine(
        lines[planningIdx]!,
        newSched,
        newDead,
        target.closed,
      );
    }

    // 2. Append LOGBOOK entry. Locate or create :LOGBOOK: drawer.
    const logEntry = `- State "DONE" from "${target.todoState}" ${formatInactive(nowIso)}`;
    insertLogbookEntry(lines, headingIdx, logEntry);

    next = {
      ...target,
      ...(newSched !== undefined ? { scheduled: newSched } : {}),
      ...(newDead !== undefined ? { deadline: newDead } : {}),
    };
  } else {
    // Replace keyword and add CLOSED planning line. We assert the
    // replacement actually fired — a no-op replace would silently
    // leave the keyword unchanged while still inserting a CLOSED
    // line, which would be a confusing partial update.
    const doneKeyword = config.doneKeywords[0] ?? "DONE";
    const replaced = headingLine.replace(
      new RegExp(`^(#{1,6}\\s+)${escapeRegex(target.todoState)}(\\b)`),
      `$1${doneKeyword}$2`,
    );
    if (replaced === headingLine) {
      throw new WriteBackError(
        `entry ${entryId} heading no longer carries TODO keyword \`${target.todoState}\` (file edited?)`,
        "entry-not-found",
      );
    }
    lines[headingIdx] = replaced;

    const closedTs: AgendaTimestamp = {
      iso: nowIso,
      hasTime: true,
      active: false,
    };
    if (planningIdx !== -1) {
      lines[planningIdx] = rewritePlanningLine(
        lines[planningIdx]!,
        target.scheduled,
        target.deadline,
        closedTs,
      );
    } else {
      lines.splice(headingIdx + 1, 0, `CLOSED: ${formatTimestamp(closedTs)}`);
    }
    next = { ...target, todoState: doneKeyword, closed: closedTs };
  }

  const updated = lines.join("\n");
  await atomicWrite(resolvedPath, updated, preMtimeMs);

  return {
    filePath,
    entryId,
    repeated: hasRepeater,
    next,
  };
}

function findPlanningLineIdx(lines: string[], headingIdx: number): number {
  // Walk forward from the heading. Empty lines are skipped, and a
  // leading `:PROPERTIES:` drawer is jumped over to its `:END:` line
  // so the search reaches a planning line that sits *after* the
  // properties block — `parseAgendaPage` accepts that placement, and
  // we'd otherwise refuse to rewrite it from `markDone`.
  let i = headingIdx + 1;
  while (i < lines.length) {
    if (lines[i]!.trim().length === 0) {
      i++;
      continue;
    }
    if (/^\s*:PROPERTIES:\s*$/.test(lines[i]!)) {
      i++;
      while (i < lines.length && !/^\s*:END:\s*$/i.test(lines[i]!)) i++;
      if (i < lines.length) i++;
      continue;
    }
    return parsePlanningLine(lines[i]!).matched ? i : -1;
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatInactive(iso: string): string {
  const ts: AgendaTimestamp = { iso, hasTime: iso.length > 10, active: false };
  return formatTimestamp(ts);
}

function rewritePlanningLine(
  original: string,
  scheduled?: AgendaTimestamp,
  deadline?: AgendaTimestamp,
  closed?: AgendaTimestamp,
): string {
  const parts: string[] = [];
  if (scheduled) parts.push(`SCHEDULED: ${formatTimestamp(scheduled)}`);
  if (deadline) parts.push(`DEADLINE: ${formatTimestamp(deadline)}`);
  if (closed) parts.push(`CLOSED: ${formatTimestamp(closed)}`);
  // Preserve leading indent.
  const indent = original.match(/^\s*/)?.[0] ?? "";
  return `${indent}${parts.join(" ")}`;
}

function insertLogbookEntry(
  lines: string[],
  headingIdx: number,
  entry: string,
): void {
  // Walk forward looking for an existing :LOGBOOK: drawer attached to
  // this heading. Stop at the next heading.
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i]!)) break;
    if (/^\s*:LOGBOOK:\s*$/.test(lines[i]!)) {
      // Insert entry as the first line inside the drawer.
      lines.splice(i + 1, 0, entry);
      return;
    }
  }
  // Otherwise create one immediately after the planning line(s).
  let insertAt = headingIdx + 1;
  while (
    insertAt < lines.length &&
    parsePlanningLine(lines[insertAt]!).matched
  ) {
    insertAt++;
  }
  // Skip an existing :PROPERTIES: drawer if present.
  if (
    insertAt < lines.length &&
    /^\s*:PROPERTIES:\s*$/.test(lines[insertAt]!)
  ) {
    while (insertAt < lines.length && !/^\s*:END:\s*$/i.test(lines[insertAt]!)) {
      insertAt++;
    }
    if (insertAt < lines.length) insertAt++;
  }
  lines.splice(insertAt, 0, ":LOGBOOK:", entry, ":END:");
}

// Write `content` to `target` atomically: stage to a unique tmp file
// alongside the target, copy the original mode bits, then `rename` —
// which is atomic within the same directory on POSIX. Two safety checks
// before the rename:
//   - `expectedMtimeMs` must still match `target`'s mtime, otherwise we
//     refuse the write (someone else edited the file between read and
//     write) so optimistic edits surface as a conflict instead of
//     silently clobbering the user's work
//   - the tmp name embeds pid + 8 random bytes to avoid two concurrent
//     `markDone` calls racing on the same `.oak-tmp` path
async function atomicWrite(
  target: string,
  content: string,
  expectedMtimeMs: number,
): Promise<void> {
  let mode: number | undefined;
  try {
    const cur = await stat(target);
    if (Math.abs(cur.mtimeMs - expectedMtimeMs) > 0.5) {
      throw new WriteBackError(
        `${target} was modified externally between read and write`,
        "conflict",
      );
    }
    mode = cur.mode;
  } catch (err) {
    if (err instanceof WriteBackError) throw err;
    throw new WriteBackError(
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
        // best-effort: a chmod failure (e.g. exotic filesystem) shouldn't
        // block the write, the file content is still correct.
      }
    }
    await rename(tmp, target);
  } catch (err) {
    // If rename failed mid-flight, leave no orphan tmp behind.
    try {
      await unlink(tmp);
    } catch {
      // ignore: tmp may already be gone (e.g. successful rename above
      // that then errored on a follow-up).
    }
    if (err instanceof WriteBackError) throw err;
    throw new WriteBackError(
      `failed to write ${target}: ${(err as Error).message}`,
      "io-error",
    );
  }
}

// Test-only handle for the conflict-detection plumbing. Production code
// must not import this — `markDone` already wires the real flow.
export const _internal = { atomicWrite };
