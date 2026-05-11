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
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { extractAssetRefs } from "./assets.js";

export type AssetWritten = {
  vaultRelPath: string;
  outputAbsPath: string;
  url: string;
  // When optimize is on and `sharp` is available, an optimizable image
  // gets one or more WebP variants written alongside the original. The
  // primary URL above points at the largest variant; `variants` lists
  // every (url, width) pair so the body can emit a proper srcset.
  variants?: Array<{ url: string; width: number }>;
};

export type ProcessedAssets = {
  body: string;
  written: AssetWritten[];
  missing: Array<{ target: string; line: number }>;
  optimized: number; // count of assets that produced WebP variants
};

export type ProcessOptions = {
  // Generate responsive WebP variants for png/jpg/jpeg assets and emit
  // body images as raw <img srcset> HTML. Requires `sharp` to be
  // resolvable from `resolveSharpFrom` (or process.cwd() by default).
  // Defaults to false: assets are just copied as-is.
  optimize?: boolean;
  // Variant widths to generate, in pixels. Sizes that exceed the
  // original image's width are dropped. The original width is always
  // included as the largest variant. Defaults to [400, 800].
  widths?: number[];
  // WebP quality 1–100. Defaults to 80, the sharp default.
  quality?: number;
  // Directory containing the consumer's package.json — sharp is
  // resolved relative to it. Defaults to process.cwd(), which is the
  // Astro project root in a typical `astro build`.
  resolveSharpFrom?: string;
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

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const OPTIMIZABLE_EXTS = new Set(["png", "jpg", "jpeg"]);

// Resolve sharp lazily so that when optimization is off, consumers
// without sharp installed still work. We use Node's createRequire +
// synchronous require() rather than dynamic `import()`, because Astro
// runs custom loaders inside Vite's module runner, and a dynamic
// import there fails partway through the build with
// "Vite module runner has been closed". The CJS require path bypasses
// Vite entirely.
//
// resolveFromDir picks the resolution context: the consumer's project
// root, since under pnpm sharp lives in the consumer's deps tree but
// not in @oak/core's.
const SHARP_MODULE = "sharp";
const _sharpCache = new Map<string, ((p: string) => unknown) | null>();

function loadSharp(resolveFromDir: string): ((p: string) => unknown) | null {
  if (_sharpCache.has(resolveFromDir)) {
    return _sharpCache.get(resolveFromDir) ?? null;
  }
  let result: ((p: string) => unknown) | null = null;
  try {
    const requireFn = createRequire(resolve(resolveFromDir, "package.json"));
    const mod = requireFn(SHARP_MODULE) as
      | ((p: string) => unknown)
      | { default: (p: string) => unknown };
    result =
      typeof mod === "function"
        ? mod
        : (mod as { default: (p: string) => unknown }).default;
  } catch {
    result = null;
  }
  _sharpCache.set(resolveFromDir, result);
  return result;
}

type SharpInstance = {
  metadata: () => Promise<{ width?: number; height?: number }>;
  clone: () => SharpInstance;
  resize: (opts: { width: number }) => SharpInstance;
  webp: (opts: { quality: number }) => SharpInstance;
  toFile: (p: string) => Promise<unknown>;
};

async function generateWebpVariants(
  sourceAbs: string,
  outDir: string,
  hash: string,
  widths: number[],
  quality: number,
  resolveSharpFrom: string,
): Promise<Array<{ url: string; width: number; outputAbsPath: string }>> {
  const sharp = loadSharp(resolveSharpFrom);
  if (!sharp) return [];
  const img = sharp(sourceAbs) as SharpInstance;
  const meta = await img.metadata();
  const originalWidth = meta.width ?? 0;
  if (originalWidth === 0) return [];

  // Variant widths: the requested widths capped at original, plus the
  // original width itself. Dedup, sort ascending.
  const targets = [...new Set(
    [...widths.filter((w) => w < originalWidth), originalWidth].sort(
      (a, b) => a - b,
    ),
  )];

  const out: Array<{ url: string; width: number; outputAbsPath: string }> = [];
  for (const w of targets) {
    const filename = `${hash}-${w}w.webp`;
    const outputAbs = resolve(outDir, filename);
    await mkdir(dirname(outputAbs), { recursive: true });
    if (!(await fileExists(outputAbs))) {
      await img.clone().resize({ width: w }).webp({ quality }).toFile(outputAbs);
    }
    out.push({ url: filename, width: w, outputAbsPath: outputAbs });
  }
  return out;
}

function isOptimizableExt(ext: string): boolean {
  return OPTIMIZABLE_EXTS.has(ext);
}

function emitImgHtml(
  alt: string,
  primary: { url: string; width: number },
  variants: Array<{ url: string; width: number }>,
): string {
  const altAttr = escapeHtmlAttr(alt);
  if (variants.length <= 1) {
    return `<img alt="${altAttr}" src="${primary.url}" loading="lazy" decoding="async">`;
  }
  const srcset = variants
    .map((v) => `${v.url} ${v.width}w`)
    .join(", ");
  const sizes = `(max-width: ${primary.width}px) 100vw, ${primary.width}px`;
  return `<img alt="${altAttr}" src="${primary.url}" srcset="${srcset}" sizes="${sizes}" loading="lazy" decoding="async">`;
}

type ResolvedAsset = {
  primaryUrl: string;
  // For optimized images, additional WebP widths the body can put in
  // a srcset. Always includes primaryUrl as one of the variants.
  variants: Array<{ url: string; width: number }>;
  primaryWidth: number;
};

export async function processBodyAssets(
  body: string,
  pageFilePath: string,
  vaultRoot: string,
  assetOutDir: string,
  assetUrlPrefix: string,
  options: ProcessOptions = {},
): Promise<ProcessedAssets> {
  const refs = extractAssetRefs(body);
  if (refs.length === 0) {
    return { body, written: [], missing: [], optimized: 0 };
  }

  const optimize = options.optimize ?? false;
  const widths = options.widths ?? [400, 800];
  const quality = options.quality ?? 80;
  const resolveSharpFrom = options.resolveSharpFrom ?? process.cwd();

  const sourceToResolved = new Map<string, ResolvedAsset>();
  const written: AssetWritten[] = [];
  const missing: ProcessedAssets["missing"] = [];
  let optimized = 0;
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

    let resolved = sourceToResolved.get(sourceAbs);
    if (!resolved) {
      const hash = await hashFileShort(sourceAbs);
      const ext = extname(sourceAbs).slice(1).toLowerCase();
      const filename = ext ? `${hash}.${ext}` : hash;
      const outputAbs = resolve(assetOutDir, filename);
      await mkdir(dirname(outputAbs), { recursive: true });
      if (!(await fileExists(outputAbs))) {
        await copyFile(sourceAbs, outputAbs);
      }
      const primaryUrl = `${prefix}/${filename}`;
      const writtenEntry: AssetWritten = {
        vaultRelPath: relative(vaultRoot, sourceAbs),
        outputAbsPath: outputAbs,
        url: primaryUrl,
      };

      let variants: Array<{ url: string; width: number }> = [];
      let primaryWidth = 0;

      if (optimize && isOptimizableExt(ext)) {
        const generated = await generateWebpVariants(
          sourceAbs,
          assetOutDir,
          hash,
          widths,
          quality,
          resolveSharpFrom,
        );
        if (generated.length > 0) {
          variants = generated.map((g) => ({
            url: `${prefix}/${g.url}`,
            width: g.width,
          }));
          // The largest variant is the primary src.
          const largest = generated[generated.length - 1]!;
          writtenEntry.variants = variants;
          primaryWidth = largest.width;
          optimized++;
        }
      }

      resolved = {
        primaryUrl: variants.length > 0 ? variants[variants.length - 1]!.url : primaryUrl,
        variants,
        primaryWidth,
      };
      sourceToResolved.set(sourceAbs, resolved);
      written.push(writtenEntry);
    }

    const alt = ref.alt ?? "";
    let replacementText: string;
    if (resolved.variants.length > 0) {
      // Optimized image → emit raw HTML with srcset/sizes.
      replacementText = emitImgHtml(
        alt,
        { url: resolved.primaryUrl, width: resolved.primaryWidth },
        resolved.variants,
      );
    } else {
      replacementText = `![${escapeMarkdownAlt(alt)}](${resolved.primaryUrl})`;
    }
    replacements.push({
      start: ref.start,
      end: ref.end,
      text: replacementText,
    });
  }

  // Apply back-to-front so original indices stay valid.
  replacements.sort((a, b) => b.start - a.start);
  let rewritten = body;
  for (const r of replacements) {
    rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
  }

  return { body: rewritten, written, missing, optimized };
}
