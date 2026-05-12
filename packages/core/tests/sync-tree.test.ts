import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { syncPaths } from "../src/sync-tree.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-sync-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

describe("syncPaths", () => {
  it("copies files in the include set, preserving directory structure", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(resolve(src, "a/b"), { recursive: true });
    await writeFile(resolve(src, "root.md"), "root", "utf8");
    await writeFile(resolve(src, "a/b/leaf.md"), "leaf", "utf8");
    await writeFile(resolve(src, "skip.md"), "skip", "utf8");

    const r = await syncPaths(src, dest, ["root.md", "a/b/leaf.md"]);
    expect(r.copied).toBe(2);
    expect(r.unchanged).toBe(0);
    expect(r.deleted).toBe(0);

    expect(await fileExists(resolve(dest, "root.md"))).toBe(true);
    expect(await fileExists(resolve(dest, "a/b/leaf.md"))).toBe(true);
    expect(await fileExists(resolve(dest, "skip.md"))).toBe(false);
  });

  it("skips unchanged files on a second run", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await writeFile(resolve(src, "a.md"), "hi", "utf8");

    const first = await syncPaths(src, dest, ["a.md"]);
    expect(first.copied).toBe(1);

    const second = await syncPaths(src, dest, ["a.md"]);
    expect(second.copied).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("re-copies when content changes (size or mtime differs)", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await writeFile(resolve(src, "a.md"), "v1", "utf8");
    await syncPaths(src, dest, ["a.md"]);

    // Mutate content; size + mtime both differ.
    await writeFile(resolve(src, "a.md"), "v1-changed", "utf8");
    const r = await syncPaths(src, dest, ["a.md"]);
    expect(r.copied).toBe(1);
    expect(await readFile(resolve(dest, "a.md"), "utf8")).toBe("v1-changed");
  });

  it("deletes dest files not present in the include set", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(resolve(src, "keep.md"), "k", "utf8");
    // Pre-existing stale entry in dest.
    await writeFile(resolve(dest, "stale.md"), "s", "utf8");

    const r = await syncPaths(src, dest, ["keep.md"]);
    expect(r.copied).toBe(1);
    expect(r.deleted).toBe(1);
    expect(await fileExists(resolve(dest, "stale.md"))).toBe(false);
    expect(await fileExists(resolve(dest, "keep.md"))).toBe(true);
  });

  it("prunes an entire dest subtree when nothing under it is in the include set", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await mkdir(resolve(dest, "old/nested"), { recursive: true });
    await writeFile(resolve(dest, "old/nested/x.md"), "x", "utf8");
    await writeFile(resolve(src, "new.md"), "n", "utf8");

    await syncPaths(src, dest, ["new.md"]);
    expect(await fileExists(resolve(dest, "old/nested/x.md"))).toBe(false);
    expect(await fileExists(resolve(dest, "new.md"))).toBe(true);
  });

  it("ignores include entries that resolve outside srcRoot", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await writeFile(resolve(src, "inside.md"), "x", "utf8");

    const r = await syncPaths(src, dest, [
      "inside.md",
      "../escape.md",
      "../../also-escape.md",
    ]);
    expect(r.copied).toBe(1);
    expect(await fileExists(resolve(dest, "inside.md"))).toBe(true);
  });

  it("preserves mtime so subsequent runs detect unchanged files", async () => {
    const src = resolve(scratch, "src");
    const dest = resolve(scratch, "dest");
    await mkdir(src, { recursive: true });
    await writeFile(resolve(src, "a.md"), "x", "utf8");
    // Pin mtime to a known instant so we can compare.
    const fixed = new Date("2024-01-01T00:00:00Z");
    await utimes(resolve(src, "a.md"), fixed, fixed);

    await syncPaths(src, dest, ["a.md"]);
    const destStat = await stat(resolve(dest, "a.md"));
    expect(destStat.mtime.toISOString()).toBe(fixed.toISOString());
  });
});
