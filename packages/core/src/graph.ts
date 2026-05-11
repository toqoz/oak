// Link resolution and graph queries.

import type {
  Backlink,
  Graph,
  LinkResolution,
  RawLink,
  ResolvedLink,
  TwoHop,
  TwoHopBridge,
  Vault,
} from "./types.js";
import { isManagedPage } from "./parse.js";
import { normalizeKey } from "./slug.js";

const EXTERNAL_PREFIX = "_external/";

// Synthetic node id for an unresolved (red) link target. The graph treats
// real pages and red-link targets as the same kind of node — both have
// inbound references — so they share one address space. The `redlink:`
// prefix never collides with a page id (ULIDs don't contain `:`).
const REDLINK_PREFIX = "redlink:";

export function redlinkTargetId(key: string): string {
  return REDLINK_PREFIX + normalizeKey(key);
}

export function isRedlinkTarget(id: string): boolean {
  return id.startsWith(REDLINK_PREFIX);
}

// Return the graph node id this link points at, or null if the link has no
// addressable target (external/invalid). Resolved links point at a page id;
// unresolved links point at a red-link node id.
export function linkTargetId(link: ResolvedLink): string | null {
  const r = link.resolution;
  if (r.status === "resolved") return r.targetId;
  if (r.status === "unresolved") {
    const key = normalizeKey(r.targetKey);
    return key.length === 0 ? null : REDLINK_PREFIX + key;
  }
  return null;
}

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
    if (!isManagedPage(page)) continue;
    const resolved = resolveLinks(vault, page.links);
    outgoing.set(page.id, resolved);

    for (const link of resolved) {
      const targetId = linkTargetId(link);
      if (targetId === null) continue;
      const list = incoming.get(targetId) ?? [];
      list.push({
        fromId: page.id,
        context: lineContextOf(page.body, link.line),
        line: link.line,
        raw: link.raw,
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

// Walk the graph treating both pages and red-link targets uniformly: each
// has inbound refs (in `incoming`); only pages additionally have outbound
// links (in `outgoing`).
function neighborSet(graph: Graph, node: string): Set<string> {
  const set = new Set<string>();
  for (const link of graph.outgoing.get(node) ?? []) {
    const t = linkTargetId(link);
    if (t !== null) set.add(t);
  }
  for (const back of graph.incoming.get(node) ?? []) {
    set.add(back.fromId);
  }
  return set;
}

// Find the original (case-preserving) target text for a red-link node by
// scanning any page known to link to it. Both the source and the candidate
// link to the bridge, so at least one will appear in `incoming`.
function redlinkDisplay(graph: Graph, node: string): string {
  const key = node.slice(REDLINK_PREFIX.length);
  for (const ref of graph.incoming.get(node) ?? []) {
    for (const link of graph.outgoing.get(ref.fromId) ?? []) {
      if (
        link.resolution.status === "unresolved" &&
        normalizeKey(link.resolution.targetKey) === key
      ) {
        return link.resolution.targetKey.trim();
      }
    }
  }
  return key;
}

function bridgeFromNode(graph: Graph, node: string): TwoHopBridge {
  if (isRedlinkTarget(node)) {
    return {
      kind: "redlink",
      targetKey: node.slice(REDLINK_PREFIX.length),
      display: redlinkDisplay(graph, node),
    };
  }
  return { kind: "page", pageId: node };
}

function bridgeKey(b: TwoHopBridge): string {
  return b.kind === "page" ? `p:${b.pageId}` : `r:${b.targetKey}`;
}

export function getTwoHopLinks(graph: Graph, pageId: string): TwoHop[] {
  const directNeighbors = neighborSet(graph, pageId);

  // Exclude self and any direct page-neighbors as 2-hop candidates. Red-link
  // targets are never candidates themselves (no page exists there yet); we
  // only walk *through* them.
  const exclude = new Set<string>();
  exclude.add(pageId);
  for (const n of directNeighbors) {
    if (!isRedlinkTarget(n)) exclude.add(n);
  }

  const bridges = new Map<string, TwoHopBridge[]>();
  for (const neighbor of directNeighbors) {
    const bridge = bridgeFromNode(graph, neighbor);
    for (const candidate of neighborSet(graph, neighbor)) {
      if (isRedlinkTarget(candidate)) continue;
      if (exclude.has(candidate)) continue;
      const list = bridges.get(candidate) ?? [];
      list.push(bridge);
      bridges.set(candidate, list);
    }
  }

  const out: TwoHop[] = [];
  for (const [candidate, vias] of bridges) {
    const seen = new Set<string>();
    const uniq: TwoHopBridge[] = [];
    for (const v of vias) {
      const k = bridgeKey(v);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(v);
    }
    uniq.sort((a, b) => bridgeKey(a).localeCompare(bridgeKey(b)));
    out.push({ pageId: candidate, via: uniq, score: uniq.length });
  }
  out.sort((a, b) => b.score - a.score || a.pageId.localeCompare(b.pageId));
  return out;
}
