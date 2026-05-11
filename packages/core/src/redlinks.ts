// Redlink collection: enumerate unresolved wiki-link targets across
// the publishable subset of a vault, with the pages that reference
// each one. The publish-template uses this to generate one route per
// redlink target (e.g. `/redlink/<slug>/`) so authors can click a
// `[[NotYetCreated]]` link in the body and land on a page listing the
// concept's bridges.

import { excerptFrom } from "./home.js";
import { isRedlinkTarget } from "./graph.js";
import { normalizeKey, slugify } from "./slug.js";
import type {
  Graph,
  ResolvedLink,
  Vault,
  Visibility,
} from "./types.js";

export type RedlinkBridge = {
  id: string;
  title: string;
  slug: string;
  // Single representative line of context from the referencing page.
  context: string;
  excerpt: string;
};

export type RedlinkSummary = {
  // Canonical lowercased key (matches `normalizeKey` of the original
  // target). Stable across visibility flips / case changes.
  key: string;
  // URL-safe slug suitable for Astro routing.
  slug: string;
  // Original-case display text picked from the first referencing page.
  display: string;
  bridges: RedlinkBridge[];
};

export type RedlinkOptions = {
  // Only walk pages whose visibility is in this set; defaults to
  // {public, unlisted}. Private pages never contribute redlinks.
  visibilityFilter?: Visibility[];
  excerptMaxChars?: number;
};

const DEFAULT_VISIBILITY: Visibility[] = ["public", "unlisted"];

// Compute a URL slug for a redlink target. We canonicalise via
// `slugify(normalizeKey(...))` so visually different but
// case/whitespace-equivalent targets collapse to the same route.
export function redlinkSlug(target: string): string {
  return slugify(normalizeKey(target));
}

export function collectRedlinks(
  vault: Vault,
  graph: Graph,
  options: RedlinkOptions = {},
): RedlinkSummary[] {
  const visible = new Set(options.visibilityFilter ?? DEFAULT_VISIBILITY);
  const excerptMax = options.excerptMaxChars ?? 240;

  // key (normalized) -> { display, bridges by fromId }
  const grouped = new Map<
    string,
    {
      display: string;
      bridges: Map<string, RedlinkBridge>;
    }
  >();

  for (const page of vault.pages.values()) {
    if (!visible.has(page.visibility)) continue;
    const outgoing: ResolvedLink[] = graph.outgoing.get(page.id) ?? [];
    for (const link of outgoing) {
      if (link.resolution.status !== "unresolved") continue;
      // Sanity: redlinkTargetId(key) follows isRedlinkTarget(), but
      // here we work off the raw target string.
      const raw = link.resolution.targetKey;
      const key = normalizeKey(raw);
      if (key.length === 0) continue;
      const entry =
        grouped.get(key) ?? { display: raw, bridges: new Map() };
      if (!entry.bridges.has(page.id)) {
        entry.bridges.set(page.id, {
          id: page.id,
          title: page.title,
          slug: page.slug,
          // Use a short body-line context if available, else fall back
          // to the heading-style excerpt.
          context: contextFromLink(page.body, link.line),
          excerpt: excerptFrom(page.body, excerptMax),
        });
      }
      grouped.set(key, entry);
    }
  }

  const out: RedlinkSummary[] = [];
  for (const [key, val] of grouped) {
    out.push({
      key,
      slug: slugify(key),
      display: val.display,
      bridges: [...val.bridges.values()].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      ),
    });
  }
  out.sort((a, b) =>
    a.display.localeCompare(b.display, undefined, { sensitivity: "base" }),
  );
  return out;
}

function contextFromLink(body: string, line: number): string {
  if (line <= 0) return "";
  const lines = body.split("\n");
  return (lines[line - 1] ?? "").trim();
}

// Suppress unused-import warning when types are tree-shaken; keep
// the helper signature explicit for callers needing to derive an id.
export function redlinkIdFor(target: string): string {
  return `redlink:${normalizeKey(target)}`;
}

// Re-exported guard so consumers don't need a second import.
export { isRedlinkTarget };
