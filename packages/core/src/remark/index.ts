// Remark / unified plugins that lift @oak/core's graph-aware behavior
// into the standard Markdown processing pipeline.
//
// Status: skeleton. Today render.ts uses a string-rewrite + markdown-it
// pipeline; that logic is being ported to remark plugins so consumers
// (Astro, MDX, custom unified pipelines) can integrate at the AST level.
//
// Public API target:
//   remarkOakLinks(graph, ctx)        // resolves [[wiki]] links
//   remarkOakTransclusion(graph, ctx) // expands ![[embeds]]
//   remarkOakBacklinks(graph, ctx)    // appends a backlinks section
//   remarkOakAssets(ctx)              // rewrites asset references

import type { Graph, OakPage } from "../types.js";

export type RemarkOakContext = {
  pageUrl: (pageId: string) => string;
  assetUrl: (target: string, page: OakPage) => string | null | undefined;
  redlinkClass?: string;
};

// Placeholder so the subpath export resolves; real plugins will replace
// these. Each will be a unified plugin returning a transformer.
export function remarkOakLinks(
  _graph: Graph,
  _ctx: RemarkOakContext,
): unknown {
  throw new Error("remarkOakLinks: not yet implemented");
}

export function remarkOakTransclusion(
  _graph: Graph,
  _ctx: RemarkOakContext,
): unknown {
  throw new Error("remarkOakTransclusion: not yet implemented");
}

export function remarkOakBacklinks(
  _graph: Graph,
  _ctx: RemarkOakContext,
): unknown {
  throw new Error("remarkOakBacklinks: not yet implemented");
}

export function remarkOakAssets(_ctx: RemarkOakContext): unknown {
  throw new Error("remarkOakAssets: not yet implemented");
}
