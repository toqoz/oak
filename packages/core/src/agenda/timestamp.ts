// Local civil date arithmetic for org timestamps.
//
// We deliberately ignore timezones and DST. Org timestamps are local
// civil dates with optional local civil times; the agenda only ever
// compares "did the user mean today" against "today as the user
// experiences it". To avoid introducing a third-party date library
// (and to keep the implementation auditable), we use Date.UTC for
// arithmetic, treating local civil components as UTC, then format
// back. Because we never cross a timezone boundary, the day count
// arithmetic is exact; for hour/minute math we use millisecond deltas.

import type {
  AgendaTimestamp,
  DurationUnit,
  Repeater,
  WarningPeriod,
} from "./types.js";

const TIMESTAMP_RE =
  /([<\[])(\d{4})-(\d{2})-(\d{2})(?:\s+[A-Za-z][A-Za-z]+)?(?:\s+(\d{2}):(\d{2})(?:-(\d{2}):(\d{2}))?)?((?:\s+(?:\+|\+\+|\.\+)\d+[hdwmy])|(?:\s+-\d+[hdwmy]))*\s*([>\]])/;

const REPEATER_RE = /(\+|\+\+|\.\+)(\d+)([hdwmy])/;
const WARNING_RE = /-(\d+)([hdwmy])/;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// --- Civil-date helpers ----------------------------------------------------

// Parse YYYY-MM-DD or YYYY-MM-DDTHH:MM into a tuple of UTC components
// suitable for Date.UTC. We do NOT round-trip through a local Date to
// avoid the host TZ shifting the date.
function splitIso(iso: string): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  hasTime: boolean;
} {
  const t = iso.indexOf("T");
  let dateStr: string;
  let timeStr: string | null;
  if (t === -1) {
    dateStr = iso;
    timeStr = null;
  } else {
    dateStr = iso.slice(0, t);
    timeStr = iso.slice(t + 1);
  }
  const [y, m, d] = dateStr.split("-").map((s) => parseInt(s, 10));
  const hh = timeStr ? parseInt(timeStr.slice(0, 2), 10) : 0;
  const mm = timeStr ? parseInt(timeStr.slice(3, 5), 10) : 0;
  return {
    y: y!,
    m: m!,
    d: d!,
    hh,
    mm,
    hasTime: timeStr !== null,
  };
}

function toUtcMs(iso: string): number {
  const { y, m, d, hh, mm } = splitIso(iso);
  return Date.UTC(y, m - 1, d, hh, mm);
}

function isoFromUtc(ms: number, hasTime: boolean): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const hh = dt.getUTCHours();
  const mm = dt.getUTCMinutes();
  const date = `${y}-${pad2(mo)}-${pad2(d)}`;
  return hasTime ? `${date}T${pad2(hh)}:${pad2(mm)}` : date;
}

