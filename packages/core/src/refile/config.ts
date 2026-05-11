// Refile configuration loader.
//
// Reads `.oak/refile.yml` from the vault root. All keys are optional;
// defaults match the oak body convention (root headings start at `##`).
// Refile is its own feature, separate from agenda — they interact (a
// refile dispatched from the agenda view resolves the source heading
// via the agenda parser), but the user-facing knobs live in their own
// file rather than being mixed into `.oak/agenda.yml`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

export type RefileConfig = {
  // Heading level (1..6) the refiled source becomes when the target is
  // "top of file" — i.e. there is no parent heading to nest under.
  // Defaults to `2` since the oak body convention starts at `##`;
  // users on the emacs `org-refile` clamp-to-level-1 convention can
  // set it to `1`.
  topOfFileLevel: number;
};

export const DEFAULT_REFILE_CONFIG: RefileConfig = {
  topOfFileLevel: 2,
};

export function mergeRefileConfig(
  partial: Partial<RefileConfig> | null | undefined,
): RefileConfig {
  if (!partial) return DEFAULT_REFILE_CONFIG;
  return {
    topOfFileLevel:
      partial.topOfFileLevel ?? DEFAULT_REFILE_CONFIG.topOfFileLevel,
  };
}

export async function loadRefileConfig(rootPath: string): Promise<RefileConfig> {
  const configPath = join(rootPath, ".oak", "refile.yml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return DEFAULT_REFILE_CONFIG;
  }
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch {
    return DEFAULT_REFILE_CONFIG;
  }
  if (!data || typeof data !== "object") return DEFAULT_REFILE_CONFIG;
  const r = data as Record<string, unknown>;

  const partial: Partial<RefileConfig> = {};
  if (typeof r["topOfFileLevel"] === "number") {
    const lv = r["topOfFileLevel"];
    // Clamp to valid Markdown heading levels. An out-of-range value
    // would either produce a non-heading line (e.g. zero `#`s) or push
    // every nested heading past `######` immediately, so we silently
    // fall back to the default rather than corrupting the file.
    if (Number.isInteger(lv) && lv >= 1 && lv <= 6) {
      partial.topOfFileLevel = lv;
    }
  }
  return mergeRefileConfig(partial);
}
