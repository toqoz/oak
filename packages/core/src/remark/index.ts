// Remark plugins that lift @oak/core's graph-aware behavior into
// the standard unified pipeline.
//
// Plugins:
//   remarkOakLinks       — resolves `[[wiki]]`, `[[Page|Label]]`,
//                          `[[Page#Heading]]` and `![[asset.png]]`
//                          embeds against a vault.
//   remarkOakAssets      — rewrites markdown image URLs (`![](path)`)
//                          via a user-supplied resolver, so static
//                          assets get the published URL.
//
// These are the building blocks the pub-template wires into
// Astro's `markdown.remarkPlugins`. They operate on mdast — no
// markdown-it, no string slicing — so they compose with shiki,
// MDX, and other unified plugins out of the box.

import { visit, SKIP } from "unist-util-visit";
import type {
  Html,
  Image,
  Link,
  Parent,
  PhrasingContent,
  Root,
  Text,
} from "mdast";

import type { OakPage, Vault } from "../types.js";
import { resolveTarget } from "../graph.js";
import { isAssetTarget } from "../assets.js";

const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g;
const REDLINK_CLASS_DEFAULT = "oak-redlink";

export type RemarkOakLinksOptions = {
  vault: Vault;
  // Map a resolved page to its published URL. Defaults to `/${slug}/`.
  pageUrl?: (page: OakPage) => string;
  // Map a wiki-style asset embed (e.g. `![[diagram.png]]`) to its
  // published URL. Returning null leaves the embed as plain alt text.
  assetUrl?: (target: string) => string | null | undefined;
  // Map an unresolved wiki link target to its placeholder URL. When
  // provided and the resolver returns a non-empty string, the redlink
  // is emitted as an `<a>` instead of a `<span>` so it's clickable.
  // Returning null/undefined keeps the current span behavior.
  redlinkUrl?: (target: string) => string | null | undefined;
  // CSS class applied to the redlink element (anchor or span).
  // Default: `oak-redlink`.
  redlinkClass?: string;
};

export type RemarkOakAssetsOptions = {
  // Resolve a markdown image `url` to its published URL. Return null
  // (or the same string) to leave the URL untouched.
  assetUrl: (target: string) => string | null | undefined;
};

function defaultPageUrl(page: OakPage): string {
  return `/${page.slug}/`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ParsedWiki = {
  target: string;
  label?: string;
  heading?: string;
};

function parseWikiInner(inner: string): ParsedWiki | null {
  let target = inner.trim();
  if (target.length === 0) return null;
  let label: string | undefined;
  let heading: string | undefined;
  const pipe = target.indexOf("|");
  if (pipe !== -1) {
    label = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe).trim();
  }
  const hash = target.indexOf("#");
  if (hash !== -1) {
    heading = target.slice(hash + 1).trim() || undefined;
    target = target.slice(0, hash).trim();
  }
  if (target.length === 0) return null;
  return { target, ...(label ? { label } : {}), ...(heading ? { heading } : {}) };
}

// Slugify a heading the way markdown renderers commonly do (lowercase,
// non-alnum to dashes, collapse). Mirrors GitHub-style anchors closely
// enough for typical content.
function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function makeText(value: string): Text {
  return { type: "text", value };
}

function makeLink(url: string, label: string): Link {
  return {
    type: "link",
    url,
    title: null,
    children: [{ type: "text", value: label }],
  };
}

function makeRedlinkHtml(target: string, label: string, cls: string): Html {
  return {
    type: "html",
    value: `<span class="${cls}" data-target="${escapeHtml(target)}">${escapeHtml(label)}</span>`,
  };
}

function makeRedlinkAnchor(
  target: string,
  label: string,
  url: string,
  cls: string,
): Html {
  return {
    type: "html",
    value: `<a class="${cls}" href="${escapeHtml(url)}" data-target="${escapeHtml(target)}">${escapeHtml(label)}</a>`,
  };
}

function makeImage(url: string, alt: string | null): Image {
  return { type: "image", url, title: null, alt };
}

