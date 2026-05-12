// Substring search over a flat document corpus.
//
// `searchDocs(docs, query)` is the public scorer. `searchVault` is a
// thin adapter that projects a `Vault` into the flat doc shape. The
// pub site emits a SearchDoc-shaped corpus at build time so the
// editor and the static site run the same scorer over the same
// fields — keeping behaviour identical without sharing the renderer.
//
// Multi-term AND semantics: the query is split on whitespace and
// every resulting token must hit somewhere on the doc (title, an
// alias, or the body) for the doc to qualify. Heading lines
// (`# … ######`) contribute extra weight so matches inside section
// titles outrank matches buried in prose.
//
// Pure functions; case-insensitive. Returns ranked hits with snippet
// windows around each match so renderers can highlight without
// re-running the search.

import type { OakPage, Vault, Visibility } from "./types.js";

// `parse.ts` pulls in node:fs etc. and would poison the browser
// bundle the pub site imports via `@oak/core/search`. The membership
// test is a one-liner — inline it here so this module stays
// dependency-free.
function isManagedPage(page: OakPage): boolean {
  for (const issue of page.parseIssues) {
    if (issue.code === "missing-id") return false;
  }
  return true;
}

export type SearchMatchKind = "title" | "alias" | "body";

export type Range = { start: number; end: number };

export type SearchSnippet = {
  kind: SearchMatchKind;
  // 1-based line number for body matches; 0 for title / alias.
  line: number;
  // Display string. May be a window of the original line with `…`
  // sentinels when the line was longer than `bodySnippetMaxChars`.
  text: string;
  // Highlight spans into `text`. Sorted by start; non-overlapping
  // (overlapping ranges are merged before being returned).
  ranges: Range[];
};

// Minimal document shape the search scorer operates on. Editor builds
// this from `Vault.pages`; pub site emits it directly from the static
// content collection.
export type SearchDoc = {
  id: string;
  title: string;
  aliases: string[];
  body: string;
  visibility: Visibility;
  // Host-specific locator the consumer uses to open this hit. Editor:
  // vault-relative path (`page.relPath`). Pub: page slug. Surfaces it
  // as the result row's subtitle and threads it back through the
  // host's `onOpen(hit)` handler.
  path: string;
};

export type SearchHit = {
  pageId: string;
  title: string;
  aliases: string[];
  visibility: Visibility;
  path: string;
  snippets: SearchSnippet[];
  // Total body match count (token-occurrences across the whole body)
  // before per-doc caps. Lets the UI render a "+N more matches"
  // affordance without re-scanning.
  bodyMatchCount: number;
  score: number;
};

export type SearchOptions = {
  limit?: number;
  bodyMatchesPerPage?: number;
  bodySnippetMaxChars?: number;
  // When set, only docs whose visibility is in the set appear.
  visibilityFilter?: Visibility[];
};

const DEFAULT_LIMIT = 200;
const DEFAULT_BODY_PER_PAGE = 5;
const DEFAULT_SNIPPET_CHARS = 200;

const SCORE_TITLE_PREFIX = 1000;
const SCORE_TITLE_CONTAINS = 500;
const SCORE_ALIAS_CONTAINS = 200;
const SCORE_HEADING_TOKEN = 20;
const SCORE_BODY_LINE = 5;

export function searchVault(
  vault: Vault,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const docs: SearchDoc[] = [];
  for (const page of vault.pages.values()) {
    if (!isManagedPage(page)) continue;
    docs.push(docFromPage(page));
  }
  return searchDocs(docs, query, opts);
}

