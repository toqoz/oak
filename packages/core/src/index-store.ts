// Persist a parsed vault + graph + validation result into a SQLite
// snapshot at `.oak/index.sqlite` for inspection by external tooling
// (Obsidian plugin, ad-hoc SQL queries, future incremental builds).
//
// The schema is intentionally denormalised within reason: linked target
// IDs are stored next to their raw textual targets so consumers can
// query backlinks/external leaks without re-resolving links.

// Type-only import: erased at compile time so we don't pay the
// `node:sqlite` experimental-warning cost until a function is actually
// called. CLI entry points override `process.emit` before the lazy
// import runs, suppressing the warning entirely.
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { isManagedPage } from "./parse.js";
import type { Graph, Issue, Vault } from "./types.js";

// Vite's resolver mangles `node:sqlite` (strips the prefix) when it
// statically analyses the source. Going through createRequire forces
// the lookup through Node's own resolver, which knows about
// `node:sqlite` natively. This keeps the module test-friendly under
// vitest while still being perfectly normal Node code.
//
// Defer createRequire to call time so esbuild bundling to CJS (used
// by the Obsidian plugin) doesn't trip over an empty `import.meta.url`
// at module load. The plugin never calls these helpers, but the
// module must still evaluate.
let _DatabaseSync: typeof DatabaseSyncCtor | null = null;
function loadDatabaseSync(): typeof DatabaseSyncCtor {
  if (_DatabaseSync) return _DatabaseSync;
  const url = import.meta.url || `file://${process.cwd()}/oak-fallback.js`;
  const _require = createRequire(url);
  const mod = _require("node:sqlite") as typeof import("node:sqlite");
  _DatabaseSync = mod.DatabaseSync;
  return _DatabaseSync;
}

export const INDEX_SCHEMA_VERSION = 1;

export const INDEX_REL_PATH = ".oak/index.sqlite";

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility TEXT NOT NULL,
  llm TEXT NOT NULL,
  file_path TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  basename TEXT NOT NULL,
  body_chars INTEGER NOT NULL,
  link_count INTEGER NOT NULL
);
CREATE INDEX pages_title ON pages(title);
CREATE INDEX pages_slug ON pages(slug);
CREATE INDEX pages_visibility ON pages(visibility);
CREATE INDEX pages_basename ON pages(basename);
CREATE INDEX pages_rel_path ON pages(rel_path);

CREATE TABLE aliases (
  page_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (page_id, alias)
);
CREATE INDEX aliases_alias ON aliases(alias);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  from_page_id TEXT NOT NULL,
  syntax TEXT NOT NULL,
  raw TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT,
  heading TEXT,
  is_embed INTEGER NOT NULL,
  line INTEGER NOT NULL,
  status TEXT NOT NULL,
  target_id TEXT,
  reason TEXT
);
CREATE INDEX links_from ON links(from_page_id);
CREATE INDEX links_target_id ON links(target_id);
CREATE INDEX links_status ON links(status);

CREATE TABLE mounts (
  id TEXT PRIMARY KEY,
  target_path TEXT NOT NULL,
  link_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  publishable INTEGER NOT NULL,
  git_policy TEXT NOT NULL,
  llm_policy TEXT NOT NULL,
  exists_flag INTEGER NOT NULL
);

