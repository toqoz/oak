// Render publishable pages to a static site under <vault>/public-site.
//
// Hard rules from the directive (§7):
//   - Render only `visibility === "public" || "unlisted"`.
//   - Block on private-leak / external-leak / unresolved embed.
//   - Assets are content-hashed; original filenames never appear in output.
//   - A manifest at .oak/publish-manifest.json drives stale cleanup.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { Graph, Issue, OakPage, Vault } from "./types.js";
import { partitionIssues } from "./validate.js";
import { renderPageDocument } from "./render.js";
import { extractAssetRefs } from "./assets.js";
import {
  homeViewModel,
  type HomeEntry,
  type HomeViewModel,
} from "./home.js";

const MANIFEST_REL = ".oak/publish-manifest.json";
const MANIFEST_SCHEMA = 1;
const PUBLISHABLE = new Set(["public", "unlisted"]);

export type PublishOptions = {
  outputDir?: string;
  baseUrl?: string;
  // If true, treat the run as a dry-run: nothing is written to disk.
  dryRun?: boolean;
};

export type PublishedPage = {
  pageId: string;
  title: string;
  slug: string;
  outputPath: string; // relative to outputDir
};

export type PublishedAsset = {
  vaultRelPath: string;
  hash: string;
  ext: string;
  outputPath: string; // relative to outputDir
};

export type PublishStats = {
  outputDir: string;
  manifestPath: string;
  baseUrl: string;
  pages: PublishedPage[];
  assets: PublishedAsset[];
  removedPages: string[]; // outputPaths
  removedAssets: string[]; // outputPaths
};

export type PublishManifest = {
  schemaVersion: number;
  generatedAt: string;
  vaultRoot: string;
  baseUrl: string;
  pages: Record<
    string,
    { slug: string; outputPath: string; title: string; contentHash: string }
  >;
  assets: Record<
    string,
    { hash: string; ext: string; outputPath: string }
  >;
};

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function joinUrl(base: string, ...parts: string[]): string {
  let prefix = base.endsWith("/") || base.length === 0 ? base : `${base}/`;
  for (const p of parts) {
    const trimmed = p.replace(/^\/+/, "");
    prefix = prefix.endsWith("/") ? `${prefix}${trimmed}` : `${prefix}/${trimmed}`;
  }
  return prefix;
}

function sanitizeBaseUrl(input: string | undefined): string {
  if (!input) return "/";
  let v = input;
  if (!v.endsWith("/")) v += "/";
  return v;
}

class PublishError extends Error {
  constructor(public issues: Issue[]) {
    super(`publish blocked by ${issues.length} validation error(s)`);
    this.name = "PublishError";
  }
}

export { PublishError };

