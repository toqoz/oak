import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseVault } from "../src/parse.js";
import {
  buildGraph,
  getBacklinks,
  getOutboundLinks,
  getTwoHopLinks,
} from "../src/graph.js";
import { partitionIssues, validateVault } from "../src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => resolve(__dirname, "fixtures", name);

function findPageId(
  vault: Awaited<ReturnType<typeof parseVault>>,
  title: string,
): string {
  for (const page of vault.pages.values()) {
    if (page.title === title) return page.id;
  }
  throw new Error(`fixture page not found: ${title}`);
}

describe("basic fixture", () => {
  it("indexes pages and resolves links across syntaxes", async () => {
    const vault = await parseVault(fx("basic"));
    expect(vault.pages.size).toBe(3);
    const graph = buildGraph(vault);

    const lff = findPageId(vault, "Local File First");
    const projectAlpha = findPageId(vault, "Project Alpha");
    const diary = findPageId(vault, "Diary");

    const out = getOutboundLinks(graph, lff);
    // Two outbound links: one wiki, one markdown — both resolve to Project Alpha.
    const resolvedTargets = out
      .map((l) => (l.resolution.status === "resolved" ? l.resolution.targetId : null))
      .filter((x): x is string => x !== null);
    expect(resolvedTargets).toContain(projectAlpha);

    // Code-fenced [[FakeLink]] in Project Alpha.md must be ignored.
    const projectAlphaOut = getOutboundLinks(graph, projectAlpha);
    const fakeFound = projectAlphaOut.some((l) => l.target === "FakeLink");
    expect(fakeFound).toBe(false);

    // Diary references Project Alpha; backlink should appear on Project Alpha.
    const back = getBacklinks(graph, projectAlpha);
    const backFromIds = back.map((b) => b.fromId);
    expect(backFromIds).toContain(diary);

    // Validation produces no errors.
    const issues = validateVault(vault, graph);
    const { errors } = partitionIssues(issues);
    expect(errors).toEqual([]);
  });
});

describe("redlinks fixture", () => {
  it("returns unresolved links inline and flags unresolved embed", async () => {
    const vault = await parseVault(fx("redlinks"));
    const graph = buildGraph(vault);
    const index = findPageId(vault, "Index");
    const out = getOutboundLinks(graph, index);

    const unresolved = out.filter((l) => l.resolution.status === "unresolved");
    expect(unresolved.map((l) => l.target)).toEqual(
      expect.arrayContaining(["Future Idea", "Missing Diagram"]),
    );

    const issues = validateVault(vault, graph);
    const { errors } = partitionIssues(issues);
    // Unresolved embed must be flagged.
    expect(errors.some((e) => e.code === "unresolved-embed")).toBe(true);
    // Plain unresolved link is NOT an error.
    expect(errors.some((e) => e.code === "invalid-link")).toBe(false);
  });
});

describe("private-leak fixture", () => {
  it("flags public->private link as an error", async () => {
    const vault = await parseVault(fx("private-leak"));
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const { errors } = partitionIssues(issues);
    expect(errors.some((e) => e.code === "private-leak")).toBe(true);
  });
});

describe("external-leak fixture", () => {
  it("flags public->external link as an error even without configured mount", async () => {
    const vault = await parseVault(fx("external-leak"));
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    const { errors } = partitionIssues(issues);
    expect(errors.some((e) => e.code === "external-leak")).toBe(true);
  });
});

describe("aliases fixture", () => {
  it("resolves links via alias", async () => {
    const vault = await parseVault(fx("aliases"));
    const graph = buildGraph(vault);
    const curator = findPageId(vault, "Curator");
    const alexBrandon = findPageId(vault, "Alex Brandon");
    const out = getOutboundLinks(graph, curator);
    const resolved = out
      .map((l) => (l.resolution.status === "resolved" ? l.resolution.targetId : null))
      .filter((x): x is string => x !== null);
    expect(resolved.every((id) => id === alexBrandon)).toBe(true);
    expect(resolved).toHaveLength(2);
  });
});

describe("twohop fixture", () => {
  it("returns two-hop neighbours with bridge info", async () => {
    const vault = await parseVault(fx("twohop"));
    const graph = buildGraph(vault);

    const a = findPageId(vault, "A");
    const b = findPageId(vault, "B");
    const c = findPageId(vault, "C");
    const d = findPageId(vault, "D");
    const e = findPageId(vault, "E");

    const twohop = getTwoHopLinks(graph, a);
    const cEntry = twohop.find((t) => t.pageId === c);
    expect(cEntry).toBeDefined();
    expect(cEntry!.via.sort()).toEqual([b, d].sort());
    expect(cEntry!.score).toBe(2);

    // Direct neighbours of A (B, D, E) must NOT appear in 2-hop.
    const ids = twohop.map((t) => t.pageId);
    expect(ids).not.toContain(b);
    expect(ids).not.toContain(d);
    expect(ids).not.toContain(e);
    expect(ids).not.toContain(a);
  });
});
