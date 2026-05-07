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

export { markDone, WriteBackError } from "./writeback.js";
export type { MarkDoneResult } from "./writeback.js";

import type { Vault } from "../types.js";
import { parseAgendaPage } from "./parse.js";
import type { AgendaConfig, AgendaEntry } from "./types.js";

// Convenience: extract entries from every page in a parsed Vault.
// Pages are visited in id-order (same iteration as the Map preserves
// insertion order), which keeps output stable across runs.
export function extractVaultAgendaEntries(
  vault: Vault,
  config: AgendaConfig,
): AgendaEntry[] {
  const out: AgendaEntry[] = [];
  for (const page of vault.pages.values()) {
    for (const e of parseAgendaPage(page, config)) {
      out.push(e);
    }
  }
  return out;
}
