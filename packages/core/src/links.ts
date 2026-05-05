// Extract link references from Markdown body text.
//
// Recognized syntaxes:
//   - Wiki links:        [[Page]], [[Page|Label]], [[Page#Heading]]
//   - Wiki embeds:       ![[Page]] (treated as a link with isEmbed=true)
//   - Markdown links:    [Label](path) where path looks like a vault page
//
// Code spans and fenced code blocks are skipped so links inside `code`
// or ```fenced``` blocks are not extracted.

import type { RawLink } from "./types.js";

const FENCE_RE = /^(?:`{3,}|~{3,})/;

type Mask = boolean[]; // mask[i] = true means index i is inside code

function buildCodeMask(body: string): Mask {
  const mask: Mask = new Array(body.length).fill(false);
  const lines = body.split("\n");

  let inFence = false;
  let cursor = 0;
  for (const line of lines) {
    const lineEnd = cursor + line.length;
    if (FENCE_RE.test(line.trimStart())) {
      // Mark the fence line itself as code
      for (let i = cursor; i < lineEnd; i++) mask[i] = true;
      inFence = !inFence;
    } else if (inFence) {
      for (let i = cursor; i < lineEnd; i++) mask[i] = true;
    } else {
      // Inline code spans on this line
      maskInlineCode(line, cursor, mask);
    }
    cursor = lineEnd + 1; // account for \n
  }
  return mask;
}

function maskInlineCode(line: string, base: number, mask: Mask): void {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      // Count backticks to support `` ` `` form.
      let tickCount = 0;
      while (i + tickCount < line.length && line[i + tickCount] === "`") {
        tickCount++;
      }
      const closing = "`".repeat(tickCount);
      const start = i;
      const searchFrom = i + tickCount;
      const end = line.indexOf(closing, searchFrom);
      if (end === -1) {
        // No closing run; treat opening ticks as literal.
        i = start + tickCount;
        continue;
      }
      const stop = end + tickCount;
      for (let j = start; j < stop; j++) mask[base + j] = true;
      i = stop;
    } else {
      i++;
    }
  }
}

function lineNumberOf(body: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < body.length; i++) {
    if (body[i] === "\n") line++;
  }
  return line;
}

function rangeIsClean(mask: Mask, start: number, end: number): boolean {
  for (let i = start; i < end && i < mask.length; i++) {
    if (mask[i]) return false;
  }
  return true;
}

const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g;
const MD_RE = /(?<!\!)\[([^\]\n]+)\]\(([^)\s]+)\)/g;

const EXTERNAL_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i;

function looksLikePageLink(target: string): boolean {
  if (EXTERNAL_URL_RE.test(target)) return false;
  if (target.startsWith("#")) return false; // pure heading
  // strip query/fragment
  const clean = target.split("#")[0]!.split("?")[0]!;
  // Treat as page link if it ends in .md or has no extension and no leading dot besides ./
  if (clean.endsWith(".md")) return true;
  return false;
}

export function extractLinks(body: string): RawLink[] {
  const mask = buildCodeMask(body);
  const out: RawLink[] = [];

  // Wikilinks
  for (const match of body.matchAll(WIKI_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!rangeIsClean(mask, start, end)) continue;

    const isEmbed = match[1] === "!";
    const inner = match[2]!.trim();
    if (inner.length === 0) continue;

    let target = inner;
    let label: string | undefined;
    let heading: string | undefined;

    const pipeIdx = target.indexOf("|");
    if (pipeIdx !== -1) {
      label = target.slice(pipeIdx + 1).trim();
      target = target.slice(0, pipeIdx).trim();
    }

    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) {
      heading = target.slice(hashIdx + 1).trim() || undefined;
      target = target.slice(0, hashIdx).trim();
    }

    if (target.length === 0) continue;

    out.push({
      syntax: "wiki",
      raw: match[0],
      target,
      label,
      heading,
      isEmbed,
      start,
      end,
      line: lineNumberOf(body, start),
    });
  }

  // Markdown links to local pages
  for (const match of body.matchAll(MD_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!rangeIsClean(mask, start, end)) continue;

    const label = match[1]!.trim();
    const url = match[2]!.trim();
    if (!looksLikePageLink(url)) continue;

    let target = url;
    let heading: string | undefined;
    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) {
      heading = target.slice(hashIdx + 1).trim() || undefined;
      target = target.slice(0, hashIdx);
    }

    out.push({
      syntax: "markdown",
      raw: match[0],
      target,
      label: label.length > 0 ? label : undefined,
      heading,
      isEmbed: false,
      start,
      end,
      line: lineNumberOf(body, start),
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
