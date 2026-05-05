// Discover asset references (images and `![[file.ext]]` embeds) in
// page bodies. Asset refs are distinct from extractLinks output:
// extractLinks tracks page-shaped wiki/markdown references, whereas
// this module finds binary/static-file references that the publisher
// needs to copy and content-hash.

import type { OakPage, RawLink } from "./types.js";
import { extractLinks } from "./links.js";

export const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "pdf",
  "mp4",
  "webm",
  "mp3",
  "ogg",
  "wav",
]);

export type AssetRef = {
  syntax: "wiki-embed" | "markdown-image";
  raw: string;
  target: string;
  alt: string | undefined;
  start: number;
  end: number;
  line: number;
};

const MD_IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function extOf(target: string): string {
  const clean = target.split("#")[0]!.split("?")[0]!;
  const dot = clean.lastIndexOf(".");
  if (dot === -1) return "";
  return clean.slice(dot + 1).toLowerCase();
}

export function isAssetTarget(target: string): boolean {
  return ASSET_EXTENSIONS.has(extOf(target));
}

function lineNumberOf(body: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < body.length; i++) {
    if (body[i] === "\n") line++;
  }
  return line;
}

// Match the same masking logic used by extractLinks: skip code spans
// and fenced blocks. We piggyback on extractLinks (which returns wiki
// embeds) for the wiki side, and reimplement the inline-code mask only
// for the markdown image scan.
const FENCE_RE = /^(?:`{3,}|~{3,})/;

function buildCodeMask(body: string): boolean[] {
  const mask = new Array<boolean>(body.length).fill(false);
  const lines = body.split("\n");
  let inFence = false;
  let cursor = 0;
  for (const line of lines) {
    const lineEnd = cursor + line.length;
    if (FENCE_RE.test(line.trimStart())) {
      for (let i = cursor; i < lineEnd; i++) mask[i] = true;
      inFence = !inFence;
    } else if (inFence) {
      for (let i = cursor; i < lineEnd; i++) mask[i] = true;
    } else {
      maskInlineCode(line, cursor, mask);
    }
    cursor = lineEnd + 1;
  }
  return mask;
}

function maskInlineCode(line: string, base: number, mask: boolean[]): void {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let tickCount = 0;
      while (i + tickCount < line.length && line[i + tickCount] === "`") {
        tickCount++;
      }
      const closing = "`".repeat(tickCount);
      const start = i;
      const searchFrom = i + tickCount;
      const end = line.indexOf(closing, searchFrom);
      if (end === -1) {
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

function rangeIsClean(mask: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end && i < mask.length; i++) {
    if (mask[i]) return false;
  }
  return true;
}

const EXTERNAL_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function extractAssetRefs(body: string): AssetRef[] {
  const out: AssetRef[] = [];
  const mask = buildCodeMask(body);

  // Wiki-style asset embeds are a subset of extractLinks output: embeds
  // whose target ends in a known asset extension.
  for (const link of extractLinks(body)) {
    if (!link.isEmbed) continue;
    if (!isAssetTarget(link.target)) continue;
    out.push({
      syntax: "wiki-embed",
      raw: link.raw,
      target: link.target,
      alt: link.label,
      start: link.start,
      end: link.end,
      line: link.line,
    });
  }

  // Standard markdown images: `![alt](path)`. Skip external URLs since
  // they don't need copying.
  for (const match of body.matchAll(MD_IMG_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!rangeIsClean(mask, start, end)) continue;

    const alt = match[1] ?? "";
    const target = match[2]!.trim();
    if (target.length === 0) continue;
    if (EXTERNAL_URL_RE.test(target)) continue;

    out.push({
      syntax: "markdown-image",
      raw: match[0],
      target,
      alt: alt.length > 0 ? alt : undefined,
      start,
      end,
      line: lineNumberOf(body, start),
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

export function pageEmbedRefs(page: OakPage): RawLink[] {
  return page.links.filter((l) => l.isEmbed && !isAssetTarget(l.target));
}
