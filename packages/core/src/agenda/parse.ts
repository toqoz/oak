// Walk an OakPage's body and emit org-style agenda entries.
//
// Recognized syntax (org-mode embedded in Markdown):
//   - Headings:        `# Foo`, `## Foo` (ATX only)
//   - TODO keyword:    leading word from config.todoKeywords/doneKeywords
//   - Priority:        `[#A]` immediately after the keyword (or after `#`s)
//   - Tags:            trailing `:tag1:tag2:` block
//   - Planning lines:  `SCHEDULED: <…> DEADLINE: <…> CLOSED: […]`
//   - Drawers:         `:PROPERTIES:` / `:LOGBOOK:` / any `:NAME:` … `:END:`
//   - Active TS:       `<2026-05-06 Wed 10:00 +1d -2d>`
//   - Inactive TS:     `[2026-05-06 Wed 09:12]`
//
// Fenced code blocks (``` or ~~~) are inert: anything inside them is
// skipped wholesale.

import { createHash } from "node:crypto";

import type { OakPage } from "../types.js";
import { buildEffectiveTags } from "./tags.js";
import {
  parseAllTimestamps,
  parseRangeTimestamp,
  parseTimestamp,
} from "./timestamp.js";
import type {
  AgendaConfig,
  AgendaEntry,
  AgendaTimestamp,
} from "./types.js";

type Frame = {
  level: number;
  // Heading-line text (without TODO/priority/tags), used for entryId.
  titleForId: string;
  ownTags: string[];
  // Properties drawer pulled from this heading's `:PROPERTIES:`.
  properties: Record<string, string>;
  // Inherited/own category. Cleared properties to default later.
  category: string | null;
};

