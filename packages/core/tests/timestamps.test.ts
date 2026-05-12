import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  isOakManaged,
  nowIsoSecond,
  recoverCreatedTimestamp,
  setCreatedAndModified,
  setCreatedIfMissing,
  setModified,
  shouldBumpModified,
  withTimestampUpdate,
  withTimestampUpdateAndRecovery,
} from "../src/timestamps.js";

const exec = promisify(execFile);

const oakFile = (extraFm: string, body: string): string =>
  `---\nid: 01HX0000000000000000000001\ntitle: T${extraFm ? `\n${extraFm}` : ""}\n---\n\n${body}`;

describe("nowIsoSecond", () => {
  it("formats UTC second-precision Z", () => {
    expect(nowIsoSecond(new Date("2026-05-10T12:34:56.789Z"))).toBe(
      "2026-05-10T12:34:56Z",
    );
  });
});

describe("shouldBumpModified", () => {
  it("returns false when the file is unchanged", () => {
    const r = oakFile("", "hello");
    expect(shouldBumpModified(r, r)).toBe(false);
  });

  it("returns true when the body changed", () => {
    expect(
      shouldBumpModified(oakFile("", "hello"), oakFile("", "hello world")),
    ).toBe(true);
  });

  // The title now lives in the body's first `# ...` heading, so a
  // genuine title rename surfaces as a body-changed save. Poking the
  // legacy `title:` field on an unmigrated page is just another opaque
  // frontmatter edit — oak no longer reads it, so we don't bump for
  // it either. (Running `oak migrate` lifts the field into a body h1.)
  it("returns false when only legacy frontmatter `title:` changed", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: Old\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: New\n---\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  it("returns false when only frontmatter (non-body) changed", () => {
    const before = `---\nid: 01HX0000000000000000000001\nvisibility: private\n---\n\n# T\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\nvisibility: public\n---\n\n# T\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  it("never bumps a file without an oak `id:` (plain markdown)", () => {
    expect(shouldBumpModified("hello", "hello world")).toBe(false);
  });

  // A user editing `modified` by hand (e.g. correcting a bad import,
  // pinning a value before a bulk operation) must not be clobbered by
  // the auto-bump. The bump rule respects user intent: if `modified`
  // itself changed in this save, the user wanted that value to stick.
  it("does not bump when the user hand-edits `modified` (FM-only edit)", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2020-12-31T00:00:00Z'\n---\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  // The pinning rule trumps body changes too: editing `modified`
  // alongside a body edit is unambiguous user intent. (Why else
  // would they touch the field?) Don't clobber.
  it("does not bump even when body changes, if user also hand-edited `modified`", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2020-12-31T00:00:00Z'\n---\n\nbody changed\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  it("does not bump when the user adds `modified` from absent", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2020-12-31T00:00:00Z'\n---\n\nbody changed\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  // Removing `modified` is not "pinning a value" — there's no value
  // to pin. Treat it as a normal save and let the bump rule run, so
  // an accidental delete heals on the next body edit.
  it("bumps normally when the user removes `modified` and edits body", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\n---\n\nbody changed\n`;
    expect(shouldBumpModified(before, after)).toBe(true);
  });

  // The "same value" case is the unchanged-FM case: the user did
  // NOT touch `modified`, so it has no claim on bump suppression.
  it("bumps normally when `modified` is unchanged and body changes", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody changed\n`;
    expect(shouldBumpModified(before, after)).toBe(true);
  });

  it("does not bump when only `created` changes (also hand-edited)", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2020-01-01T00:00:00Z'\n---\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });
});

describe("setModified / setCreatedAndModified", () => {
  it("setModified inserts when missing, replaces when present", () => {
    const noFm = oakFile("", "body\n");
    const stamped = setModified(noFm, "2026-05-10T00:00:00Z");
    expect(stamped).toContain("modified: '2026-05-10T00:00:00Z'");
    const restamped = setModified(stamped, "2026-05-11T00:00:00Z");
    expect(restamped).toContain("modified: '2026-05-11T00:00:00Z'");
    expect(restamped.match(/modified:/g)?.length).toBe(1);
  });

  it("setCreatedAndModified writes both fields", () => {
    const out = setCreatedAndModified(
      oakFile("", "body\n"),
      "2026-05-10T00:00:00Z",
    );
    expect(out).toContain("created: '2026-05-10T00:00:00Z'");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
  });
});

describe("withTimestampUpdate", () => {
  it("bumps when body changes", () => {
    const before = oakFile("", "body\n");
    const after = oakFile("", "body changed\n");
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
    expect(out).toContain("body changed");
  });

  it("does not bump on a pure-frontmatter edit (body unchanged)", () => {
    const before = `---\nid: 01HX0000000000000000000001\nvisibility: private\n---\n\n# T\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\nvisibility: public\n---\n\n# T\n\nbody\n`;
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toBe(after);
  });

  it("preserves an existing `created`", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\n---\n\nbody changed\n`;
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toContain("created: '2024-01-01T00:00:00Z'");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
  });

  it("leaves plain markdown alone", () => {
    const before = "hello\n";
    const after = "hello world\n";
    expect(withTimestampUpdate(before, after, "2026-05-10T00:00:00Z")).toBe(
      after,
    );
  });
});

describe("isOakManaged", () => {
  it("requires a non-empty `id:` field", () => {
    expect(isOakManaged(oakFile("", "x"))).toBe(true);
    expect(isOakManaged("---\ntitle: x\n---\n\nbody\n")).toBe(false);
    expect(isOakManaged("plain markdown\n")).toBe(false);
  });
});

describe("setCreatedIfMissing", () => {
  it("inserts when the field is absent", () => {
    const out = setCreatedIfMissing(oakFile("", "body\n"), "2024-01-01T00:00:00Z");
    expect(out).toContain("created: '2024-01-01T00:00:00Z'");
  });

  it("never overwrites a present value", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2020-01-01T00:00:00Z'\n---\n\nbody\n`;
    const out = setCreatedIfMissing(before, "2024-01-01T00:00:00Z");
    expect(out).toBe(before);
  });
});