export function searchDocs(
  docs: SearchDoc[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const bodyCap = opts.bodyMatchesPerPage ?? DEFAULT_BODY_PER_PAGE;
  const snippetMax = opts.bodySnippetMaxChars ?? DEFAULT_SNIPPET_CHARS;
  const visFilter = opts.visibilityFilter
    ? new Set<Visibility>(opts.visibilityFilter)
    : null;

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    if (visFilter && !visFilter.has(doc.visibility)) continue;
    const hit = scoreDoc(doc, tokens, bodyCap, snippetMax);
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

function docFromPage(page: OakPage): SearchDoc {
  return {
    id: page.id,
    title: page.title,
    aliases: [...page.aliases],
    body: page.body,
    visibility: page.visibility,
    path: page.relPath,
  };
}

function tokenize(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

function findAll(text: string, term: string): Range[] {
  if (term.length === 0) return [];
  const out: Range[] = [];
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  while (from <= lower.length - needle.length) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return out;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}\s/.test(line);
}

function scoreDoc(
  doc: SearchDoc,
  tokens: string[],
  bodyCap: number,
  snippetMax: number,
): SearchHit | null {
  const tokenHit = new Array<boolean>(tokens.length).fill(false);

  // Title — record per-token contribution. A token at offset 0 of the
  // title scores at the higher "prefix" tier; otherwise "contains".
  let titlePrefixHits = 0;
  let titleContainsHits = 0;
  const titleRanges: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const ranges = findAll(doc.title, tokens[i]!);
    if (ranges.length === 0) continue;
    tokenHit[i] = true;
    if (ranges[0]!.start === 0) titlePrefixHits++;
    else titleContainsHits++;
    titleRanges.push(...ranges);
  }

  // Aliases — the alias-scoring tier only fires when every token
  // hits within a single alias (an alias represents one name; a
  // half-match doesn't reflect intent). But token-level satisfaction
  // still counts: if any alias contains a token, that token has
  // landed somewhere on the doc and contributes to the AND
  // requirement below.
  const aliasSnippets: SearchSnippet[] = [];
  for (const alias of doc.aliases) {
    const perToken: Range[][] = tokens.map((t) => findAll(alias, t));
    for (let i = 0; i < tokens.length; i++) {
      if (perToken[i]!.length > 0) tokenHit[i] = true;
    }
    const allHit = perToken.every((r) => r.length > 0);
    if (allHit) {
      aliasSnippets.push({
        kind: "alias",
        line: 0,
        text: alias,
        ranges: mergeRanges(perToken.flat()),
      });
    }
  }

  // Body — line-by-line. Each line with any match becomes one
  // snippet with all of that line's ranges merged. Heading lines
  // (`# ` … `###### `) contribute an extra ranking bonus per
  // token-hit, so matches inside section titles outrank
  // mid-paragraph mentions.
  let bodyMatchCount = 0;
  let headingTokenHits = 0;
  const bodyLines: Array<{
    line: number;
    text: string;
    ranges: Range[];
  }> = [];
  const lines = doc.body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = isHeadingLine(line);
    const lineRanges: Range[] = [];
    for (let t = 0; t < tokens.length; t++) {
      const r = findAll(line, tokens[t]!);
      if (r.length === 0) continue;
      tokenHit[t] = true;
      bodyMatchCount += r.length;
      if (heading) headingTokenHits += r.length;
      lineRanges.push(...r);
    }
    if (lineRanges.length > 0) {
      bodyLines.push({
        line: i + 1,
        text: line,
        ranges: mergeRanges(lineRanges),
      });
    }
  }

  // AND requirement — every token has to have landed somewhere.
  for (const hit of tokenHit) if (!hit) return null;

  const score =
    titlePrefixHits * SCORE_TITLE_PREFIX +
    titleContainsHits * SCORE_TITLE_CONTAINS +
    aliasSnippets.length * SCORE_ALIAS_CONTAINS +
    headingTokenHits * SCORE_HEADING_TOKEN +
    bodyLines.length * SCORE_BODY_LINE;

  const snippets: SearchSnippet[] = [];
  if (titleRanges.length > 0) {
    snippets.push({
      kind: "title",
      line: 0,
      text: doc.title,
      ranges: mergeRanges(titleRanges),
    });
  }
  snippets.push(...aliasSnippets);
  for (let i = 0; i < bodyLines.length && i < bodyCap; i++) {
    const bl = bodyLines[i]!;
    const win = windowAround(bl.text, bl.ranges, snippetMax);
    snippets.push({
      kind: "body",
      line: bl.line,
      text: win.text,
      ranges: win.ranges,
    });
  }

  if (snippets.length === 0) return null;

  return {
    pageId: doc.id,
    title: doc.title,
    aliases: [...doc.aliases],
    visibility: doc.visibility,
    path: doc.path,
    snippets,
    bodyMatchCount,
    score,
  };
}

// Slide a window of at most `maxChars` centred on the first range,
// then translate every original range into the windowed coordinate
// space (clipping any that fall outside).
function windowAround(
  line: string,
  ranges: Range[],
  maxChars: number,
): { text: string; ranges: Range[] } {
  if (line.length <= maxChars) {
    return { text: line, ranges };
  }
  const first = ranges[0]!;
  const matchLen = first.end - first.start;
  const lead = Math.max(20, Math.floor((maxChars - matchLen) / 2));
  let from = Math.max(0, first.start - lead);
  let to = Math.min(line.length, from + maxChars);
  from = Math.max(0, to - maxChars);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < line.length ? "…" : "";
  const text = prefix + line.slice(from, to) + suffix;
  const shift = prefix.length - from;
  const clipped: Range[] = [];
  for (const r of ranges) {
    if (r.end <= from || r.start >= to) continue;
    const s = Math.max(r.start, from) + shift;
    const e = Math.min(r.end, to) + shift;
    if (e > s) clipped.push({ start: s, end: e });
  }
  return { text, ranges: clipped };
}
