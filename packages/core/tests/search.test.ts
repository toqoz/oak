import { describe, expect, it } from "vitest";

import { searchDocs, searchVault } from "../src/search.js";
import type { SearchDoc } from "../src/search.js";
import type { OakPage, Vault, Visibility } from "../src/types.js";

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
    filePath: `/vault/${init.id}.md`,
    relPath: `${init.id}.md`,
    basename: init.id,
    body: init.body ?? "",
    rawFrontmatter: {},
    created: null,
    modified: null,
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
    const snip = hits[0]!.snippets[0]!;
    expect(snip).toMatchObject({ kind: "title", text: "Alpha Bravo" });
    expect(snip.ranges).toEqual([{ start: 6, end: 11 }]);
  });

  it("matches aliases", () => {
    const vault = makeVault([
      makePage({ id: "a", title: "Page A", aliases: ["Bravo", "Charlie"] }),
    ]);
    const hits = searchVault(vault, "char");
    expect(hits).toHaveLength(1);
    const aliasSnippet = hits[0]!.snippets.find((s) => s.kind === "alias")!;
    expect(aliasSnippet.text).toBe("Charlie");
    expect(aliasSnippet.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("emits one body snippet per matching line with merged ranges", () => {
    const body = ["first line foo", "second", "third foo bar foo"].join("\n");
    const vault = makeVault([makePage({ id: "a", title: "A", body })]);
    const hits = searchVault(vault, "foo");
    expect(hits).toHaveLength(1);
    const bodySnips = hits[0]!.snippets.filter((s) => s.kind === "body");
    expect(bodySnips.map((s) => s.line)).toEqual([1, 3]);
    // Line 3 has two `foo` matches; both should land in the same snippet.
    expect(bodySnips[1]!.ranges).toHaveLength(2);
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
    const r = snip.ranges[0]!;
    expect(snip.text.slice(r.start, r.end)).toBe("needle");
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

  it("excludes unmanaged pages (those with `missing-id` parse issues)", () => {
    const real = makePage({ id: "real", title: "Findable", body: "needle" });
    const orphan = makePage({
      id: "unidentified:dropped.md",
      title: "Findable",
      body: "needle",
    });
    orphan.parseIssues = [
      {
        severity: "error",
        code: "missing-id",
        message: "Page is missing required `id` frontmatter",
      },
    ];
    const ids = searchVault(makeVault([real, orphan]), "needle").map(
      (h) => h.pageId,
    );
    expect(ids).toEqual(["real"]);
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

describe("searchDocs — multi-term", () => {
  function makeDoc(init: {
    id: string;
    title: string;
    body?: string;
    aliases?: string[];
    visibility?: Visibility;
  }): SearchDoc {
    return {
      id: init.id,
      title: init.title,
      aliases: init.aliases ?? [],
      body: init.body ?? "",
      visibility: init.visibility ?? "private",
      path: init.id,
    };
  }

  it("AND-matches across whitespace-separated tokens", () => {
    const docs = [
      makeDoc({ id: "both", title: "Graph", body: "theory of graphs" }),
      makeDoc({ id: "graph-only", title: "Graphs", body: "no other word" }),
      makeDoc({ id: "theory-only", title: "Theory", body: "no other word" }),
    ];
    const ids = searchDocs(docs, "graph theory").map((h) => h.pageId);
    // `graph-only` lacks the literal `theory`; `theory-only` lacks `graph`.
    // Only `both` has each token landing somewhere.
    expect(ids).toEqual(["both"]);
  });

  it("a token can be satisfied by title, alias, or body", () => {
    const docs = [
      // "graph" hits via title, "theory" via body — both required.
      makeDoc({ id: "split", title: "Graph", body: "deep theory" }),
      // Same split but via alias instead of title.
      makeDoc({
        id: "alias-split",
        title: "Other",
        aliases: ["graph stuff"],
        body: "talks about theory",
      }),
      // Missing one term entirely.
      makeDoc({ id: "missing", title: "Graph", body: "no other word" }),
    ];
    const ids = searchDocs(docs, "graph theory").map((h) => h.pageId);
    expect(ids).toContain("split");
    expect(ids).toContain("alias-split");
    expect(ids).not.toContain("missing");
  });

  it("aliases match only when every token lands within the same alias", () => {
    const docs = [
      makeDoc({
        id: "split-aliases",
        title: "Other",
        // "graph" in one alias, "theory" in another — should NOT trigger
        // the alias scoring tier (an alias represents a single name).
        aliases: ["graph", "theory"],
        body: "graph theory connects ideas",
      }),
      makeDoc({
        id: "combined",
        title: "Other",
        aliases: ["graph theory primer"],
        body: "no body match",
      }),
    ];
    const hits = searchDocs(docs, "graph theory");
    const split = hits.find((h) => h.pageId === "split-aliases");
    const combined = hits.find((h) => h.pageId === "combined");
    expect(split).toBeDefined();
    expect(combined).toBeDefined();
    expect(
      split!.snippets.find((s) => s.kind === "alias"),
    ).toBeUndefined();
    expect(
      combined!.snippets.find((s) => s.kind === "alias"),
    ).toBeDefined();
  });

  it("heading lines boost the body score", () => {
    const docs = [
      makeDoc({
        id: "heading",
        title: "Other",
        body: "# Target word here\n\nUnrelated body.",
      }),
      makeDoc({
        id: "prose",
        title: "Other",
        body: "intro line\n\nrandom target buried in prose",
      }),
    ];
    const hits = searchDocs(docs, "target");
    expect(hits[0]!.pageId).toBe("heading");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("title prefix beats title contains across mixed-position tokens", () => {
    const docs = [
      makeDoc({
        id: "prefix-then-contains",
        title: "graph theory primer",
        body: "n/a",
      }),
      makeDoc({
        id: "contains-only",
        title: "intro to graph theory",
        body: "n/a",
      }),
    ];
    const ids = searchDocs(docs, "graph theory").map((h) => h.pageId);
    expect(ids).toEqual(["prefix-then-contains", "contains-only"]);
  });

  it("merges overlapping multi-token ranges on the same line", () => {
    // "abc" and "bcd" share the middle `bc`; the line should surface a
    // single merged range [0, 4) covering "abcd" rather than two
    // conflicting spans.
    const docs = [
      makeDoc({ id: "x", title: "x", body: "abcd more text" }),
    ];
    const hits = searchDocs(docs, "abc bcd");
    expect(hits).toHaveLength(1);
    const body = hits[0]!.snippets.find((s) => s.kind === "body")!;
    expect(body.ranges).toEqual([{ start: 0, end: 4 }]);
  });
});
