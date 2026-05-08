// Run an AgendaQuery over a flat list of entries to produce an
// AgendaView (the data shape consumed by CLI rendering and the
// Obsidian view).

import {
  addUnits,
  daysBetween,
  dateOnly,
  dayName,
  todayIso,
  withinWarning,
} from "./timestamp.js";
import { compileMatch } from "./match.js";
import type {
  AgendaConfig,
  AgendaEntry,
  AgendaItem,
  AgendaQuery,
  AgendaTimestamp,
  AgendaView,
} from "./types.js";

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function bucketLabel(iso: string, todayIsoDate: string): string {
  const day = DAY_LABELS[
    new Date(
      Date.UTC(
        parseInt(iso.slice(0, 4), 10),
        parseInt(iso.slice(5, 7), 10) - 1,
        parseInt(iso.slice(8, 10), 10),
      ),
    ).getUTCDay()
  ]!;
  const delta = daysBetween(todayIsoDate, iso);
  if (delta === 0) return `${day} ${iso}  (today)`;
  if (delta === 1) return `${day} ${iso}  (tomorrow)`;
  if (delta === -1) return `${day} ${iso}  (yesterday)`;
  return `${day} ${iso}`;
}

function isStillOpen(entry: AgendaEntry, doneSet: Set<string>): boolean {
  if (entry.todoState === null) return true;
  return !doneSet.has(entry.todoState);
}

// Apply `skipDeadlinePrewarningIfScheduled` policy. Mirrors emacs
// `org-agenda-skip-deadline-prewarning-if-scheduled`.
//   false           — never skip (emacs default)
//   true            — always skip when SCHEDULED is set
//   "pre-scheduled" — skip only while today is strictly before the
//                     SCHEDULED date; once scheduled day arrives, the
//                     deadline pre-warning resumes.
function shouldSkipPrewarning(
  entry: AgendaEntry,
  todayIsoDate: string,
  config: AgendaConfig,
): boolean {
  const policy = config.skipDeadlinePrewarningIfScheduled;
  if (!policy) return false;
  if (!entry.scheduled) return false;
  if (policy === true) return true;
  // "pre-scheduled"
  return todayIsoDate < dateOnly(entry.scheduled.iso);
}

function timeOf(ts: AgendaTimestamp): string | null {
  if (!ts.hasTime) return null;
  return ts.iso.slice(11, 16);
}

function endTimeOf(ts: AgendaTimestamp): string | null {
  if (!ts.endIso || ts.endIso.length <= 10) return null;
  return ts.endIso.slice(11, 16);
}

function compareItems(
  a: AgendaItem,
  b: AgendaItem,
  defaultPriority: string,
): number {
  // time-up
  const at = a.time ?? "99:99";
  const bt = b.time ?? "99:99";
  if (at !== bt) return at < bt ? -1 : 1;
  // priority-down (A < B < C means A is higher). Entries without an
  // explicit priority sort as if they had `config.priorities.default`.
  const ap = a.entry.priority ?? defaultPriority;
  const bp = b.entry.priority ?? defaultPriority;
  if (ap !== bp) return ap < bp ? -1 : 1;
  // category-keep
  if (a.entry.category !== b.entry.category) {
    return a.entry.category < b.entry.category ? -1 : 1;
  }
  if (a.entry.line !== b.entry.line) return a.entry.line - b.entry.line;
  return 0;
}