function resolveAssetSource(
  page: OakPage,
  target: string,
  vaultRoot: string,
): string | null {
  // Strip URL fragment / query so the FS path lookup matches.
  const clean = target.split("#")[0]!.split("?")[0]!;
  if (clean.length === 0) return null;
  if (isAbsolute(clean)) return null; // refuse absolute filesystem paths
  let abs: string;
  if (clean.startsWith("/")) {
    abs = resolve(vaultRoot, `.${clean}`);
  } else if (clean.startsWith("_assets/") || clean.startsWith("./") || clean.includes("/")) {
    if (clean.startsWith("./") || clean.startsWith("../")) {
      abs = resolve(dirname(page.filePath), clean);
    } else {
      // Treat path with `/` as vault-rooted (e.g. `_assets/diagram.png`)
      abs = resolve(vaultRoot, clean);
    }
  } else {
    // Bare filename — try `_assets/` first, then page directory.
    abs = resolve(vaultRoot, "_assets", clean);
  }
  return abs;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function hashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  const h = createHash("sha256").update(buf).digest("hex");
  return h.slice(0, 16);
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function loadManifest(path: string): Promise<PublishManifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as PublishManifest;
    if (parsed.schemaVersion !== MANIFEST_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveManifest(
  path: string,
  manifest: PublishManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function removeIfExists(p: string): Promise<void> {
  await rm(p, { force: true, recursive: false }).catch(() => undefined);
}

async function removePageDir(outputDir: string, slug: string): Promise<void> {
  // Remove {slug}/index.html and the slug directory itself if empty.
  const pagePath = resolve(outputDir, slug, "index.html");
  await removeIfExists(pagePath);
  const dir = resolve(outputDir, slug);
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) {
      await rm(dir, { recursive: false }).catch(() => undefined);
    }
  } catch {
    // dir already gone
  }
}

export async function publish(
  vault: Vault,
  graph: Graph,
  issues: Issue[],
  options: PublishOptions = {},
): Promise<PublishStats> {
  const { errors } = partitionIssues(issues);
  if (errors.length > 0) {
    throw new PublishError(errors);
  }

  const baseUrl = sanitizeBaseUrl(options.baseUrl);
  const outputDir = resolve(
    options.outputDir ?? join(vault.rootPath, "public-site"),
  );
  const manifestPath = resolve(vault.rootPath, MANIFEST_REL);

  // Pick publishable pages and lock in their slugs.
  const publishable: OakPage[] = [];
  const seenSlugs = new Map<string, string>();
  for (const page of vault.pages.values()) {
    if (!PUBLISHABLE.has(page.visibility)) continue;
    const previous = seenSlugs.get(page.slug);
    if (previous) {
      throw new PublishError([
        {
          severity: "error",
          code: "slug-collision",
          message: `slug \`${page.slug}\` collides between pages \`${previous}\` and \`${page.id}\``,
        },
      ]);
    }
    seenSlugs.set(page.slug, page.id);
    publishable.push(page);
  }

  // Pre-resolve assets: hash + plan output paths.
  type PlannedAsset = {
    sourceAbs: string;
    vaultRelPath: string;
    hash: string;
    ext: string;
    outputPath: string;
  };
  const assetByTarget = new Map<string, PlannedAsset>(); // key: `<pageId>::<target>`
  const assetByVaultRel = new Map<string, PlannedAsset>(); // key: vault rel path

  for (const page of publishable) {
    const refs = extractAssetRefs(page.body);
    for (const ref of refs) {
      const sourceAbs = resolveAssetSource(page, ref.target, vault.rootPath);
      if (!sourceAbs) continue;
      if (!(await fileExists(sourceAbs))) {
        throw new PublishError([
          {
            severity: "error",
            code: "missing-asset",
            message: `Asset not found: ${ref.target} referenced from ${page.title} (line ${ref.line})`,
            pageId: page.id,
            filePath: page.filePath,
          },
        ]);
      }
      const vaultRel = toPosix(relative(vault.rootPath, sourceAbs));
      let plan = assetByVaultRel.get(vaultRel);
      if (!plan) {
        const hash = await hashFile(sourceAbs);
        const ext = extname(sourceAbs).slice(1).toLowerCase();
        plan = {
          sourceAbs,
          vaultRelPath: vaultRel,
          hash,
          ext,
          outputPath: ext ? `assets/${hash}.${ext}` : `assets/${hash}`,
        };
        assetByVaultRel.set(vaultRel, plan);
      }
      assetByTarget.set(`${page.id}::${ref.target}`, plan);
    }
  }

  // URL maps for renderer.
  const pageUrlById = new Map<string, string>();
  for (const page of publishable) {
    pageUrlById.set(page.id, joinUrl(baseUrl, page.slug, ""));
  }
  const ctx = {
    pageUrl: (pageId: string) => {
      const u = pageUrlById.get(pageId);
      if (u) return u;
      // Pages outside the publishable set should never be linked — leak
      // guards prevent this — so this branch is paranoid only.
      return joinUrl(baseUrl);
    },
    assetUrl: (target: string, page: OakPage) => {
      const plan = assetByTarget.get(`${page.id}::${target}`);
      if (!plan) return null;
      return joinUrl(baseUrl, plan.outputPath);
    },
  };

  // Render each page to HTML.
  type RenderedPage = {
    page: OakPage;
    html: string;
    contentHash: string;
    outputPath: string;
  };
  const rendered: RenderedPage[] = [];
  for (const page of publishable) {
    const html = renderPageDocument(page, vault.pages, graph, ctx);
    const outputPath = `${page.slug}/index.html`;
    rendered.push({
      page,
      html,
      contentHash: hashString(html),
      outputPath,
    });
  }

  // Build new manifest.
  const newManifest: PublishManifest = {
    schemaVersion: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    vaultRoot: vault.rootPath,
    baseUrl,
    pages: {},
    assets: {},
  };
  for (const r of rendered) {
    newManifest.pages[r.page.id] = {
      slug: r.page.slug,
      outputPath: r.outputPath,
      title: r.page.title,
      contentHash: r.contentHash,
    };
  }
  for (const plan of assetByVaultRel.values()) {
    newManifest.assets[plan.vaultRelPath] = {
      hash: plan.hash,
      ext: plan.ext,
      outputPath: plan.outputPath,
    };
  }

  // Compute stale page/asset paths from the prior manifest.
  const old = await loadManifest(manifestPath);
  const removedPages: string[] = [];
  const removedAssets: string[] = [];
  if (old) {
    for (const [pid, info] of Object.entries(old.pages)) {
      const next = newManifest.pages[pid];
      if (!next || next.outputPath !== info.outputPath) {
        removedPages.push(info.outputPath);
      }
    }
    for (const [vrel, info] of Object.entries(old.assets)) {
      const next = newManifest.assets[vrel];
      if (!next || next.outputPath !== info.outputPath) {
        removedAssets.push(info.outputPath);
      }
    }
  }

  if (options.dryRun) {
    return {
      outputDir,
      manifestPath,
      baseUrl,
      pages: rendered.map((r) => ({
        pageId: r.page.id,
        title: r.page.title,
        slug: r.page.slug,
        outputPath: r.outputPath,
      })),
      assets: [...assetByVaultRel.values()].map((a) => ({
        vaultRelPath: a.vaultRelPath,
        hash: a.hash,
        ext: a.ext,
        outputPath: a.outputPath,
      })),
      removedPages,
      removedAssets,
    };
  }

  // Write outputs.
  await mkdir(outputDir, { recursive: true });
  for (const r of rendered) {
    const abs = resolve(outputDir, r.outputPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, r.html, "utf8");
  }

  // Copy assets.
  for (const plan of assetByVaultRel.values()) {
    const abs = resolve(outputDir, plan.outputPath);
    await mkdir(dirname(abs), { recursive: true });
    const buf = await readFile(plan.sourceAbs);
    await writeFile(abs, buf);
  }

  // Generate graph.json (only resolved internal links between
  // publishable pages).
  const publishableIds = new Set(rendered.map((r) => r.page.id));
  const graphJson = {
    nodes: rendered.map((r) => ({
      id: r.page.id,
      title: r.page.title,
      slug: r.page.slug,
      url: pageUrlById.get(r.page.id),
    })),
    edges: rendered.flatMap((r) =>
      (graph.outgoing.get(r.page.id) ?? [])
        .filter((l) => l.resolution.status === "resolved")
        .filter((l) =>
          l.resolution.status === "resolved"
            ? publishableIds.has(l.resolution.targetId)
            : false,
        )
        .map((l) => ({
          from: r.page.id,
          to:
            l.resolution.status === "resolved" ? l.resolution.targetId : "",
          label: l.label ?? l.target,
        })),
    ),
  };
  await writeFile(
    resolve(outputDir, "graph.json"),
    JSON.stringify(graphJson, null, 2) + "\n",
    "utf8",
  );

  // Generate search-index.json (page metadata + plain body text).
  const searchIndex = rendered.map((r) => ({
    id: r.page.id,
    title: r.page.title,
    slug: r.page.slug,
    url: pageUrlById.get(r.page.id),
    body: stripWikiSyntax(r.page.body),
  }));
  await writeFile(
    resolve(outputDir, "search-index.json"),
    JSON.stringify(searchIndex) + "\n",
    "utf8",
  );

  // Generate index.html — the static-site home page. Mirrors what the
  // Obsidian home view shows so the two stay structurally consistent.
  const home = await homeViewModel(vault, graph, {
    visibilityFilter: ["public", "unlisted"],
  });
  const homeHtml = renderHomeDocument(home, baseUrl, pageUrlById);
  await writeFile(resolve(outputDir, "index.html"), homeHtml, "utf8");

  // Remove stale outputs.
  for (const slugPath of new Set(removedPages.map((p) => p.split("/")[0]!))) {
    await removePageDir(outputDir, slugPath);
  }
  for (const assetPath of removedAssets) {
    await removeIfExists(resolve(outputDir, assetPath));
  }

  await saveManifest(manifestPath, newManifest);

  return {
    outputDir,
    manifestPath,
    baseUrl,
    pages: rendered.map((r) => ({
      pageId: r.page.id,
      title: r.page.title,
      slug: r.page.slug,
      outputPath: r.outputPath,
    })),
    assets: [...assetByVaultRel.values()].map((a) => ({
      vaultRelPath: a.vaultRelPath,
      hash: a.hash,
      ext: a.ext,
      outputPath: a.outputPath,
    })),
    removedPages,
    removedAssets,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHomeEntryLi(
  entry: HomeEntry,
  pageUrlById: Map<string, string>,
): string {
  const url = pageUrlById.get(entry.id) ?? "";
  const meta: string[] = [];
  if (entry.updatedAt) {
    meta.push(`updated ${entry.updatedAt.slice(0, 10)}`);
  }
  if (entry.inboundCount > 0) meta.push(`${entry.inboundCount} backlinks`);
  const metaLine =
    meta.length > 0 ? `<div class="oak-meta">${escapeHtml(meta.join(" · "))}</div>` : "";
  const excerpt =
    entry.excerpt.length > 0
      ? `<p class="oak-excerpt">${escapeHtml(entry.excerpt)}</p>`
      : "";
  return `<li>
  <a href="${escapeHtml(url)}">${escapeHtml(entry.title)}</a>
  ${metaLine}
  ${excerpt}
</li>`;
}

function renderHomeDocument(
  home: HomeViewModel,
  baseUrl: string,
  pageUrlById: Map<string, string>,
): string {
  const recentList =
    home.recent.length > 0
      ? `<section>
  <h2>Recent updates</h2>
  <ul class="oak-list">
${home.recent.map((e) => renderHomeEntryLi(e, pageUrlById)).join("\n")}
  </ul>
</section>`
      : "";
  const allList = `<section>
  <h2>All pages (${home.pages.length})</h2>
  <ul class="oak-list">
${home.pages.map((e) => renderHomeEntryLi(e, pageUrlById)).join("\n")}
  </ul>
</section>`;
  const stats = home.stats;
  const statsLine = `${stats.public} public · ${stats.unlisted} unlisted`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Index</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; line-height: 1.5; color: #222; }
  h1 { margin-bottom: 0.2em; }
  .oak-stats { color: #666; font-size: 0.9em; margin-bottom: 1.5em; }
  .oak-list { list-style: none; padding: 0; }
  .oak-list li { margin: 0.8em 0; }
  .oak-list a { font-weight: 500; text-decoration: none; color: #1a4f8a; }
  .oak-list a:hover { text-decoration: underline; }
  .oak-meta { font-size: 0.8em; color: #888; margin-top: 0.1em; }
  .oak-excerpt { margin: 0.2em 0 0; color: #444; font-size: 0.95em; white-space: pre-line; }
  footer { margin-top: 3em; font-size: 0.8em; color: #999; }
  footer a { color: inherit; }
</style>
</head>
<body>
<h1><a href="${escapeHtml(baseUrl)}">Index</a></h1>
<p class="oak-stats">${escapeHtml(statsLine)}</p>
${recentList}
${allList}
<footer>generated ${escapeHtml(home.generatedAt)} · <a href="graph.json">graph.json</a> · <a href="search-index.json">search-index.json</a></footer>
</body>
</html>
`;
}

function stripWikiSyntax(body: string): string {
  return body
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf("|");
      const text = pipe === -1 ? inner : inner.slice(pipe + 1);
      return text.split("#")[0]!.trim();
    })
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}
