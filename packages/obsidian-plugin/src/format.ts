// Pure helpers shared between the sidebar and tests. No Obsidian
// imports here — keep them unit-testable.

import {
  getBacklinks,
  getTwoHopLinks,
  type Backlink,
  type Graph,
  type OakPage,
  type ResolvedLink,
  type TwoHop,
  type Vault,
} from "@oak/core";

export type OutboundEntry =
  | { kind: "page"; label: string; targetId: string }
  | { kind: "external"; label: string; target: string }
  | { kind: "redlink"; label: string; target: string }
  | { kind: "invalid"; label: string; reason: string };

export type BacklinkEntry = {
  fromId: string;
  fromTitle: string;
  context: string;
};

export type TwoHopBridgeEntry =
  | { kind: "page"; id: string; title: string }
  | { kind: "redlink"; targetKey: string; display: string };

export type TwoHopEntry = {
  pageId: string;
  title: string;
  via: TwoHopBridgeEntry[];
  score: number;
};

export type PageSummary = {
  id: string;
  title: string;
  visibility: string;
  slug: string;
  llm: string;
  publishable: boolean;
  parseErrors: number;
};

const PUBLISHABLE = new Set(["public", "unlisted"]);

export function summarizePage(page: OakPage): PageSummary {
  return {
    id: page.id,
    title: page.title,
    visibility: page.visibility,
    slug: page.slug,
    llm: page.llm,
    publishable: PUBLISHABLE.has(page.visibility),
    parseErrors: page.parseIssues.filter((i) => i.severity === "error").length,
  };
}

export function describeOutbound(
  link: ResolvedLink,
  vault: Vault,
): OutboundEntry {
  const r = link.resolution;
  switch (r.status) {
    case "resolved": {
      const target = vault.pages.get(r.targetId);
      const label = link.label ?? target?.title ?? link.target;
      return { kind: "page", label, targetId: r.targetId };
    }
    case "external":
      return {
        kind: "external",
        label: link.label ?? link.target,
        target: link.target,
      };
    case "unresolved":
      return {
        kind: "redlink",
        label: link.label ?? link.target,
        target: link.target,
      };
    case "invalid":
      return {
        kind: "invalid",
        label: link.label ?? link.target,
        reason: r.reason,
      };
  }
}

export function describeBacklinks(
  graph: Graph,
  vault: Vault,
  pageId: string,
): BacklinkEntry[] {
  const out: BacklinkEntry[] = [];
  const seen = new Map<string, BacklinkEntry>();
  for (const b of getBacklinks(graph, pageId)) {
    if (seen.has(b.fromId)) continue;
    const from = vault.pages.get(b.fromId);
    const entry: BacklinkEntry = {
      fromId: b.fromId,
      fromTitle: from?.title ?? b.fromId,
      context: b.context,
    };
    seen.set(b.fromId, entry);
    out.push(entry);
  }
  return out;
}

export function describeTwoHop(
  graph: Graph,
  vault: Vault,
  pageId: string,
  limit = 25,
): TwoHopEntry[] {
  const raw: TwoHop[] = getTwoHopLinks(graph, pageId).slice(0, limit);
  return raw.map((h) => ({
    pageId: h.pageId,
    title: vault.pages.get(h.pageId)?.title ?? h.pageId,
    via: h.via.map((b): TwoHopBridgeEntry =>
      b.kind === "page"
        ? {
            kind: "page",
            id: b.pageId,
            title: vault.pages.get(b.pageId)?.title ?? b.pageId,
          }
        : {
            kind: "redlink",
            targetKey: b.targetKey,
            display: b.display,
          },
    ),
    score: h.score,
  }));
}