export function buildWeeklyAgenda(
  entries: AgendaEntry[],
  config: AgendaConfig,
  fromIso: string,
  days: number,
  todayIsoDate: string,
): AgendaView {
  const doneSet = new Set(config.doneKeywords);
  const buckets: { key: string; label: string; items: AgendaItem[] }[] = [];

  for (let d = 0; d < days; d++) {
    const dateIso = addUnits(fromIso, d, "d");
    const items: AgendaItem[] = [];

    for (const entry of entries) {
      const open = isStillOpen(entry, doneSet);

      // SCHEDULED
      if (entry.scheduled && open) {
        const sIso = dateOnly(entry.scheduled.iso);
        const delta = daysBetween(sIso, dateIso); // positive = day-after-scheduled
        if (sIso === dateIso) {
          items.push({
            entry,
            date: dateIso,
            marker: "scheduled",
            daysDelta: 0,
            time: timeOf(entry.scheduled),
            endTime: endTimeOf(entry.scheduled),
          });
        } else if (
          // Show overdue scheduled on today only.
          delta > 0 &&
          dateIso === todayIsoDate
        ) {
          items.push({
            entry,
            date: dateIso,
            marker: "scheduled-overdue",
            daysDelta: delta,
            time: timeOf(entry.scheduled),
            endTime: endTimeOf(entry.scheduled),
          });
        }
      }

      // DEADLINE
      if (entry.deadline && open) {
        const dIso = dateOnly(entry.deadline.iso);
        const w = withinWarning(
          entry.deadline,
          dateIso,
          config.defaultDeadlineWarningDays,
        );
        if (w.onDay) {
          items.push({
            entry,
            date: dateIso,
            marker: "deadline",
            daysDelta: 0,
            time: timeOf(entry.deadline),
            endTime: endTimeOf(entry.deadline),
          });
        } else if (
          w.warning !== null &&
          dateIso === todayIsoDate &&
          !shouldSkipPrewarning(entry, dateIso, config)
        ) {
          // Show warning lookahead only on today's bucket.
          items.push({
            entry,
            date: dateIso,
            marker: "deadline-warning",
            daysDelta: w.warning,
            time: null,
            endTime: null,
          });
        } else if (w.overdue !== null && dateIso === todayIsoDate) {
          // Overdue shows on today (and only today).
          items.push({
            entry,
            date: dateIso,
            marker: "deadline-overdue",
            daysDelta: w.overdue,
            time: null,
            endTime: null,
          });
        }
        // Make sure a deadline that is strictly in the future and
        // outside today's warning bucket still shows on its own day.
        if (
          !w.onDay &&
          w.warning === null &&
          w.overdue === null &&
          dIso === dateIso
        ) {
          items.push({
            entry,
            date: dateIso,
            marker: "deadline",
            daysDelta: 0,
            time: timeOf(entry.deadline),
            endTime: endTimeOf(entry.deadline),
          });
        }
      }

      // Body active timestamps (any state).
      for (const ts of entry.bodyTimestamps) {
        const tIso = dateOnly(ts.iso);
        if (tIso === dateIso) {
          items.push({
            entry,
            date: dateIso,
            marker: "timestamp",
            daysDelta: 0,
            time: timeOf(ts),
            endTime: endTimeOf(ts),
          });
        }
      }
    }

    items.sort((a, b) => compareItems(a, b, config.priorities.default));
    buckets.push({
      key: dateIso,
      label: bucketLabel(dateIso, todayIsoDate),
      items,
    });
  }

  return {
    query: { kind: "weekly", from: fromIso, days },
    generatedAt: new Date().toISOString(),
    buckets,
  };
}

export function buildTodoView(
  entries: AgendaEntry[],
  config: AgendaConfig,
  options: { keyword?: string; includeDone?: boolean },
): AgendaView {
  const doneSet = new Set(config.doneKeywords);
  const filtered = entries.filter((e) => {
    if (e.todoState === null) return false;
    if (options.keyword && e.todoState !== options.keyword) return false;
    if (!options.includeDone && doneSet.has(e.todoState)) return false;
    return true;
  });
  const items: AgendaItem[] = filtered.map((entry) => ({
    entry,
    date: entry.scheduled
      ? dateOnly(entry.scheduled.iso)
      : entry.deadline
        ? dateOnly(entry.deadline.iso)
        : null,
    marker: null,
    daysDelta: null,
    time: entry.scheduled
      ? timeOf(entry.scheduled)
      : entry.deadline
        ? timeOf(entry.deadline)
        : null,
    endTime: null,
  }));
  const defaultPri = config.priorities.default;
  items.sort((a, b) => {
    // Priority-down then date-up then alpha.
    const ap = a.entry.priority ?? defaultPri;
    const bp = b.entry.priority ?? defaultPri;
    if (ap !== bp) return ap < bp ? -1 : 1;
    const ad = a.date ?? "9999-99-99";
    const bd = b.date ?? "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.entry.title < b.entry.title ? -1 : 1;
  });
  return {
    query: {
      kind: "todo",
      ...(options.keyword !== undefined ? { keyword: options.keyword } : {}),
      ...(options.includeDone !== undefined
        ? { includeDone: options.includeDone }
        : {}),
    } as AgendaQuery,
    generatedAt: new Date().toISOString(),
    buckets: [{ key: "all", label: "Global TODO list", items }],
  };
}

