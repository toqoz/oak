// Render an oak page to HTML for publishing.
//
// Strategy:
//   1. Walk extractLinks/extractAssetRefs to learn every wiki and image
//      reference and its position in the source body.
//   2. Splice replacement Markdown (or raw HTML for red links) over the
//      original spans, working back-to-front so indices stay valid.
//   3. Hand the rewritten Markdown to markdown-it.
//
// The publisher pre-resolves page URLs and asset URLs, so this module
// is purely a transformer — no fs access, no hashing.

import MarkdownIt from "markdown-it";

import type { Graph, OakPage, RawLink, ResolvedLink } from "./types.js";
import { extractAssetRefs, isAssetTarget, type AssetRef } from "./assets.js";

export type RenderContext = {
  pageUrl: (pageId: string) => string;
  // Resolve an asset reference (the target as written in the Markdown,
  // e.g. `_assets/diagram.png` or `./img.svg`) to its published URL.
  // Return null/undefined to leave the asset unhandled (rendered as-is).
  assetUrl: (target: string, page: OakPage) => string | null | undefined;
  // Optional: produce raw HTML for unresolved wiki targets. Default is
  // a `<span class="oak-redlink">…</span>`.
  redlinkHtml?: (target: string, label: string | undefined) => string;
};

type Replacement = {
  start: number;
  end: number;
  text: string;
};

let _md: MarkdownIt | null = null;
function getMarkdown(): MarkdownIt {
  if (_md) return _md;
  _md = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
    breaks: false,
  });
  return _md;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Markdown-link-text escaping: brackets and parens cause bad parses.
function escapeLinkLabel(s: string): string {
  return s.replace(/[\[\]]/g, (m) => `\\${m}`);
}

function escapeLinkUrl(s: string): string {
  // Bare URL inside `(...)` — escape ) and whitespace so markdown-it
  // doesn't misparse the closing paren.
  return s.replace(/[\s)]/g, (m) => encodeURIComponent(m));
}

function defaultRedlink(target: string, label: string | undefined): string {
  const text = label ?? target;
  return `<span class="oak-redlink" data-target="${escapeHtml(target)}">${escapeHtml(text)}</span>`;
}

function applyReplacements(body: string, edits: Replacement[]): string {
  if (edits.length === 0) return body;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  // Detect overlap to prevent silent corruption.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(
        `overlapping replacements at ${sorted[i - 1]!.start}-${sorted[i - 1]!.end} and ${sorted[i]!.start}-${sorted[i]!.end}`,
      );
    }
  }
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    out += body.slice(cursor, e.start);
    out += e.text;
    cursor = e.end;
  }
  out += body.slice(cursor);
  return out;
}

function wikiLinkReplacement(
  link: ResolvedLink,
  page: OakPage,
  graph: Graph,
  vault: Map<string, OakPage>,
  ctx: RenderContext,
): string {
  void page;
  void graph;

  const r = link.resolution;
  // Embeds with a non-asset target render as a link-to-page placeholder.
  if (link.isEmbed && r.status === "resolved") {
    const target = vault.get(r.targetId);
    if (target) {
      const url = ctx.pageUrl(target.id);
      const label = link.label ?? target.titlePlain;
      const heading = link.heading ? `#${link.heading}` : "";
      return `[${escapeLinkLabel(label)}](${escapeLinkUrl(url + heading)}){.oak-embed}`;
    }
  }

  if (r.status === "resolved") {
    const target = vault.get(r.targetId);
    if (target) {
      const url = ctx.pageUrl(target.id);
      const label = link.label ?? target.titlePlain;
      const heading = link.heading ? `#${link.heading}` : "";
      return `[${escapeLinkLabel(label)}](${escapeLinkUrl(url + heading)})`;
    }
  }

  if (r.status === "unresolved") {
    const fn = ctx.redlinkHtml ?? defaultRedlink;
    return fn(link.target, link.label);
  }

  // External and invalid: leak guards should have prevented us from
  // ever rendering these for public pages. As a safety net, emit
  // sanitised plain text so we never leak a target path.
  return escapeHtml(link.label ?? link.target);
}

function assetReplacement(
  ref: AssetRef,
  page: OakPage,
  ctx: RenderContext,
): string {
  const url = ctx.assetUrl(ref.target, page);
  if (!url) {
    // Unhandled — render alt text only. This avoids leaking the
    // original filesystem path into published HTML.
    const alt = ref.alt ?? "";
    return alt.length > 0 ? escapeHtml(alt) : "";
  }
  const alt = ref.alt ?? "";
  return `![${escapeLinkLabel(alt)}](${escapeLinkUrl(url)})`;
}

export function rewriteBody(
  page: OakPage,
  vault: Map<string, OakPage>,
  graph: Graph,
  ctx: RenderContext,
): string {
  const edits: Replacement[] = [];
  const assetRefs = extractAssetRefs(page.body);
  const assetSpans = new Set<string>();
  for (const ref of assetRefs) {
    edits.push({
      start: ref.start,
      end: ref.end,
      text: assetReplacement(ref, page, ctx),
    });
    assetSpans.add(`${ref.start}:${ref.end}`);
  }

  const outgoing = graph.outgoing.get(page.id) ?? [];
  for (const link of outgoing) {
    // Skip wiki links that are also asset embeds (handled above).
    if (link.isEmbed && isAssetTarget(link.target)) continue;
    if (assetSpans.has(`${link.start}:${link.end}`)) continue;
    edits.push({
      start: link.start,
      end: link.end,
      text: wikiLinkReplacement(link, page, graph, vault, ctx),
    });
  }

  return applyReplacements(page.body, edits);
}

export function renderPage(
  page: OakPage,
  vault: Map<string, OakPage>,
  graph: Graph,
  ctx: RenderContext,
): string {
  const md = getMarkdown();
  const rewritten = rewriteBody(page, vault, graph, ctx);
  return md.render(rewritten);
}

// Convenience: shape a complete HTML document around the rendered body.
// The body already carries the `# Title` heading from the source file,
// so the `<article>` wrapper does not re-emit an `<h1>`. The `<title>`
// tag uses the plain-text form so decorations and wikilink syntax don't
// leak into the browser chrome.
export function renderPageDocument(
  page: OakPage,
  vault: Map<string, OakPage>,
  graph: Graph,
  ctx: RenderContext,
  options: { lang?: string; title?: string } = {},
): string {
  const body = renderPage(page, vault, graph, ctx);
  const title = options.title ?? page.titlePlain;
  const lang = options.lang ?? "en";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`;
}

// Re-export RawLink for downstream packages.
export type { RawLink };
