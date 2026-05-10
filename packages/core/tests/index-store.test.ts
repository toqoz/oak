import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  buildGraph,
  parseVault,
  queryIndex,
  validateVault,
  writeIndex,
  readIndexMeta,
  INDEX_SCHEMA_VERSION,
  indexPathFor,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-index-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function copyFixture(name: string): Promise<string> {
  const dest = resolve(scratch, name);
  await cp(fxRoot(name), dest, { recursive: true });
  return dest;
}

describe("writeIndex", () => {
  it("persists pages, links, and meta from the basic fixture", async () => {
    const vaultPath = await copyFixture("basic");
    const vault = await parseVault(vaultPath);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const stats = await writeIndex(vault, graph, issues);

    expect(stats.pages).toBe(3);
    expect(stats.links).toBeGreaterThan(0);
    expect(stats.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(stats.dbPath).toBe(indexPathFor(vault.rootPath));

    const meta = readIndexMeta(stats.dbPath);
    expect(meta.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(meta.vaultRoot).toBe(vault.rootPath);
    expect(meta.indexedAt.length).toBeGreaterThan(0);

    const pageRows = queryIndex<{ title: string }>(
      stats.dbPath,
      "SELECT title FROM pages ORDER BY title",
    );
    expect(pageRows.map((r) => r.title)).toEqual([
      "Diary",
      "Local File First",
      "Project Alpha",
    ]);

    const linkStatuses = queryIndex<{ status: string; n: number }>(
      stats.dbPath,
      "SELECT status, COUNT(*) AS n FROM links GROUP BY status",
    );
    const statusMap = new Map(linkStatuses.map((r) => [r.status, r.n]));
    expect(statusMap.get("resolved") ?? 0).toBeGreaterThan(0);
  });

  it("records issues for the private-leak fixture", async () => {
    const vaultPath = await copyFixture("private-leak");
    const vault = await parseVault(vaultPath);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const stats = await writeIndex(vault, graph, issues);

    expect(stats.issues).toBeGreaterThan(0);

    const codes = queryIndex<{ code: string }>(
      stats.dbPath,
      "SELECT code FROM issues",
    );
    expect(codes.map((r) => r.code)).toContain("private-leak");
  });

  it("excludes unmanaged files from the pages table but still records the missing-id issue", async () => {
    const vaultPath = await copyFixture("basic");
    await writeFile(
      resolve(vaultPath, "dropped.md"),
      "# Dropped\n\nbody\n",
      "utf8",
    );
    const vault = await parseVault(vaultPath);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const stats = await writeIndex(vault, graph, issues);

    // basic fixture has 3 managed pages; dropped.md is unmanaged and
    // must not be counted.
    expect(stats.pages).toBe(3);
    const relPaths = queryIndex<{ rel_path: string }>(
      stats.dbPath,
      "SELECT rel_path FROM pages",
    );
    expect(relPaths.map((r) => r.rel_path)).not.toContain("dropped.md");

    // The reason it's absent is still discoverable via the issues table.
    const codes = queryIndex<{ code: string }>(
      stats.dbPath,
      "SELECT code FROM issues WHERE file_path LIKE '%dropped.md'",
    );
    expect(codes.map((r) => r.code)).toContain("missing-id");
  });

  it("rebuilds cleanly: subsequent writes do not duplicate rows", async () => {
    const vaultPath = await copyFixture("basic");
    const vault = await parseVault(vaultPath);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);

    const a = await writeIndex(vault, graph, issues);
    const b = await writeIndex(vault, graph, issues);
    expect(b.pages).toBe(a.pages);
    expect(b.links).toBe(a.links);

    const total = queryIndex<{ n: number }>(
      b.dbPath,
      "SELECT COUNT(*) AS n FROM pages",
    );
    expect(total[0]!.n).toBe(a.pages);
  });
});
