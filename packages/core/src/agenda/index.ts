// Public surface of the agenda module.

export type {
  AgendaConfig,
  AgendaEntry,
  AgendaItem,
  AgendaMarker,
  AgendaQuery,
  AgendaTimestamp,
  AgendaView,
  DurationUnit,
  Repeater,
  RepeaterKind,
  SkipDeadlinePrewarningPolicy,
  WarningPeriod,
} from "./types.js";

export {
  DEFAULT_AGENDA_CONFIG,
  loadAgendaConfig,
  mergeAgendaConfig,
} from "./config.js";

export {
  addUnits,
  advanceRepeater,
  compareTimestamps,
  dateOnly,
  dayName,
  dayOfWeek,
  daysBetween,
  formatTimestamp,
  nowIsoMinute,
  parseAllTimestamps,
  parseRangeTimestamp,
  parseTimestamp,
  todayIso,
  withinWarning,
} from "./timestamp.js";

export { buildEffectiveTags } from "./tags.js";

export { parseAgendaPage, parsePlanningLine } from "./parse.js";

export { compileMatch } from "./match.js";
export type { MatchPredicate } from "./match.js";

export {
  buildMatchView,
  buildSearchView,
  buildTodoView,
  buildWeeklyAgenda,
  runAgenda,
  startOfWeek,
} from "./query.js";

export {
  frontmatterLineCount,
  markDone,
  WriteBackError,
} from "./writeback.js";
export type { MarkDoneResult } from "./writeback.js";

export {
  collectRefileTargets,
  refile,
  RefileError,
} from "./refile.js";
export type {
  RefileLocation,
  RefileResult,
  RefileTarget,
} from "./refile.js";

import type { Vault } from "../types.js";
import { parseAgendaPage } from "./parse.js";
import type { AgendaConfig, AgendaEntry } from "./types.js";

// Returns true when `relPath` matches `pattern`. Patterns are
// path-prefix matches with directory semantics:
//   - exact equality (`tasks.md` matches `tasks.md`)
//   - directory prefix (`projects` or `projects/` matches anything
//     under `projects/`)
// Globs (`*`, `**`) are NOT supported on purpose — emacs
// `org-agenda-files` is itself a flat list of files/dirs.
function matchesAgendaPath(relPath: string, pattern: string): boolean {
  const trimmed = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (trimmed.length === 0) return false;
  if (relPath === trimmed) return true;
  return relPath.startsWith(`${trimmed}/`);
}

export function isPageInAgendaScope(
  relPath: string,
  config: AgendaConfig,
): boolean {
  if (config.agendaFiles && config.agendaFiles.length > 0) {
    if (!config.agendaFiles.some((p) => matchesAgendaPath(relPath, p))) {
      return false;
    }
  }
  if (config.agendaFilesExclude.length > 0) {
    if (config.agendaFilesExclude.some((p) => matchesAgendaPath(relPath, p))) {
      return false;
    }
  }
  return true;
}

// Convenience: extract entries from every page in a parsed Vault that
// is in agenda scope. Pages are visited in id-order (same iteration as
// the Map preserves insertion order), which keeps output stable across
// runs.
export function extractVaultAgendaEntries(
  vault: Vault,
  config: AgendaConfig,
): AgendaEntry[] {
  const out: AgendaEntry[] = [];
  for (const page of vault.pages.values()) {
    if (!isPageInAgendaScope(page.relPath, config)) continue;
    for (const e of parseAgendaPage(page, config)) {
      out.push(e);
    }
  }
  return out;
}
