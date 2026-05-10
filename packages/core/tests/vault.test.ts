import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { parseVault } from "../src/parse.js";
import {
  buildGraph,
  getBacklinks,
  getOutboundLinks,
  getTwoHopLinks,
  redlinkTargetId,
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

describe("twohop-redlinks fixture", () => {
  it("bridges pages that share an unresolved wiki target", async () => {
    const vault = await parseVault(fx("twohop-redlinks"));
    const graph = buildGraph(vault);

    const alpha = findPageId(vault, "Alpha");
    const beta = findPageId(vault, "Beta");
    const delta = findPageId(vault, "Delta");
    const gamma = findPageId(vault, "Gamma");

    // Both casings ("Shared Topic" / "shared topic") fold to the same
    // synthetic target id and feed the unified `incoming` index.
    const refs = getBacklinks(graph, redlinkTargetId("Shared Topic"));
    expect(refs.map((r) => r.fromId).sort()).toEqual(
      [alpha, beta, delta].sort(),
    );

    // From Alpha, both Beta and Delta should surface as 2-hop neighbours
    // via the shared red link, and the bridge should be reported as a
    // redlink (not a page).
    const fromAlpha = getTwoHopLinks(graph, alpha);
    const ids = fromAlpha.map((t) => t.pageId).sort();
    expect(ids).toEqual([beta, delta].sort());
    for (const entry of fromAlpha) {
      expect(entry.via).toHaveLength(1);
      const v = entry.via[0]!;
      expect(v.kind).toBe("redlink");
      if (v.kind === "redlink") expect(v.targetKey).toBe("shared topic");
    }

    // From Beta, Gamma is a direct neighbour and must not appear; Alpha and
    // Delta should appear via the red link bridge.
    const fromBeta = getTwoHopLinks(graph, beta);
    const betaIds = fromBeta.map((t) => t.pageId);
    expect(betaIds).not.toContain(gamma);
    expect(betaIds.sort()).toEqual([alpha, delta].sort());
  });
});

describe("system root files", () => {
  let scratchDir: string;
  beforeEach(async () => {
    scratchDir = await mkdtemp(resolve(tmpdir(), "oak-vault-"));
  });
  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it("excludes vault-root scratch.md from the indexed surface", async () => {
    await writeFile(
      resolve(scratchDir, "real.md"),
      "---\ntitle: Real\nvisibility: private\n---\nbody\n",
      "utf8",
    );
    await writeFile(
      resolve(scratchDir, "scratch.md"),
      "# *scratch*\n\nephemeral\n",
      "utf8",
    );
    const vault = await parseVault(scratchDir);
    const titles = [...vault.pages.values()].map((p) => p.title);
    expect(titles).toContain("Real");
    expect(titles).not.toContain("*scratch*");
    const paths = [...vault.pages.values()].map((p) => p.relPath);
    expect(paths).not.toContain("scratch.md");
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
    const viaPageIds = cEntry!.via
      .map((v) => (v.kind === "page" ? v.pageId : null))
      .filter((x): x is string => x !== null)
      .sort();
    expect(viaPageIds).toEqual([b, d].sort());
    expect(cEntry!.score).toBe(2);

    // Direct neighbours of A (B, D, E) must NOT appear in 2-hop.
    const ids = twohop.map((t) => t.pageId);
    expect(ids).not.toContain(b);
    expect(ids).not.toContain(d);
    expect(ids).not.toContain(e);
    expect(ids).not.toContain(a);
  });
});
