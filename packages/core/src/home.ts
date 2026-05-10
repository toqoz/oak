// "Home" / index view of the vault.
//
// Both the publisher (which writes a static index.html) and the
// Obsidian plugin (which renders a live home pane) consume this same
// view model so the two stay structurally consistent.

import { stat } from "node:fs/promises";

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
};

export type HomeViewModel = {
  generatedAt: string;
  stats: HomeStats;
  pages: HomeEntry[]; // sorted by title (case-insensitive)
  recent: HomeEntry[]; // sorted by updatedAt desc, capped to recentLimit
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
const COLLAPSE_WS = /\s+/g;

export function excerptFrom(body: string, maxChars = 200): string {
  // Strip non-prose syntax first, then walk every line so headings and
  // list items contribute their text to the excerpt.
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
    const text = line.replace(STRIP_LINE_MARKERS, "").trim();
    if (text.length > 0) parts.push(text);
  }
  const chosen = parts.join(" ").replace(COLLAPSE_WS, " ").trim();
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
  };

  const all: HomeEntry[] = [];
  for (const page of vault.pages.values()) {
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
      title: page.title,
      slug: page.slug,
      visibility: page.visibility,
      vaultRelPath: page.relPath,
      excerpt: excerptFrom(page.body, excerptMax),
      updatedAt,
      outboundCount: countResolvedOutgoing(outgoing),
      inboundCount: countInbound(graph.incoming.get(page.id) ?? []),
    });
  }

  const pages = [...all].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  const recent = [...all]
    .filter((e): e is HomeEntry & { updatedAt: string } => e.updatedAt !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, recentLimit);

  return {
    generatedAt: new Date().toISOString(),
    stats,
    pages,
    recent,
  };
}
