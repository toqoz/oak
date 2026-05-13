// Feed publication dates — the publish-branch sidecar that stamps a
// first-publish ISO instant onto each page opted into the feed via
// `feed: true` in frontmatter.
//
// Why a sidecar rather than rewriting the source vault: `oak pub
// build` must not mutate the user's working tree. The first-publish
// timestamp is derived state — it belongs to the publish branch, not
// to the note. Storing it under `<worktree>/feed-dates.json` keeps
// `pub build` purely additive on the source side and idempotent
// across rebuilds (a second build sees the existing entry and
// reuses it).
//
// Stale entries are intentionally retained: if a user toggles
// `feed: true` off and on again the same page resurfaces with its
// original date rather than a fresh "now", which is what a feed
// reader expects. Operators who want a clean slate can delete the
// file (or the relevant entries) by hand.
//
// On-disk shape (flat map by design — simplest readable JSON; if we
// ever need per-entry metadata we'll wrap it in `{ version, dates }`):
//
//   {
//     "ABCD-EFGH-IJKL": "2026-05-12T10:00:00Z",
//     "MNOP-QRST-UVWX": "2026-05-12T10:01:00Z"
//   }

import { readFile, writeFile } from "node:fs/promises";

import { parseVault } from "./parse.js";
import { coerceTimestamp, nowIsoSecond } from "./timestamps.js";
import type { Visibility } from "./types.js";

// Visibilities eligible for the feed. `private` is unconditionally
// excluded — those files never enter the publish branch — and
// `unlisted` is excluded because "unlisted" semantically means "do
// not advertise"; a feed is the prototypical advertise channel.
const FEED_VISIBILITY: ReadonlySet<Visibility> = new Set(["public"]);

export const FEED_DATES_FILENAME = "feed-dates.json";

export type FeedDates = Record<string, string>;

export async function readFeedDates(path: string): Promise<FeedDates> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt sidecar — treat as empty rather than crashing the build.
    // The next write will overwrite with valid JSON.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: FeedDates = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const iso = coerceTimestamp(value);
    if (iso !== null) out[id] = iso;
  }
  return out;
}

export async function writeFeedDates(
  path: string,
  dates: FeedDates,
): Promise<void> {
  // Sort keys so the on-disk form has a deterministic diff. Two
  // builds against the same source produce byte-identical files.
  const sorted: FeedDates = {};
  for (const id of Object.keys(dates).sort()) {
    sorted[id] = dates[id]!;
  }
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

export type SyncFeedDatesResult = {
  // Total feed-eligible page ids found in the vault.
  eligible: number;
  // New entries written this run.
  added: number;
  // Entries reused from the existing sidecar.
  reused: number;
  // Entries present in the sidecar but no longer feed-eligible (kept).
  stale: number;
  // The dates map after the sync.
  dates: FeedDates;
};

// One-shot reconciliation pass:
//   1. Read the existing sidecar at `sidecarPath` (may be missing).
//   2. Find every page in `vaultRoot` with `feed: true` and a
//      feed-eligible visibility.
//   3. For each, reuse the existing date or stamp `nowIso`.
//   4. Leave stale entries in place (see module header for rationale).
//   5. Write the merged map back to `sidecarPath`.
//
// Returns counts plus the final map so callers can log/inspect.
export async function syncFeedDates(
  vaultRoot: string,
  sidecarPath: string,
  nowIso: string = nowIsoSecond(),
): Promise<SyncFeedDatesResult> {
  const existing = await readFeedDates(sidecarPath);
  const vault = await parseVault(vaultRoot);

  const next: FeedDates = { ...existing };
  const eligibleIds = new Set<string>();
  let added = 0;
  let reused = 0;
  for (const page of vault.pages.values()) {
    if (!page.feed) continue;
    if (!FEED_VISIBILITY.has(page.visibility)) continue;
    eligibleIds.add(page.id);
    if (existing[page.id]) {
      reused++;
    } else {
      next[page.id] = nowIso;
      added++;
    }
  }

  let stale = 0;
  for (const id of Object.keys(next)) {
    if (!eligibleIds.has(id)) stale++;
  }

  await writeFeedDates(sidecarPath, next);

  return {
    eligible: eligibleIds.size,
    added,
    reused,
    stale,
    dates: next,
  };
}