// Replace a wiki match with the appropriate mdast node. Returns null
// when the match should be left as the original literal text (e.g.
// because no resolver could handle it). The parent will then keep the
// original text for that span.
function resolveWikiNode(
  parsed: ParsedWiki,
  isEmbed: boolean,
  options: RemarkOakLinksOptions,
): PhrasingContent {
  const { vault } = options;
  const pageUrl = options.pageUrl ?? defaultPageUrl;
  const redlinkClass = options.redlinkClass ?? REDLINK_CLASS_DEFAULT;

  // Asset-typed embeds: render an image, regardless of whether the
  // target resolves to a vault page (an embedded `.png` is always a
  // file lookup, not a page).
  if (isEmbed && isAssetTarget(parsed.target)) {
    const url = options.assetUrl?.(parsed.target);
    if (url) {
      return makeImage(url, parsed.label ?? null);
    }
    // No asset resolver — strip to alt text to avoid leaking the path.
    return makeText(parsed.label ?? "");
  }

  const resolution = resolveTarget(vault, parsed.target);
  if (resolution.status === "resolved") {
    const target = vault.pages.get(resolution.targetId);
    if (target) {
      const base = pageUrl(target);
      const url = parsed.heading
        ? `${base}#${headingSlug(parsed.heading)}`
        : base;
      const label = parsed.label ?? target.title;
      // Page embed → render as a marked-up link the template can style.
      if (isEmbed) {
        return {
          type: "link",
          url,
          title: null,
          data: { hProperties: { className: ["oak-embed"] } },
          children: [{ type: "text", value: label }],
        } satisfies Link;
      }
      return makeLink(url, label);
    }
  }

  if (resolution.status === "unresolved") {
    const label = parsed.label ?? parsed.target;
    const url = options.redlinkUrl?.(parsed.target);
    if (typeof url === "string" && url.length > 0) {
      return makeRedlinkAnchor(parsed.target, label, url, redlinkClass);
    }
    return makeRedlinkHtml(parsed.target, label, redlinkClass);
  }

  // External / invalid: emit alt-text only to avoid leaking the target.
  return makeText(parsed.label ?? parsed.target);
}

// Walk text nodes, splitting on wiki-link matches and replacing each
// match with a resolved node. Pure mdast in/out — leaves code spans
// (`inlineCode`) and code blocks (`code`) untouched because they're
// not `text` nodes.
export function remarkOakLinks(options: RemarkOakLinksOptions) {
  return () => (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) return;
      // Don't rewrite text inside an existing link — wiki syntax
      // there has been chosen explicitly by the author.
      if (parent.type === "link") return;

      const value = node.value;
      WIKI_RE.lastIndex = 0;
      const replacements: PhrasingContent[] = [];
      let cursor = 0;
      let match: RegExpExecArray | null;
      let consumedAny = false;

      while ((match = WIKI_RE.exec(value)) !== null) {
        const isEmbed = match[1] === "!";
        const parsed = parseWikiInner(match[2]!);
        if (!parsed) continue;
        consumedAny = true;
        if (match.index > cursor) {
          replacements.push(makeText(value.slice(cursor, match.index)));
        }
        replacements.push(resolveWikiNode(parsed, isEmbed, options));
        cursor = match.index + match[0].length;
      }

      if (!consumedAny) return;
      if (cursor < value.length) {
        replacements.push(makeText(value.slice(cursor)));
      }
      parent.children.splice(index, 1, ...replacements);
      // Skip past the inserted nodes (don't revisit the new ones).
      return [SKIP, index + replacements.length];
    });
  };
}

// Rewrite standard markdown image URLs through a user-supplied
// resolver. Skips absolute, protocol-relative, and external URLs so
// authors can mix vault assets and remote images freely.
const URL_EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function remarkOakAssets(options: RemarkOakAssetsOptions) {
  return () => (tree: Root) => {
    visit(tree, "image", (node: Image) => {
      if (!node.url || URL_EXTERNAL_RE.test(node.url)) return;
      const url = options.assetUrl(node.url);
      if (typeof url === "string" && url.length > 0) {
        node.url = url;
      }
    });
  };
}
