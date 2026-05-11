// Create a new oak page with well-formed frontmatter.
//
// Both the CLI (`oak new`) and the Obsidian plugin call this helper
// so the on-disk shape stays consistent across entry points.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, posix, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { ulid } from "ulid";

import { slugify } from "./slug.js";
import { nowIsoSecond } from "./timestamps.js";
import type { Visibility } from "./types.js";

const ILLEGAL_FS = /[\\/:*?"<>|]/g;
const VISIBILITIES: ReadonlySet<Visibility> = new Set([
  "private",
  "unlisted",
  "public",
]);

export type CreatePageOptions = {
  title: string;
  visibility?: Visibility;
  slug?: string;
  aliases?: string[];
  body?: string;
  // Vault-relative path (e.g. "notes/2026/04.md"). If omitted, derived
  // from the title at the vault root.
  at?: string;
  // Default true; set false to overwrite an existing file (unused
  // today, kept as an explicit knob so a future "rename" workflow can
  // reuse this helper).
  failIfExists?: boolean;
  // Test seam: deterministic id generation in tests.
  generateId?: () => string;
  // Test seam: deterministic `created` / `modified` timestamps.
  now?: () => Date;
};

export type CreatePageResult = {
  id: string;
  title: string;
  slug: string;
  visibility: Visibility;
  aliases: string[];
  filePath: string;
  vaultRelPath: string;
};

// Pure result of "what would this new page look like?". Used by the
// CLI (writes via fs) and the Obsidian plugin (writes via vault.create
// so Obsidian's own watchers / metadata cache pick it up promptly).
export type ComposedPage = {
  id: string;
  title: string;
  slug: string;
  visibility: Visibility;
  aliases: string[];
  vaultRelPath: string; // posix
  text: string; // full file content (frontmatter + body)
};

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

// Convert a title into a filesystem-safe basename. Replaces OS-illegal
// characters with `-`, normalises whitespace, trims, caps length.
// Exported because both `composePage` (new file) and the Obsidian
// plugin's title rename flow need the same algorithm.
export function pathSafeFilename(title: string): string {
  return title
    .normalize("NFC")
    .replace(ILLEGAL_FS, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function ensureMarkdownExt(p: string): string {
  return extname(p).toLowerCase() === ".md" ? p : `${p}.md`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Pure: produce the file contents and target path without touching
// the filesystem.
export function composePage(options: CreatePageOptions): ComposedPage {
  const title = options.title.trim();
  if (title.length === 0) {
    throw new Error("composePage: title is required");
  }
  const visibility = options.visibility ?? "private";
  if (!VISIBILITIES.has(visibility)) {
    throw new Error(`composePage: invalid visibility \`${visibility}\``);
  }
  const aliases = (options.aliases ?? [])
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  let relPath: string;
  if (options.at && options.at.length > 0) {
    if (isAbsolute(options.at)) {
      throw new Error(
        "composePage: `at` must be a vault-relative path, not absolute",
      );
    }
    relPath = ensureMarkdownExt(options.at);
  } else {
    const safe = pathSafeFilename(title);
    if (safe.length === 0) {
      throw new Error(
        `composePage: could not derive a filename from title \`${title}\``,
      );
    }
    relPath = `${safe}.md`;
  }

  const id = options.generateId ? options.generateId() : ulid();
  const slug = options.slug?.trim() || slugify(title);

  // Build frontmatter explicitly so the YAML is self-documenting:
  // every page on disk shows visibility even when it's at the
  // default.
  const fm: Record<string, unknown> = { id, title };
  if (aliases.length > 0) fm["aliases"] = aliases;
  fm["visibility"] = visibility;
  fm["slug"] = slug;
  // `created` / `modified` start equal — the file is brand new, so
  // creation and last-modification are the same instant. Subsequent
  // writes go through `withTimestampUpdate()` which only bumps
  // `modified`.
  const stamp = nowIsoSecond(options.now ? options.now() : new Date());
  fm["created"] = stamp;
  fm["modified"] = stamp;

  const yamlText = yaml.dump(fm, {
    sortKeys: false,
    lineWidth: 120,
    noRefs: true,
  });
  const body = options.body ?? "";
  const text = `---\n${yamlText}---\n\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}`;

  return {
    id,
    title,
    slug,
    visibility,
    aliases,
    vaultRelPath: toPosix(relPath),
    text,
  };
}

export async function createPage(
  vaultRoot: string,
  options: CreatePageOptions,
): Promise<CreatePageResult> {
  const composed = composePage(options);
  const absPath = resolve(vaultRoot, composed.vaultRelPath);
  if (!absPath.startsWith(resolve(vaultRoot))) {
    throw new Error("createPage: path escapes the vault root");
  }
  const failIfExists = options.failIfExists ?? true;
  if (failIfExists && (await exists(absPath))) {
    throw new Error(
      `createPage: file already exists at ${composed.vaultRelPath}`,
    );
  }
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, composed.text, "utf8");
  return {
    id: composed.id,
    title: composed.title,
    slug: composed.slug,
    visibility: composed.visibility,
    aliases: composed.aliases,
    filePath: absPath,
    vaultRelPath: composed.vaultRelPath,
  };
}