export function todayIso(now: Date = new Date()): string {
  // Caller's local civil date.
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function nowIsoMinute(now: Date = new Date()): string {
  return `${todayIso(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function dayOfWeek(iso: string): number {
  // 0=Sunday … 6=Saturday for the YYYY-MM-DD prefix of `iso`.
  const { y, m, d } = splitIso(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayName(iso: string): string {
  return DAY_NAMES[dayOfWeek(iso)]!;
}

// Add `n` units to an ISO date, returning the new ISO. If the original
// has time, the time component is preserved; if not, the result has
// only a date component.
export function addUnits(
  iso: string,
  n: number,
  unit: DurationUnit,
): string {
  const { y, m, d, hh, mm, hasTime } = splitIso(iso);
  switch (unit) {
    case "h":
      return isoFromUtc(Date.UTC(y, m - 1, d, hh + n, mm), hasTime || true);
    case "d":
      return isoFromUtc(Date.UTC(y, m - 1, d + n, hh, mm), hasTime);
    case "w":
      return isoFromUtc(Date.UTC(y, m - 1, d + 7 * n, hh, mm), hasTime);
    case "m":
      return isoFromUtc(Date.UTC(y, m - 1 + n, d, hh, mm), hasTime);
    case "y":
      return isoFromUtc(Date.UTC(y + n, m - 1, d, hh, mm), hasTime);
  }
}

// Whole-day delta between two ISO date prefixes (b - a).
export function daysBetween(a: string, b: string): number {
  const aa = splitIso(a);
  const bb = splitIso(b);
  const aMs = Date.UTC(aa.y, aa.m - 1, aa.d);
  const bMs = Date.UTC(bb.y, bb.m - 1, bb.d);
  return Math.round((bMs - aMs) / 86_400_000);
}

export function compareTimestamps(a: AgendaTimestamp, b: AgendaTimestamp): number {
  return toUtcMs(a.iso) - toUtcMs(b.iso);
}

export function dateOnly(iso: string): string {
  return iso.length > 10 ? iso.slice(0, 10) : iso;
}

// --- Parsing ---------------------------------------------------------------

export function parseTimestamp(raw: string): AgendaTimestamp | null {
  const m = raw.match(TIMESTAMP_RE);
  if (!m) return null;
  const [, openBracket, ys, mo, d, hh, mm, eh, em] = m;
  const active = openBracket === "<";
  const date = `${ys}-${mo}-${d}`;
  const hasTime = hh !== undefined && mm !== undefined;
  const iso = hasTime ? `${date}T${hh}:${mm}` : date;
  let endIso: string | undefined;
  if (eh !== undefined && em !== undefined) {
    endIso = `${date}T${eh}:${em}`;
  }

  let repeater: Repeater | undefined;
  let warn: WarningPeriod | undefined;
  // The capture group only retains the last match; re-scan the raw
  // bracket payload for ALL repeater/warning tokens.
  const tail = raw.slice(0, raw.lastIndexOf(active ? ">" : "]"));
  for (const r of tail.matchAll(/(\+\+|\.\+|\+)(\d+)([hdwmy])/g)) {
    repeater = {
      kind: r[1] as Repeater["kind"],
      n: parseInt(r[2]!, 10),
      unit: r[3] as DurationUnit,
    };
  }
  for (const w of tail.matchAll(/-(\d+)([hdwmy])/g)) {
    // Be careful: a date like 2026-05-06 also contains "-..." matches.
    // Skip warnings that overlap the date itself by requiring a leading
    // space before the dash.
    const at = w.index ?? 0;
    if (at === 0 || tail[at - 1] !== " ") continue;
    warn = { n: parseInt(w[1]!, 10), unit: w[2] as DurationUnit };
  }

  const ts: AgendaTimestamp = { iso, hasTime, active };
  if (endIso !== undefined) ts.endIso = endIso;
  if (repeater !== undefined) ts.repeater = repeater;
  if (warn !== undefined) ts.warn = warn;
  return ts;
}

// Parse a date-range timestamp: `<...>--<...>`.
// Returns a single AgendaTimestamp with iso=start, endIso=end, hasTime=false
// unless both ends carry times (in which case endIso carries the end time).
export function parseRangeTimestamp(raw: string): AgendaTimestamp | null {
  const sep = raw.indexOf(">--<");
  const sep2 = raw.indexOf("]--[");
  let split: number;
  if (sep !== -1) split = sep + 1;
  else if (sep2 !== -1) split = sep2 + 1;
  else return null;
  const left = raw.slice(0, split);
  const right = raw.slice(split + 2);
  const a = parseTimestamp(left);
  const b = parseTimestamp(right);
  if (!a || !b) return null;
  const out: AgendaTimestamp = {
    iso: a.iso,
    hasTime: a.hasTime,
    active: a.active && b.active,
    endIso: b.iso,
  };
  if (a.repeater) out.repeater = a.repeater;
  if (a.warn) out.warn = a.warn;
  return out;
}

// Parse all active+inactive timestamps from a body of text. Order of
// appearance is preserved. Range timestamps (`<…>--<…>`) collapse into
// one entry.
export function parseAllTimestamps(body: string): AgendaTimestamp[] {
  const out: AgendaTimestamp[] = [];
  // First sweep range timestamps.
  const consumed: Array<[number, number]> = [];
  const RANGE_RE =
    /(<\d{4}-\d{2}-\d{2}[^>]*>--<\d{4}-\d{2}-\d{2}[^>]*>)|(\[\d{4}-\d{2}-\d{2}[^\]]*\]--\[\d{4}-\d{2}-\d{2}[^\]]*\])/g;
  for (const m of body.matchAll(RANGE_RE)) {
    const t = parseRangeTimestamp(m[0]);
    if (t) {
      out.push(t);
      consumed.push([m.index!, m.index! + m[0].length]);
    }
  }
  // Then standalone single timestamps that don't overlap a range.
  const SINGLE_RE =
    /(<\d{4}-\d{2}-\d{2}[^>]*>)|(\[\d{4}-\d{2}-\d{2}[^\]]*\])/g;
  for (const m of body.matchAll(SINGLE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (consumed.some(([a, b]) => start >= a && end <= b)) continue;
    const t = parseTimestamp(m[0]);
    if (t) out.push(t);
  }
  return out;
}

// --- Formatting ------------------------------------------------------------

export function formatTimestamp(ts: AgendaTimestamp): string {
  const open = ts.active ? "<" : "[";
  const close = ts.active ? ">" : "]";
  const date = dateOnly(ts.iso);
  let body = `${date} ${dayName(date)}`;
  if (ts.hasTime) {
    const time = ts.iso.slice(11, 16);
    if (ts.endIso && ts.endIso.length > 10 && dateOnly(ts.endIso) === date) {
      body += ` ${time}-${ts.endIso.slice(11, 16)}`;
    } else {
      body += ` ${time}`;
    }
  }
  if (ts.repeater) {
    body += ` ${ts.repeater.kind}${ts.repeater.n}${ts.repeater.unit}`;
  }
  if (ts.warn) {
    body += ` -${ts.warn.n}${ts.warn.unit}`;
  }
  return `${open}${body}${close}`;
}

// --- Repeater advancement --------------------------------------------------

export function advanceRepeater(
  ts: AgendaTimestamp,
  doneAtIso: string,
): AgendaTimestamp {
  if (!ts.repeater) return ts;
  const { kind, n, unit } = ts.repeater;
  let nextIso: string;
  switch (kind) {
    case "+":
      nextIso = addUnits(ts.iso, n, unit);
      break;
    case "++": {
      // Shift by `n unit` increments until strictly after doneAt.
      let cur = ts.iso;
      const targetMs = toUtcMs(doneAtIso);
      while (toUtcMs(cur) <= targetMs) {
        cur = addUnits(cur, n, unit);
      }
      nextIso = cur;
      break;
    }
    case ".+": {
      // Shift relative to doneAt, preserving the time-of-day from the
      // original if any.
      const orig = splitIso(ts.iso);
      const baseIso = orig.hasTime
        ? `${dateOnly(doneAtIso)}T${pad2(orig.hh)}:${pad2(orig.mm)}`
        : dateOnly(doneAtIso);
      nextIso = addUnits(baseIso, n, unit);
      break;
    }
  }
  const out: AgendaTimestamp = {
    iso: nextIso,
    hasTime: ts.hasTime,
    active: ts.active,
  };
  if (ts.endIso !== undefined) {
    // For time-ranges-on-same-day, advance the end timestamp by the
    // same delta the start moved.
    const deltaMs = toUtcMs(nextIso) - toUtcMs(ts.iso);
    out.endIso = isoFromUtc(toUtcMs(ts.endIso) + deltaMs, ts.endIso.length > 10);
  }
  if (ts.repeater) out.repeater = ts.repeater;
  if (ts.warn) out.warn = ts.warn;
  return out;
}

// --- Warning window --------------------------------------------------------

export function withinWarning(
  deadline: AgendaTimestamp,
  todayIsoDate: string,
  defaultDays: number,
): { onDay: boolean; warning: number | null; overdue: number | null } {
  const dl = dateOnly(deadline.iso);
  const delta = daysBetween(todayIsoDate, dl); // >0 = upcoming, <0 = past
  if (delta === 0) return { onDay: true, warning: null, overdue: null };
  if (delta < 0) return { onDay: false, warning: null, overdue: -delta };
  const warnDays = deadline.warn ? unitsToDays(deadline.warn) : defaultDays;
  if (delta <= warnDays) return { onDay: false, warning: delta, overdue: null };
  return { onDay: false, warning: null, overdue: null };
}

function unitsToDays(w: WarningPeriod): number {
  switch (w.unit) {
    case "h":
      return Math.max(1, Math.ceil(w.n / 24));
    case "d":
      return w.n;
    case "w":
      return w.n * 7;
    case "m":
      return w.n * 30;
    case "y":
      return w.n * 365;
  }
}

export const _internal = {
  TIMESTAMP_RE,
  REPEATER_RE,
  WARNING_RE,
  splitIso,
  toUtcMs,
  isoFromUtc,
};
