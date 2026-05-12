// "Related" view model for a single page: outbound, inbound, and
// 2-hop neighbours, shaped for renderers (publish-template, Obsidian
// plugin) that need title + URL + bridge info rather than raw graph
// edges.
//
// All page references are filtered by visibility so the publish flow
// can lean on this for its per-page "related" surface without leaking
// private pages.

import {
  getBacklinks,
  getTwoHopLinks,
  isRedlinkTarget,
} from "./graph.js";
import { excerptFrom } from "./home.js";
import type {
  Backlink,
  Graph,
  OakPage,
  ResolvedLink,
  TwoHop,
  Vault,
  Visibility,
} from "./types.js";

export type PageRef = {
  id: string;
  title: string;
  slug: string;
};

export type OutboundEntry =
  | ({ kind: "page" } & PageRef)
  | { kind: "redlink"; targetKey: string; display: string }
  | { kind: "external"; target: string };

export type InboundEntry = PageRef & {
  // Single representative line of context for the backlink. Picked
  // from the first occurrence on the source page.
  context: string;
  excerpt: string;
};

export type TwoHopBridgeEntry =
  | ({ kind: "page" } & PageRef)
  | { kind: "redlink"; targetKey: string; display: string };

export type TwoHopEntry = PageRef & {
  via: TwoHopBridgeEntry[];
  score: number;
  excerpt: string;
};

export type RelatedView = {
  outbound: OutboundEntry[];
  inbound: InboundEntry[];
  twoHop: TwoHopEntry[];
};

export type RelatedOptions = {
  // Pages whose visibility is not in this set are filtered out of all
  // three lists. Defaults to {public, unlisted}.
  visibilityFilter?: Visibility[];
  // Excerpt length passed through to `excerptFrom`.
  excerptMaxChars?: number;
  // Cap on 2-hop entries returned. Default 25 mirrors the Obsidian
  // plugin's per-page limit.
  twoHopLimit?: number;
};

const DEFAULT_VISIBILITY: Visibility[] = ["public", "unlisted"];

function visibleSet(filter?: Visibility[]): Set<Visibility> {
  return new Set(filter ?? DEFAULT_VISIBILITY);
}

function pageRef(page: OakPage): PageRef {
  return { id: page.id, title: page.titlePlain, slug: page.slug };
}

function buildOutbound(
  page: OakPage,
  vault: Vault,
  graph: Graph,
  visible: Set<Visibility>,
): OutboundEntry[] {
  const out: OutboundEntry[] = [];
  const seen = new Set<string>();
  const links: ResolvedLink[] = graph.outgoing.get(page.id) ?? [];
  for (const link of links) {
    const r = link.resolution;
    if (r.status === "resolved") {
      const target = vault.pages.get(r.targetId);
      if (!target || !visible.has(target.visibility)) continue;
      const key = `p:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "page", ...pageRef(target) });
    } else if (r.status === "unresolved") {
      const key = `r:${r.targetKey.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: "redlink",
        targetKey: r.targetKey,
        display: link.label ?? r.targetKey,
      });
    } else if (r.status === "external") {
      const key = `e:${link.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "external", target: link.target });
    }
    // "invalid" intentionally dropped — surface as parse issues, not
    // navigation targets.
  }
  return out;
}

function buildInbound(
  page: OakPage,
  vault: Vault,
  graph: Graph,
  visible: Set<Visibility>,
  excerptMax: number,
): InboundEntry[] {
  const out: InboundEntry[] = [];
  const seen = new Set<string>();
  const back: Backlink[] = graph.incoming.get(page.id) ?? [];
  for (const b of back) {
    if (seen.has(b.fromId)) continue;
    const from = vault.pages.get(b.fromId);
    if (!from || !visible.has(from.visibility)) continue;
    seen.add(b.fromId);
    out.push({
      ...pageRef(from),
      context: b.context,
      excerpt: excerptFrom(from.body, excerptMax),
    });
  }
  return out;
}

function buildTwoHop(
  page: OakPage,
  vault: Vault,
  graph: Graph,
  visible: Set<Visibility>,
  limit: number,
  excerptMax: number,
): TwoHopEntry[] {
  const raw: TwoHop[] = getTwoHopLinks(graph, page.id);
  const out: TwoHopEntry[] = [];
  for (const hop of raw) {
    if (isRedlinkTarget(hop.pageId)) continue; // safety; shouldn't appear
    const target = vault.pages.get(hop.pageId);
    if (!target || !visible.has(target.visibility)) continue;

    const via: TwoHopBridgeEntry[] = [];
    for (const b of hop.via) {
      if (b.kind === "page") {
        const bp = vault.pages.get(b.pageId);
        if (!bp || !visible.has(bp.visibility)) continue;
        via.push({ kind: "page", ...pageRef(bp) });
      } else {
        via.push({
          kind: "redlink",
          targetKey: b.targetKey,
          display: b.display,
        });
      }
    }
    if (via.length === 0) continue;

    out.push({
      ...pageRef(target),
      via,
      score: via.length,
      excerpt: excerptFrom(target.body, excerptMax),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function relatedView(
  vault: Vault,
  graph: Graph,
  pageId: string,
  options: RelatedOptions = {},
): RelatedView {
  const visible = visibleSet(options.visibilityFilter);
  const excerptMax = options.excerptMaxChars ?? 240;
  const twoHopLimit = options.twoHopLimit ?? 25;

  const page = vault.pages.get(pageId);
  if (!page) {
    return { outbound: [], inbound: [], twoHop: [] };
  }

  return {
    outbound: buildOutbound(page, vault, graph, visible),
    inbound: buildInbound(page, vault, graph, visible, excerptMax),
    twoHop: buildTwoHop(page, vault, graph, visible, twoHopLimit, excerptMax),
  };
}
