import { describe, expect, it } from "vitest";

import { searchVault } from "../src/search.js";
import type {
  OakPage,
  Vault,
  Visibility,
} from "../src/types.js";

type PageInit = {
  id: string;
  title: string;
  body?: string;
  aliases?: string[];
  visibility?: Visibility;
};

function makePage(init: PageInit): OakPage {
  return {
    type: "page",
    id: init.id,
    title: init.title,
    titlePlain: init.title,
    aliases: init.aliases ?? [],
    visibility: init.visibility ?? "private",
    slug: init.id,
    llm: "deny",
    filePath: `/vault/${init.id}.md`,
    relPath: `${init.id}.md`,
    basename: init.id,
    body: init.body ?? "",
    rawFrontmatter: {},
    links: [],
    parseIssues: [],
  };
}

function makeVault(pages: OakPage[]): Vault {
  const map = new Map<string, OakPage>();
  for (const p of pages) map.set(p.id, p);
  return {
    rootPath: "/vault",
    pages: map,
    externals: new Map(),
    mounts: new Map(),
    byTitle: new Map(),
    byAlias: new Map(),
    byBasename: new Map(),
    bySlug: new Map(),
    byVaultRelPath: new Map(),
    titleConflicts: new Map(),
    aliasConflicts: new Map(),
    slugConflicts: new Map(),
    basenameConflicts: new Map(),
    issues: [],
  };
}

describe("searchVault", () => {
  it("returns nothing for an empty query", () => {
    const vault = makeVault([makePage({ id: "a", title: "Alpha" })]);
    expect(searchVault(vault, "")).toEqual([]);
    expect(searchVault(vault, "   ")).toEqual([]);
  });

  it("matches title case-insensitively and reports the match offset", () => {
    const vault = makeVault([makePage({ id: "a", title: "Alpha Bravo" })]);
    const hits = searchVault(vault, "BRAVO");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippets[0]).toMatchObject({
      kind: "title",
      text: "Alpha Bravo",
      start: 6,
      end: 11,
    });
  });

  it("matches aliases", () => {
    const vault = makeVault([
      makePage({ id: "a", title: "Page A", aliases: ["Bravo", "Charlie"] }),
    ]);
    const hits = searchVault(vault, "char");
    expect(hits).toHaveLength(1);
    const aliasSnippet = hits[0]!.snippets.find((s) => s.kind === "alias");
    expect(aliasSnippet).toMatchObject({ text: "Charlie", start: 0, end: 4 });
  });

  it("emits one body snippet per match with 1-based line numbers", () => {
    const body = ["first line foo", "second", "third foo bar foo"].join("\n");
    const vault = makeVault([makePage({ id: "a", title: "A", body })]);
    const hits = searchVault(vault, "foo");
    expect(hits).toHaveLength(1);
    const lines = hits[0]!.snippets
      .filter((s) => s.kind === "body")
      .map((s) => s.line);
    expect(lines).toEqual([1, 3, 3]);
    expect(hits[0]!.bodyMatchCount).toBe(3);
  });

  it("ranks title-prefix above title-contains above alias above body-only", () => {
    const vault = makeVault([
      makePage({ id: "body", title: "Other", body: "foo foo foo" }),
      makePage({ id: "alias", title: "Other", aliases: ["foo bar"] }),
      makePage({ id: "contains", title: "All About foo" }),
      makePage({ id: "prefix", title: "foo guide" }),
    ]);
    const order = searchVault(vault, "foo").map((h) => h.pageId);
    expect(order).toEqual(["prefix", "contains", "alias", "body"]);
  });

  it("caps body snippets per page but reports the true match count", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i} foo`).join("\n");
    const vault = makeVault([makePage({ id: "a", title: "A", body })]);
    const hits = searchVault(vault, "foo", { bodyMatchesPerPage: 3 });
    expect(hits).toHaveLength(1);
    const bodySnippets = hits[0]!.snippets.filter((s) => s.kind === "body");
    expect(bodySnippets).toHaveLength(3);
    expect(hits[0]!.bodyMatchCount).toBe(20);
  });

  it("windows long lines and adjusts match offsets", () => {
    const filler = "x".repeat(500);
    const body = `${filler} needle ${filler}`;
    const vault = makeVault([makePage({ id: "a", title: "A", body })]);
    const hits = searchVault(vault, "needle", { bodySnippetMaxChars: 80 });
    const snip = hits[0]!.snippets.find((s) => s.kind === "body")!;
    expect(snip.text.length).toBeLessThanOrEqual(82); // ≤ 80 + two `…`
    expect(snip.text.startsWith("…")).toBe(true);
    expect(snip.text.endsWith("…")).toBe(true);
    expect(snip.text.slice(snip.start, snip.end)).toBe("needle");
  });

  it("respects visibilityFilter", () => {
    const vault = makeVault([
      makePage({ id: "pub", title: "foo", visibility: "public" }),
      makePage({ id: "priv", title: "foo", visibility: "private" }),
    ]);
    const ids = searchVault(vault, "foo", {
      visibilityFilter: ["public"],
    }).map((h) => h.pageId);
    expect(ids).toEqual(["pub"]);
  });

  it("respects the global limit", () => {
    const pages: OakPage[] = [];
    for (let i = 0; i < 10; i++) {
      pages.push(makePage({ id: `p${i}`, title: `foo ${i}` }));
    }
    const hits = searchVault(makeVault(pages), "foo", { limit: 3 });
    expect(hits).toHaveLength(3);
  });
});
