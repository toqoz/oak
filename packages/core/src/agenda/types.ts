// org-agenda port — public types.
//
// The data model below mirrors emacs `org-agenda` semantics as closely
// as a Markdown-hosted source format permits. Headings are Markdown ATX
// (`#…######`); everything else (TODO keywords, priorities, planning
// lines, drawers, timestamps, repeaters) is lifted verbatim from
// org-mode.

export type RepeaterKind = "+" | "++" | ".+";
export type DurationUnit = "h" | "d" | "w" | "m" | "y";

export type Repeater = {
  kind: RepeaterKind;
  n: number;
  unit: DurationUnit;
};

export type WarningPeriod = {
  n: number;
  unit: DurationUnit;
};

// A single org-style timestamp, active or inactive.
//   <2026-05-06 Wed>            iso=2026-05-06, hasTime=false, active=true
//   <2026-05-06 Wed 10:00>      hasTime=true
//   <2026-05-06 Wed 10:00-11:30> hasTime=true, endIso=2026-05-06T11:30
//   <2026-05-06 Wed 10:00 +1d -2d> repeater={kind:"+",n:1,unit:"d"}, warn={n:2,unit:"d"}
//   [2026-05-06 Wed]            active=false (never appears in agenda)
//   <2026-05-06 Wed>--<2026-05-08 Fri> a date-range; modeled as a single
//   timestamp with iso=start and endIso=end (no time).
export type AgendaTimestamp = {
  iso: string; // YYYY-MM-DD or YYYY-MM-DDTHH:MM (local civil time)
  hasTime: boolean;
  endIso?: string;
  active: boolean;
  repeater?: Repeater;
  warn?: WarningPeriod;
};

export type AgendaEntry = {
  // Stable id derived from relPath + heading-path; survives line edits
  // as long as the heading text/level chain doesn't change.
  entryId: string;
  pageId: string;
  filePath: string;
  relPath: string;
  // 1-based line number of the heading (`# …`) in the source body.
  // Note: we count in body lines (after frontmatter), so consumers that
  // need the absolute file line should add the frontmatter offset.
  line: number;
  level: number; // 1..6 (markdown heading level)
  title: string; // heading text minus TODO/priority/tags
  todoState: string | null;
  priority: string | null; // "A" | "B" | "C" | … (configurable)
  // Effective tags: own + ancestor + frontmatter, with exclude list applied.
  tags: string[];
  ownTags: string[];
  // Property bag from `:PROPERTIES:` drawer + synthesized `:CATEGORY:`.
  properties: Record<string, string>;
  category: string;
  scheduled?: AgendaTimestamp;
  deadline?: AgendaTimestamp;
  closed?: AgendaTimestamp;
  bodyTimestamps: AgendaTimestamp[];
  // Entry body (lines after the heading until the next sibling/EOF),
  // used by the search view. Excludes drawers and planning lines so a
  // body regex doesn't accidentally hit a property.
  body: string;
};

export type AgendaConfig = {
  todoKeywords: string[];
  doneKeywords: string[];
  defaultDeadlineWarningDays: number;
  useTagInheritance: boolean;
  tagsExcludeFromInheritance: string[];
  agendaFiles: string[] | null; // null = whole vault
  agendaFilesExclude: string[];
  weekStartsOn: 0 | 1; // 0 = Sunday, 1 = Monday (org default)
  priorities: { highest: string; lowest: string; default: string };
};

export type AgendaQuery =
  | { kind: "weekly"; from: string; days: number } // YYYY-MM-DD
  | { kind: "todo"; keyword?: string; includeDone?: boolean }
  | { kind: "match"; expression: string }
  | { kind: "search"; regex: string };

// What kind of "marker" applies to an item rendered into an agenda day.
//   "scheduled" — on-day SCHEDULED
//   "scheduled-overdue" — past-due SCHEDULED still pending
//   "deadline" — on-day DEADLINE
//   "deadline-warning" — within the warning window before DEADLINE
//   "deadline-overdue" — past DEADLINE still pending
//   "timestamp" — body active timestamp
export type AgendaMarker =
  | "scheduled"
  | "scheduled-overdue"
  | "deadline"
  | "deadline-warning"
  | "deadline-overdue"
  | "timestamp";

export type AgendaItem = {
  entry: AgendaEntry;
  // For weekly view: the date-bucket this item lives in (YYYY-MM-DD).
  // For other views: the "anchor" date if the entry has one, else null.
  date: string | null;
  marker: AgendaMarker | null;
  // For overdue/warning markers, days delta vs. today (positive = past
  // for overdue, positive = upcoming for warning).
  daysDelta: number | null;
  // Time-of-day if the underlying timestamp had one (HH:MM); else null.
  time: string | null;
  endTime: string | null;
};

export type AgendaView = {
  query: AgendaQuery;
  generatedAt: string; // ISO timestamp
  // For weekly view: keyed YYYY-MM-DD → ordered items.
  // For other views: a single bucket "all".
  buckets: { key: string; label: string; items: AgendaItem[] }[];
};
