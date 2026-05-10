import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { branchExists, headCommit } from "../src/git.js";
import { pubBuild, pubInit, pubStatus } from "../src/publish-branch.js";

const exec = promisify(execFile);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-pub-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// Stand up a git repo without ensureGitRepo() so we can disable
// commit signing before any commit is made — some CI environments
// inherit a global signing requirement that the test process can't
// satisfy.
async function makeVault(): Promise<string> {
  const v = resolve(scratch, "vault");
  await mkdir(v, { recursive: true });
  await exec("git", ["-C", v, "init", "-q", "-b", "main"]);
  await exec("git", ["-C", v, "config", "commit.gpgsign", "false"]);
  await exec("git", ["-C", v, "config", "user.name", "test"]);
  await exec("git", ["-C", v, "config", "user.email", "test@example.com"]);
  // Initial commit so HEAD exists for branch / worktree operations.
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

async function makeBuildArtifact(vault: string): Promise<string> {
  const dir = resolve(vault, "dist");
  await mkdir(resolve(dir, "_astro"), { recursive: true });
  await writeFile(resolve(dir, "index.html"), "<html>hi</html>", "utf8");
  await writeFile(resolve(dir, "_astro/style.css"), "body{}", "utf8");
  return dir;
}

describe("pubInit", () => {
  it("creates the orphan branch and scaffolds template files", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();

    expect(await branchExists(vault, "public")).toBe(false);
    const r = await pubInit({
      vaultRoot: vault,
      templateDir: template,
    });
    expect(r.branch).toBe("public");
    expect(r.branchCreated).toBe(true);
    expect(r.initialCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await branchExists(vault, "public")).toBe(true);
    expect(r.scaffolded.sort()).toEqual(
      ["astro.config.mjs", "package.json", "src/pages/index.astro"].sort(),
    );
    expect(r.skipped).toEqual([]);
  });

  it("is idempotent on the branch and skips existing scaffold files", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();

    await pubInit({ vaultRoot: vault, templateDir: template });
    // User edited package.json — second init must not overwrite it.
    await writeFile(
      resolve(vault, "package.json"),
      JSON.stringify({ name: "user-customized" }),
      "utf8",
    );
    const r2 = await pubInit({ vaultRoot: vault, templateDir: template });
    expect(r2.branchCreated).toBe(false);
    expect(r2.branchAlreadyExisted).toBe(true);
    expect(r2.scaffolded).toEqual([]);
    expect(r2.skipped.sort()).toEqual(
      ["astro.config.mjs", "package.json", "src/pages/index.astro"].sort(),
    );
  });

  it("does not move HEAD off the source branch", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await writeFile(resolve(vault, "note.md"), "# note\n", "utf8");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", [
      "-C",
      vault,
      "commit",
      "-m",
      "user content",
    ]);

    const before = await headCommit(vault);
    await pubInit({ vaultRoot: vault, templateDir: template });
    const after = await headCommit(vault);
    expect(after).toBe(before);
  });
});

describe("pubBuild", () => {
  it("publishes the build artifact to the branch as a new commit", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    await makeBuildArtifact(vault);

    // Source-side commit so the message has something to reference.
    await writeFile(resolve(vault, "note.md"), "# note\n", "utf8");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "add note"]);
    const sourceHead = await headCommit(vault);

    const r = await pubBuild({
      vaultRoot: vault,
      branch: "public",
      source: "dist",
      push: false,
    });
    expect(r.publishedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.sourceCommit).toBe(sourceHead);
    expect(r.checkpointCommit).toBeNull();
    expect(r.pushed).toBe(false);

    // Branch HEAD should have the published artifacts.
    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    ]);
    const files = ls.stdout.trim().split("\n").sort();
    expect(files).toEqual(["_astro/style.css", "index.html"]);

    // Commit subject embeds the source HEAD.
    const subject = await exec("git", [
      "-C",
      vault,
      "log",
      "-1",
      "--format=%s",
      "public",
    ]);
    expect(subject.stdout.trim()).toBe(`publish: ${sourceHead}`);
  });

  it("auto-checkpoints when the working tree is dirty", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    await makeBuildArtifact(vault);

    // Dirty file outside dist/.
    await writeFile(resolve(vault, "note.md"), "# wip\n", "utf8");

    const r = await pubBuild({
      vaultRoot: vault,
      source: "dist",
      push: false,
    });
    expect(r.sourceDirty).toBe(true);
    expect(r.checkpointCommit).toMatch(/^[0-9a-f]{40}$/);
    // After auto-checkpoint, sourceCommit should be the checkpoint commit.
    expect(r.sourceCommit).toBe(r.checkpointCommit);
  });

  it("refuses to build when the publish branch is missing", async () => {
    const vault = await makeVault();
    await makeBuildArtifact(vault);
    await expect(
      pubBuild({ vaultRoot: vault, source: "dist", push: false }),
    ).rejects.toMatchObject({ code: "branch-missing" });
  });

  it("refuses --no-checkpoint with a dirty tree", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    await makeBuildArtifact(vault);
    await writeFile(resolve(vault, "note.md"), "# wip\n", "utf8");

    await expect(
      pubBuild({
        vaultRoot: vault,
        source: "dist",
        push: false,
        noCheckpoint: true,
      }),
    ).rejects.toMatchObject({ code: "dirty-tree" });
  });

  it("refuses to build when source dir is missing", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });

    await expect(
      pubBuild({ vaultRoot: vault, source: "dist", push: false }),
    ).rejects.toMatchObject({ code: "source-missing" });
  });

  it("re-publish replaces all files (no leftovers from prior commit)", async () => {
    const vault = await makeVault();
    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });
    await makeBuildArtifact(vault);
    await pubBuild({ vaultRoot: vault, source: "dist", push: false });

    // Replace dist with a different set of files.
    await rm(resolve(vault, "dist"), { recursive: true, force: true });
    await mkdir(resolve(vault, "dist"), { recursive: true });
    await writeFile(
      resolve(vault, "dist/index.html"),
      "<html>v2</html>",
      "utf8",
    );
    await pubBuild({ vaultRoot: vault, source: "dist", push: false });

    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    ]);
    const files = ls.stdout.trim().split("\n").sort();
    // _astro/style.css from the first publish must be gone.
    expect(files).toEqual(["index.html"]);
  });
});

