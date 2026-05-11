import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the built CLI entry. The cli package's `pretest` (via the
// monorepo build step) should have produced this; if it hasn't, the
// tests fail loudly so we don't silently exercise stale code.
const cliBin = resolve(__dirname, "..", "dist", "index.js");

let scratch: string;

async function buildCliIfMissing(): Promise<void> {
  // Re-run the build to guarantee we're exercising the current
  // sources. tsc is fast enough that this is fine to do once per
  // suite.
  await exec("pnpm", ["build"], { cwd: resolve(__dirname, "..") });
}

beforeAll(async () => {
  await buildCliIfMissing();
});

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-cli-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// Stand up a git repo without ensureGitRepo() so we can disable
// commit signing before any commit is made — some CI environments
// inherit a global signing requirement the test process can't satisfy.
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

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runOak(
  cwd: string,
  args: string[],
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec("node", [cliBin, ...args], {
      cwd,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("oak pub", () => {
  it("prints help with no subcommand", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "--vault", vault]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/oak pub — publish branch tooling/);
    expect(r.stdout).toMatch(/oak pub init/);
    expect(r.stdout).toMatch(/oak pub build/);
  });

  it("reports an unknown subcommand and exits non-zero", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "noogie", "--vault", vault]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Unknown pub subcommand: noogie/);
  });
});

describe("oak pub init", () => {
  it("creates the public branch and scaffolds files", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "init", "--vault", vault]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Created publish branch `public`/);
    expect(r.stdout).toMatch(/Scaffolded \d+ file/);
    // Branch exists.
    const refs = await exec("git", [
      "-C",
      vault,
      "branch",
      "--list",
      "public",
    ]);
    expect(refs.stdout).toContain("public");
    // Some core scaffolded files landed.
    const pkg = await readFile(resolve(vault, "package.json"), "utf8");
    expect(pkg).toContain("astro");
  });

  it("emits the dev-rewrite notice when running from source", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "init", "--vault", vault]);
    // We're running inside the oak monorepo where the template ships
    // workspace:* refs that get rewritten to file: paths.
    expect(r.stdout).toMatch(/Development install detected/);
    expect(r.stdout).toMatch(/@oak\/core -> file:/);
    // Scaffolded package.json should have the file: ref.
    const pkg = JSON.parse(
      await readFile(resolve(vault, "package.json"), "utf8"),
    );
    expect(pkg.dependencies["@oak/core"]).toMatch(/^file:/);
  });

  it("is idempotent on re-run (branch already exists, files skipped)", async () => {
    const vault = await makeVault();
    await runOak(vault, ["pub", "init", "--vault", vault]);
    const r2 = await runOak(vault, ["pub", "init", "--vault", vault]);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(
      /Publish branch `public` already exists — skipped/,
    );
    expect(r2.stdout).toMatch(/\(exists\)/);
  });
});

describe("oak pub status", () => {
  it("reports branch absence before init and presence after", async () => {
    const vault = await makeVault();
    const before = await runOak(vault, ["pub", "status", "--vault", vault]);
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/exists: +no/);

    await runOak(vault, ["pub", "init", "--vault", vault]);

    const after = await runOak(vault, ["pub", "status", "--vault", vault]);
    expect(after.code).toBe(0);
    expect(after.stdout).toMatch(/exists: +yes/);
  });
});

describe("oak pub build", () => {
  async function makeBuildArtifact(vault: string): Promise<void> {
    const dist = resolve(vault, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(dist, "index.html"), "<html>hi</html>", "utf8");
  }

  it("refuses to build when the publish branch doesn't exist yet", async () => {
    const vault = await makeVault();
    await makeBuildArtifact(vault);
    const r = await runOak(vault, [
      "pub",
      "build",
      "--vault",
      vault,
      "--no-push",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/branch.*does not exist/);
  });

  it("refuses --no-checkpoint when the working tree is dirty", async () => {
    const vault = await makeVault();
    await runOak(vault, ["pub", "init", "--vault", vault]);
    await makeBuildArtifact(vault);
    // Dirty file (the init scaffolded files already make the tree dirty).
    const r = await runOak(vault, [
      "pub",
      "build",
      "--vault",
      vault,
      "--no-push",
      "--no-checkpoint",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/working tree is dirty/);
  });

  it("publishes a build artifact and embeds the source SHA in the commit", async () => {
    const vault = await makeVault();
    await runOak(vault, ["pub", "init", "--vault", vault]);
    await makeBuildArtifact(vault);

    const r = await runOak(vault, [
      "pub",
      "build",
      "--vault",
      vault,
      "--no-push",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Published [0-9a-f]{7} to `public`/);
    expect(r.stdout).toMatch(/pushed: +no/);

    // The publish branch now contains index.html.
    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      "public",
    ]);
    expect(ls.stdout.trim().split("\n")).toContain("index.html");

    // The commit subject references the source HEAD.
    const subject = await exec("git", [
      "-C",
      vault,
      "log",
      "-1",
      "--format=%s",
      "public",
    ]);
    expect(subject.stdout.trim()).toMatch(/^publish: [0-9a-f]{40}/);
  });

  it("--allow-dirty publishes without checkpointing, tags commit dirty", async () => {
    const vault = await makeVault();
    await runOak(vault, ["pub", "init", "--vault", vault]);
    await makeBuildArtifact(vault);
    // Tree is dirty from the scaffold; commit it so we have a clean
    // baseline, then dirty it again to test --allow-dirty specifically.
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "scaffold"]);
    await writeFile(resolve(vault, "draft.md"), "wip\n", "utf8");

    const r = await runOak(vault, [
      "pub",
      "build",
      "--vault",
      vault,
      "--no-push",
      "--allow-dirty",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(dirty\)/);

    const subject = await exec("git", [
      "-C",
      vault,
      "log",
      "-1",
      "--format=%s",
      "public",
    ]);
    expect(subject.stdout.trim()).toMatch(/^publish: [0-9a-f]{40} \(dirty\)$/);
  });
});
