import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGraph,
  excerptFrom,
  homeViewModel,
  parseVault,
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
  it("strips wiki syntax, code, and headings; truncates", () => {
    const body = [
      "# Title",
      "",
      "First paragraph with [[Wiki|alias]] and `code` reference.",
      "",
      "Second paragraph.",
    ].join("\n");
    expect(excerptFrom(body, 200)).toBe(
      "First paragraph with alias and reference.",
    );
    expect(excerptFrom("a".repeat(300), 100)).toMatch(/^a+…$/);
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

