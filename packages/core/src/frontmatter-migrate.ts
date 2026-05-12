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
//   v3 — title moves out of the frontmatter into the body as a
//        top-level `# ...` heading. The 2→3 step strips the `title:`
//        field and, if the body lacks an h1, inserts `# <old title>`
//        immediately after the frontmatter fence.
//
// Files without a `version:` field are treated as v1, which keeps
// every page in the wild (written before this feature landed)
// upgradable in-place. Non-oak markdown (no `id:`) is skipped
// entirely — the file is the user's, oak doesn't own its frontmatter.

import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import yaml from "js-yaml";

import { parseVault } from "./parse.js";
import { extractFirstH1 } from "./slug.js";
import {
  isOakManaged,
  nowIsoSecond,
  recoverCreatedTimestamp,
  recoverModifiedTimestamp,
  setCreatedIfMissing,
  setFrontmatterVersion,
  setModifiedIfMissing,
} from "./timestamps.js";

export const LATEST_FRONTMATTER_VERSION = 3;

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
  // The title value that was lifted from `title:` into the body's
  // first `# ...` heading by the 2→3 step. Absent when the body
  // already had an h1 (so the fm field was just dropped) or when the
  // file had no `title:` field to begin with.
  titleMoved?: string;
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
  {
    from: 2,
    to: 3,
    // The 2→3 step lifts `title:` out of the frontmatter into the
    // body's first `# ...` heading. Pure text rewrite — no git or
    // filesystem signals are consulted.
    apply: async (ctx) => {
      const result = moveTitleToBody(ctx.raw);
      const added: AddedFields = {};
      if (result.titleMoved !== null) added.titleMoved = result.titleMoved;
      return { text: result.text, added };
    },
  },
];

// Lift the frontmatter `title` field into the body as a top-level
// `# ...` heading. Three cases:
//
//   1. fm has `title:` and the body has no h1 yet
//      → drop the field; insert `# <title>` after the fence.
//   2. fm has `title:` and the body already has an h1
//      → drop the field; leave the body untouched (the body's h1 is
//        already the canonical source under the new schema).
//   3. fm has no `title:`
//      → no rewrite. Returns `raw` unchanged; the caller still stamps
//        the version, so the file moves to v3 even when there was
//        nothing to lift.
//
// The `titleMoved` value in the result identifies case 1 specifically
// — only there did the body gain a new heading worth reporting.
function moveTitleToBody(raw: string): {
  text: string;
  titleMoved: string | null;
} {
  const parsed = matter(raw);
  const data = {
    ...((parsed.data as Record<string, unknown> | undefined) ?? {}),
  };
  if (!("title" in data)) {
    return { text: raw, titleMoved: null };
  }

  const rawTitle = data["title"];
  const titleStr =
    typeof rawTitle === "string"
      ? rawTitle.trim()
      : rawTitle == null
        ? ""
        : String(rawTitle).trim();

  delete data["title"];
  const withoutTitle = rewriteFrontmatter(raw, data);

  // If the body already carries an h1, the fm value is redundant — we
  // just strip the field. Same when the fm value is empty / unusable.
  if (titleStr.length === 0) {
    return { text: withoutTitle, titleMoved: null };
  }
  const bodyHasH1 = extractFirstH1(parsed.content) !== null;
  if (bodyHasH1) {
    return { text: withoutTitle, titleMoved: null };
  }

  // Insert `# Title` directly after the frontmatter fence, separated
  // from any following body content by a blank line. `rewriteFrontmatter`
  // always emits a `\n` after the closing fence, so the only ambiguity
  // is whether the next character is already a newline.
  const fenceMatch = withoutTitle.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fenceMatch) {
    const head = withoutTitle.slice(0, fenceMatch[0].length);
    const tail = withoutTitle.slice(fenceMatch[0].length);
    const separator = tail.startsWith("\n") ? "" : "\n";
    return {
      text: `${head}\n# ${titleStr}\n${separator}${tail}`,
      titleMoved: titleStr,
    };
  }
  return {
    text: `# ${titleStr}\n\n${withoutTitle}`,
    titleMoved: titleStr,
  };
}

// Replace (or insert) the YAML frontmatter block of `raw` with one
// produced from `data`. Body text after the closing fence is preserved
// byte-for-byte. Mirrors the private helper in `timestamps.ts`; kept
// inline here so this migration step doesn't depend on internals of an
// unrelated module.
function rewriteFrontmatter(
  raw: string,
  data: Record<string, unknown>,
): string {
  const yamlText = yaml.dump(data, {
    sortKeys: false,
    lineWidth: 120,
    noRefs: true,
  });
  const fenceMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fenceMatch) {
    return `---\n${yamlText}---\n${raw.slice(fenceMatch[0].length)}`;
  }
  return `---\n${yamlText}---\n\n${raw}`;
}

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