export function buildMatchView(
  entries: AgendaEntry[],
  expression: string,
  config: AgendaConfig,
): AgendaView {
  const predicate = compileMatch(expression);
  const items: AgendaItem[] = entries
    .filter((e) => predicate(e))
    .map((entry) => ({
      entry,
      date: entry.scheduled
        ? dateOnly(entry.scheduled.iso)
        : entry.deadline
          ? dateOnly(entry.deadline.iso)
          : null,
      marker: null,
      daysDelta: null,
      time: entry.scheduled ? timeOf(entry.scheduled) : null,
      endTime: null,
    }));
  const defaultPri = config.priorities.default;
  items.sort((a, b) => {
    const ap = a.entry.priority ?? defaultPri;
    const bp = b.entry.priority ?? defaultPri;
    if (ap !== bp) return ap < bp ? -1 : 1;
    return a.entry.title < b.entry.title ? -1 : 1;
  });
  return {
    query: { kind: "match", expression },
    generatedAt: new Date().toISOString(),
    buckets: [
      { key: "all", label: `Match: ${expression}`, items },
    ],
  };
}

export function buildSearchView(
  entries: AgendaEntry[],
  regex: string,
): AgendaView {
  const re = new RegExp(regex, "i");
  const items: AgendaItem[] = entries
    .filter(
      (e) => re.test(e.title) || re.test(e.body),
    )
    .map((entry) => ({
      entry,
      date: null,
      marker: null,
      daysDelta: null,
      time: null,
      endTime: null,
    }));
  items.sort((a, b) =>
    a.entry.relPath === b.entry.relPath
      ? a.entry.line - b.entry.line
      : a.entry.relPath < b.entry.relPath
        ? -1
        : 1,
  );
  return {
    query: { kind: "search", regex },
    generatedAt: new Date().toISOString(),
    buckets: [{ key: "all", label: `Search: /${regex}/i`, items }],
  };
}

export function runAgenda(
  entries: AgendaEntry[],
  query: AgendaQuery,
  config: AgendaConfig,
  now: Date = new Date(),
): AgendaView {
  switch (query.kind) {
    case "weekly":
      return buildWeeklyAgenda(
        entries,
        config,
        query.from,
        query.days,
        todayIso(now),
      );
    case "todo":
      return buildTodoView(entries, config, {
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
        ...(query.includeDone !== undefined
          ? { includeDone: query.includeDone }
          : {}),
      });
    case "match":
      return buildMatchView(entries, query.expression, config);
    case "search":
      return buildSearchView(entries, query.regex);
  }
}

// Helper for callers: compute the Monday-of-this-week for a given date,
// honoring weekStartsOn config.
export function startOfWeek(
  iso: string,
  weekStartsOn: 0 | 1,
): string {
  const dow = new Date(
    Date.UTC(
      parseInt(iso.slice(0, 4), 10),
      parseInt(iso.slice(5, 7), 10) - 1,
      parseInt(iso.slice(8, 10), 10),
    ),
  ).getUTCDay();
  // distance back to start-of-week
  const offset = (dow - weekStartsOn + 7) % 7;
  return addUnits(iso, -offset, "d");
}

// Re-export for consumers that need the day name.
export { dayName };
