// Vault-wide frontmatter migrations.
//
// Every oak-managed page carries a `version:` field in its YAML
// frontmatter that names the schema it conforms to. `oak migrate`
// upgrades older files to the latest version in sequence, running one
// step per gap so a v0 file passes through every intermediate state on
// its way to current.
//
// History of the schema:
//   v1 — the pre-timestamp era. Pages had id/title/visibility/slug/
//        aliases but no `created` / `modified`.
//   v2 — adds `created` and `modified`. The 1→2 step folds in what
//        used to be `oak migrate timestamps`: backfill the two fields
//        from git history / mtime / birthtime where possible, then
//        stamp `version: 2`.
//
// Files without a `version:` field are treated as v1, which keeps
// every page in the wild (written before this feature landed)
// upgradable in-place. Non-oak markdown (no `id:`) is skipped
// entirely — the file is the user's, oak doesn't own its frontmatter.

import { readFile, writeFile } from "node:fs/promises";

import { parseVault } from "./parse.js";
import {
  isOakManaged,
  nowIsoSecond,
  recoverCreatedTimestamp,
  recoverModifiedTimestamp,
  setCreatedIfMissing,
  setFrontmatterVersion,
  setModifiedIfMissing,
} from "./timestamps.js";

export const LATEST_FRONTMATTER_VERSION = 2;

export type MigrationContext = {
  raw: string;
  filePath: string;
  vaultRoot: string;
  nowIso: string;
};

// Per-page record of fields the migration wrote. Kept open-ended so
// future steps can surface their own additions without changing the
// report shape.
export type AddedFields = {
  created?: string;
  modified?: string;
};

export type MigrationStep = {
  from: number;
  to: number;
  // Mutates `raw` and returns the new file text plus a record of what
  // changed (used in the migration report). Pure with respect to the
  // filesystem except for the recovery helpers, which may shell out to
  // git via the absolute file path.
  apply: (ctx: MigrationContext) => Promise<{
    text: string;
    added: AddedFields;
  }>;
};

export type FrontmatterMigrationEntry = {
  relPath: string;
  filePath: string;
  fromVersion: number;
  toVersion: number;
  added: AddedFields;
};

export type FrontmatterMigrationReport = {
  // All oak-managed pages encountered.
  scanned: number;
  // Pages that moved up at least one version.
  changed: number;
  // Pages already at the latest version.
  unchanged: number;
  // True when the report describes a planned change rather than a
  // performed one — files on disk are untouched.
  dryRun: boolean;
  entries: FrontmatterMigrationEntry[];
};

export type MigrateFrontmatterOptions = {
  vaultRoot: string;
  dryRun?: boolean;
  // Override the `now` used as the final fallback in the recovery
  // cascade. Mostly here for tests; production callers leave it.
  now?: Date;
};

// Read the schema version off a raw page. Missing or non-numeric
// `version:` falls back to 1 (the pre-version era). We never trust a
// value we can't parse — better to attempt re-migration than to skip
// a file silently.
export function getFrontmatterVersion(raw: string): number {
  // Tiny regex pass rather than full YAML — the migration only needs
  // to spot a top-level integer named `version`. Anything else (a
  // string, a malformed value) is treated as "unknown, assume 1".
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return 1;
  const line = fence[1]!.match(/^version:\s*(\d+)\s*$/m);
  if (!line) return 1;
  const n = parseInt(line[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const MIGRATION_STEPS: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    // The 1→2 step is the old `migrateTimestamps` flow, lifted in
    // verbatim. The shape — per-field cascade, never overwrite
    // present values, modified anchored to a separately-recovered
    // signal — is unchanged; only the framing moved.
    apply: async (ctx) => {
      const added: AddedFields = {};
      let out = ctx.raw;

      const beforeCreated = out;
      const createdRecovered = await recoverCreatedTimestamp(
        ctx.vaultRoot,
        ctx.filePath,
        ctx.nowIso,
      );
      out = setCreatedIfMissing(out, createdRecovered);
      const createdWritten = out !== beforeCreated;
      if (createdWritten) added.created = createdRecovered;

      // The modified cascade reads `created` as a lower bound — either
      // the value we just wrote, or whatever the file already had.
      const createdForModified = createdWritten
        ? createdRecovered
        : extractTopLevelString(out, "created");
      const beforeMod = out;
      const modifiedRecovered = await recoverModifiedTimestamp(
        ctx.vaultRoot,
        ctx.filePath,
        createdForModified,
        ctx.nowIso,
      );
      out = setModifiedIfMissing(out, modifiedRecovered);
      if (out !== beforeMod) added.modified = modifiedRecovered;

      return { text: out, added };
    },
  },
];

// Apply every step strictly above `fromVersion` and up to (including)
// `LATEST_FRONTMATTER_VERSION`, in order. The version stamp is written
// once at the end — intermediate steps can read the prior version off
// the still-current frontmatter if they ever need to.
export async function migratePageRaw(
  raw: string,
  filePath: string,
  vaultRoot: string,
  nowIso: string = nowIsoSecond(),
): Promise<{
  text: string;
  fromVersion: number;
  toVersion: number;
  added: AddedFields;
} | null> {
  const fromVersion = getFrontmatterVersion(raw);
  if (fromVersion >= LATEST_FRONTMATTER_VERSION) return null;

  let text = raw;
  const added: AddedFields = {};
  for (const step of MIGRATION_STEPS) {
    if (step.from < fromVersion) continue;
    if (step.to > LATEST_FRONTMATTER_VERSION) break;
    const result = await step.apply({
      raw: text,
      filePath,
      vaultRoot,
      nowIso,
    });
    text = result.text;
    Object.assign(added, result.added);
  }
  text = setFrontmatterVersion(text, LATEST_FRONTMATTER_VERSION);
  return {
    text,
    fromVersion,
    toVersion: LATEST_FRONTMATTER_VERSION,
    added,
  };
}

export async function migrateFrontmatter(
  opts: MigrateFrontmatterOptions,
): Promise<FrontmatterMigrationReport> {
  const dryRun = opts.dryRun === true;
  const nowIso = nowIsoSecond(opts.now ?? new Date());

  const vault = await parseVault(opts.vaultRoot);
  const entries: FrontmatterMigrationEntry[] = [];
  let scanned = 0;
  let changed = 0;
  let unchanged = 0;

  for (const page of vault.pages.values()) {
    if (page.type !== "page") continue;

    // parseVault synthesizes an `id` for files without one (flagged
    // as a validation error). The migration only touches truly
    // oak-managed files — re-check `isOakManaged` against the raw
    // bytes so plain markdown is left alone.
    const raw = await readFile(page.filePath, "utf8");
    if (!isOakManaged(raw)) continue;
    scanned += 1;

    const result = await migratePageRaw(
      raw,
      page.filePath,
      opts.vaultRoot,
      nowIso,
    );
    if (result === null) {
      unchanged += 1;
      continue;
    }

    if (!dryRun) {
      await writeFile(page.filePath, result.text, "utf8");
    }
    changed += 1;
    entries.push({
      relPath: page.relPath,
      filePath: page.filePath,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      added: result.added,
    });
  }

  return { scanned, changed, unchanged, dryRun, entries };
}

// Pull a single top-level string field out of a frontmatter block
// without parsing the full YAML. Only used here to read back a value
// we may have just written, so the surface stays minimal.
function extractTopLevelString(raw: string, key: string): string | null {
  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return null;
  const fm = fence[1]!;
  const re = new RegExp(`^${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, "m");
  const line = fm.match(re);
  return line ? line[1]!.trim() : null;
}
