import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { branchExists } from "../src/git.js";
import {
  DEFAULT_PUBLISH_BRANCH,
  PUBLISH_WORKTREE_REL,
  collectPublishablePaths,
  pubBuild,
  pubInit,
  pubStatus,
} from "../src/publish-branch.js";
import { FEED_DATES_FILENAME, readFeedDates } from "../src/feed-dates.js";

const exec = promisify(execFile);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-pub-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeVault(): Promise<string> {
  const v = resolve(scratch, "vault");
  await mkdir(v, { recursive: true });
  await exec("git", ["-C", v, "init", "-q", "-b", "main"]);
  await exec("git", ["-C", v, "config", "commit.gpgsign", "false"]);
  await exec("git", ["-C", v, "config", "user.name", "test"]);
  await exec("git", ["-C", v, "config", "user.email", "test@example.com"]);
  await exec("git", [
    "-C",
    v,
    "commit",
    "--allow-empty",
    "-m",
    "init: test vault",
  ]);
  return v;
}

async function makeTemplate(): Promise<string> {
  const t = resolve(scratch, "template");
  await mkdir(resolve(t, "src/pages"), { recursive: true });
  await writeFile(
    resolve(t, "package.json"),
    JSON.stringify({ name: "template", scripts: { build: "echo ok" } }),
    "utf8",
  );
  await writeFile(
    resolve(t, "astro.config.mjs"),
    "export default {};\n",
    "utf8",
  );
  await writeFile(
    resolve(t, "src/pages/index.astro"),
    "<h1>hi</h1>\n",
    "utf8",
  );
  return t;
}

// Write a markdown file with frontmatter visibility + body.
async function writePage(
  vault: string,
  relPath: string,
  visibility: "public" | "unlisted" | "private",
  body: string,
): Promise<void> {
  const abs = resolve(vault, relPath);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(
    abs,
    `---\nvisibility: ${visibility}\n---\n\n${body}`,
    "utf8",
  );
}