describe("pubStatus", () => {
  it("reports whether the publish branch exists", async () => {
    const vault = await makeVault();
    const before = await pubStatus(vault);
    expect(before.branchExists).toBe(false);

    const template = await makeTemplate();
    await pubInit({ vaultRoot: vault, templateDir: template });

    const after = await pubStatus(vault);
    expect(after.branchExists).toBe(true);
  });
});

describe("pubInit / workspace dep rewriting", () => {
  // Build a self-contained mini-monorepo so the test doesn't depend on
  // oak's own packages being installable. The template references a
  // sibling fake "@my/lib" package via workspace:*; pubInit should
  // resolve that to the on-disk path.
  async function makeMonorepoTemplate(): Promise<{
    template: string;
    libDir: string;
  }> {
    const root = resolve(scratch, "monorepo");
    const template = resolve(root, "packages/template");
    const libDir = resolve(root, "packages/lib");
    const templateNm = resolve(template, "node_modules/@my/lib");

    await mkdir(template, { recursive: true });
    await mkdir(libDir, { recursive: true });
    await mkdir(templateNm, { recursive: true });

    // The library being referenced.
    await writeFile(
      resolve(libDir, "package.json"),
      JSON.stringify({ name: "@my/lib", version: "1.2.3" }),
      "utf8",
    );

    // Symlink-style: place a copy of @my/lib's package.json under the
    // template's node_modules so require.resolve can find it. Use a
    // real copy rather than a symlink to keep the test platform-
    // agnostic.
    await writeFile(
      resolve(templateNm, "package.json"),
      JSON.stringify({ name: "@my/lib", version: "1.2.3" }),
      "utf8",
    );

    // Template package with a workspace ref + a non-workspace ref.
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

    return { template, libDir };
  }

  it("rewrites workspace:* deps to file: refs pointing at the resolved package", async () => {
    const vault = await makeVault();
    const { template } = await makeMonorepoTemplate();

    const r = await pubInit({ vaultRoot: vault, templateDir: template });

    const scaffolded = JSON.parse(
      await readFile(resolve(vault, "package.json"), "utf8"),
    );
    // The exact resolved path depends on whether require.resolve walks
    // up from the template (and finds the local node_modules copy) or
    // follows a symlink to the workspace source. Both shapes are valid
    // installations; require either an absolute file: ref ending in
    // the package name's last segment.
    const lib = scaffolded.dependencies["@my/lib"] as string;
    expect(lib.startsWith("file:/")).toBe(true);
    expect(lib).toMatch(/\/lib$/);
    // Non-workspace ref left untouched.
    expect(scaffolded.dependencies.astro).toBe("^5.0.0");
    // Unresolvable workspace dep stays as-is (no file: rewrite available).
    expect(scaffolded.devDependencies["@my/lib-dev"]).toBe("workspace:^1.0.0");

    // Result reports the rewrite for the CLI to surface.
    expect(r.rewrittenDevDeps).toHaveLength(1);
    expect(r.rewrittenDevDeps[0]).toMatchObject({
      file: "package.json",
      name: "@my/lib",
    });
    expect(r.rewrittenDevDeps[0]!.resolvedTo).toMatch(/\/lib$/);
  });

  it("does nothing when the package.json has no workspace deps", async () => {
    const vault = await makeVault();
    const tpl = resolve(scratch, "plain-template");
    await mkdir(tpl, { recursive: true });
    await writeFile(
      resolve(tpl, "package.json"),
      JSON.stringify({
        name: "tpl",
        dependencies: { astro: "^5.0.0" },
      }),
      "utf8",
    );

    const r = await pubInit({ vaultRoot: vault, templateDir: tpl });
    expect(r.rewrittenDevDeps).toEqual([]);
    const scaffolded = JSON.parse(
      await readFile(resolve(vault, "package.json"), "utf8"),
    );
    expect(scaffolded.dependencies.astro).toBe("^5.0.0");
  });
});