type Pending = {
  frame: Frame;
  // Heading line, 1-based, in body.
  line: number;
  // Title (without keyword/priority/tags), Markdown-formatted text preserved.
  title: string;
  todoState: string | null;
  priority: string | null;
  scheduled?: AgendaTimestamp;
  deadline?: AgendaTimestamp;
  closed?: AgendaTimestamp;
  bodyLines: string[];
  // True until we've seen a non-planning, non-drawer line; while true,
  // we still accept planning lines as planners.
  acceptingPlanning: boolean;
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(?:`{3,}|~{3,})/;
const TAG_BLOCK_RE = /\s+(:[A-Za-z0-9_@#%]+(?::[A-Za-z0-9_@#%]+)*:)\s*$/;
const PRIORITY_RE = /^\[#([A-Z])\]\s*/;
const PROP_OPEN_RE = /^\s*:([A-Z_][A-Z0-9_]*):\s*$/;
const END_DRAWER_RE = /^\s*:END:\s*$/i;
const PROP_LINE_RE = /^\s*:([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/;
const PLANNING_TOKEN_RE =
  /(SCHEDULED|DEADLINE|CLOSED):\s*(<[^>]+>(?:--<[^>]+>)?|\[[^\]]+\](?:--\[[^\]]+\])?)/g;

function deriveEntryId(relPath: string, headingPath: string[]): string {
  const h = createHash("sha1");
  h.update(relPath);
  h.update("\n");
  for (const t of headingPath) {
    h.update(t);
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

function defaultCategoryFromFile(relPath: string): string {
  const last = relPath.split("/").pop() ?? relPath;
  return last.replace(/\.md$/i, "");
}

function parsePlanningLine(line: string): {
  scheduled?: AgendaTimestamp;
  deadline?: AgendaTimestamp;
  closed?: AgendaTimestamp;
  matched: boolean;
} {
  const out: ReturnType<typeof parsePlanningLine> = { matched: false };
  const re =
    /(SCHEDULED|DEADLINE|CLOSED):\s*(<[^>]+>(?:--<[^>]+>)?|\[[^\]]+\](?:--\[[^\]]+\])?)/g;
  let touched = false;
  for (const m of line.matchAll(re)) {
    touched = true;
    const which = m[1]!;
    const ts =
      m[2]!.includes("--")
        ? parseRangeTimestamp(m[2]!)
        : parseTimestamp(m[2]!);
    if (!ts) continue;
    if (which === "SCHEDULED") out.scheduled = ts;
    else if (which === "DEADLINE") out.deadline = ts;
    else if (which === "CLOSED") out.closed = ts;
  }
  // The line counts as a planning line only if it's exclusively
  // planning tokens + whitespace.
  const stripped = line.replace(re, "").trim();
  out.matched = touched && stripped.length === 0;
  return out;
}

function splitHeadingText(
  raw: string,
  todoSet: Set<string>,
  doneSet: Set<string>,
): {
  todoState: string | null;
  priority: string | null;
  title: string;
  ownTags: string[];
} {
  let rest = raw.trim();
  let ownTags: string[] = [];
  const tagMatch = rest.match(TAG_BLOCK_RE);
  if (tagMatch) {
    const tagBlock = tagMatch[1]!;
    ownTags = tagBlock
      .split(":")
      .filter((t) => t.length > 0);
    rest = rest.slice(0, tagMatch.index!).trimEnd();
  }
  let todoState: string | null = null;
  const firstSpace = rest.indexOf(" ");
  const firstWord = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  if (todoSet.has(firstWord) || doneSet.has(firstWord)) {
    todoState = firstWord;
    rest = firstSpace === -1 ? "" : rest.slice(firstSpace + 1);
  }
  let priority: string | null = null;
  const pri = rest.match(PRIORITY_RE);
  if (pri) {
    priority = pri[1]!;
    rest = rest.slice(pri[0].length);
  }
  return { todoState, priority, title: rest.trim(), ownTags };
}

export function parseAgendaPage(
  page: OakPage,
  config: AgendaConfig,
): AgendaEntry[] {
  const todoSet = new Set(config.todoKeywords);
  const doneSet = new Set(config.doneKeywords);

  const lines = page.body.split("\n");
  const stack: Frame[] = [];
  // Wrap `pending` in an object so closure-mutations from
  // closePending/startHeading don't defeat TS's control-flow narrowing
  // when we later read `pending` inside the loop.
  const pendingHolder: { value: Pending | null } = { value: null };
  const entries: AgendaEntry[] = [];

  // State flags for fence/drawer tracking.
  let inFence = false;
  let drawerName: string | null = null;
  // While inside a `:PROPERTIES:` drawer attached to the current
  // pending heading, accumulate key/value into pending.frame.properties.
  // Other drawers (`:LOGBOOK:`, custom) get skipped.

  const closePending = (): void => {
    const pending = pendingHolder.value;
    if (!pending) return;
    const headingPath: string[] = [];
    for (const f of stack) headingPath.push(f.titleForId);
    headingPath.push(pending.frame.titleForId);
    const ancestorTags = stack.map((f) => f.ownTags);
    const effectiveTags = buildEffectiveTags(
      pending.frame.ownTags,
      ancestorTags,
      config,
    );
    let category =
      pending.frame.properties["CATEGORY"] ??
      stack
        .map((f) => f.properties["CATEGORY"])
        .filter((v): v is string => typeof v === "string")
        .pop();
    if (!category) category = defaultCategoryFromFile(page.relPath);

    const properties: Record<string, string> = {};
    for (const f of stack) Object.assign(properties, f.properties);
    Object.assign(properties, pending.frame.properties);
    if (!properties["CATEGORY"]) properties["CATEGORY"] = category;

    const body = pending.bodyLines.join("\n");
    const bodyTimestamps = parseAllTimestamps(body).filter((t) => t.active);

    // Skip prose headings — those without any TODO state, planning
    // line, or active timestamp — as they're not agenda-relevant.
    const isAgendaWorthy =
      pending.todoState !== null ||
      pending.scheduled !== undefined ||
      pending.deadline !== undefined ||
      pending.closed !== undefined ||
      bodyTimestamps.length > 0;
    if (isAgendaWorthy) {
      const entry: AgendaEntry = {
        entryId: deriveEntryId(page.relPath, headingPath),
        pageId: page.id,
        filePath: page.filePath,
        relPath: page.relPath,
        line: pending.line,
        level: pending.frame.level,
        title: pending.title,
        todoState: pending.todoState,
        priority: pending.priority,
        tags: effectiveTags,
        ownTags: pending.frame.ownTags,
        properties,
        category,
        bodyTimestamps,
        body,
      };
      if (pending.scheduled) entry.scheduled = pending.scheduled;
      if (pending.deadline) entry.deadline = pending.deadline;
      if (pending.closed) entry.closed = pending.closed;
      entries.push(entry);
    }
    // Once the heading is closed, its frame becomes an ancestor for
    // any child headings parsed next. The stack-trim in startHeading
    // is what removes it again when we leave its level.
    stack.push(pending.frame);
    pendingHolder.value = null;
  };

  const startHeading = (level: number, lineNo: number, raw: string): void => {
    closePending();
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }
    const split = splitHeadingText(raw, todoSet, doneSet);
    const frame: Frame = {
      level,
      titleForId: `${level}:${split.title}`,
      ownTags: split.ownTags,
      properties: {},
      category: null,
    };
    pendingHolder.value = {
      frame,
      line: lineNo,
      title: split.title,
      todoState: split.todoState,
      priority: split.priority,
      bodyLines: [],
      acceptingPlanning: true,
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (FENCE_RE.test(line.trimStart())) {
      // Toggle fence and forward to body if pending.
      inFence = !inFence;
      const cur = pendingHolder.value;
      if (cur) {
        cur.bodyLines.push(line);
        cur.acceptingPlanning = false;
      }
      continue;
    }

    if (inFence) {
      const cur = pendingHolder.value;
      if (cur) {
        cur.bodyLines.push(line);
        cur.acceptingPlanning = false;
      }
      continue;
    }

    if (drawerName !== null) {
      if (END_DRAWER_RE.test(line)) {
        drawerName = null;
        continue;
      }
      const cur = pendingHolder.value;
      if (drawerName === "PROPERTIES" && cur) {
        const m = line.match(PROP_LINE_RE);
        if (m) {
          cur.frame.properties[m[1]!.toUpperCase()] = m[2]!;
        }
      }
      // Drawer body is not part of the entry body.
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      startHeading(level, lineNo, headingMatch[2]!);
      continue;
    }

    const cur = pendingHolder.value;
    if (cur && cur.acceptingPlanning) {
      // Allow blank lines without breaking planning acceptance.
      if (line.trim().length === 0) {
        cur.bodyLines.push(line);
        continue;
      }
      const planning = parsePlanningLine(line);
      if (planning.matched) {
        if (planning.scheduled) cur.scheduled = planning.scheduled;
        if (planning.deadline) cur.deadline = planning.deadline;
        if (planning.closed) cur.closed = planning.closed;
        continue;
      }
      const drawerOpen = line.match(PROP_OPEN_RE);
      if (drawerOpen) {
        drawerName = drawerOpen[1]!.toUpperCase();
        continue;
      }
      cur.acceptingPlanning = false;
    } else if (cur) {
      // After body has begun, drawers can still appear (e.g. LOGBOOK
      // grows over time); skip their contents but don't store.
      const drawerOpen = line.match(PROP_OPEN_RE);
      if (drawerOpen) {
        drawerName = drawerOpen[1]!.toUpperCase();
        continue;
      }
    }

    if (cur) {
      cur.bodyLines.push(line);
    }
  }
  closePending();
  return entries;
}
