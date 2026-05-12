// Parse oak vault files into typed data structures.

import { readFile, readdir, stat, lstat, realpath } from "node:fs/promises";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";

import { newId } from "./id.js";
import type {
  ExternalDocument,
  Issue,
  Mount,
  OakPage,
  PageFrontmatter,
  Vault,
  Visibility,
} from "./types.js";
import { extractLinks } from "./links.js";
import {
  extractFirstH1,
  normalizeKey,
  plainTextTitle,
  slugify,
} from "./slug.js";
import { coerceTimestamp } from "./timestamps.js";

const SYSTEM_DIRS = new Set([
  "_assets",
  "_external",
  ".oak",
  ".obsidian",
  ".git",
  "node_modules",
  "public-site",
]);

// Top-level filenames the indexer treats as out-of-band even though
// they sit in the vault root. `scratch.md` is the emacs-style scratch
// buffer surfaced by the Obsidian plugin — it lives at the root so
// Obsidian's editor can open it (the abstract file tree skips
// dotfile dirs), but it's a transient surface that must not appear
// in graph, search, validation, or publish.
const SYSTEM_ROOT_FILES = new Set(["scratch.md"]);

const VALID_VISIBILITIES: ReadonlySet<Visibility> = new Set([
  "private",
  "unlisted",
  "public",
]);

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function basenameNoExt(filePath: string): string {
  const base = filePath.split(sep).pop()!;
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

// True iff the page has the structural prerequisites for oak to manage
// it — namely, an `id` in its frontmatter. Files that lack one are
// surfaced via the home view's "Unmanaged" section so the user can
// import them; until then they're excluded from search, the SQLite
// index, and link resolution lookup tables (an `unidentified:<path>`
// id is meaningless as a backlink target).
export function isManagedPage(page: OakPage): boolean {
  for (const issue of page.parseIssues) {
    if (issue.code === "missing-id") return false;
  }
  return true;
}

function coerceAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function parsePage(
  filePath: string,
  rootPath: string,
): Promise<OakPage> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as PageFrontmatter;
  const body = parsed.content;
  const issues: Issue[] = [];

  const relPathPosix = toPosix(relative(rootPath, filePath));
  const basename = basenameNoExt(filePath);

  // Title — sourced from the first ATX `# ...` heading in the body.
  // Falls back to the filename basename so the rest of the pipeline can
  // still run; the missing heading is surfaced as an error.
  let title: string;
  const h1 = extractFirstH1(body);
  if (h1) {
    title = h1.raw;
  } else {
    title = basename;
    issues.push({
      severity: "error",
      code: "missing-title",
      message: `Page is missing a top-level \`# Title\` heading`,
      filePath,
    });
  }
  const titlePlain = plainTextTitle(title);

  // ID
  let id: string;
  if (typeof fm.id === "string" && fm.id.trim().length > 0) {
    id = fm.id.trim();
  } else {
    // Synthesize a stable-ish id from path so the rest of the pipeline can run,
    // but flag as an error so validation fails.
    id = `unidentified:${relPathPosix}`;
    issues.push({
      severity: "error",
      code: "missing-id",
      message: `Page is missing required \`id\` frontmatter`,
      filePath,
    });
  }

  // Visibility
  let visibility: Visibility = "private";
  if (typeof fm.visibility === "string") {
    if (VALID_VISIBILITIES.has(fm.visibility as Visibility)) {
      visibility = fm.visibility as Visibility;
    } else {
      issues.push({
        severity: "error",
        code: "invalid-visibility",
        message: `Invalid visibility: ${JSON.stringify(fm.visibility)}`,
        filePath,
      });
    }
  } else if (fm.visibility !== undefined) {
    issues.push({
      severity: "error",
      code: "invalid-visibility",
      message: `\`visibility\` must be a string`,
      filePath,
    });
  }

  const aliases = coerceAliases(fm.aliases);

  let slug: string;
  if (typeof fm.slug === "string" && fm.slug.trim().length > 0) {
    slug = fm.slug.trim();
  } else {
    slug = slugify(titlePlain);
  }

  const links = extractLinks(body);

  const created = coerceTimestamp((fm as Record<string, unknown>)["created"]);
  const modified = coerceTimestamp(
    (fm as Record<string, unknown>)["modified"],
  );

  const feed = (fm as Record<string, unknown>)["feed"] === true;

  return {
    type: "page",
    id,
    title,
    titlePlain,
    aliases,
    visibility,
    slug,
    filePath,
    relPath: relPathPosix,
    basename,
    body,
    rawFrontmatter: fm,
    created,
    modified,
    feed,
    links,
    parseIssues: issues,
  };
}

