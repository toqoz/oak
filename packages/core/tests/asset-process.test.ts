import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  processBodyAssets,
  resolveAssetSource,
} from "../src/asset-process.js";

let scratch: string;
let vault: string;
let outDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-asset-"));
  vault = resolve(scratch, "vault");
  outDir = resolve(scratch, "out");
  await mkdir(vault, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8ffff3f000005fe02fea3358184000000004945" +
    "4e44ae426082",
  "hex",
);

async function writeAsset(rel: string, content: Buffer = TINY_PNG): Promise<string> {
  const abs = resolve(vault, rel);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

describe("resolveAssetSource", () => {
  it("resolves bare filenames against <vault>/_assets/", () => {
    const out = resolveAssetSource(
      "/some/vault/post.md",
      "diagram.png",
      "/some/vault",
    );
    expect(out).toBe("/some/vault/_assets/diagram.png");
  });

  it("resolves vault-rooted paths from the vault root", () => {
    const out = resolveAssetSource(
      "/v/post.md",
      "_assets/x.png",
      "/v",
    );
    expect(out).toBe("/v/_assets/x.png");
  });

  it("resolves explicit relative paths against the page directory", () => {
    const out = resolveAssetSource(
      "/v/posts/post.md",
      "./img.png",
      "/v",
    );
    expect(out).toBe("/v/posts/img.png");
  });

  it("strips fragments and query strings before resolution", () => {
    const out = resolveAssetSource(
      "/v/post.md",
      "diagram.png#fig-1",
      "/v",
    );
    expect(out).toBe("/v/_assets/diagram.png");
  });

  it("refuses absolute filesystem paths", () => {
    expect(resolveAssetSource("/v/p.md", "/etc/passwd", "/v")).toBeNull();
  });

  it("returns null for empty target", () => {
    expect(resolveAssetSource("/v/p.md", "", "/v")).toBeNull();
  });
});

describe("processBodyAssets", () => {
  it("copies a wiki-embed asset, hashes it, and rewrites the body", async () => {
    await writeAsset("_assets/diagram.png");
    const body = "Hello\n\n![[diagram.png]]\n";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak",
    );
    expect(r.written.length).toBe(1);
    expect(r.written[0]!.url).toMatch(/^\/_oak\/[0-9a-f]{16}\.png$/);
    // Body now contains a markdown image with the rewritten URL.
    expect(r.body).toMatch(/!\[\]\(\/_oak\/[0-9a-f]{16}\.png\)/);
    // File was actually copied.
    const s = await stat(r.written[0]!.outputAbsPath);
    expect(s.isFile()).toBe(true);
    expect(s.size).toBe(TINY_PNG.length);
  });

  it("copies a markdown-image asset (relative path) and rewrites its URL", async () => {
    await writeAsset("posts/img.png");
    const body = "![alt](./img.png)\n";
    const r = await processBodyAssets(
      body,
      resolve(vault, "posts/post.md"),
      vault,
      outDir,
      "/_oak",
    );
    expect(r.written.length).toBe(1);
    expect(r.body).toMatch(/!\[alt\]\(\/_oak\/[0-9a-f]{16}\.png\)/);
  });

  it("dedupes by content hash across pages and references", async () => {
    await writeAsset("_assets/a.png");
    // Two refs to the same asset in one body.
    const body = "Top: ![[a.png]] and bottom: ![alt](_assets/a.png)";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak",
    );
    // One physical write, both URLs identical.
    expect(r.written.length).toBe(1);
    const dirEntries = await readdir(outDir);
    expect(dirEntries.length).toBe(1);
    // Both occurrences in the body should point at the same URL.
    const urls = [...r.body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(
      (m) => m[1]!,
    );
    expect(urls.length).toBe(2);
    expect(urls[0]).toBe(urls[1]);
  });

  it("preserves alt text on rewritten images", async () => {
    await writeAsset("_assets/x.png");
    const body = "![[x.png|figure 1]]";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak",
    );
    expect(r.body).toMatch(/!\[figure 1\]\(\/_oak\/[0-9a-f]{16}\.png\)/);
  });

it("reports missing assets without throwing or writing", async () => {
    const body = "![[nope.png]]";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak",
    );
    expect(r.written.length).toBe(0);
    expect(r.missing.length).toBe(1);
    expect(r.missing[0]!.target).toBe("nope.png");
    // Body unchanged.
    expect(r.body).toBe(body);
  });

  it("is a no-op for bodies without any asset references", async () => {
    const body = "Just text, no images.\n\n[[Page link]] only.";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak",
    );
    expect(r.body).toBe(body);
    expect(r.written.length).toBe(0);
  });

  it("trims trailing slashes from the URL prefix", async () => {
    await writeAsset("_assets/x.png");
    const body = "![[x.png]]";
    const r = await processBodyAssets(
      body,
      resolve(vault, "post.md"),
      vault,
      outDir,
      "/_oak/", // trailing slash
    );
    expect(r.written[0]!.url).not.toContain("//");
  });

  it("skips redundant copy when target file already exists", async () => {
    await writeAsset("_assets/a.png");
    const body = "![[a.png]]";
    // First call writes the file.
    await processBodyAssets(
      body,
      resolve(vault, "p.md"),
      vault,
      outDir,
      "/_oak",
    );
    const beforeMtime = (
      await stat((await readdir(outDir, { withFileTypes: true }))[0]!.name === "" ? "" : resolve(outDir, (await readdir(outDir))[0]!))
    ).mtimeMs;
    // Wait a tick so any new write would record a different mtime.
    await new Promise((r) => setTimeout(r, 10));
    // Second call should see the file present and skip the copy.
    await processBodyAssets(
      body,
      resolve(vault, "p.md"),
      vault,
      outDir,
      "/_oak",
    );
    const afterMtime = (
      await stat(resolve(outDir, (await readdir(outDir))[0]!))
    ).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });
});
