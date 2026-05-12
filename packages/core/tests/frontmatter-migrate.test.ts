import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  LATEST_FRONTMATTER_VERSION,
  getFrontmatterVersion,
  migrateFrontmatter,
} from "../src/frontmatter-migrate.js";

const exec = promisify(execFile);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-fm-migrate-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function nowSecondsIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function oakPage(
  id: string,
  body: string,
  extra: Record<string, string> = {},
): string {
  const lines = [`id: ${id}`, `title: T-${id.slice(-2)}`];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k}: '${v}'`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("getFrontmatterVersion", () => {
  it("returns 1 when no version field is present (legacy file)", () => {
    expect(
      getFrontmatterVersion(oakPage("01HX0000000000000000000001", "body\n")),
    ).toBe(1);
  });

  it("returns the declared version when present", () => {
    const raw = `---\nversion: 2\nid: 01HX0000000000000000000001\ntitle: t\n---\n\nbody\n`;
    expect(getFrontmatterVersion(raw)).toBe(2);
  });

  it("treats a non-numeric version as 1 (recover via re-migration)", () => {
    const raw = `---\nversion: garbage\nid: 01HX0000000000000000000001\ntitle: t\n---\n\nbody\n`;
    expect(getFrontmatterVersion(raw)).toBe(1);
  });

  it("returns 1 for files without frontmatter", () => {
    expect(getFrontmatterVersion("plain markdown\n")).toBe(1);
  });
});

describe("migrateFrontmatter", () => {
  it("stamps version on a legacy page and fills both timestamps", async () => {
    const fp = resolve(scratch, "a.md");
    await writeFile(fp, oakPage("01HX0000000000000000000001", "body\n"));
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.scanned).toBe(1);
    expect(report.changed).toBe(1);
    expect(report.unchanged).toBe(0);
    expect(report.entries[0]!.fromVersion).toBe(1);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.created).toBeDefined();
    expect(report.entries[0]!.added.modified).toBeDefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    expect(raw).toContain("created:");
    expect(raw).toContain("modified:");
    expect(getFrontmatterVersion(raw)).toBe(LATEST_FRONTMATTER_VERSION);
  });

  it("preserves a present `created`, fills `modified` from mtime", async () => {
    const beforeWrite = nowSecondsIso();
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      created: "2020-01-01T00:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    const afterRun = nowSecondsIso();
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.created).toBeUndefined();
    const mod = report.entries[0]!.added.modified!;
    expect(mod).not.toBe("2020-01-01T00:00:00Z");
    expect(mod >= beforeWrite).toBe(true);
    expect(mod <= afterRun).toBe(true);
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("created: '2020-01-01T00:00:00Z'");
    expect(raw).toContain(`modified: '${mod}'`);
    expect(getFrontmatterVersion(raw)).toBe(LATEST_FRONTMATTER_VERSION);
  });

  it("uses the oldest signal for `created` (mtime older than git first-add)", async () => {
    try {
      await exec("git", ["init", "-q"], { cwd: scratch });
      await exec("git", ["config", "user.email", "t@t"], { cwd: scratch });
      await exec("git", ["config", "user.name", "t"], { cwd: scratch });
      await exec("git", ["config", "commit.gpgsign", "false"], { cwd: scratch });
      const fp = resolve(scratch, "a.md");
      await writeFile(fp, oakPage("01HX0000000000000000000001", "old\n"));
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
      await utimes(fp, old, old);
      const report = await migrateFrontmatter({ vaultRoot: scratch });
      expect(report.changed).toBe(1);
      expect(report.entries[0]!.added.created).toBe("2018-03-04T05:06:07Z");
    } catch (err) {
      const msg = (err as Error).message;
      if (/sign|signing|gpg/i.test(msg)) return;
      throw err;
    }
  });

  it("uses git last-touch commit for `modified` when history exists", async () => {
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
      const report = await migrateFrontmatter({ vaultRoot: scratch });
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
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.modified).toBeUndefined();
    expect(report.entries[0]!.added.created).toBeDefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain("modified: '2019-06-15T12:00:00Z'");
  });

  it("only stamps the version on a v1 page that already has both timestamps", async () => {
    // The pre-version era left a long tail of pages with `created`
    // and `modified` already populated but no `version:`. The
    // migration must still touch them — to set version: 2 — even
    // though it has no fields to fill.
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n", {
      created: "2020-01-01T00:00:00Z",
      modified: "2020-01-02T00:00:00Z",
    });
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.unchanged).toBe(0);
    expect(report.entries[0]!.fromVersion).toBe(1);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.created).toBeUndefined();
    expect(report.entries[0]!.added.modified).toBeUndefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    expect(raw).toContain("created: '2020-01-01T00:00:00Z'");
    expect(raw).toContain("modified: '2020-01-02T00:00:00Z'");
  });

  it("skips pages already at the latest version", async () => {
    const fp = resolve(scratch, "a.md");
    const before =
      `---\nversion: ${LATEST_FRONTMATTER_VERSION}\nid: 01HX0000000000000000000001\ntitle: t\ncreated: '2020-01-01T00:00:00Z'\nmodified: '2020-01-02T00:00:00Z'\n---\n\nbody\n`;
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.scanned).toBe(1);
    expect(report.changed).toBe(0);
    expect(report.unchanged).toBe(1);
    expect(report.entries).toEqual([]);
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe(before);
  });

  it("skips non-oak markdown (no `id:` frontmatter)", async () => {
    const fp = resolve(scratch, "plain.md");
    await writeFile(fp, "# heading\n\njust a note\n");
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.scanned).toBe(0);
    expect(report.changed).toBe(0);
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe("# heading\n\njust a note\n");
  });

  it("dry-run reports the plan without writing to disk", async () => {
    const fp = resolve(scratch, "a.md");
    const before = oakPage("01HX0000000000000000000001", "body\n");
    await writeFile(fp, before);
    const report = await migrateFrontmatter({
      vaultRoot: scratch,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.fromVersion).toBe(1);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.created).toBeDefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toBe(before);
  });

  it("lifts a v2 page's `title:` into a body h1 and stamps version 3", async () => {
    const fp = resolve(scratch, "a.md");
    const before =
      `---\nversion: 2\nid: 01HX0000000000000000000001\n` +
      `title: My Page\nvisibility: private\n` +
      `created: '2020-01-01T00:00:00Z'\nmodified: '2020-01-02T00:00:00Z'\n---\n\n` +
      `body line\n`;
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.fromVersion).toBe(2);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.titleMoved).toBe("My Page");
    const raw = await readFile(fp, "utf8");
    expect(raw).not.toMatch(/^title:/m);
    expect(raw).toContain("# My Page\n");
    expect(raw).toContain("body line");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    // The inserted heading lands directly after the fence, then a
    // blank line, then the preserved body.
    expect(raw).toMatch(/---\n\n# My Page\n\nbody line\n$/);
  });

  it("drops a v2 page's `title:` when the body already has an h1", async () => {
    const fp = resolve(scratch, "a.md");
    const before =
      `---\nversion: 2\nid: 01HX0000000000000000000001\n` +
      `title: Old Frontmatter Title\n` +
      `created: '2020-01-01T00:00:00Z'\nmodified: '2020-01-02T00:00:00Z'\n---\n\n` +
      `# Already In Body\n\nbody line\n`;
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.titleMoved).toBeUndefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).not.toMatch(/^title:/m);
    expect(raw).toContain("# Already In Body");
    expect(raw).not.toContain("# Old Frontmatter Title");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
  });

  it("stamps v3 without rewriting a v2 page that already has no `title:`", async () => {
    const fp = resolve(scratch, "a.md");
    const before =
      `---\nversion: 2\nid: 01HX0000000000000000000001\n` +
      `visibility: private\n` +
      `created: '2020-01-01T00:00:00Z'\nmodified: '2020-01-02T00:00:00Z'\n---\n\n` +
      `# Body Title\n\nbody line\n`;
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.added.titleMoved).toBeUndefined();
    const raw = await readFile(fp, "utf8");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    expect(raw).toContain("# Body Title");
    // Body content preserved byte-for-byte after the fence.
    expect(raw.split("---\n").slice(2).join("---\n")).toBe(
      "\n# Body Title\n\nbody line\n",
    );
  });

  it("walks a legacy v1 file end-to-end: title lifted + timestamps backfilled + id rewritten", async () => {
    // A pre-version-era file: no `version:`, no timestamps, title in
    // the frontmatter, no h1 in the body. The whole 1→4 cascade
    // should run in a single migration pass.
    const fp = resolve(scratch, "a.md");
    await writeFile(fp, oakPage("01HX0000000000000000000099", "body\n"));
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.fromVersion).toBe(1);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.created).toBeDefined();
    expect(report.entries[0]!.added.modified).toBeDefined();
    expect(report.entries[0]!.added.titleMoved).toBe("T-99");
    expect(report.entries[0]!.added.idRewritten?.from).toBe(
      "01HX0000000000000000000099",
    );
    expect(report.entries[0]!.added.idRewritten?.to).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    const raw = await readFile(fp, "utf8");
    expect(raw).not.toMatch(/^title:/m);
    expect(raw).toContain("# T-99\n");
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    expect(raw).not.toContain("01HX0000000000000000000099");
    expect(raw).toContain(`id: ${report.entries[0]!.added.idRewritten?.to}`);
  });

  it("rewrites a v3 page's id into grouped Base32 and stamps version 4", async () => {
    const fp = resolve(scratch, "a.md");
    const before =
      `---\nversion: 3\nid: 01HX0000000000000000000042\n` +
      `visibility: private\nslug: t-42\n` +
      `created: '2020-01-01T00:00:00Z'\nmodified: '2020-01-02T00:00:00Z'\n---\n\n` +
      `# T-42\n\nbody line\n`;
    await writeFile(fp, before);
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.changed).toBe(1);
    expect(report.entries[0]!.fromVersion).toBe(3);
    expect(report.entries[0]!.toVersion).toBe(LATEST_FRONTMATTER_VERSION);
    expect(report.entries[0]!.added.titleMoved).toBeUndefined();
    const rewritten = report.entries[0]!.added.idRewritten;
    expect(rewritten?.from).toBe("01HX0000000000000000000042");
    expect(rewritten?.to).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const raw = await readFile(fp, "utf8");
    expect(raw).not.toContain("01HX0000000000000000000042");
    expect(raw).toContain(`id: ${rewritten?.to}`);
    expect(raw).toContain(`version: ${LATEST_FRONTMATTER_VERSION}`);
    // Body preserved across the rewrite.
    expect(raw).toContain("# T-42\n\nbody line\n");
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
    const report = await migrateFrontmatter({ vaultRoot: scratch });
    expect(report.scanned).toBe(2);
    expect(report.changed).toBe(2);
  });
});