async function* walkMarkdown(
  dir: string,
  rootPath: string,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      // Skip dotfiles/dirs except .oak which is system-handled separately.
      // We do not parse .obsidian or .git contents.
      continue;
    }
    const full = join(dir, entry.name);
    const relFromRoot = relative(rootPath, full);
    const topLevel = relFromRoot.split(sep)[0]!;
    if (entry.isDirectory()) {
      if (SYSTEM_DIRS.has(entry.name) && full !== rootPath) continue;
      // Also skip nested system-named dirs at root only
      if (SYSTEM_DIRS.has(topLevel)) continue;
      yield* walkMarkdown(full, rootPath);
    } else if (entry.isFile()) {
      if (SYSTEM_DIRS.has(topLevel)) continue;
      // Root-level system files (e.g. scratch.md) are excluded from
      // the indexed surface even though they sit alongside real pages.
      if (dir === rootPath && SYSTEM_ROOT_FILES.has(entry.name)) continue;
      if (extname(entry.name).toLowerCase() === ".md") {
        yield full;
      }
    }
  }
}

type LoadedMounts = {
  mounts: Map<string, Mount>;
  issues: Issue[];
};

async function loadMounts(rootPath: string): Promise<LoadedMounts> {
  const mounts = new Map<string, Mount>();
  const issues: Issue[] = [];
  const configPath = join(rootPath, ".oak", "mounts.local.yml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return { mounts, issues };
  }
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch (err) {
    issues.push({
      severity: "error",
      code: "mount-config-parse",
      message: `Failed to parse mounts.local.yml: ${(err as Error).message}`,
      filePath: configPath,
    });
    return { mounts, issues };
  }

  if (!data || typeof data !== "object") return { mounts, issues };
  const root = data as Record<string, unknown>;
  const list = root["mounts"];
  if (!list || typeof list !== "object") return { mounts, issues };

  for (const [id, value] of Object.entries(list as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const targetPath = typeof v["targetPath"] === "string" ? v["targetPath"] : "";
    const linkPath =
      typeof v["linkPath"] === "string"
        ? v["linkPath"]
        : `_external/${id}`;
    const mode = v["mode"] === "readwrite" ? "readwrite" : "readonly";
    const gitPolicy =
      v["gitPolicy"] === "ignore" ? "ignore" : "status-only";

    if (!targetPath) {
      issues.push({
        severity: "error",
        code: "mount-missing-target",
        message: `Mount \`${id}\` is missing targetPath`,
        filePath: configPath,
      });
      continue;
    }

    const absLink = resolve(rootPath, linkPath);
    let exists = false;
    try {
      await stat(absLink); // follows symlinks; if link points nowhere this throws
      exists = true;
    } catch {
      exists = false;
    }

    mounts.set(id, {
      id,
      targetPath,
      linkPath,
      mode,
      publishable: false,
      gitPolicy,
      exists,
    });

    if (!exists) {
      issues.push({
        severity: "error",
        code: "broken-mount",
        message: `Mount \`${id}\` link path is missing or broken: ${linkPath}`,
        filePath: configPath,
      });
    }
  }

  return { mounts, issues };
}

async function discoverExternals(
  rootPath: string,
  mounts: Map<string, Mount>,
): Promise<ExternalDocument[]> {
  const out: ExternalDocument[] = [];
  for (const mount of mounts.values()) {
    if (!mount.exists) continue;
    const linkAbs = resolve(rootPath, mount.linkPath);
    let realRoot: string;
    try {
      realRoot = await realpath(linkAbs);
    } catch {
      continue;
    }
    for await (const file of walkAll(realRoot)) {
      const rel = toPosix(relative(realRoot, file));
      const vaultRel = `${toPosix(mount.linkPath)}/${rel}`;
      out.push({
        type: "external",
        id: `external:${mount.id}:${rel}`,
        mountId: mount.id,
        relPath: rel,
        vaultRelPath: vaultRel,
        title: rel,
        publishable: false,
      });
    }
  }
  return out;
}

async function* walkAll(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAll(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function recordConflict(
  map: Map<string, string[]>,
  key: string,
  pageId: string,
): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(pageId)) list.push(pageId);
  } else {
    map.set(key, [pageId]);
  }
}

