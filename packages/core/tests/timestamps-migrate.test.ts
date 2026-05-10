import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { migrateTimestamps } from "../src/timestamps-migrate.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-ts-migrate-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function oakPage(id: string, body: string, extra: Record<string, string> = {}): string {
  const lines = [`id: ${id}`, `title: T-${id.slice(-2)}`];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k}: '${v}'`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("migrateTimestamps", () => {
  it("fills both fields on a page that has neither", async () => {
    const fp = resolve(scratch, "a.md");
    await writeFile(fp, oakPage("01HX0000000000000000000001", "body\n"));
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.scanned).toBe(1);
    expect(report.changed).toBe(1);
    expect(report.unchanged).toBe(0);
    expect(report.entries[0]!.added.created).toBeDefined();
    expect(report.entries[0]!.added.modified).toBeDefined();
    // When both are recovered together, `modified` is anchored to the
    // (just-filled) `created`, not to `now`.
    expect(report.entries[0]!.added.modified).toBe(
      report.entries[0]!.added.created,
    );
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("created:");
    expect(raw).toContain("modified:");
  });

  it("preserves a present `created`, fills only `modified`", async () => {
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      created: "2020-01-01T00:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.created).toBeUndefined();
    // `modified` anchors to the existing `created`.
    expect(report.entries[0]!.added.modified).toBe("2020-01-01T00:00:00Z");
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("created: '2020-01-01T00:00:00Z'");
    expect(raw).toContain("modified: '2020-01-01T00:00:00Z'");
  });

  it("preserves a hand-edited `modified` (never overwrites)", async () => {
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      modified: "2019-06-15T12:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    // Only `created` was added; the user's `modified` value stands.
    expect(report.entries[0]!.added.modified).toBeUndefined();
    expect(report.entries[0]!.added.created).toBeDefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("modified: '2019-06-15T12:00:00Z'");
  });

  it("skips pages that already have both fields", async () => {
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      created: "2020-01-01T00:00:00Z",
      modified: "2020-01-02T00:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.changed).toBe(0);
    expect(report.unchanged).toBe(1);
    expect(report.entries).toEqual([]);
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe(before);
  });

  it("skips non-oak markdown (no `id:` frontmatter)", async () => {
    const fp = resolve(scratch, "plain.md");
    await writeFile(fp, "# heading\n\njust a note\n");
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.scanned).toBe(0);
    expect(report.changed).toBe(0);
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe("# heading\n\njust a note\n");
  });

  it("dry-run reports the plan without writing to disk", async () => {
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n");
    await writeFile(fp, before);
    const report = await migrateTimestamps({
      vaultRoot: scratch,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.created).toBeDefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe(before);
  });

  it("walks nested directories", async () => {
    const dir = resolve(scratch, "sub", "deeper");
    await writeFile(
      resolve(scratch, "top.md"),
      oakPage("01HX0000000000000000000001", "x\n"),
    );
    await (async () => {
      await rm(dir, { recursive: true, force: true });
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
    })();
    await writeFile(
      resolve(dir, "nested.md"),
      oakPage("01HX0000000000000000000002", "y\n"),
    );
    const report = await migrateTimestamps({ vaultRoot: scratch });
    expect(report.scanned).toBe(2);
    expect(report.changed).toBe(2);
  });
});
