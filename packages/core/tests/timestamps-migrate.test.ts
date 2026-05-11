import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { migrateTimestamps } from "../src/timestamps-migrate.js";

const exec = promisify(execFile);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-ts-migrate-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function nowSecondsIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

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
    // Both cascades reach for filesystem signals (birthtime / mtime)
    // when no git history exists, so for a freshly-written file the
    // values land in the same second and end up equal — but that's a
    // consequence of the file being brand new, not of an explicit
    // anchor. See the git-history test below for the case where the
    // values actually diverge.
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("created:");
    expect(raw).toContain("modified:");
  });

  it("preserves a present `created`, fills `modified` from mtime", async () => {
    // Capture a window around the write so we can assert that the
    // recovered `modified` came from mtime (which is set at write
    // time), not from the ancient `created` value.
    const beforeWrite = nowSecondsIso();
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      created: "2020-01-01T00:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateTimestamps({ vaultRoot: scratch });
    const afterRun = nowSecondsIso();
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.created).toBeUndefined();
    // `modified` no longer anchors to the (potentially ancient)
    // existing `created` — it comes from the modified-recovery
    // cascade (git last-touch → mtime → created → now). With no git
    // history this lands on mtime, which is the moment we just wrote
    // the file. Verify it's in the write window, not the 2020 value
    // that the old "anchor to created" behaviour would have written.
    const mod = report.entries[0]!.added.modified!;
    expect(mod).not.toBe("2020-01-01T00:00:00Z");
    expect(mod >= beforeWrite).toBe(true);
    expect(mod <= afterRun).toBe(true);
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("created: '2020-01-01T00:00:00Z'");
    expect(raw).toContain(`modified: '${mod}'`);
  });

  it("uses the oldest signal for `created` (mtime older than git first-add)", async () => {
    // Bootstrap-into-git scenario: a file existed on disk for years
    // before the vault was put under git. mtime preserves the
    // original creation; git first-add only knows about the
    // bootstrap commit. The migration must pick the older signal
    // (mtime here, because birthtime can't be set from userspace
    // and would be ≈ now in this test).
    try {
      await exec("git", ["init", "-q"], { cwd: scratch });
      await exec("git", ["config", "user.email", "t@t"], { cwd: scratch });
      await exec("git", ["config", "user.name", "t"], { cwd: scratch });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: scratch });
      const fp = resolve(scratch, "a.md");
      await writeFile(fp, oakPage("01HX0000000000000000000001", "old\n"));
      // Push mtime back to 2018, simulating a file that's been on
      // disk for years pre-dating the git bootstrap.
      const old = new Date("2018-03-04T05:06:07Z");
      await utimes(fp, old, old);
      await exec("git", ["add", "a.md"], { cwd: scratch });
      await exec(
        "git",
        ["commit", "-q", "-m", "bootstrap"],
        {
          cwd: scratch,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2024-12-01T00:00:00+00:00",
            GIT_COMMITTER_DATE: "2024-12-01T00:00:00+00:00",
          },
        },
      );
      // git add can re-touch mtime on some platforms; restore it.
      await utimes(fp, old, old);
      const report = await migrateTimestamps({ vaultRoot: scratch });
      expect(report.changed).toBe(1);
      // `created` picks the oldest evidence (mtime = 2018), NOT the
      // git first-add date (= 2024 bootstrap commit).
      expect(report.entries[0]!.added.created).toBe("2018-03-04T05:06:07Z");
    } catch (err) {
      const msg = (err as Error).message;
      if (/sign|signing|gpg/i.test(msg)) return;
      throw err;
    }
  });

  it("uses git last-touch commit for `modified` when history exists", async () => {
    // Initialise a tiny repo with two commits a year apart and verify
    // that the migration backfills `modified` from the *latest*
    // commit, not from `created` or mtime. Skip when the sandbox
    // refuses to commit (signing infra) — the same skip pattern as
    // the recoverCreatedTimestamp git test in timestamps.test.ts.
    try {
      await exec("git", ["init", "-q"], { cwd: scratch });
      await exec("git", ["config", "user.email", "t@t"], { cwd: scratch });
      await exec("git", ["config", "user.name", "t"], { cwd: scratch });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: scratch });
      const fp = resolve(scratch, "a.md");
      await writeFile(fp, oakPage("01HX0000000000000000000001", "v1\n"));
      await exec("git", ["add", "a.md"], { cwd: scratch });
      await exec(
        "git",
        ["commit", "-q", "-m", "first"],
        {
          cwd: scratch,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2020-01-02T03:04:05+00:00",
            GIT_COMMITTER_DATE: "2020-01-02T03:04:05+00:00",
          },
        },
      );
      await writeFile(fp, oakPage("01HX0000000000000000000001", "v2\n"));
      await exec("git", ["add", "a.md"], { cwd: scratch });
      await exec(
        "git",
        ["commit", "-q", "-m", "second"],
        {
          cwd: scratch,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2024-06-15T10:11:12+00:00",
            GIT_COMMITTER_DATE: "2024-06-15T10:11:12+00:00",
          },
        },
      );
      const report = await migrateTimestamps({ vaultRoot: scratch });
      expect(report.changed).toBe(1);
      expect(report.entries[0]!.added.created).toBe("2020-01-02T03:04:05Z");
      expect(report.entries[0]!.added.modified).toBe("2024-06-15T10:11:12Z");
    } catch (err) {
      const msg = (err as Error).message;
      if (/sign|signing|gpg/i.test(msg)) return;
      throw err;
    }
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
