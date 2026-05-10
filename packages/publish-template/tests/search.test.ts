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
