import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGraph,
  excerptFrom,
  homeViewModel,
  parseVault,
  publish,
  validateVault,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-home-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("excerptFrom", () => {
  it("strips wiki syntax and code; preserves line breaks between paragraphs", () => {
    const body = [
      "Intro paragraph.",
      "",
      "First paragraph with [[Wiki|alias]] and `code` reference.",
      "",
      "Second paragraph.",
    ].join("\n");
    expect(excerptFrom(body, 200)).toBe(
      [
        "Intro paragraph.",
        "First paragraph with alias and reference.",
        "Second paragraph.",
      ].join("\n"),
    );
    expect(excerptFrom("a".repeat(300), 100)).toMatch(/^a+…$/);
  });

  it("includes heading and list text on separate lines with markers stripped", () => {
    const body = [
      "# Top heading",
      "",
      "## Section A",
      "",
      "- item one",
      "- [x] item two",
      "1. ordered",
      "",
      "> quoted line",
      "",
      "Body prose.",
    ].join("\n");
    expect(excerptFrom(body, 200)).toBe(
      [
        "Top heading",
        "Section A",
        "item one",
        "item two",
        "ordered",
        "quoted line",
        "Body prose.",
      ].join("\n"),
    );
  });
});

describe("homeViewModel", () => {
  it("counts visibilities and red links across the whole vault", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("redlinks"), root, { recursive: true });
    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const home = await homeViewModel(vault, graph);
    expect(home.stats.pages).toBe(1);
    expect(home.stats.public).toBe(1);
    expect(home.stats.redLinks).toBeGreaterThan(0);
  });

  it("filters by visibility when requested", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("publish-basic"), root, { recursive: true });
    const vault = await parseVault(root);
    const graph = buildGraph(vault);

    const all = await homeViewModel(vault, graph);
    expect(all.pages.map((p) => p.title).sort()).toEqual([
      "About",
      "Diary",
      "Hello",
    ]);

    const publishable = await homeViewModel(vault, graph, {
      visibilityFilter: ["public", "unlisted"],
    });
    expect(publishable.pages.map((p) => p.title).sort()).toEqual([
      "About",
      "Hello",
    ]);
  });

  it("sorts recent by mtime descending", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("twohop"), root, { recursive: true });
    // Set deterministic mtimes: A oldest, E newest.
    const order = ["A.md", "B.md", "C.md", "D.md", "E.md"];
    const base = Date.now() - 60_000;
    for (let i = 0; i < order.length; i++) {
      const t = new Date(base + i * 10_000);
      await utimes(resolve(root, order[i]!), t, t);
    }
    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const home = await homeViewModel(vault, graph, { recentLimit: 3 });
    expect(home.recent.map((e) => e.title)).toEqual(["E", "D", "C"]);
  });

});

describe("publisher emits index.html", () => {
  it("writes a static home page with publishable entries", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("publish-basic"), root, { recursive: true });
    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const stats = await publish(vault, graph, issues, { baseUrl: "/" });
    const indexHtml = await readFile(
      resolve(stats.outputDir, "index.html"),
      "utf8",
    );
    expect(indexHtml).toContain("<title>Index</title>");
    expect(indexHtml).toContain("Hello");
    expect(indexHtml).toContain("About");
    // Diary is private — must not appear.
    expect(indexHtml).not.toContain("Diary");
    // Page links resolve to slug URLs.
    expect(indexHtml).toContain('href="/hello/"');
    expect(indexHtml).toContain('href="/about/"');
  });
});