// Variant that also stamps `id:` (required for stable feed-dates keys)
// and an opt-in `feed: true` flag.
async function writeFeedPage(
  vault: string,
  relPath: string,
  visibility: "public" | "unlisted" | "private",
  id: string,
  feed: boolean,
  body: string,
): Promise<void> {
  const abs = resolve(vault, relPath);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(
    abs,
    [
      "---",
      `id: ${id}`,
      `visibility: ${visibility}`,
      `feed: ${feed}`,
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
}

describe("pubInit", () => {
  it("creates the orphan branch and lays down a worktree at .oak/pub", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();

    expect(await branchExists(vault, DEFAULT_PUBLISH_BRANCH)).toBe(false);
    const r = await pubInit({ vaultRoot: vault, templateDir: template });
    expect(r.branch).toBe(DEFAULT_PUBLISH_BRANCH);
    expect(r.branchCreated).toBe(true);
    expect(r.worktreePath).toBe(resolve(vault, PUBLISH_WORKTREE_REL));
    expect(r.initialCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.scaffoldCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.scaffoldCommit).not.toBe(r.initialCommit);
    expect(await branchExists(vault, DEFAULT_PUBLISH_BRANCH)).toBe(true);
    expect(r.scaffolded.sort()).toEqual(
      ["astro.config.mjs", "package.json", "src/pages/index.astro"].sort(),
    );
    // Scaffolded files land in the worktree, not in the main vault.
    const inWorktree = await stat(
      resolve(r.worktreePath, "astro.config.mjs"),
    );
    expect(inWorktree.isFile()).toBe(true);
    await expect(
      stat(resolve(vault, "astro.config.mjs")),
    ).rejects.toThrow();
  });

  it("commits the scaffold as a second commit on the orphan branch", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();

    const r = await pubInit({ vaultRoot: vault, templateDir: template });

    // Branch should have exactly two commits: init (empty) + scaffold.
    const log = await exec("git", [
      "-C",
      vault,
      "log",
      "--format=%H %s",
      DEFAULT_PUBLISH_BRANCH,
    ]);
    const lines = log.stdout.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("scaffold: oak pub-template");
    expect(lines[1]).toContain("init: oak oak/pub branch");

    // The scaffold commit's tree carries the expected files.
    const tree = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      r.scaffoldCommit!,
    ]);
    expect(tree.stdout.trim().split("\n").sort()).toEqual(
      ["astro.config.mjs", "package.json", "src/pages/index.astro"].sort(),
    );
  });

  it("writes `.oak` to .git/info/exclude so source-branch status stays clean", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    const excludeContent = await readFile(
      resolve(vault, ".git/info/exclude"),
      "utf8",
    );
    expect(excludeContent).toMatch(/^\.oak$/m);

    // Running again shouldn't duplicate the entry. Simulate by removing
    // the worktree and re-running init.
    await rm(resolve(vault, ".oak"), { recursive: true, force: true });
    await exec("git", ["-C", vault, "worktree", "prune"]);
    await pubInit({ vaultRoot: vault, templateDir: template });
    const reread = await readFile(
      resolve(vault, ".git/info/exclude"),
      "utf8",
    );
    const occurrences = reread.split(/\r?\n/).filter((l) => l === ".oak").length;
    expect(occurrences).toBe(1);
  });

  it("errors if the publish worktree path already exists", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    // Pre-create the worktree path so init must refuse.
    await mkdir(resolve(vault, PUBLISH_WORKTREE_REL), { recursive: true });
    await expect(
      pubInit({ vaultRoot: vault, templateDir: template }),
    ).rejects.toMatchObject({ code: "worktree-exists" });
  });

  it("does not move HEAD off the source branch", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writeFile(resolve(vault, "note.md"), "# note\n", "utf8");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "user content"]);

    const before = (
      await exec("git", ["-C", vault, "rev-parse", "HEAD"])
    ).stdout.trim();
    await pubInit({ vaultRoot: vault, templateDir: template });
    const after = (
      await exec("git", ["-C", vault, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);

    // Source branch is still main, no Astro files leaked here.
    const branchName = (
      await exec("git", ["-C", vault, "branch", "--show-current"])
    ).stdout.trim();
    expect(branchName).toBe("main");
    await expect(
      stat(resolve(vault, "astro.config.mjs")),
    ).rejects.toThrow();
  });
});

describe("collectPublishablePaths", () => {
  it("includes public and unlisted pages and excludes private ones", async () => {
    const vault = await makeVault();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await writePage(vault, "beta.md", "unlisted", "# Beta\n");
    await writePage(vault, "secret.md", "private", "# Secret\n");

    const paths = await collectPublishablePaths(vault);
    expect([...paths].sort()).toEqual(["alpha.md", "beta.md"]);
  });

  it("includes assets referenced from public pages", async () => {
    const vault = await makeVault();
    await mkdir(resolve(vault, "_assets"), { recursive: true });
    await writeFile(resolve(vault, "_assets/diagram.png"), "fakepng", "utf8");
    await writePage(
      vault,
      "alpha.md",
      "public",
      "Some text ![[diagram.png]] more.\n",
    );

    const paths = await collectPublishablePaths(vault);
    expect([...paths].sort()).toEqual(["_assets/diagram.png", "alpha.md"]);
  });

  it("does not include assets referenced only from private pages", async () => {
    const vault = await makeVault();
    await mkdir(resolve(vault, "_assets"), { recursive: true });
    await writeFile(resolve(vault, "_assets/leak.png"), "fakepng", "utf8");
    await writePage(
      vault,
      "secret.md",
      "private",
      "Hidden ![[leak.png]] image.\n",
    );

    const paths = await collectPublishablePaths(vault);
    expect(paths.size).toBe(0);
  });
});

