import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGraph,
  composePage,
  createPage,
  parseVault,
} from "../src/index.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-create-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("composePage (pure)", () => {
  it("derives a sane filename from the title and produces canonical YAML", () => {
    const composed = composePage({
      title: "My / Awesome: Page",
      generateId: () => "01HX000000000000000000NEW1",
    });
    expect(composed.vaultRelPath).toBe("My - Awesome- Page.md");
    expect(composed.id).toBe("01HX000000000000000000NEW1");
    expect(composed.visibility).toBe("private");
    expect(composed.llm).toBe("deny");
    expect(composed.slug).toBe("my-awesome-page");
    expect(composed.text).toContain("id: 01HX000000000000000000NEW1");
    // Title lives in the body as a `# ...` heading, not in frontmatter.
    expect(composed.text).not.toMatch(/^title:/m);
    expect(composed.text).toContain("# My / Awesome: Page");
    expect(composed.text).toMatch(/^---\n/);
  });

  it("respects --at and aliases", () => {
    const composed = composePage({
      title: "Notes",
      at: "journal/2026/04",
      aliases: [" daily ", "", "Diary"],
      visibility: "public",
      llm: "summary-only",
    });
    expect(composed.vaultRelPath).toBe("journal/2026/04.md");
    expect(composed.aliases).toEqual(["daily", "Diary"]);
    expect(composed.visibility).toBe("public");
    expect(composed.llm).toBe("summary-only");
    expect(composed.text).toContain("aliases:\n  - daily\n  - Diary");
  });

  it("rejects empty title and absolute --at", () => {
    expect(() => composePage({ title: "" })).toThrow(/title is required/);
    expect(() => composePage({ title: "x", at: "/etc/passwd" })).toThrow(
      /vault-relative/,
    );
  });
});

describe("createPage (filesystem)", () => {
  it("writes a file that parseVault can re-read", async () => {
    const result = await createPage(scratch, {
      title: "Hello world",
      visibility: "public",
      aliases: ["hello"],
    });
    expect(result.vaultRelPath).toBe("Hello world.md");
    const text = await readFile(result.filePath, "utf8");
    expect(text).toContain("id:");
    expect(text).toContain("# Hello world");
    expect(text).toContain("visibility: public");

    const vault = await parseVault(scratch);
    expect(vault.pages.size).toBe(1);
    const page = [...vault.pages.values()][0]!;
    expect(page.title).toBe("Hello world");
    expect(page.visibility).toBe("public");
    expect(page.aliases).toEqual(["hello"]);
    expect(page.parseIssues.filter((i) => i.severity === "error")).toEqual([]);

    const graph = buildGraph(vault);
    expect(graph.outgoing.get(page.id) ?? []).toEqual([]);
  });

  it("refuses to clobber an existing file", async () => {
    await createPage(scratch, { title: "dup" });
    await expect(
      createPage(scratch, { title: "dup" }),
    ).rejects.toThrow(/already exists/);
  });

  it("creates intermediate directories for nested --at", async () => {
    const r = await createPage(scratch, {
      title: "Daily",
      at: "journal/2026/04/04.md",
    });
    expect(r.vaultRelPath).toBe("journal/2026/04/04.md");
    const vault = await parseVault(scratch);
    expect(vault.pages.size).toBe(1);
  });
});
