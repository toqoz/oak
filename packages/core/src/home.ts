// "Home" / index view of the vault.
//
// Both the publisher (which writes a static index.html) and the
// Obsidian plugin (which renders a live home pane) consume this same
// view model so the two stay structurally consistent.

import { stat } from "node:fs/promises";

import { isManagedPage } from "./parse.js";
import type {
  Backlink,
  Graph,
  ResolvedLink,
  Vault,
  Visibility,
} from "./types.js";

export type HomeEntry = {
  id: string;
  title: string;
  slug: string;
  visibility: Visibility;
  vaultRelPath: string;
  excerpt: string;
  updatedAt: string | null; // ISO mtime
  outboundCount: number;
  inboundCount: number;
};

export type HomeStats = {
  pages: number;
  public: number;
  unlisted: number;
  private: number;
  redLinks: number; // total unresolved wiki links across the vault
  externals: number; // configured external mounts
  unmanaged: number; // .md files in the vault that lack an `id` frontmatter
};

// A vault file the indexer found but oak does not yet manage — it has
// no `id` in its frontmatter, so parse synthesised an `unidentified:…`
// id. Surfaced separately from `pages` so the home view can offer an
// explicit "import" action that fills in the missing frontmatter.
export type UnmanagedEntry = {
  vaultRelPath: string;
  basename: string;
  updatedAt: string | null; // ISO mtime
};

export type HomeViewModel = {
  generatedAt: string;
  stats: HomeStats;
  pages: HomeEntry[]; // sorted by title (case-insensitive); excludes unmanaged
  recent: HomeEntry[]; // sorted by updatedAt desc, capped to recentLimit; excludes unmanaged
  // Count of all entries with an updatedAt that would be eligible for
  // `recent` if `recentLimit` were unbounded. Surfaced so callers can
  // show "ALL (N)" without re-running the model with a higher cap.
  recentTotal: number;
  // Pages opted into the published feed (frontmatter `feed: true`).
  // Restricted to `public` visibility — that's the only visibility the
  // RSS feed builder emits — and sorted by updatedAt desc with nulls
  // last. Independent of `recentLimit`.
  feed: HomeEntry[];
  unmanaged: UnmanagedEntry[]; // sorted by vaultRelPath
};

export type HomeViewOptions = {
  recentLimit?: number;
  excerptMaxChars?: number;
  // Optional filter to restrict which pages appear in `pages` /
  // `recent`. The publisher passes `["public", "unlisted"]` so only
  // publishable pages leak to the static site.
  visibilityFilter?: Visibility[];
};

const STRIP_WIKI = /!?\[\[([^\]\n]+)\]\]/g;
const STRIP_FENCED = /```[\s\S]*?```/g;
const STRIP_INLINE_CODE = /`[^`\n]*`/g;
const STRIP_LINE_MARKERS =
  /^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)+/;
const COLLAPSE_HSPACE = /[ \t]+/g;

export function excerptFrom(body: string, maxChars = 200): string {
  // Strip non-prose syntax first, then walk every line so headings and
  // list items contribute their text to the excerpt. Lines are joined
  // with "\n" so consumers can render each heading / list item on its
  // own visual line (via CSS `white-space: pre-line`).
  const cleaned = body
    .replace(STRIP_FENCED, "")
    .replace(STRIP_INLINE_CODE, "")
    .replace(STRIP_WIKI, (_m, inner: string) => {
      const pipe = inner.indexOf("|");
      const label = pipe === -1 ? inner : inner.slice(pipe + 1);
      return label.split("#")[0]!.trim();
    })
    .trim();
  const parts: string[] = [];
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const text = line
      .replace(STRIP_LINE_MARKERS, "")
      .replace(COLLAPSE_HSPACE, " ")
      .trim();
    if (text.length > 0) parts.push(text);
  }
  const chosen = parts.join("\n");
  if (chosen.length <= maxChars) return chosen;
  return `${chosen.slice(0, maxChars).trimEnd()}…`;
}

async function fileMtime(filePath: string): Promise<string | null> {
  try {
    const s = await stat(filePath);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}

function countResolvedOutgoing(links: ResolvedLink[]): number {
  return links.filter((l) => l.resolution.status === "resolved").length;
}

function countInbound(backlinks: Backlink[]): number {
  // Distinct source pages: a single page that links twice still counts
  // as one inbound.
  const set = new Set<string>();
  for (const b of backlinks) set.add(b.fromId);
  return set.size;
}

export async function homeViewModel(
  vault: Vault,
  graph: Graph,
  options: HomeViewOptions = {},
): Promise<HomeViewModel> {
  const recentLimit = options.recentLimit ?? 10;
  const excerptMax = options.excerptMaxChars ?? 200;
  const filter = options.visibilityFilter
    ? new Set<Visibility>(options.visibilityFilter)
    : null;

  const stats: HomeStats = {
    pages: 0,
    public: 0,
    unlisted: 0,
    private: 0,
    redLinks: 0,
    externals: vault.externals.size,
    unmanaged: 0,
  };

  const all: HomeEntry[] = [];
  const feedIds = new Set<string>();
  const unmanaged: UnmanagedEntry[] = [];
  for (const page of vault.pages.values()) {
    if (!isManagedPage(page)) {
      stats.unmanaged++;
      unmanaged.push({
        vaultRelPath: page.relPath,
        basename: page.basename,
        updatedAt: await fileMtime(page.filePath),
      });
      // Skip stats / link counting / pages list — the file is not yet
      // an oak page in any meaningful sense.
      continue;
    }

    stats.pages++;
    if (page.visibility === "public") stats.public++;
    else if (page.visibility === "unlisted") stats.unlisted++;
    else stats.private++;

    const outgoing = graph.outgoing.get(page.id) ?? [];
    for (const l of outgoing) {
      if (l.resolution.status === "unresolved") stats.redLinks++;
    }

    if (filter && !filter.has(page.visibility)) continue;

    const updatedAt = await fileMtime(page.filePath);
    all.push({
      id: page.id,
      title: page.titlePlain,
      slug: page.slug,
      visibility: page.visibility,
      vaultRelPath: page.relPath,
      excerpt: excerptFrom(page.body, excerptMax),
      updatedAt,
      outboundCount: countResolvedOutgoing(outgoing),
      inboundCount: countInbound(graph.incoming.get(page.id) ?? []),
    });
    // Feed eligibility mirrors `syncFeedDates`: opt-in via frontmatter
    // and restricted to public visibility. `unlisted` is intentionally
    // excluded — "do not advertise" semantics conflict with the feed.
    if (page.feed && page.visibility === "public") feedIds.add(page.id);
  }

  unmanaged.sort((a, b) => a.vaultRelPath.localeCompare(b.vaultRelPath));

  const pages = [...all].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  const byRecent = [...all]
    .filter((e): e is HomeEntry & { updatedAt: string } => e.updatedAt !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const recent = byRecent.slice(0, recentLimit);
  const feed = [...all]
    .filter((e) => feedIds.has(e.id))
    .sort((a, b) => {
      // Recent first; entries without mtime sink to the bottom.
      const au = a.updatedAt ?? "";
      const bu = b.updatedAt ?? "";
      if (au === bu) return 0;
      return au < bu ? 1 : -1;
    });

  return {
    generatedAt: new Date().toISOString(),
    stats,
    pages,
    recent,
    recentTotal: byRecent.length,
    feed,
    unmanaged,
  };
}