describe("pubBuild", () => {
  it("syncs only publishable pages and their assets into the worktree", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();

    await mkdir(resolve(vault, "_assets"), { recursive: true });
    await writeFile(resolve(vault, "_assets/pub.png"), "publicpng", "utf8");
    await writeFile(resolve(vault, "_assets/secret.png"), "secretpng", "utf8");
    await writePage(vault, "alpha.md", "public", "Hi ![[pub.png]]\n");
    await writePage(vault, "secret.md", "private", "Hi ![[secret.png]]\n");

    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed vault"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    const r = await pubBuild({ vaultRoot: vault, push: false });
    expect(r.publishedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(false);

    // Worktree's vault/ subdir holds only the public page + its asset.
    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      DEFAULT_PUBLISH_BRANCH,
    ]);
    const files = ls.stdout.trim().split("\n").sort();
    expect(files).toContain("vault/alpha.md");
    expect(files).toContain("vault/_assets/pub.png");
    expect(files).not.toContain("vault/secret.md");
    expect(files).not.toContain("vault/_assets/secret.png");
  });

  it("makes no commit on a second run when nothing has changed", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    const r1 = await pubBuild({ vaultRoot: vault, push: false });
    expect(r1.committed).toBe(true);

    const r2 = await pubBuild({ vaultRoot: vault, push: false });
    expect(r2.committed).toBe(false);
    expect(r2.publishedCommit).toBe(r1.publishedCommit);
  });

  it("removes vault entries that no longer belong (visibility flip)", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    await pubBuild({ vaultRoot: vault, push: false });

    // Flip alpha to private — next publish should remove it.
    await writePage(vault, "alpha.md", "private", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "hide alpha"]);

    const r = await pubBuild({ vaultRoot: vault, push: false });
    expect(r.committed).toBe(true);

    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      DEFAULT_PUBLISH_BRANCH,
    ]);
    const files = ls.stdout.trim().split("\n");
    expect(files.some((f) => f === "vault/alpha.md")).toBe(false);
  });

  it("tags the commit subject with (dirty) when the source tree is dirty", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    // Dirty something so gitStatus reports dirty.
    await writeFile(resolve(vault, "draft.md"), "wip\n", "utf8");

    await pubBuild({ vaultRoot: vault, push: false });
    const subject = await exec("git", [
      "-C",
      vault,
      "log",
      "-1",
      "--format=%s",
      DEFAULT_PUBLISH_BRANCH,
    ]);
    expect(subject.stdout.trim()).toMatch(/^publish: [0-9a-f]{40} \(dirty\)$/);
  });

  it("refuses to build when the publish branch is missing", async () => {
    const vault = await makeVault();
    await expect(
      pubBuild({ vaultRoot: vault, push: false }),
    ).rejects.toMatchObject({ code: "branch-missing" });
  });

  it("refuses to build when the worktree is missing", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    // Remove the worktree dir behind oak's back.
    await rm(resolve(vault, PUBLISH_WORKTREE_REL), {
      recursive: true,
      force: true,
    });
    await exec("git", ["-C", vault, "worktree", "prune"]);

    await expect(
      pubBuild({ vaultRoot: vault, push: false }),
    ).rejects.toMatchObject({ code: "worktree-missing" });
  });
});

