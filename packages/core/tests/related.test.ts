import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildGraph } from "../src/graph.js";
import { parseVault } from "../src/parse.js";
import { relatedView } from "../src/related.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(resolve(tmpdir(), "oak-related-"));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

async function page(
  name: string,
  visibility: "public" | "unlisted" | "private",
  body: string,
): Promise<void> {
  await mkdir(resolve(vaultDir, "."), { recursive: true });
  await writeFile(
    resolve(vaultDir, `${name}.md`),
    `---\nid: ${name}\ntitle: ${name}\nvisibility: ${visibility}\n---\n\n${body}`,
    "utf8",
  );
}

describe("relatedView", () => {
  it("returns outbound page entries for resolved wiki links", async () => {
    await page("alpha", "public", "Hi see [[beta]]\n");
    await page("beta", "public", "Beta body\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "alpha");
    expect(r.outbound).toHaveLength(1);
    expect(r.outbound[0]).toMatchObject({
      kind: "page",
      id: "beta",
      slug: "beta",
    });
  });

  it("returns redlink outbound entries for unresolved wiki targets", async () => {
    await page("alpha", "public", "see [[NotYet]]\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "alpha");
    expect(r.outbound).toEqual([
      { kind: "redlink", targetKey: "NotYet", display: "NotYet" },
    ]);
  });

  it("filters private pages out of inbound and outbound", async () => {
    await page("public-page", "public", "");
    await page("secret", "private", "links to [[public-page]]\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "public-page");
    expect(r.inbound).toHaveLength(0);
  });

  it("computes 2-hop neighbours through a page bridge", async () => {
    await page("a", "public", "see [[b]]\n");
    await page("b", "public", "see [[c]]\n");
    await page("c", "public", "Final\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "a");
    // a -> b directly, then b -> c is the 2-hop.
    expect(r.twoHop.map((h) => h.id)).toEqual(["c"]);
    expect(r.twoHop[0]!.via[0]).toMatchObject({ kind: "page", id: "b" });
  });

  it("computes 2-hop bridges through redlinks (shared red-link concept)", async () => {
    await page("a", "public", "see [[SharedConcept]]\n");
    await page("b", "public", "see [[SharedConcept]]\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "a");
    expect(r.twoHop.map((h) => h.id)).toEqual(["b"]);
    expect(r.twoHop[0]!.via[0]).toMatchObject({
      kind: "redlink",
      display: "SharedConcept",
    });
  });

  it("returns empty arrays for an unknown page id", async () => {
    await page("a", "public", "");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = relatedView(vault, graph, "nope");
    expect(r).toEqual({ outbound: [], inbound: [], twoHop: [] });
  });
});
