import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm, cp } from "node:fs/promises";
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
