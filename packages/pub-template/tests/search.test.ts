import { describe, expect, it } from "vitest";
import {
  searchCorpus,
  highlight,
  type SearchDoc,
} from "../src/lib/search.ts";

const corpus: SearchDoc[] = [
  {
    id: "intro",
    title: "Introduction",
    slug: "intro",
    aliases: ["preface"],
    body: [
      "# Welcome to oak",
      "",
      "Oak is a knowledge graph tool. It connects pages with [[wiki]]",
      "links, and surfaces [[backlinks]] automatically.",
    ].join("\n"),
  },
  {
    id: "graphs",
    title: "Graph Theory",
    slug: "graphs",
    aliases: [],
    body: [
      "# Graph Theory",
      "",
      "Nodes connected by edges. Useful for modelling relationships",
      "between knowledge pages.",
    ].join("\n"),
  },
  {
    id: "empty",
    title: "Stub",
    slug: "stub",
    aliases: [],
    body: "",
  },
];

describe("searchCorpus", () => {
  it("returns nothing for an empty query", () => {
    expect(searchCorpus(corpus, "").length).toBe(0);
    expect(searchCorpus(corpus, "   ").length).toBe(0);
  });

  it("finds a match in body text", () => {
    const hits = searchCorpus(corpus, "knowledge");
    expect(hits.map((h) => h.doc.id).sort()).toEqual(["graphs", "intro"]);
  });

  it("ranks title matches higher than body matches", () => {
    const hits = searchCorpus(corpus, "graph");
    // "Graph Theory" matches in title; intro mentions "graph" in body.
    expect(hits[0]!.doc.id).toBe("graphs");
  });

  it("requires every term to match somewhere (AND semantics)", () => {
    // "graph" matches both, "alias" matches neither — no hits.
    const hits = searchCorpus(corpus, "graph alias");
    expect(hits.length).toBe(0);
  });

  it("matches against aliases", () => {
    const hits = searchCorpus(corpus, "preface");
    expect(hits.map((h) => h.doc.id)).toContain("intro");
  });

  it("returns highlight ranges in the title and body lines", () => {
    const hits = searchCorpus(corpus, "knowledge");
    const intro = hits.find((h) => h.doc.id === "intro");
    expect(intro).toBeDefined();
    expect(intro!.lines.length).toBeGreaterThan(0);
    const line = intro!.lines[0]!;
    expect(line.ranges.length).toBeGreaterThan(0);
    const r = line.ranges[0]!;
    expect(line.text.slice(r.start, r.end).toLowerCase()).toBe("knowledge");
  });

  it("caps lines per hit", () => {
    const longBody = Array.from({ length: 20 }, (_, i) => `line ${i} match`).join(
      "\n",
    );
    const big: SearchDoc = {
      id: "big",
      title: "Big",
      slug: "big",
      aliases: [],
      body: longBody,
    };
    const hits = searchCorpus([big], "match", { linesPerHit: 3 });
    expect(hits[0]!.lines.length).toBe(3);
  });

  it("is case-insensitive", () => {
    const hitsLower = searchCorpus(corpus, "knowledge");
    const hitsUpper = searchCorpus(corpus, "KNOWLEDGE");
    expect(hitsLower.length).toBe(hitsUpper.length);
  });

  it("ranks heading matches higher than plain body matches", () => {
    const doc = (id: string, body: string): SearchDoc => ({
      id,
      title: id,
      slug: id,
      aliases: [],
      body,
    });
    const cor = [
      doc("heading", "# Target Word\n\nUnrelated body."),
      doc("body", "intro line\n\nrandom Target Word in plain text"),
    ];
    const hits = searchCorpus(cor, "Target");
    // Both qualify, but heading wins.
    expect(hits[0]!.doc.id).toBe("heading");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("respects maxResults", () => {
    const cor = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      title: `n${i}`,
      slug: `n${i}`,
      aliases: [],
      body: `match in body ${i}`,
    }));
    const hits = searchCorpus(cor, "match", { maxResults: 3 });
    expect(hits.length).toBe(3);
  });

  it("populates titleMatches with offset ranges into the title", () => {
    const cor: SearchDoc[] = [
      {
        id: "x",
        title: "Knowledge Graphs",
        slug: "x",
        aliases: [],
        body: "",
      },
    ];
    const hits = searchCorpus(cor, "graphs");
    expect(hits.length).toBe(1);
    const r = hits[0]!.titleMatches[0]!;
    expect(hits[0]!.doc.title.slice(r.start, r.end).toLowerCase()).toBe(
      "graphs",
    );
  });

  it("merges overlapping multi-term ranges on the same body line", () => {
    const cor: SearchDoc[] = [
      {
        id: "x",
        title: "x",
        slug: "x",
        aliases: [],
        // Both "abc" and "bcd" hit this line, with overlapping spans.
        body: "abcd context",
      },
    ];
    const hits = searchCorpus(cor, "abc bcd");
    expect(hits.length).toBe(1);
    const ranges = hits[0]!.lines[0]!.ranges;
    // mergeRanges should collapse [0,3) and [1,4) into a single [0,4).
    expect(ranges.length).toBe(1);
    expect(ranges[0]).toEqual({ start: 0, end: 4 });
  });

  it("does not crash on documents with empty body", () => {
    const cor: SearchDoc[] = [
      { id: "z", title: "z", slug: "z", aliases: [], body: "" },
    ];
    expect(() => searchCorpus(cor, "anything")).not.toThrow();
  });
});

describe("highlight", () => {
  it("wraps ranges in <mark>", () => {
    const out = highlight("hello world", [{ start: 6, end: 11 }]);
    expect(out).toBe("hello <mark>world</mark>");
  });

  it("escapes html", () => {
    const out = highlight("a <b> c", []);
    expect(out).toBe("a &lt;b&gt; c");
  });

  it("escapes html inside the highlight", () => {
    const out = highlight("<x>", [{ start: 0, end: 3 }]);
    expect(out).toBe("<mark>&lt;x&gt;</mark>");
  });

  it("handles multiple non-overlapping ranges", () => {
    const out = highlight("aaa bbb ccc", [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(out).toBe("<mark>aaa</mark> bbb <mark>ccc</mark>");
  });
});