CREATE TABLE externals (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  vault_rel_path TEXT NOT NULL,
  title TEXT NOT NULL
);
CREATE INDEX externals_vault_rel ON externals(vault_rel_path);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  page_id TEXT,
  file_path TEXT
);
CREATE INDEX issues_severity ON issues(severity);
CREATE INDEX issues_code ON issues(code);
`;

export type IndexStats = {
  pages: number;
  aliases: number;
  links: number;
  mounts: number;
  externals: number;
  issues: number;
  schemaVersion: number;
  indexedAt: string;
  dbPath: string;
};

export type ReadIndexMeta = {
  schemaVersion: number;
  indexedAt: string;
  vaultRoot: string;
};

export function indexPathFor(vaultRoot: string): string {
  return resolve(vaultRoot, INDEX_REL_PATH);
}

export async function writeIndex(
  vault: Vault,
  graph: Graph,
  issues: Issue[],
  dbPath?: string,
): Promise<IndexStats> {
  const finalPath = dbPath ?? indexPathFor(vault.rootPath);
  await mkdir(dirname(finalPath), { recursive: true });
  // SQLite locks the file when open; remove any previous snapshot so we
  // always emit a clean rebuild.
  await rm(finalPath, { force: true });

  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(finalPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA_SQL);

    const insertMeta = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
    );
    const insertPage = db.prepare(
      `INSERT INTO pages
       (id, title, slug, visibility, llm, file_path, rel_path, basename, body_chars, link_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAlias = db.prepare(
      "INSERT INTO aliases (page_id, alias) VALUES (?, ?)",
    );
    const insertLink = db.prepare(
      `INSERT INTO links
       (from_page_id, syntax, raw, target, label, heading, is_embed, line, status, target_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMount = db.prepare(
      `INSERT INTO mounts
       (id, target_path, link_path, mode, publishable, git_policy, llm_policy, exists_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertExternal = db.prepare(
      `INSERT INTO externals
       (id, mount_id, rel_path, vault_rel_path, title)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertIssue = db.prepare(
      `INSERT INTO issues
       (severity, code, message, page_id, file_path)
       VALUES (?, ?, ?, ?, ?)`,
    );

    db.exec("BEGIN");
    try {
      const indexedAt = new Date().toISOString();
      insertMeta.run("schema_version", String(INDEX_SCHEMA_VERSION));
      insertMeta.run("indexed_at", indexedAt);
      insertMeta.run("vault_root", vault.rootPath);

      let aliasCount = 0;
      let linkCount = 0;
      let pageCount = 0;

      for (const page of vault.pages.values()) {
        // Unmanaged pages are absent from the lookup tables and graph;
        // mirror that here so the SQLite snapshot stays internally
        // consistent. The `missing-id` parse issue is still recorded
        // in the issues table so the file is discoverable.
        if (!isManagedPage(page)) continue;
        pageCount++;
        insertPage.run(
          page.id,
          page.title,
          page.slug,
          page.visibility,
          page.llm,
          page.filePath,
          page.relPath,
          page.basename,
          page.body.length,
          page.links.length,
        );
        for (const alias of page.aliases) {
          insertAlias.run(page.id, alias);
          aliasCount++;
        }
        const outgoing = graph.outgoing.get(page.id) ?? [];
        for (const link of outgoing) {
          let status: string;
          let targetId: string | null = null;
          let reason: string | null = null;
          switch (link.resolution.status) {
            case "resolved":
              status = "resolved";
              targetId = link.resolution.targetId;
              break;
            case "external":
              status = "external";
              targetId = link.resolution.externalId;
              break;
            case "unresolved":
              status = "unresolved";
              break;
            case "invalid":
              status = "invalid";
              reason = link.resolution.reason;
              break;
          }
          insertLink.run(
            page.id,
            link.syntax,
            link.raw,
            link.target,
            link.label ?? null,
            link.heading ?? null,
            link.isEmbed ? 1 : 0,
            link.line,
            status,
            targetId,
            reason,
          );
          linkCount++;
        }
      }

      for (const mount of vault.mounts.values()) {
        insertMount.run(
          mount.id,
          mount.targetPath,
          mount.linkPath,
          mount.mode,
          mount.publishable ? 1 : 0,
          mount.gitPolicy,
          mount.llmPolicy,
          mount.exists ? 1 : 0,
        );
      }

      for (const ext of vault.externals.values()) {
        insertExternal.run(
          ext.id,
          ext.mountId,
          ext.relPath,
          ext.vaultRelPath,
          ext.title,
        );
      }

      for (const issue of issues) {
        insertIssue.run(
          issue.severity,
          issue.code,
          issue.message,
          issue.pageId ?? null,
          issue.filePath ?? null,
        );
      }

      db.exec("COMMIT");

      return {
        pages: pageCount,
        aliases: aliasCount,
        links: linkCount,
        mounts: vault.mounts.size,
        externals: vault.externals.size,
        issues: issues.length,
        schemaVersion: INDEX_SCHEMA_VERSION,
        indexedAt,
        dbPath: finalPath,
      };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

// Convenience for tooling and tests: run a read-only query against an
// existing index file without exposing the DatabaseSync constructor.
export function queryIndex<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  params: ReadonlyArray<string | number | bigint | null> = [],
): T[] {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(sql);
    return stmt.all(...params) as T[];
  } finally {
    db.close();
  }
}

export function readIndexMeta(dbPath: string): ReadIndexMeta {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);
    return {
      schemaVersion: Number(map.get("schema_version") ?? "0"),
      indexedAt: map.get("indexed_at") ?? "",
      vaultRoot: map.get("vault_root") ?? "",
    };
  } finally {
    db.close();
  }
}
