import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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

  it("surfaces files without `id` frontmatter as unmanaged and excludes them from pages/recent", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("publish-basic"), root, { recursive: true });
    // Drop a file the way an external system would: no oak frontmatter
    // at all. parseVault will synthesize an `unidentified:…` id and
    // emit a `missing-id` parse issue, which homeViewModel reads to
    // segregate it from the real pages.
    await writeFile(
      resolve(root, "dropped.md"),
      "# Dropped from elsewhere\n\nbody body body\n",
      "utf8",
    );

    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const home = await homeViewModel(vault, graph);

    expect(home.unmanaged.map((u) => u.vaultRelPath)).toEqual(["dropped.md"]);
    expect(home.unmanaged[0]!.basename).toBe("dropped");
    expect(home.stats.unmanaged).toBe(1);
    // Counted out of pages / visibility totals.
    expect(home.pages.map((p) => p.title).sort()).toEqual([
      "About",
      "Diary",
      "Hello",
    ]);
    expect(home.recent.find((r) => r.vaultRelPath === "dropped.md")).toBeUndefined();
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
    // `recentTotal` reports the full count regardless of `recentLimit`.
    expect(home.recentTotal).toBe(order.length);
  });

  it("collects feed-eligible public pages into `feed`", async () => {
    const root = resolve(scratch, "vault");
    await mkdir(root, { recursive: true });
    const fmFeed = [
      "---",
      "id: AAAA-BBBB-CCCC",
      "visibility: public",
      "slug: feed-page",
      "feed: true",
      "---",
      "",
      "# Feed page",
      "",
      "body",
      "",
    ].join("\n");
    const fmNoFeed = [
      "---",
      "id: DDDD-EEEE-FFFF",
      "visibility: public",
      "slug: plain-public",
      "---",
      "",
      "# Plain public",
      "",
      "body",
      "",
    ].join("\n");
    const fmUnlistedFeed = [
      "---",
      "id: GGGG-HHHH-IIII",
      "visibility: unlisted",
      "slug: unlisted-feed",
      // feed: true on an unlisted page violates parse validation but
      // we still want the home model to defensively exclude it.
      "feed: true",
      "---",
      "",
      "# Unlisted feed",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(resolve(root, "feed-page.md"), fmFeed, "utf8");
    await writeFile(resolve(root, "plain-public.md"), fmNoFeed, "utf8");
    await writeFile(resolve(root, "unlisted-feed.md"), fmUnlistedFeed, "utf8");

    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const home = await homeViewModel(vault, graph);
    expect(home.feed.map((e) => e.title)).toEqual(["Feed page"]);
  });

});

