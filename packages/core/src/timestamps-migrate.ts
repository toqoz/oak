// One-shot timestamp backfill — fills `created` and `modified` on
// oak-managed pages that lack them, without touching pages where
// both fields are already present.
//
// Why a separate one-shot tool when `withTimestampUpdateAndRecovery`
// can already self-heal `created` on save?
//
//   - It heals lazily, only on the *next* edit. A vault that's been
//     read for a year before this feature lands would still report
//     null `created` on every untouched page until someone happens to
//     save them.
//   - The save path deliberately does NOT add `modified` when only
//     `created` is missing (and vice versa) — that conflates recovery
//     with "did the user just edit this?". A migration *should* set
//     both so downstream consumers (sorts, agenda recency, sync) can
//     rely on the fields existing.
//
// The fill order respects user intent:
//   - present `created` is never overwritten
//   - present `modified` is never overwritten (a hand-edit is sacred)
//   - missing `created` and `modified` each run their own recovery
//     cascade (git/birthtime/mtime). Since the cascades draw from
//     different evidence — first-add commit vs. last-touch commit,
//     birthtime vs. mtime — they normally produce different values
//     for files that have actually been edited. They only coincide
//     for a file that was created and never touched again.

import { readFile, writeFile } from "node:fs/promises";

import { parseVault } from "./parse.js";
import {
  isOakManaged,
  nowIsoSecond,
  recoverCreatedTimestamp,
  recoverModifiedTimestamp,
  setCreatedIfMissing,
  setModifiedIfMissing,
} from "./timestamps.js";

export type TimestampMigrationEntry = {
  relPath: string;
  filePath: string;
  // Only fields the migration actually wrote. An entry that filled
  // only `created` will leave `modified` undefined here. (Pages with
  // both fields present are not emitted at all.)
  added: {
    created?: string;
    modified?: string;
  };
};

export type TimestampMigrationReport = {
  // All oak-managed pages encountered (with or without missing fields).
  scanned: number;
  // Pages that had at least one field added.
  changed: number;
  // Pages that already had both fields and were left alone.
  unchanged: number;
  // True when the report describes a planned change rather than a
  // performed one — files on disk are untouched.
  dryRun: boolean;
  entries: TimestampMigrationEntry[];
};

export type MigrateTimestampsOptions = {
  vaultRoot: string;
  dryRun?: boolean;
  // Override the `now` used as the final fallback in the recovery
  // cascade. Mostly here for tests; production callers leave it.
  now?: Date;
};

export async function migrateTimestamps(
  opts: MigrateTimestampsOptions,
): Promise<TimestampMigrationReport> {
  const dryRun = opts.dryRun === true;
  const nowIso = nowIsoSecond(opts.now ?? new Date());

  const vault = await parseVault(opts.vaultRoot);
  const entries: TimestampMigrationEntry[] = [];
  let scanned = 0;
  let changed = 0;
  let unchanged = 0;

  for (const page of vault.pages.values()) {
    if (page.type !== "page") continue;

    // parseVault synthesizes an `id` for files without one (flagged
    // as a validation error). The migration only touches truly
    // oak-managed files — we re-check `isOakManaged` against the raw
    // bytes so plain markdown in the vault is left alone.
    const raw = await readFile(page.filePath, "utf8");
    if (!isOakManaged(raw)) continue;
    scanned += 1;

    const hasCreated = page.created !== null;
    const hasModified = page.modified !== null;
    if (hasCreated && hasModified) {
      unchanged += 1;
      continue;
    }

    let out = raw;
    const added: { created?: string; modified?: string } = {};
    // The created cascade runs only when `created` is missing — both
    // because we don't want to overwrite a present value, and because
    // shelling out to git is the expensive part of the loop.
    let createdValue: string | null = null;

    if (!hasCreated) {
      createdValue = await recoverCreatedTimestamp(
        opts.vaultRoot,
        page.filePath,
        nowIso,
      );
      const before = out;
      out = setCreatedIfMissing(out, createdValue);
      if (out !== before) added.created = createdValue;
    } else {
      // Read the existing value so we can pass it to the modified
      // cascade as a lower bound.
      createdValue = extractCreated(out);
    }

    if (!hasModified) {
      // The modified cascade runs git-last-commit / mtime / created,
      // so a file that was created and then edited gets a `modified`
      // value reflecting the edit, not a copy of `created`.
      const modValue = await recoverModifiedTimestamp(
        opts.vaultRoot,
        page.filePath,
        createdValue,
        nowIso,
      );
      const before = out;
      out = setModifiedIfMissing(out, modValue);
      if (out !== before) added.modified = modValue;
    }

    if (added.created === undefined && added.modified === undefined) {
      // Defensive: shouldn't reach here given the gates above, but
      // if for some reason setCreatedIfMissing / setModifiedIfMissing
      // declined the write, treat the page as unchanged.
      unchanged += 1;
      continue;
    }

    if (!dryRun) {
      await writeFile(page.filePath, out, "utf8");
    }
    changed += 1;
    entries.push({
      relPath: page.relPath,
      filePath: page.filePath,
      added,
    });
  }

  return { scanned, changed, unchanged, dryRun, entries };
}

// Tiny helper: extract the `created` value out of a frontmatter block
// without re-parsing the whole file. We don't need full YAML for this
// — the migration only ever queries a value it just wrote, and the
// writer canonicalises the key.
function extractCreated(raw: string): string | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1]!;
  const line = fm.match(/^created:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  return line ? line[1]!.trim() : null;
}
