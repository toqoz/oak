// Link resolution and graph queries.

import type {
  Backlink,
  Graph,
  LinkResolution,
  RawLink,
  RedlinkBucket,
  ResolvedLink,
  TwoHop,
  TwoHopBridge,
  Vault,
} from "./types.js";
import { normalizeKey } from "./slug.js";

const EXTERNAL_PREFIX = "_external/";

function resolveOne(vault: Vault, link: RawLink): LinkResolution {
  const targetRaw = link.target.trim();
  if (targetRaw.length === 0) {
    return { status: "invalid", reason: "empty link target" };
  }

  // Path-like targets containing `/`: prefer path lookup.
  const looksLikePath = targetRaw.includes("/") || targetRaw.endsWith(".md");
  if (looksLikePath) {
    const noExt = targetRaw.replace(/\.md$/i, "").replace(/^\.\//, "");
    const key = normalizeKey(noExt);

    if (noExt.startsWith(EXTERNAL_PREFIX)) {
      // External documents must be resolved via the byVaultRelPath table,
      // which is only populated for configured & existing mounts. If the
      // mount does not exist, surface as `external` with a synthetic id so
      // downstream leak checks can still flag the link.
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
      // Could be a page or external. byVaultRelPath stores both, so check.
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
  const redlinks = new Map<string, RedlinkBucket>();

  for (const page of vault.pages.values()) {
    const resolved = resolveLinks(vault, page.links);
    outgoing.set(page.id, resolved);

    for (const link of resolved) {
      const r = link.resolution;
      if (r.status === "resolved") {
        const targetId = r.targetId;
        const list = incoming.get(targetId) ?? [];
        list.push({
          fromId: page.id,
          context: lineContextOf(page.body, link.line),
        });
        incoming.set(targetId, list);
      } else if (r.status === "unresolved") {
        const key = normalizeKey(r.targetKey);
        if (key.length === 0) continue;
        let bucket = redlinks.get(key);
        if (!bucket) {
          bucket = { display: r.targetKey.trim(), refs: [] };
          redlinks.set(key, bucket);
        }
        bucket.refs.push({
          fromId: page.id,
          context: lineContextOf(page.body, link.line),
        });
      }
    }
  }

  return { outgoing, incoming, redlinks };
}

export function getOutboundLinks(graph: Graph, pageId: string): ResolvedLink[] {
  return graph.outgoing.get(pageId) ?? [];
}

export function getBacklinks(graph: Graph, pageId: string): Backlink[] {
  return graph.incoming.get(pageId) ?? [];
}

// Internal: nodes in the 2-hop graph are either real page IDs or virtual
// red-link nodes. The `redlink:` prefix can never collide with a page ID
// because page IDs are ULIDs (no `:` in their charset).
const REDLINK_NODE_PREFIX = "redlink:";

function isRedlinkNode(node: string): boolean {
  return node.startsWith(REDLINK_NODE_PREFIX);
}

function redlinkNode(key: string): string {
  return REDLINK_NODE_PREFIX + key;
}

function redlinkKey(node: string): string {
  return node.slice(REDLINK_NODE_PREFIX.length);
}

function neighborSet(graph: Graph, node: string): Set<string> {
  const set = new Set<string>();
  if (isRedlinkNode(node)) {
    // A red-link "node" has no outgoing of its own — its neighbors are
    // every page that mentions it.
    const bucket = graph.redlinks.get(redlinkKey(node));
    for (const ref of bucket?.refs ?? []) set.add(ref.fromId);
    return set;
  }
  for (const link of graph.outgoing.get(node) ?? []) {
    if (link.resolution.status === "resolved") {
      set.add(link.resolution.targetId);
    } else if (link.resolution.status === "unresolved") {
      const key = normalizeKey(link.resolution.targetKey);
      if (key.length > 0) set.add(redlinkNode(key));
    }
  }
  for (const back of graph.incoming.get(node) ?? []) {
    set.add(back.fromId);
  }
  return set;
}

function bridgeFromNode(graph: Graph, node: string): TwoHopBridge {
  if (isRedlinkNode(node)) {
    const key = redlinkKey(node);
    return {
      kind: "redlink",
      targetKey: key,
      display: graph.redlinks.get(key)?.display ?? key,
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
  // bridges are never candidates themselves (they aren't real pages); we
  // only walk *through* them.
  const exclude = new Set<string>();
  exclude.add(pageId);
  for (const n of directNeighbors) {
    if (!isRedlinkNode(n)) exclude.add(n);
  }

  const bridges = new Map<string, TwoHopBridge[]>();
  for (const neighbor of directNeighbors) {
    const bridge = bridgeFromNode(graph, neighbor);
    for (const candidate of neighborSet(graph, neighbor)) {
      if (isRedlinkNode(candidate)) continue;
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
