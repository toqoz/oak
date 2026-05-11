import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { loadOakPagesInto } from "../src/astro/index.js";
import type { OakEntryData } from "../src/astro/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

let assetOutDir: string;
beforeEach(async () => {
  // Isolate the loader's asset side-effects so they don't pollute
  // packages/core/public when tests run from there.
  assetOutDir = await mkdtemp(resolve(tmpdir(), "oak-loader-assets-"));
});
afterEach(async () => {
  await rm(assetOutDir, { recursive: true, force: true });
});

// Astro's DataStore is a black box at this layer, so simulate the
// surface area the loader actually touches.
type StoredEntry = {
  id: string;
  data: Record<string, unknown>;
  body?: string;
  filePath?: string;
  digest?: string | number;
};

function makeStore() {
  const entries = new Map<string, StoredEntry>();
  return {
    set: (e: StoredEntry): boolean => {
      entries.set(e.id, e);
      return true;
    },
    clear: (): void => {
      entries.clear();
    },
    get: (id: string): StoredEntry | undefined => entries.get(id),
    keys: (): string[] => [...entries.keys()],
    values: (): StoredEntry[] => [...entries.values()],
    size: (): number => entries.size,
  };
}

function digest(input: Record<string, unknown> | string): string {
  return createHash("sha1")
    .update(typeof input === "string" ? input : JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

describe("oakLoader / loadOakPagesInto", () => {
  it("emits one entry per publishable page (default: public + unlisted)", async () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      assetOutDir,
    });
    expect(r.count).toBe(2);
    expect(store.keys().sort()).toEqual(["about", "hello"]);
    // Diary is private — must not be in the store.
    for (const e of store.values()) {
      const d = e.data as unknown as OakEntryData;
      expect(d.visibility).not.toBe("private");
    }
  });

  it("respects an explicit visibilityFilter", async () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      visibilityFilter: ["public"],
      assetOutDir,
    });
    // Only public-visibility pages.
    for (const e of store.values()) {
      const d = e.data as unknown as OakEntryData;
      expect(d.visibility).toBe("public");
    }
  });

  it("includes raw markdown body and filePath on each entry", async () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      assetOutDir,
    });
    const hello = store.get("hello");
    expect(hello).toBeDefined();
    expect(hello!.body).toContain("This is the home page");
    expect(hello!.filePath).toMatch(/Hello\.md$/);
    expect(hello!.digest).toMatch(/^[0-9a-f]+$/);
  });

  it("computes outbound and inbound link summaries (publishable-only)", async () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      assetOutDir,
    });
    const hello = store.get("hello")!.data as unknown as OakEntryData;
    const helloPages = hello.outbound.flatMap((o) =>
      o.kind === "page" ? [o.slug] : [],
    );
    expect(helloPages).toContain("about");

    const about = store.get("about")!.data as unknown as OakEntryData;
    expect(about.inbound.map((i) => i.slug)).toContain("hello");
  });

  it("clears the store before re-populating (idempotent re-runs)", async () => {
    const store = makeStore();
    store.set({ id: "stale", data: { title: "old" } });
    expect(store.size()).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      assetOutDir,
    });
    expect(store.get("stale")).toBeUndefined();
  });

  it("allows overriding the entry id", async () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await loadOakPagesInto(store as any, digest, {
      vault: fxRoot("publish-basic"),
      idFor: (page) => `page:${page.id}`,
      assetOutDir,
    });
    for (const k of store.keys()) {
      expect(k.startsWith("page:")).toBe(true);
    }
  });
});
