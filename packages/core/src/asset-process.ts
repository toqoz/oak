// Copy referenced assets out of the vault into a public-served
// directory and rewrite the markdown body so URLs point at the new
// location.
//
// This exists because Astro 5's Content Layer doesn't (yet?) auto-
// process body images for custom loaders the way it does for the
// built-in glob loader. Without this step, an `![alt](./img.png)`
// reference in a vault page survives into rendered HTML as a relative
// URL that resolves to nothing in dist/.
//
// What we do:
//   1. Walk the body for asset references (both `![[diagram.png]]`
//      and `![alt](./img.png)`) using extractAssetRefs.
//   2. Resolve each to an absolute filesystem path using oak's
//      conventions (vault-rooted paths, _assets/, page-relative).
//   3. Hash the file content (sha256, first 16 chars) and copy to
//      <assetOutDir>/<hash>.<ext>. Same content → same hash → reused.
//   4. Replace each reference in the body with `![alt](<urlPrefix>/<hash>.<ext>)`.
//
// What we don't do (yet):
//   - WebP/AVIF transcoding, srcset generation, responsive sizing.
//     Once Astro lets custom loaders register asset imports cleanly,
//     this module can defer to that pipeline instead.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { extractAssetRefs } from "./assets.js";

export type AssetWritten = {
  vaultRelPath: string;
  outputAbsPath: string;
  url: string;
};

export type ProcessedAssets = {
  body: string;
  written: AssetWritten[];
  missing: Array<{ target: string; line: number }>;
};

// Resolve an asset target string against a page's location.
//
// Conventions, in order of precedence:
//   - explicit `./` / `../` → relative to the page's directory
//   - any `/` in the target  → vault-rooted
//   - bare filename          → vault-rooted `_assets/<name>`
//
// Strips fragments and query strings before resolution. Refuses
// absolute filesystem paths so vault content can't reach outside.
export function resolveAssetSource(
  pageFilePath: string,
  target: string,
  vaultRoot: string,
): string | null {
  const clean = target.split("#")[0]!.split("?")[0]!;
  if (clean.length === 0) return null;
  if (isAbsolute(clean)) return null;
  if (clean.startsWith("./") || clean.startsWith("../")) {
    return resolve(dirname(pageFilePath), clean);
  }
  if (clean.includes("/")) {
    return resolve(vaultRoot, clean);
  }
  return resolve(vaultRoot, "_assets", clean);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function hashFileShort(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function escapeMarkdownAlt(s: string): string {
  // Square brackets terminate the alt text early, so escape them. Pipe
  // and parens are fine inside `![…](…)`.
  return s.replace(/[\[\]]/g, "\\$&");
}

export async function processBodyAssets(
  body: string,
  pageFilePath: string,
  vaultRoot: string,
  assetOutDir: string,
  assetUrlPrefix: string,
): Promise<ProcessedAssets> {
  const refs = extractAssetRefs(body);
  if (refs.length === 0) return { body, written: [], missing: [] };

  const sourceToUrl = new Map<string, string>();
  const written: AssetWritten[] = [];
  const missing: ProcessedAssets["missing"] = [];
  type Replacement = { start: number; end: number; text: string };
  const replacements: Replacement[] = [];

  // Trim trailing slashes off the prefix so we can join with `/` cleanly.
  const prefix = assetUrlPrefix.replace(/\/+$/, "");

  for (const ref of refs) {
    const sourceAbs = resolveAssetSource(pageFilePath, ref.target, vaultRoot);
    if (!sourceAbs || !(await fileExists(sourceAbs))) {
      missing.push({ target: ref.target, line: ref.line });
      continue;
    }
    let url = sourceToUrl.get(sourceAbs);
    if (!url) {
      const hash = await hashFileShort(sourceAbs);
      const ext = extname(sourceAbs).slice(1).toLowerCase();
      const filename = ext ? `${hash}.${ext}` : hash;
      const outputAbs = resolve(assetOutDir, filename);
      await mkdir(dirname(outputAbs), { recursive: true });
      // Same hash → same content. Skip the copy if the file is already
      // there (cheap dedupe across pages and across reloads).
      if (!(await fileExists(outputAbs))) {
        await copyFile(sourceAbs, outputAbs);
      }
      url = `${prefix}/${filename}`;
      sourceToUrl.set(sourceAbs, url);
      written.push({
        vaultRelPath: relative(vaultRoot, sourceAbs),
        outputAbsPath: outputAbs,
        url,
      });
    }
    const alt = ref.alt ?? "";
    replacements.push({
      start: ref.start,
      end: ref.end,
      text: `![${escapeMarkdownAlt(alt)}](${url})`,
    });
  }

  // Apply back-to-front so original indices stay valid.
  replacements.sort((a, b) => b.start - a.start);
  let rewritten = body;
  for (const r of replacements) {
    rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
  }

  return { body: rewritten, written, missing };
}
