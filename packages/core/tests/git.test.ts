import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  checkpoint,
  ensureGitRepo,
  ensureGitignore,
  gitStatus,
  isGitRepo,
  recentCommits,
  snapshot,
} from "../src/git.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-git-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeVault(): Promise<string> {
  const v = resolve(scratch, "vault");
  await mkdir(v, { recursive: true });
  return v;
}

describe("ensureGitRepo", () => {
  it("initializes a fresh repo, writes .gitignore, and makes an initial commit", async () => {
    const vault = await makeVault();
    expect(await isGitRepo(vault)).toBe(false);
    const r = await ensureGitRepo(vault);
    expect(r.initialized).toBe(true);
    expect(r.gitignoreUpdated).toBe(true);
    expect(r.initialCommit).not.toBeNull();
    expect(await isGitRepo(vault)).toBe(true);

    const gi = await readFile(resolve(vault, ".gitignore"), "utf8");
    expect(gi).toContain("public-site/");
    expect(gi).toContain(".oak/index.sqlite");
  });

  it("is idempotent on an existing repo", async () => {
    const vault = await makeVault();
    const a = await ensureGitRepo(vault);
    const b = await ensureGitRepo(vault);
    expect(a.initialized).toBe(true);
    expect(b.initialized).toBe(false);
    expect(b.gitignoreUpdated).toBe(false);
  });

  it("preserves user-added gitignore entries below the managed block", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    const giPath = resolve(vault, ".gitignore");
    const original = await readFile(giPath, "utf8");
    await writeFile(giPath, original + "\n# my own\nmy-secret/\n", "utf8");

    // Calling ensureGitignore now reformats the file (it ignores any
    // duplicate managed-line drift) but must keep the user's lines.
    await ensureGitignore(vault);
    const after = await readFile(giPath, "utf8");
    expect(after).toContain("my-secret/");
    // A second call with the file already in canonical form is a no-op.
    const second = await ensureGitignore(vault);
    expect(second.updated).toBe(false);
  });
});

describe("snapshot / checkpoint / status", () => {
  it("snapshot commits dirty changes and reports a hash", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    await writeFile(resolve(vault, "Note.md"), "---\nid: x\n---\n\n# x\n\nbody\n", "utf8");

    const r = await snapshot(vault);
    expect(r.committed).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(r.message).toMatch(/^snapshot: /);
  });

  it("snapshot reports no-changes on a clean tree", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    const r = await snapshot(vault);
    expect(r.committed).toBe(false);
    expect(r.reason).toBe("no-changes");
  });

  it("checkpoint requires a message and prefixes it", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    await writeFile(resolve(vault, "Note.md"), "x\n", "utf8");

    await expect(checkpoint(vault, "")).rejects.toThrow(/required/i);
    const r = await checkpoint(vault, "before publish");
    expect(r.committed).toBe(true);
    expect(r.message).toBe("checkpoint: before publish");
  });

  it("ignores paths configured in the managed gitignore", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    await mkdir(resolve(vault, "public-site"), { recursive: true });
    await writeFile(resolve(vault, "public-site/index.html"), "<x>", "utf8");

    const status = await gitStatus(vault);
    const dirtyPaths = [
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
    ].map((e) => e.path);
    expect(dirtyPaths.some((p) => p.startsWith("public-site"))).toBe(false);
    expect(status.dirty).toBe(false);
  });

  it("recentCommits returns the latest snapshots in order", async () => {
    const vault = await makeVault();
    await ensureGitRepo(vault);
    for (let i = 0; i < 3; i++) {
      await writeFile(resolve(vault, `n${i}.md`), `# ${i}\n`, "utf8");
      await snapshot(vault, { message: `snapshot: probe-${i}` });
    }
    const commits = await recentCommits(vault, 5);
    // Includes init + 3 probes
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits[0]!.subject).toBe("snapshot: probe-2");
    expect(commits[1]!.subject).toBe("snapshot: probe-1");
    expect(commits[2]!.subject).toBe("snapshot: probe-0");
  });
});
