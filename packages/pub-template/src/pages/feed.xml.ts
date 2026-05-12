import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { excerptFrom } from "@oak/core";

// RSS 2.0 feed of every page that opted in via `feed: true` in
// frontmatter. The first-publish instant comes from the publish
// branch's `feed-dates.json` sidecar (stamped by `oak pub build`);
// pages without a stamped date — typically pages added since the
// last build — are skipped so the feed never produces a malformed
// pubDate.
//
// Channel metadata is intentionally derived from `OAK_SITE_URL` and
// the site title constant so a fork can customise the latter in one
// place. If you want richer config (separate description, language,
// per-author tags) extend this file in your own copy — the template
// is meant to be edited.

const SITE_TITLE = "oak site";
const SITE_DESCRIPTION = "Pages tagged for the feed.";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso: string): string {
  // RSS 2.0 mandates RFC 822 dates. Date.toUTCString returns exactly
  // that format ("Wed, 12 May 2026 10:00:00 GMT"); fall back to the
  // raw ISO if parsing fails so we never emit "Invalid Date".
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

export const GET: APIRoute = async ({ site }) => {
  const docs = await getCollection("docs");
  const items = docs
    .filter((d) => d.data.feed && d.data.published)
    .sort((a, b) => {
      // Newest first. published is non-null by construction (filter).
      const ap = a.data.published as string;
      const bp = b.data.published as string;
      return bp.localeCompare(ap);
    });

  const siteOrigin = site ? site.toString().replace(/\/$/, "") : "";
  const channelLink = `${siteOrigin}/`;
  const feedSelfLink = `${siteOrigin}/feed.xml`;
  const lastBuildDate =
    items.length > 0
      ? rfc822(items[0]!.data.published as string)
      : new Date().toUTCString();

  const itemXml = items
    .map((d) => {
      const url = `${siteOrigin}/${d.data.slug}/`;
      const description = excerptFrom(d.body ?? "", 400);
      return [
        "    <item>",
        `      <title>${xmlEscape(d.data.title)}</title>`,
        `      <link>${xmlEscape(url)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(url)}</guid>`,
        `      <pubDate>${rfc822(d.data.published as string)}</pubDate>`,
        `      <description>${xmlEscape(description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xmlEscape(SITE_TITLE)}</title>`,
    `    <link>${xmlEscape(channelLink)}</link>`,
    `    <description>${xmlEscape(SITE_DESCRIPTION)}</description>`,
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    `    <atom:link href="${xmlEscape(feedSelfLink)}" rel="self" type="application/rss+xml" />`,
    itemXml,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