describe("recoverCreatedTimestamp", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), "oak-ts-rec-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("falls back to file mtime when the path is not in a git repo", async () => {
    const fp = resolve(scratch, "note.md");
    await writeFile(fp, "x");
    const recovered = await recoverCreatedTimestamp(scratch, fp);
    // Format check is enough; we only assert the cascade reached the
    // birthtime/mtime branch (the format is identical to nowIsoSecond's).
    expect(recovered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  // birthtime is the right answer for "created" but only on FS that
  // record it. Force a divergence (mtime far in the future) and
  // confirm the cascade picked birthtime, not mtime. Skip when the
  // host FS doesn't track birthtime — running the assertion against
  // a fabricated value would prove nothing.
  it("prefers birthtime over mtime when both are available and birthtime <= mtime", async () => {
    const fp = resolve(scratch, "note.md");
    await writeFile(fp, "x");
    const initial = await stat(fp);
    if (initial.birthtimeMs <= 0 || initial.birthtimeMs > initial.mtimeMs) {
      // Host FS doesn't carry a real birthtime — bail rather than
      // assert against meaningless data.
      return;
    }
    const future = new Date(initial.mtimeMs + 5 * 365 * 24 * 60 * 60 * 1000);
    await utimes(fp, future, future);
    const recovered = await recoverCreatedTimestamp(null, fp);
    const recoveredMs = new Date(recovered).getTime();
    // Picked birthtime → recoveredMs ≈ initial.birthtimeMs.
    // Picked mtime → recoveredMs ≈ future.getTime() (5y in the future).
    // The gap is years, so a generous threshold is safe.
    expect(recoveredMs).toBeLessThan(future.getTime() - 86_400_000);
    expect(Math.abs(recoveredMs - initial.birthtimeMs)).toBeLessThan(2_000);
  });

  // When the FS reports a bogus birthtime that's *after* mtime
  // (happens on copy/restore), the cascade must reject it and use
  // mtime as the older, more honest bound.
  it("falls back to mtime when birthtime is later than mtime", async () => {
    const fp = resolve(scratch, "note.md");
    await writeFile(fp, "x");
    const initial = await stat(fp);
    if (initial.birthtimeMs <= 0) return;
    // Push mtime to a value before birthtime — simulates a restore
    // where contents are older than the inode.
    const past = new Date(initial.birthtimeMs - 5 * 365 * 24 * 60 * 60 * 1000);
    await utimes(fp, past, past);
    const recovered = await recoverCreatedTimestamp(null, fp);
    const recoveredMs = new Date(recovered).getTime();
    // Should land on mtime (≈ past), not birthtime.
    expect(Math.abs(recoveredMs - past.getTime())).toBeLessThan(2_000);
  });

  it("falls back to `now` when the file does not exist", async () => {
    const recovered = await recoverCreatedTimestamp(
      scratch,
      resolve(scratch, "nope.md"),
      "2030-01-02T03:04:05Z",
    );
    expect(recovered).toBe("2030-01-02T03:04:05Z");
  });

  it("works when vaultRoot is null (skips git, uses mtime)", async () => {
    const fp = resolve(scratch, "note.md");
    await writeFile(fp, "x");
    const recovered = await recoverCreatedTimestamp(null, fp);
    expect(recovered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("recovers from git when the file has a commit history", async () => {
    // Initialise a tiny repo with one commit. Skip the test if the
    // sandbox blocks git (commit signing infra) — the cascade itself
    // is exercised by the no-git tests above; this one verifies the
    // git branch is wired up when the environment cooperates.
    try {
      await exec("git", ["init", "-q"], { cwd: scratch });
      await exec("git", ["config", "user.email", "t@t"], { cwd: scratch });
      await exec("git", ["config", "user.name", "t"], { cwd: scratch });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: scratch });
      const fp = resolve(scratch, "note.md");
      await writeFile(fp, "x");
      await exec("git", ["add", "note.md"], { cwd: scratch });
      await exec(
        "git",
        ["commit", "-q", "--date=2020-01-02T03:04:05+00:00", "-m", "init"],
        {
          cwd: scratch,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2020-01-02T03:04:05+00:00",
            GIT_COMMITTER_DATE: "2020-01-02T03:04:05+00:00",
          },
        },
      );
      const recovered = await recoverCreatedTimestamp(scratch, fp);
      expect(recovered).toBe("2020-01-02T03:04:05Z");
    } catch (err) {
      const msg = (err as Error).message;
      if (/sign|signing|gpg/i.test(msg)) {
        // Sandbox refuses to commit; the cascade's other branches
        // are still validated by the preceding tests.
        return;
      }
      throw err;
    }
  });
});