describe("pubBuild / feed-dates", () => {
  it("stamps a feed-dates.json sidecar at the worktree root for feed-eligible pages", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writeFeedPage(vault, "alpha.md", "public", "page-alpha", true, "# Alpha\n");
    await writeFeedPage(vault, "beta.md", "public", "page-beta", false, "# Beta\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    const r = await pubBuild({ vaultRoot: vault, push: false });

    expect(r.feed.eligible).toBe(1);
    expect(r.feed.added).toBe(1);
    expect(r.feed.reused).toBe(0);
    expect(r.feed.dates["page-alpha"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const sidecar = await readFeedDates(
      resolve(vault, PUBLISH_WORKTREE_REL, FEED_DATES_FILENAME),
    );
    expect(Object.keys(sidecar)).toEqual(["page-alpha"]);

    // The sidecar is tracked on the publish branch alongside vault/.
    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      DEFAULT_PUBLISH_BRANCH,
    ]);
    expect(ls.stdout.trim().split("\n")).toContain(FEED_DATES_FILENAME);
  });

  it("keeps the same stamped date across repeated builds", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writeFeedPage(vault, "alpha.md", "public", "page-alpha", true, "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    const r1 = await pubBuild({ vaultRoot: vault, push: false });
    const stamp = r1.feed.dates["page-alpha"]!;

    // Wait long enough that nowIsoSecond would advance if called again.
    await new Promise((r) => setTimeout(r, 1100));

    const r2 = await pubBuild({ vaultRoot: vault, push: false });
    expect(r2.feed.reused).toBe(1);
    expect(r2.feed.added).toBe(0);
    expect(r2.feed.dates["page-alpha"]).toBe(stamp);
  });

  it("does not stamp private or unlisted pages even when feed: true is set", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writeFeedPage(vault, "u.md", "unlisted", "page-u", true, "# U\n");
    await writeFeedPage(vault, "p.md", "private", "page-p", true, "# P\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await pubInit({ vaultRoot: vault, templateDir: template });
    const r = await pubBuild({ vaultRoot: vault, push: false });
    expect(r.feed.eligible).toBe(0);
    expect(r.feed.dates).toEqual({});
  });
});

describe("pubStatus", () => {
  it("reports branch and worktree presence", async () => {
    const vault = await makeVault();
    const before = await pubStatus(vault);
    expect(before.branchExists).toBe(false);
    expect(before.worktreeExists).toBe(false);
    expect(before.worktreePath).toBe(resolve(vault, PUBLISH_WORKTREE_REL));

    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });

    const after = await pubStatus(vault);
    expect(after.branchExists).toBe(true);
    expect(after.worktreeExists).toBe(true);
  });
});

describe("pubInit / workspace dep rewriting", () => {
  async function makeMonorepoTemplate(): Promise<{ template: string }> {
    const root = resolve(scratch, "monorepo");
    const template = resolve(root, "packages/template");
    const libDir = resolve(root, "packages/lib");
    const templateNm = resolve(template, "node_modules/@my/lib");

    await mkdir(template, { recursive: true });
    await mkdir(libDir, { recursive: true });
    await mkdir(templateNm, { recursive: true });

    await writeFile(
      resolve(libDir, "package.json"),
      JSON.stringify({ name: "@my/lib", version: "1.2.3" }),
      "utf8",
    );
    await writeFile(
      resolve(templateNm, "package.json"),
      JSON.stringify({ name: "@my/lib", version: "1.2.3" }),
      "utf8",
    );
    await writeFile(
      resolve(template, "package.json"),
      JSON.stringify({
        name: "tpl",
        dependencies: {
          "@my/lib": "workspace:*",
          astro: "^5.0.0",
        },
        devDependencies: {
          "@my/lib-dev": "workspace:^1.0.0",
        },
      }),
      "utf8",
    );

    return { template };
  }

  it("rewrites workspace:* deps in scaffolded package.json", async () => {
    const vault = await makeVault();
    const { template } = await makeMonorepoTemplate();

    const r = await pubInit({ vaultRoot: vault, templateDir: template });
    const scaffolded = JSON.parse(
      await readFile(resolve(r.worktreePath, "package.json"), "utf8"),
    );
    expect(scaffolded.dependencies["@my/lib"]).toMatch(/^file:\//);
    expect(scaffolded.dependencies.astro).toBe("^5.0.0");
    expect(scaffolded.devDependencies["@my/lib-dev"]).toBe("workspace:^1.0.0");
    expect(r.rewrittenDevDeps).toHaveLength(1);
    expect(r.rewrittenDevDeps[0]).toMatchObject({
      file: "package.json",
      name: "@my/lib",
    });
  });
});
