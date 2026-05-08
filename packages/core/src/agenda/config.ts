// Agenda configuration loader.
//
// Reads `.oak/agenda.yml` from the vault root. All keys are optional;
// defaults match emacs `org-agenda` defaults where reasonable.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { AgendaConfig } from "./types.js";

export const DEFAULT_AGENDA_CONFIG: AgendaConfig = {
  todoKeywords: ["TODO", "NEXT", "WAITING"],
  doneKeywords: ["DONE", "CANCELLED"],
  defaultDeadlineWarningDays: 14,
  useTagInheritance: true,
  tagsExcludeFromInheritance: [],
  agendaFiles: null,
  agendaFilesExclude: [],
  weekStartsOn: 1,
  priorities: { highest: "A", lowest: "C", default: "B" },
  skipDeadlinePrewarningIfScheduled: "pre-scheduled",
};

function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out;
}

export function mergeAgendaConfig(
  partial: Partial<AgendaConfig> | null | undefined,
): AgendaConfig {
  if (!partial) return DEFAULT_AGENDA_CONFIG;
  return {
    todoKeywords:
      partial.todoKeywords ?? DEFAULT_AGENDA_CONFIG.todoKeywords,
    doneKeywords:
      partial.doneKeywords ?? DEFAULT_AGENDA_CONFIG.doneKeywords,
    defaultDeadlineWarningDays:
      partial.defaultDeadlineWarningDays ??
      DEFAULT_AGENDA_CONFIG.defaultDeadlineWarningDays,
    useTagInheritance:
      partial.useTagInheritance ?? DEFAULT_AGENDA_CONFIG.useTagInheritance,
    tagsExcludeFromInheritance:
      partial.tagsExcludeFromInheritance ??
      DEFAULT_AGENDA_CONFIG.tagsExcludeFromInheritance,
    agendaFiles:
      partial.agendaFiles === undefined
        ? DEFAULT_AGENDA_CONFIG.agendaFiles
        : partial.agendaFiles,
    agendaFilesExclude:
      partial.agendaFilesExclude ?? DEFAULT_AGENDA_CONFIG.agendaFilesExclude,
    weekStartsOn:
      partial.weekStartsOn ?? DEFAULT_AGENDA_CONFIG.weekStartsOn,
    priorities: partial.priorities ?? DEFAULT_AGENDA_CONFIG.priorities,
    skipDeadlinePrewarningIfScheduled:
      partial.skipDeadlinePrewarningIfScheduled ??
      DEFAULT_AGENDA_CONFIG.skipDeadlinePrewarningIfScheduled,
  };
}

export async function loadAgendaConfig(rootPath: string): Promise<AgendaConfig> {
  const configPath = join(rootPath, ".oak", "agenda.yml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return DEFAULT_AGENDA_CONFIG;
  }
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch {
    return DEFAULT_AGENDA_CONFIG;
  }
  if (!data || typeof data !== "object") return DEFAULT_AGENDA_CONFIG;
  const r = data as Record<string, unknown>;

  const partial: Partial<AgendaConfig> = {};
  const todo = coerceStringArray(r["todoKeywords"]);
  if (todo) partial.todoKeywords = todo;
  const done = coerceStringArray(r["doneKeywords"]);
  if (done) partial.doneKeywords = done;
  if (typeof r["defaultDeadlineWarningDays"] === "number") {
    partial.defaultDeadlineWarningDays = r["defaultDeadlineWarningDays"];
  }
  if (typeof r["useTagInheritance"] === "boolean") {
    partial.useTagInheritance = r["useTagInheritance"];
  }
  const excl = coerceStringArray(r["tagsExcludeFromInheritance"]);
  if (excl) partial.tagsExcludeFromInheritance = excl;
  const files = coerceStringArray(r["agendaFiles"]);
  if (files) partial.agendaFiles = files;
  const filesExcl = coerceStringArray(r["agendaFilesExclude"]);
  if (filesExcl) partial.agendaFilesExclude = filesExcl;
  if (r["weekStartsOn"] === 0 || r["weekStartsOn"] === 1) {
    partial.weekStartsOn = r["weekStartsOn"];
  }
  const skip = r["skipDeadlinePrewarningIfScheduled"];
  if (skip === false || skip === true || skip === "pre-scheduled") {
    partial.skipDeadlinePrewarningIfScheduled = skip;
  }
  if (r["priorities"] && typeof r["priorities"] === "object") {
    const p = r["priorities"] as Record<string, unknown>;
    if (
      typeof p["highest"] === "string" &&
      typeof p["lowest"] === "string" &&
      typeof p["default"] === "string" &&
      // Highest must sort <= lowest (e.g. "A" <= "C"). When the user
      // flips them, `splitHeadingText`'s range check becomes
      // unsatisfiable and every `[#X]` would silently fall through to
      // the title — fall back to the defaults instead so a typo in
      // `.oak/agenda.yml` doesn't quietly disable priorities.
      p["highest"] <= p["lowest"]
    ) {
      partial.priorities = {
        highest: p["highest"],
        lowest: p["lowest"],
        default: p["default"],
      };
    }
  }
  return mergeAgendaConfig(partial);
}
