// Link resolution and graph queries.

import type {
  Backlink,
  Graph,
  LinkResolution,
  RawLink,
  ResolvedLink,
  TwoHop,
  Vault,
} from "./types.js";
import { normalizeKey } from "./slug.js";

const EXTERNAL_PREFIX = "_external/";

function resolveOne(vault: Vault, link: RawLink): LinkResolution {
  return resolveTarget(vault, link.target);
}

// Resolve a wiki/markdown link target string against a vault. Exposed
// so renderer plugins (e.g. @oak/core/remark) can map `[[X]]` to a
// page id without constructing a synthetic RawLink.
export function resolveTarget(vault: Vault, target: string): LinkResolution {
  const targetRaw = target.trim();
  if (targetRaw.length === 0) {
    return { status: "invalid", reason: "empty link target" };
  }

  // Path-like targets containing `/`: prefer path lookup.
  const looksLikePath = targetRaw.includes("/") || targetRaw.endsWith(".md");
  if (looksLikePath) {
    const noExt = targetRaw.replace(/\.md$/i, "").replace(/^\.\//, "");
    const key = normalizeKey(noExt);

    if (noExt.startsWith(EXTERNAL_PREFIX)) {
      const id = vault.byVaultRelPath.get(key);
      if (id !== undefined) {
        return { status: "external", externalId: id };
      }
      return {
        status: "external",
        externalId: `external:unconfigured:${noExt}`,
      };
    }

    const hit = vault.byVaultRelPath.get(key);
    if (hit !== undefined) {
      if (vault.pages.has(hit)) return { status: "resolved", targetId: hit };
      if (vault.externals.has(hit))
        return { status: "external", externalId: hit };
    }
    return { status: "unresolved", targetKey: targetRaw };
  }

  const key = normalizeKey(targetRaw);
  const titleHit = vault.byTitle.get(key);
  if (titleHit !== undefined)
    return { status: "resolved", targetId: titleHit };

  const aliasHit = vault.byAlias.get(key);
  if (aliasHit !== undefined)
    return { status: "resolved", targetId: aliasHit };

  const basenameHit = vault.byBasename.get(key);
  if (basenameHit !== undefined)
    return { status: "resolved", targetId: basenameHit };

  return { status: "unresolved", targetKey: targetRaw };
}

export function resolveLinks(vault: Vault, links: RawLink[]): ResolvedLink[] {
  return links.map((link) => ({ ...link, resolution: resolveOne(vault, link) }));
}

function lineContextOf(body: string, line: number): string {
  const lines = body.split("\n");
  const idx = Math.max(0, line - 1);
  return (lines[idx] ?? "").trim();
}

export function buildGraph(vault: Vault): Graph {
  const outgoing = new Map<string, ResolvedLink[]>();
  const incoming = new Map<string, Backlink[]>();

  for (const page of vault.pages.values()) {
    const resolved = resolveLinks(vault, page.links);
    outgoing.set(page.id, resolved);

    for (const link of resolved) {
      if (link.resolution.status !== "resolved") continue;
      const targetId = link.resolution.targetId;
      const list = incoming.get(targetId) ?? [];
      list.push({
        fromId: page.id,
        context: lineContextOf(page.body, link.line),
      });
      incoming.set(targetId, list);
    }
  }

  return { outgoing, incoming };
}

export function getOutboundLinks(graph: Graph, pageId: string): ResolvedLink[] {
  return graph.outgoing.get(pageId) ?? [];
}

export function getBacklinks(graph: Graph, pageId: string): Backlink[] {
  return graph.incoming.get(pageId) ?? [];
}

function neighborSet(graph: Graph, pageId: string): Set<string> {
  const set = new Set<string>();
  for (const link of graph.outgoing.get(pageId) ?? []) {
    if (link.resolution.status === "resolved") {
      set.add(link.resolution.targetId);
    }
  }
  for (const back of graph.incoming.get(pageId) ?? []) {
    set.add(back.fromId);
  }
  return set;
}

export function getTwoHopLinks(graph: Graph, pageId: string): TwoHop[] {
  const directNeighbors = neighborSet(graph, pageId);
  const exclude = new Set(directNeighbors);
  exclude.add(pageId);

  // Collect bridges per two-hop candidate.
  const bridges = new Map<string, Set<string>>();
  for (const neighbor of directNeighbors) {
    const second = neighborSet(graph, neighbor);
    for (const candidate of second) {
      if (exclude.has(candidate)) continue;
      const set = bridges.get(candidate) ?? new Set<string>();
      set.add(neighbor);
      bridges.set(candidate, set);
    }
  }

  const out: TwoHop[] = [];
  for (const [candidate, viaSet] of bridges) {
    out.push({
      pageId: candidate,
      via: [...viaSet].sort(),
      score: viaSet.size,
    });
  }
  out.sort((a, b) => b.score - a.score || a.pageId.localeCompare(b.pageId));
  return out;
}
