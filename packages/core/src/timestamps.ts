// Page-level timestamp helpers (`created` / `modified`).
//
// Two surfaces:
//   - `nowIsoSecond()` — the canonical format oak writes into
//     frontmatter: ISO 8601, second precision, UTC, e.g.
//     `2026-05-10T12:34:56Z`. UTC keeps the value stable across
//     timezone changes and laptop travel.
//   - `withTimestampUpdate()` — given the pre-write and post-write
//     file text, return the post-write text with `modified` bumped iff
//     the change merits it. Rule:
//       1. body changed                                  → bump
//       2. only frontmatter changed AND title changed    → bump
//       3. only frontmatter changed AND title unchanged  → skip
//     This way visibility flips, alias tweaks, slug renames don't
//     resurface a page in "recently modified" lists. `created` is
//     left exactly as it was — `composePage` is the only writer.

import matter from "gray-matter";
import yaml from "js-yaml";

import type { PageFrontmatter } from "./types.js";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function nowIsoSecond(now: Date = new Date()): string {
  return (
    `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}` +
    `T${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}Z`
  );
}

// Coerce a frontmatter value into a string timestamp or null. We do
// not validate the format: any string is round-tripped, anything else
// becomes null. js-yaml may parse an unquoted ISO string as a Date;
// coerce that back via `toISOString()` so the type stays string.
export function coerceTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}

// True when `raw` is an oak-managed page: it carries an `id:` field
// in its YAML frontmatter. Plain markdown files (vault content the
// user keeps outside oak's surface, agenda fixtures without
// frontmatter, scratch buffers, …) round-trip untouched.
export function isOakManaged(raw: string): boolean {
  const parsed = matter(raw);
  const id = (parsed.data as Record<string, unknown> | undefined)?.["id"];
  return typeof id === "string" && id.trim().length > 0;
}

// Decide whether a save warrants bumping `modified`. Uses gray-matter
// to split frontmatter from body so the comparison stays stable
// across YAML reformatting (e.g. key reordering by Obsidian's
// processFrontMatter). Non-oak-managed files (no `id:`) never bump,
// so writing through helpers that gate on this won't fabricate a
// frontmatter block where the user never asked for one.
export function shouldBumpModified(oldRaw: string, newRaw: string): boolean {
  if (oldRaw === newRaw) return false;
  if (!isOakManaged(newRaw)) return false;
  const oldP = matter(oldRaw);
  const newP = matter(newRaw);
  if (oldP.content !== newP.content) return true;
  const oldTitle = (oldP.data as PageFrontmatter | undefined)?.title;
  const newTitle = (newP.data as PageFrontmatter | undefined)?.title;
  return oldTitle !== newTitle;
}

// Replace (or insert) the YAML frontmatter block of `raw` with one
// produced from `data`. Body text after the closing fence is preserved
// byte-for-byte. When `raw` has no frontmatter we still emit one,
// followed by a blank line per oak's on-disk convention.
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

// Set `modified` on the frontmatter of `newRaw` to `nowIso`, if and
// only if `shouldBumpModified(oldRaw, newRaw)` says so. The bump
// preserves field order: if `modified` already exists it is rewritten
// in place; if not it is appended after `created` (or at the end).
// `created` is never touched here.
export function withTimestampUpdate(
  oldRaw: string,
  newRaw: string,
  nowIso: string = nowIsoSecond(),
): string {
  if (!shouldBumpModified(oldRaw, newRaw)) return newRaw;
  return setModified(newRaw, nowIso);
}

// Force-set `modified` regardless of whether the change passes the
// bump rule. Used by callers that already know they intend to bump
// (e.g. the title-commit flow) and want a single helper for the
// frontmatter mutation.
export function setModified(raw: string, nowIso: string): string {
  const parsed = matter(raw);
  const data = { ...((parsed.data as Record<string, unknown> | undefined) ?? {}) };
  // Preserve insertion order: `modified` belongs after `created` when
  // both are present. Achieved by deleting then reinserting so the new
  // value lands at the natural tail position (yaml.dump emits in
  // object key order in v8+).
  if ("modified" in data) {
    delete data["modified"];
  }
  data["modified"] = nowIso;
  return rewriteFrontmatter(raw, data);
}

// Set both `created` and `modified` on `raw` to `nowIso`. Used by
// composePage when minting a new file. Existing values are
// overwritten — composePage is the only caller and it operates on a
// freshly composed file.
export function setCreatedAndModified(raw: string, nowIso: string): string {
  const parsed = matter(raw);
  const data = { ...((parsed.data as Record<string, unknown> | undefined) ?? {}) };
  delete data["created"];
  delete data["modified"];
  data["created"] = nowIso;
  data["modified"] = nowIso;
  return rewriteFrontmatter(raw, data);
}
