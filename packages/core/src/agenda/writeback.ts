// DONE-transition file rewrite.
//
// Two flavors:
//   1. Repeater present: leave the keyword as TODO, advance the
//      SCHEDULED/DEADLINE timestamps, and append a state-change line
//      under :LOGBOOK:.
//   2. No repeater: rewrite the keyword to the configured DONE keyword
//      (first one in config.doneKeywords) and insert/replace a CLOSED
//      planning line on the line after the heading.

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";

import { parseAgendaPage } from "./parse.js";
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
  // gray-matter strips the frontmatter and leaves the body as `content`.
  // Find the file-line offset by counting newlines up to where the body
  // begins.
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  if (!m) return bodyLine;
  const fmText = m[0];
  const fmLines = (fmText.match(/\n/g) ?? []).length;
  return bodyLine + fmLines;
}

export async function markDone(
  filePath: string,
  entryId: string,
  config: AgendaConfig,
  now: Date = new Date(),
  relPath?: string,
): Promise<MarkDoneResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
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

    // Find planning line below heading (allowing leading whitespace).
    let planningIdx = headingIdx + 1;
    while (
      planningIdx < lines.length &&
      lines[planningIdx]!.trim().length === 0
    ) {
      planningIdx++;
    }
    if (
      planningIdx < lines.length &&
      /(SCHEDULED|DEADLINE|CLOSED):/.test(lines[planningIdx]!)
    ) {
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
    // Replace keyword and add CLOSED planning line.
    const doneKeyword = config.doneKeywords[0] ?? "DONE";
    lines[headingIdx] = headingLine.replace(
      new RegExp(`^(#{1,6}\\s+)${escapeRegex(target.todoState)}(\\b)`),
      `$1${doneKeyword}$2`,
    );

    let planningIdx = headingIdx + 1;
    while (
      planningIdx < lines.length &&
      lines[planningIdx]!.trim().length === 0
    ) {
      planningIdx++;
    }
    const closedTs: AgendaTimestamp = {
      iso: nowIso,
      hasTime: true,
      active: false,
    };
    if (
      planningIdx < lines.length &&
      /(SCHEDULED|DEADLINE|CLOSED):/.test(lines[planningIdx]!)
    ) {
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
  await atomicWrite(filePath, updated);

  return {
    filePath,
    entryId,
    repeated: hasRepeater,
    next,
  };
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
    /(SCHEDULED|DEADLINE|CLOSED):/.test(lines[insertAt]!)
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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = join(dirname(filePath), `.${(filePath.split(/[\\/]/).pop() ?? "tmp")}.oak-tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    throw new WriteBackError(
      `failed to write ${filePath}: ${(err as Error).message}`,
      "io-error",
    );
  }
}