describe("withTimestampUpdateAndRecovery", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), "oak-ts-wtur-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("backfills a missing `created` even when modified does not bump", async () => {
    const fp = resolve(scratch, "note.md");
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: private\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: public\n---\n\nbody\n`;
    await writeFile(fp, after);
    const out = await withTimestampUpdateAndRecovery(
      before,
      after,
      scratch,
      fp,
      "2026-05-10T00:00:00Z",
    );
    expect(out).toContain("created:");
    // Modified should NOT be added: pure-frontmatter edit, body unchanged.
    expect(out).not.toContain("modified:");
  });

  it("bumps modified AND backfills created when both are needed", async () => {
    const fp = resolve(scratch, "note.md");
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\n---\n\nbody changed\n`;
    await writeFile(fp, after);
    const out = await withTimestampUpdateAndRecovery(
      before,
      after,
      scratch,
      fp,
      "2026-05-10T00:00:00Z",
    );
    expect(out).toContain("created:");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
  });

  it("is a no-op when both fields are present and the file is unchanged", async () => {
    const fp = resolve(scratch, "note.md");
    const both = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\nmodified: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    await writeFile(fp, both);
    const out = await withTimestampUpdateAndRecovery(
      both,
      both,
      scratch,
      fp,
      "2026-05-10T00:00:00Z",
    );
    expect(out).toBe(both);
  });

  it("ignores plain markdown (no oak `id:`)", async () => {
    const fp = resolve(scratch, "plain.md");
    await writeFile(fp, "hello world\n");
    const out = await withTimestampUpdateAndRecovery(
      "hello\n",
      "hello world\n",
      scratch,
      fp,
      "2026-05-10T00:00:00Z",
    );
    expect(out).toBe("hello world\n");
  });
});
