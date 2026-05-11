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
  // Re-run the build to guarantee we're exercising the current sources.
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

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runOak(cwd: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec("node", [cliBin, ...args], {
      cwd,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

const BRANCH = "oak/pub";
const WORKTREE_REL = ".oak/pub";

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
  it("creates the publish branch + worktree and scaffolds the template", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "init", "--vault", vault]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Created publish branch `oak\/pub`/);
    expect(r.stdout).toMatch(/Worktree:/);
    expect(r.stdout).toMatch(/Scaffolded \d+ file/);

    // Branch exists.
    const refs = await exec("git", [
      "-C",
      vault,
      "branch",
      "--list",
      BRANCH,
    ]);
    expect(refs.stdout).toContain(BRANCH);

    // Scaffolded files landed in the worktree, not the vault root.
    const pkg = await readFile(
      resolve(vault, WORKTREE_REL, "package.json"),
      "utf8",
    );
    expect(pkg).toContain("astro");
  });

  it("emits the dev-rewrite notice when running from source", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "init", "--vault", vault]);
    expect(r.stdout).toMatch(/Development install detected/);
    expect(r.stdout).toMatch(/@oak\/core -> file:/);
    const pkg = JSON.parse(
      await readFile(resolve(vault, WORKTREE_REL, "package.json"), "utf8"),
    );
    expect(pkg.dependencies["@oak/core"]).toMatch(/^file:/);
  });

  it("errors on re-run because the worktree path is already taken", async () => {
    const vault = await makeVault();
    await runOak(vault, ["pub", "init", "--vault", vault]);
    const r2 = await runOak(vault, ["pub", "init", "--vault", vault]);
    expect(r2.code).not.toBe(0);
    expect(r2.stderr).toMatch(/already exists/);
  });
});

describe("oak pub status", () => {
  it("reports branch + worktree absence before init and presence after", async () => {
    const vault = await makeVault();
    const before = await runOak(vault, ["pub", "status", "--vault", vault]);
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/exists: +no/);
    expect(before.stdout).toMatch(/missing/);

    await runOak(vault, ["pub", "init", "--vault", vault]);

    const after = await runOak(vault, ["pub", "status", "--vault", vault]);
    expect(after.code).toBe(0);
    expect(after.stdout).toMatch(/exists: +yes/);
    expect(after.stdout).toMatch(/present/);
  });
});

describe("oak pub build", () => {
  it("refuses to build when the publish branch doesn't exist yet", async () => {
    const vault = await makeVault();
    const r = await runOak(vault, ["pub", "build", "--vault", vault]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/branch.*does not exist/);
  });

  it("publishes the publishable subset and reports counts", async () => {
    const vault = await makeVault();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await writePage(vault, "secret.md", "private", "# Secret\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await runOak(vault, ["pub", "init", "--vault", vault]);

    const r = await runOak(vault, ["pub", "build", "--vault", vault]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Published [0-9a-f]{7} to `oak\/pub`/);
    expect(r.stdout).toMatch(/sync: +\+\d+ =\d+ -\d+/);
    expect(r.stdout).toMatch(/pushed: +no/);

    // alpha.md ends up in the published branch under vault/, secret.md does not.
    const ls = await exec("git", [
      "-C",
      vault,
      "ls-tree",
      "-r",
      "--name-only",
      BRANCH,
    ]);
    const files = ls.stdout.trim().split("\n");
    expect(files).toContain("vault/alpha.md");
    expect(files).not.toContain("vault/secret.md");
  });

  it("tags commits with (dirty) when the source tree is dirty", async () => {
    const vault = await makeVault();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await runOak(vault, ["pub", "init", "--vault", vault]);
    // Dirty the source tree.
    await writeFile(resolve(vault, "draft.md"), "wip\n", "utf8");

    const r = await runOak(vault, ["pub", "build", "--vault", vault]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(dirty\)/);

    const subject = await exec("git", [
      "-C",
      vault,
      "log",
      "-1",
      "--format=%s",
      BRANCH,
    ]);
    expect(subject.stdout.trim()).toMatch(/^publish: [0-9a-f]{40} \(dirty\)$/);
  });

  it("reports no-op when nothing has changed since last publish", async () => {
    const vault = await makeVault();
    await writePage(vault, "alpha.md", "public", "# Alpha\n");
    await exec("git", ["-C", vault, "add", "."]);
    await exec("git", ["-C", vault, "commit", "-m", "seed"]);

    await runOak(vault, ["pub", "init", "--vault", vault]);
    await runOak(vault, ["pub", "build", "--vault", vault]);
    const r2 = await runOak(vault, ["pub", "build", "--vault", vault]);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/No changes since last publish/);
  });
});
