// Vault-wide substring search.
//
// Pure function over a parsed `Vault`. Case-insensitive. Scans three
// fields per page — title, aliases, body lines — and returns ranked
// hits with snippet windows around each match so renderers can
// highlight without re-running the search.
//
// Ranking tiers (higher first):
//   title-prefix match > title-contains > alias-contains > body-only
// Ties break by snippet count desc, then title asc.

import type { OakPage, Vault, Visibility } from "./types.js";

export type SearchMatchKind = "title" | "alias" | "body";

export type SearchSnippet = {
  kind: SearchMatchKind;
  // 1-based line number for body matches; 0 for title/alias.
  line: number;
  // Display string. May be a window of the original line with `…`
  // sentinels when the line was longer than `bodySnippetMaxChars`.
  text: string;
  // [start, end) match offsets within `text`.
  start: number;
  end: number;
};

export type SearchHit = {
  pageId: string;
  title: string;
  aliases: string[];
  visibility: Visibility;
  vaultRelPath: string;
  snippets: SearchSnippet[];
  // Total body matches before the per-page cap was applied. Lets the
  // UI render a "+N more matches" affordance without re-searching.
  bodyMatchCount: number;
  score: number;
};

export type SearchOptions = {
  limit?: number;
  bodyMatchesPerPage?: number;
  bodySnippetMaxChars?: number;
  // When set, only pages whose visibility is in the set appear.
  visibilityFilter?: Visibility[];
};

const DEFAULT_LIMIT = 200;
const DEFAULT_BODY_PER_PAGE = 5;
const DEFAULT_SNIPPET_CHARS = 200;

const SCORE_TITLE_PREFIX = 1000;
const SCORE_TITLE_CONTAINS = 500;
const SCORE_ALIAS_CONTAINS = 200;

export function searchVault(
  vault: Vault,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const q = query.trim();
  if (q.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const bodyCap = opts.bodyMatchesPerPage ?? DEFAULT_BODY_PER_PAGE;
  const snippetMax = opts.bodySnippetMaxChars ?? DEFAULT_SNIPPET_CHARS;
  const visFilter = opts.visibilityFilter
    ? new Set<Visibility>(opts.visibilityFilter)
    : null;

  const qLower = q.toLowerCase();
  const hits: SearchHit[] = [];

  for (const page of vault.pages.values()) {
    if (visFilter && !visFilter.has(page.visibility)) continue;
    const hit = scorePage(page, q, qLower, bodyCap, snippetMax);
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.snippets.length !== b.snippets.length) {
      return b.snippets.length - a.snippets.length;
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  return hits.slice(0, limit);
}

function scorePage(
  page: OakPage,
  query: string,
  qLower: string,
  bodyCap: number,
  snippetMax: number,
): SearchHit | null {
  const snippets: SearchSnippet[] = [];
  let score = 0;

  // Title
  const titleLower = page.title.toLowerCase();
  const titleIdx = titleLower.indexOf(qLower);
  if (titleIdx !== -1) {
    score += titleIdx === 0 ? SCORE_TITLE_PREFIX : SCORE_TITLE_CONTAINS;
    snippets.push({
      kind: "title",
      line: 0,
      text: page.title,
      start: titleIdx,
      end: titleIdx + query.length,
    });
  }

  // Aliases — surface each match as its own snippet so the UI can show
  // which alias caught the query (useful when a page has several).
  for (const alias of page.aliases) {
    const aliasLower = alias.toLowerCase();
    const idx = aliasLower.indexOf(qLower);
    if (idx === -1) continue;
    score += SCORE_ALIAS_CONTAINS;
    snippets.push({
      kind: "alias",
      line: 0,
      text: alias,
      start: idx,
      end: idx + query.length,
    });
  }

  // Body — line-by-line. Accumulate every match (with windowing) up to
  // the per-page cap; keep a separate counter so the UI can hint
  // "+N more matches" without re-scanning the body.
  let bodyMatchCount = 0;
  let bodySnippetCount = 0;
  const lines = page.body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineLower = line.toLowerCase();
    let from = 0;
    while (from <= lineLower.length) {
      const idx = lineLower.indexOf(qLower, from);
      if (idx === -1) break;
      bodyMatchCount++;
      if (bodySnippetCount < bodyCap) {
        const win = windowAround(line, idx, idx + query.length, snippetMax);
        snippets.push({
          kind: "body",
          line: i + 1,
          text: win.text,
          start: win.start,
          end: win.end,
        });
        bodySnippetCount++;
      }
      from = idx + Math.max(qLower.length, 1);
    }
  }

  if (snippets.length === 0 && bodyMatchCount === 0) return null;

  // Body contributes a small ranking signal so a page with 20 body
  // matches ranks above one with 1, but it never out-ranks a title or
  // alias hit.
  score += Math.min(bodyMatchCount, 100);

  return {
    pageId: page.id,
    title: page.title,
    aliases: [...page.aliases],
    visibility: page.visibility,
    vaultRelPath: page.relPath,
    snippets,
    bodyMatchCount,
    score,
  };
}

// Slide a window of at most `maxChars` characters centered on the
// match. Adds `…` sentinels when the window doesn't reach the line's
// edges. Returns offsets relative to the windowed text so callers can
// highlight directly without recomputing.
function windowAround(
  line: string,
  matchStart: number,
  matchEnd: number,
  maxChars: number,
): { text: string; start: number; end: number } {
  if (line.length <= maxChars) {
    return { text: line, start: matchStart, end: matchEnd };
  }
  const matchLen = matchEnd - matchStart;
  // Aim to give roughly equal context on either side of the match,
  // but never less than half the budget on the leading side.
  const lead = Math.max(20, Math.floor((maxChars - matchLen) / 2));
  let from = Math.max(0, matchStart - lead);
  let to = Math.min(line.length, from + maxChars);
  // If we hit the right edge first, pull `from` back so the window
  // still uses the full budget.
  from = Math.max(0, to - maxChars);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < line.length ? "…" : "";
  const text = prefix + line.slice(from, to) + suffix;
  const shift = prefix.length - from;
  return {
    text,
    start: matchStart + shift,
    end: matchEnd + shift,
  };
}
