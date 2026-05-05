import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  buildGraph,
  parseVault,
  publish,
  PublishError,
  validateVault,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-publish-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function copyFixture(name: string): Promise<string> {
  const dest = resolve(scratch, name);
  await cp(fxRoot(name), dest, { recursive: true });
  return dest;
}

async function publishVault(vaultPath: string, opts = {}) {
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);
  return await publish(vault, graph, issues, opts);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

describe("publish (basic)", () => {
  it("renders public pages, hashes assets, and writes manifest", async () => {
    const vaultPath = await copyFixture("publish-basic");
    const stats = await publishVault(vaultPath);

    // Two public pages, one shared asset
    expect(stats.pages.map((p) => p.slug).sort()).toEqual(["about", "hello"]);
    expect(stats.assets).toHaveLength(1);
    const asset = stats.assets[0]!;
    expect(asset.outputPath).toMatch(/^assets\/[0-9a-f]{16}\.svg$/);

    // Pages exist on disk
    expect(
      await fileExists(resolve(stats.outputDir, "hello/index.html")),
    ).toBe(true);
    expect(
      await fileExists(resolve(stats.outputDir, "about/index.html")),
    ).toBe(true);
    expect(
      await fileExists(resolve(stats.outputDir, asset.outputPath)),
    ).toBe(true);

    // Private page absent
    const slugs = (await readdir(stats.outputDir)).filter(
      (e) => !e.includes("."),
    );
    expect(slugs).not.toContain("diary");

    // Manifest written
    expect(await fileExists(stats.manifestPath)).toBe(true);
    const manifestRaw = JSON.parse(
      await readFile(stats.manifestPath, "utf8"),
    );
    expect(Object.keys(manifestRaw.pages).sort()).toEqual(
      stats.pages.map((p) => p.pageId).sort(),
    );

    // graph.json + search-index.json
    const graphJson = JSON.parse(
      await readFile(resolve(stats.outputDir, "graph.json"), "utf8"),
    );
    expect(graphJson.nodes.map((n: { slug: string }) => n.slug).sort()).toEqual(
      ["about", "hello"],
    );
    const edge = graphJson.edges.find(
      (e: { from: string }) => e.from.endsWith("PUB1"),
    );
    expect(edge).toBeDefined();

    const searchIndex = JSON.parse(
      await readFile(resolve(stats.outputDir, "search-index.json"), "utf8"),
    );
    expect(searchIndex).toHaveLength(2);
    // wiki link syntax stripped from search body
    expect(searchIndex.find((s: { slug: string }) => s.slug === "hello")
      .body).not.toContain("[[About]]");
  });

  it("rewrites wiki links to slug URLs and asset embeds to hashed URLs", async () => {
    const vaultPath = await copyFixture("publish-basic");
    const stats = await publishVault(vaultPath, { baseUrl: "/" });
    const helloHtml = await readFile(
      resolve(stats.outputDir, "hello/index.html"),
      "utf8",
    );
    expect(helloHtml).toContain('href="/about/"');
    expect(helloHtml).not.toContain("[[About]]");

    const aboutHtml = await readFile(
      resolve(stats.outputDir, "about/index.html"),
      "utf8",
    );
    expect(aboutHtml).toMatch(/src="\/assets\/[0-9a-f]{16}\.svg"/);
    // Original asset path must not leak.
    expect(aboutHtml).not.toContain("_assets/diagram.svg");
  });
});

describe("publish (leak guards)", () => {
  it("blocks publish on private-leak", async () => {
    const vaultPath = await copyFixture("private-leak");
    await expect(publishVault(vaultPath)).rejects.toBeInstanceOf(PublishError);
  });

  it("blocks publish on external-leak", async () => {
    const vaultPath = await copyFixture("external-leak");
    await expect(publishVault(vaultPath)).rejects.toBeInstanceOf(PublishError);
  });

  it("blocks publish when an asset referenced by a public page is missing", async () => {
    const vaultPath = await copyFixture("publish-basic");
    await rm(resolve(vaultPath, "_assets/diagram.svg"));
    await expect(publishVault(vaultPath)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing-asset" }),
      ]),
    });
  });
});

describe("publish (manifest cleanup)", () => {
  it("removes stale page output when a page becomes private", async () => {
    const vaultPath = await copyFixture("publish-basic");
    const first = await publishVault(vaultPath);
    expect(
      await fileExists(resolve(first.outputDir, "about/index.html")),
    ).toBe(true);

    // Make About private and republish.
    const aboutPath = resolve(vaultPath, "About.md");
    const original = await readFile(aboutPath, "utf8");
    const flipped = original.replace("visibility: public", "visibility: private");
    // Remove the now-orphaned wiki link from Hello so we don't introduce
    // a leak (private-leak guard would block publish).
    const helloPath = resolve(vaultPath, "Hello.md");
    const helloOriginal = await readFile(helloPath, "utf8");
    await writeFile(
      helloPath,
      helloOriginal.replace("[[About]]", "About (private)"),
      "utf8",
    );
    await writeFile(aboutPath, flipped, "utf8");

    const second = await publishVault(vaultPath);
    expect(second.pages.map((p) => p.slug)).toEqual(["hello"]);
    expect(
      await fileExists(resolve(second.outputDir, "about/index.html")),
    ).toBe(false);
    // The stale asset (only referenced by About) is removed too.
    expect(second.removedAssets.length).toBeGreaterThan(0);
  });
});