export async function parseVault(rootPath: string): Promise<Vault> {
  const absRoot = resolve(rootPath);
  const issues: Issue[] = [];

  // Confirm root exists and is a directory.
  try {
    const s = await lstat(absRoot);
    if (!s.isDirectory()) {
      issues.push({
        severity: "error",
        code: "vault-not-directory",
        message: `Vault root is not a directory: ${absRoot}`,
      });
    }
  } catch (err) {
    issues.push({
      severity: "error",
      code: "vault-missing",
      message: `Vault root does not exist: ${absRoot} (${(err as Error).message})`,
    });
  }

  const pages = new Map<string, OakPage>();

  for await (const file of walkMarkdown(absRoot, absRoot)) {
    try {
      const page = await parsePage(file, absRoot);
      // Detect duplicate IDs: synthesize a unique id if collided so we don't
      // silently drop pages, and surface the conflict via vault-level issues.
      if (pages.has(page.id)) {
        const existing = pages.get(page.id)!;
        issues.push({
          severity: "error",
          code: "duplicate-id",
          message: `Duplicate id \`${page.id}\` in ${page.relPath} (also ${existing.relPath})`,
          filePath: file,
        });
        const reassigned = `${page.id}#${newId()}`;
        pages.set(reassigned, { ...page, id: reassigned });
      } else {
        pages.set(page.id, page);
      }
    } catch (err) {
      issues.push({
        severity: "error",
        code: "page-parse-failed",
        message: `Failed to parse ${file}: ${(err as Error).message}`,
        filePath: file,
      });
    }
  }

  // Lookup tables
  const byTitle = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const byBasename = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const byVaultRelPath = new Map<string, string>();

  const titleConflicts = new Map<string, string[]>();
  const aliasConflicts = new Map<string, string[]>();
  const slugConflicts = new Map<string, string[]>();
  const basenameConflicts = new Map<string, string[]>();

  for (const page of pages.values()) {
    // Unmanaged pages (no `id` in frontmatter) get a synthesised
    // `unidentified:<path>` id that is useless as a link target, so
    // skip the lookup tables entirely. The page stays in `pages` so
    // the home view can surface it for import.
    if (!isManagedPage(page)) continue;

    const tk = normalizeKey(page.titlePlain);
    if (byTitle.has(tk) && byTitle.get(tk) !== page.id) {
      recordConflict(titleConflicts, tk, byTitle.get(tk)!);
      recordConflict(titleConflicts, tk, page.id);
    } else {
      byTitle.set(tk, page.id);
    }

    const bk = normalizeKey(page.basename);
    if (byBasename.has(bk) && byBasename.get(bk) !== page.id) {
      recordConflict(basenameConflicts, bk, byBasename.get(bk)!);
      recordConflict(basenameConflicts, bk, page.id);
    } else {
      byBasename.set(bk, page.id);
    }

    const sk = normalizeKey(page.slug);
    if (sk.length > 0) {
      if (bySlug.has(sk) && bySlug.get(sk) !== page.id) {
        recordConflict(slugConflicts, sk, bySlug.get(sk)!);
        recordConflict(slugConflicts, sk, page.id);
      } else {
        bySlug.set(sk, page.id);
      }
    }

    for (const alias of page.aliases) {
      const ak = normalizeKey(alias);
      if (ak.length === 0) continue;
      if (byAlias.has(ak) && byAlias.get(ak) !== page.id) {
        recordConflict(aliasConflicts, ak, byAlias.get(ak)!);
        recordConflict(aliasConflicts, ak, page.id);
      } else {
        byAlias.set(ak, page.id);
      }
    }

    // Vault-relative path lookup keys (without `.md`)
    const relNoExt = page.relPath.replace(/\.md$/i, "");
    byVaultRelPath.set(normalizeKey(relNoExt), page.id);
  }

  // Mounts
  const { mounts, issues: mountIssues } = await loadMounts(absRoot);
  for (const i of mountIssues) issues.push(i);

  const externals = new Map<string, ExternalDocument>();
  for (const ext of await discoverExternals(absRoot, mounts)) {
    externals.set(ext.id, ext);
    const k = normalizeKey(ext.vaultRelPath);
    byVaultRelPath.set(k, ext.id);
  }

  return {
    rootPath: absRoot,
    pages,
    externals,
    mounts,
    byTitle,
    byAlias,
    byBasename,
    bySlug,
    byVaultRelPath,
    titleConflicts,
    aliasConflicts,
    slugConflicts,
    basenameConflicts,
    issues,
  };
}
