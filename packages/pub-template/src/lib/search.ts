// Editor-style search over an in-memory corpus.
//
// Behavior, mirroring what an editor would do:
//   - Split the query on whitespace; every term must match (AND).
//   - Match in title (high weight), aliases, headings (medium), body
//     (low). All comparisons are case-insensitive.
//   - For each matching page, surface up to a few body lines that
//     contain any term, with character offsets so the UI can
//     highlight them. The "context line" beats abstract snippets —
//     authors recognise their own writing when they see actual lines.
//
// Pure functions; no DOM. Wire into a page (or a future global modal)
// by calling `searchCorpus(corpus, query)`.

export type SearchDoc = {
  id: string;
  title: string;
  slug: string;
  aliases: string[];
  body: string;
};

export type SearchHit = {
  doc: SearchDoc;
  score: number;
  // Highlighted matches in title (offset ranges).
  titleMatches: Range[];
  // Up to `linesPerHit` matching body lines, each with its own
  // highlight ranges.
  lines: LineMatch[];
};

export type Range = { start: number; end: number };

export type LineMatch = {
  lineNumber: number; // 1-based
  text: string;
  ranges: Range[];
};

export type SearchOptions = {
  // Cap on body lines surfaced per doc. Default 3.
  linesPerHit?: number;
  // Cap on total results. Default 50.
  maxResults?: number;
};

function tokenize(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

// Find every (case-insensitive) occurrence of `term` in `text` and
// return [start, end) ranges.
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

// Merge overlapping/adjacent ranges so the highlighter never has to
// deal with conflicting spans.
function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]!;
    const cur = sorted[i]!;
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

export function searchCorpus(
  corpus: SearchDoc[],
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const linesPerHit = options.linesPerHit ?? 3;
  const maxResults = options.maxResults ?? 50;
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];

  for (const doc of corpus) {
    const titleMatches: Range[] = [];
    let titleHits = 0;
    for (const t of terms) {
      const matches = findAll(doc.title, t);
      if (matches.length > 0) titleHits++;
      titleMatches.push(...matches);
    }

    const aliasHits = doc.aliases.some((a) =>
      terms.every((t) => a.toLowerCase().includes(t.toLowerCase())),
    );

    // Body scan, line-by-line. Track which terms have matched anywhere
    // — every term has to land somewhere (title, alias, or body) for
    // the doc to qualify.
    const lines = doc.body.split("\n");
    const lineMatches: LineMatch[] = [];
    const termsHitInBody = new Set<string>();
    let headingTermHits = 0;

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const ranges: Range[] = [];
      for (const t of terms) {
        const r = findAll(text, t);
        if (r.length > 0) {
          termsHitInBody.add(t);
          ranges.push(...r);
          if (isHeadingLine(text)) headingTermHits++;
        }
      }
      if (ranges.length > 0) {
        lineMatches.push({
          lineNumber: i + 1,
          text,
          ranges: mergeRanges(ranges),
        });
      }
    }

    // Every term must be findable somewhere on the doc.
    const everyTermHit = terms.every(
      (t) =>
        termsHitInBody.has(t) ||
        doc.title.toLowerCase().includes(t.toLowerCase()) ||
        doc.aliases.some((a) => a.toLowerCase().includes(t.toLowerCase())),
    );
    if (!everyTermHit) continue;

    const score =
      titleHits * 100 +
      (aliasHits ? 50 : 0) +
      headingTermHits * 20 +
      lineMatches.length * 5;
    if (score === 0 && lineMatches.length === 0) continue;

    hits.push({
      doc,
      score,
      titleMatches: mergeRanges(titleMatches),
      lines: lineMatches.slice(0, linesPerHit),
    });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score || a.doc.title.localeCompare(b.doc.title),
  );
  return hits.slice(0, maxResults);
}

// Render a string as HTML with highlight ranges wrapped in <mark>.
// Ranges must be non-overlapping (use mergeRanges first).
export function highlight(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return escapeHtml(text);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue; // skip overlapping
    out += escapeHtml(text.slice(cursor, r.start));
    out += "<mark>" + escapeHtml(text.slice(r.start, r.end)) + "</mark>";
    cursor = r.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
