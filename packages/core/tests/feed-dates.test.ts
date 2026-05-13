import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  readFeedDates,
  syncFeedDates,
  writeFeedDates,
} from "../src/feed-dates.js";
import { parseVault } from "../src/parse.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-feed-dates-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writePage(
  vault: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const abs = resolve(vault, relPath);
  await mkdir(resolve(abs, ".."), { recursive: true });
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", body);
  await writeFile(abs, lines.join("\n"), "utf8");
}

describe("readFeedDates", () => {
  it("returns an empty map when the file is absent", async () => {
    const out = await readFeedDates(resolve(scratch, "missing.json"));
    expect(out).toEqual({});
  });

  it("returns an empty map when the file is malformed JSON", async () => {
    const p = resolve(scratch, "bad.json");
    await writeFile(p, "{not json", "utf8");
    expect(await readFeedDates(p)).toEqual({});
  });

  it("drops entries whose values aren't string ISO timestamps", async () => {
    const p = resolve(scratch, "mixed.json");
    await writeFile(
      p,
      JSON.stringify({
        "good-id": "2026-05-12T10:00:00Z",
        "bad-id": 12345,
        "also-bad": null,
      }),
      "utf8",
    );
    expect(await readFeedDates(p)).toEqual({
      "good-id": "2026-05-12T10:00:00Z",
    });
  });
});

describe("writeFeedDates", () => {
  it("writes a sorted, pretty-printed JSON object with a trailing newline", async () => {
    const p = resolve(scratch, "out.json");
    await writeFeedDates(p, {
      "z-page": "2026-05-12T10:01:00Z",
      "a-page": "2026-05-12T10:00:00Z",
    });
    const raw = await readFile(p, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(
      [
        "{",
        '  "a-page": "2026-05-12T10:00:00Z",',
        '  "z-page": "2026-05-12T10:01:00Z"',
        "}",
        "",
      ].join("\n"),
    );
  });
});

describe("syncFeedDates", () => {
  it("stamps new entries for feed-eligible pages and persists them", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public", feed: true },
      "# Alpha\n",
    );

    const sidecar = resolve(scratch, "feed-dates.json");
    const r = await syncFeedDates(vault, sidecar, "2026-05-12T10:00:00Z");

    expect(r.eligible).toBe(1);
    expect(r.added).toBe(1);
    expect(r.reused).toBe(0);
    expect(r.stale).toBe(0);
    expect(r.dates).toEqual({ "page-alpha": "2026-05-12T10:00:00Z" });

    const persisted = await readFeedDates(sidecar);
    expect(persisted).toEqual({ "page-alpha": "2026-05-12T10:00:00Z" });
  });

  it("reuses existing entries on a second pass instead of restamping", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public", feed: true },
      "# Alpha\n",
    );

    const sidecar = resolve(scratch, "feed-dates.json");
    await syncFeedDates(vault, sidecar, "2026-05-12T10:00:00Z");
    const r = await syncFeedDates(vault, sidecar, "2099-01-01T00:00:00Z");

    expect(r.added).toBe(0);
    expect(r.reused).toBe(1);
    expect(r.dates).toEqual({ "page-alpha": "2026-05-12T10:00:00Z" });
  });

  it("ignores pages without feed: true", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public" },
      "# Alpha\n",
    );
    await writePage(
      vault,
      "beta.md",
      { id: "page-beta", visibility: "public", feed: false },
      "# Beta\n",
    );

    const sidecar = resolve(scratch, "feed-dates.json");
    const r = await syncFeedDates(vault, sidecar, "2026-05-12T10:00:00Z");
    expect(r.eligible).toBe(0);
    expect(r.dates).toEqual({});
  });

  it("excludes non-public visibilities even when feed: true is set", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "unlisted.md",
      { id: "page-unlisted", visibility: "unlisted", feed: true },
      "# Unlisted\n",
    );
    await writePage(
      vault,
      "private.md",
      { id: "page-private", visibility: "private", feed: true },
      "# Private\n",
    );

    const sidecar = resolve(scratch, "feed-dates.json");
    const r = await syncFeedDates(vault, sidecar, "2026-05-12T10:00:00Z");
    expect(r.eligible).toBe(0);
    expect(r.dates).toEqual({});
  });

  it("flags feed: true on a non-public page as a parse-level error", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "unlisted.md",
      { id: "page-unlisted", visibility: "unlisted", feed: true },
      "# Unlisted\n",
    );
    await writePage(
      vault,
      "private.md",
      { id: "page-private", visibility: "private", feed: true },
      "# Private\n",
    );
    await writePage(
      vault,
      "ok.md",
      { id: "page-ok", visibility: "public", feed: true },
      "# OK\n",
    );

    const parsed = await parseVault(vault);
    const issuesFor = (id: string) =>
      parsed.pages.get(id)?.parseIssues ?? [];
    expect(issuesFor("page-unlisted").map((i) => i.code)).toContain(
      "feed-non-public",
    );
    expect(issuesFor("page-private").map((i) => i.code)).toContain(
      "feed-non-public",
    );
    expect(issuesFor("page-ok").map((i) => i.code)).not.toContain(
      "feed-non-public",
    );
  });

  it("retains stale entries when a page toggles feed: true off", async () => {
    const vault = resolve(scratch, "vault");
    await mkdir(vault, { recursive: true });
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public", feed: true },
      "# Alpha\n",
    );

    const sidecar = resolve(scratch, "feed-dates.json");
    await syncFeedDates(vault, sidecar, "2026-05-12T10:00:00Z");

    // Flip feed off.
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public", feed: false },
      "# Alpha\n",
    );
    const r = await syncFeedDates(vault, sidecar, "2026-05-13T10:00:00Z");

    expect(r.eligible).toBe(0);
    expect(r.added).toBe(0);
    expect(r.reused).toBe(0);
    expect(r.stale).toBe(1);
    expect(r.dates).toEqual({ "page-alpha": "2026-05-12T10:00:00Z" });

    // And re-toggling on must reuse the original stamp.
    await writePage(
      vault,
      "alpha.md",
      { id: "page-alpha", visibility: "public", feed: true },
      "# Alpha\n",
    );
    const r2 = await syncFeedDates(vault, sidecar, "2099-01-01T00:00:00Z");
    expect(r2.reused).toBe(1);
    expect(r2.added).toBe(0);
    expect(r2.dates["page-alpha"]).toBe("2026-05-12T10:00:00Z");
  });
});
