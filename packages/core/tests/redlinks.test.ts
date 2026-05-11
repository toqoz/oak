import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { buildGraph } from "../src/graph.js";
import { parseVault } from "../src/parse.js";
import { collectRedlinks, redlinkSlug } from "../src/redlinks.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(resolve(tmpdir(), "oak-redlinks-"));
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

describe("collectRedlinks", () => {
  it("collects one entry per unique redlink target", async () => {
    await page("a", "public", "see [[NotYet]] and [[AlsoNotYet]]\n");
    await page("b", "public", "see [[NotYet]] again\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = collectRedlinks(vault, graph);
    expect(r.map((e) => e.display).sort()).toEqual([
      "AlsoNotYet",
      "NotYet",
    ]);
    const notYet = r.find((e) => e.display === "NotYet")!;
    expect(notYet.bridges.map((b) => b.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores redlinks referenced only from private pages", async () => {
    await page("secret", "private", "see [[HiddenTarget]]\n");
    const vault = await parseVault(vaultDir);
    const graph = buildGraph(vault);
    const r = collectRedlinks(vault, graph);
    expect(r).toEqual([]);
  });

  it("emits URL-safe slugs", async () => {
    expect(redlinkSlug("Hello World")).toBe("hello-world");
    expect(redlinkSlug("[[Funky/Path]]")).toBe(redlinkSlug("Funky/Path"));
  });
});
