// Git is invisible infrastructure (directive §8): the user never runs
// git themselves. This module wraps the subset of git plumbing that
// other modules need — init, snapshot, checkpoint, status, log — and
// nothing else.
//
// We invoke `git` through child_process rather than pulling in a
// library. The dependency footprint stays at zero; the surface stays
// exactly as wide as the directive demands.

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Files oak writes into the vault but never wants tracked. The
// directive §8 lists these as the canonical ignore set.
const MANAGED_GITIGNORE_LINES = [
  "# managed by oak — edit Track/Ignore in directive if you change this",
  "_external/",
  ".oak/index.sqlite",
  ".oak/tmp/",
  ".git-worktrees/",
  "public-site/",
  "node_modules/",
  ".DS_Store",
];

const FALLBACK_USER_NAME = "oak";
const FALLBACK_USER_EMAIL = "oak@local";

export type GitStatusEntry = {
  // 2-char porcelain code, e.g. " M", "??", "A "
  code: string;
  path: string;
};

export type GitStatus = {
  initialized: boolean;
  branch: string | null;
  // True iff there's any change tracked or untracked.
  dirty: boolean;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  ignored: GitStatusEntry[];
};

export type CommitRecord = {
  hash: string;
  shortHash: string;
  authorDate: string;
  subject: string;
};

export type SnapshotResult = {
  committed: boolean;
  hash: string | null;
  message: string;
  reason?: "no-changes" | "ok";
};

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stdout: string = "",
    public readonly stderr: string = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function runGit(
  vaultRoot: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd: vaultRoot,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (options.allowFailure) {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw new GitError(
      `git ${args.join(" ")} failed: ${e.stderr ?? e.message}`,
      e.stdout ?? "",
      e.stderr ?? "",
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(vaultRoot: string): Promise<boolean> {
  const r = await runGit(
    vaultRoot,
    ["rev-parse", "--is-inside-work-tree"],
    { allowFailure: true },
  );
  return r.code === 0 && r.stdout.trim() === "true";
}

async function readGitConfig(
  vaultRoot: string,
  key: string,
): Promise<string | null> {
  const r = await runGit(vaultRoot, ["config", "--get", key], {
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

async function ensureCommitterIdentity(vaultRoot: string): Promise<void> {
  // If the user has no name / email set anywhere git can find it, set
  // a vault-local fallback so commits don't fail. We never overwrite
  // existing config.
  const name = await readGitConfig(vaultRoot, "user.name");
  if (!name) {
    await runGit(vaultRoot, ["config", "user.name", FALLBACK_USER_NAME]);
  }
  const email = await readGitConfig(vaultRoot, "user.email");
  if (!email) {
    await runGit(vaultRoot, ["config", "user.email", FALLBACK_USER_EMAIL]);
  }
}

export type EnsureRepoResult = {
  initialized: boolean;
  gitignoreUpdated: boolean;
  initialCommit: string | null;
};

export async function ensureGitignore(
  vaultRoot: string,
): Promise<{ updated: boolean; path: string }> {
  const path = resolve(vaultRoot, ".gitignore");
  let current = "";
  if (await pathExists(path)) {
    current = await readFile(path, "utf8");
  }
  const managed = MANAGED_GITIGNORE_LINES.join("\n") + "\n";

  // Strip our managed block from `current` to leave only user lines.
  // We treat the managed block as the contiguous span of recognised
  // lines (header + ignore patterns) at the very top of the file.
  const split = current.split(/\r?\n/);
  let i = 0;
  while (
    i < split.length &&
    (MANAGED_GITIGNORE_LINES.includes(split[i] ?? "") ||
      (split[i] ?? "").startsWith("# managed by oak"))
  ) {
    i++;
  }
  // Eat one separator blank line if present.
  if (i < split.length && (split[i] ?? "").length === 0) i++;

  const preserved = split.slice(i).filter((l) => l.length > 0);
  const desired =
    managed + (preserved.length > 0 ? "\n" + preserved.join("\n") + "\n" : "");

  if (current === desired) return { updated: false, path };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, desired, "utf8");
  return { updated: true, path };
}

export async function ensureGitRepo(
  vaultRoot: string,
): Promise<EnsureRepoResult> {
  await mkdir(vaultRoot, { recursive: true });
  let initialized = false;
  if (!(await isGitRepo(vaultRoot))) {
    await runGit(vaultRoot, ["init", "-q", "-b", "main"]);
    initialized = true;
  }
  await ensureCommitterIdentity(vaultRoot);
  const ignore = await ensureGitignore(vaultRoot);

  // First-ever commit: stage what's there and bootstrap so subsequent
  // diffs have something to compare against.
  let initialCommit: string | null = null;
  if (initialized) {
    await runGit(vaultRoot, ["add", "-A"]);
    const r = await runGit(
      vaultRoot,
      ["commit", "--allow-empty", "-m", "init: oak vault"],
      { allowFailure: true },
    );
    if (r.code === 0) {
      const head = await runGit(vaultRoot, ["rev-parse", "HEAD"]);
      initialCommit = head.stdout.trim();
    }
  }

  return {
    initialized,
    gitignoreUpdated: ignore.updated,
    initialCommit,
  };
}

function parsePorcelain(stdout: string): {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  ignored: GitStatusEntry[];
} {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const ignored: GitStatusEntry[] = [];

  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    if (code === "??") {
      untracked.push({ code, path });
      continue;
    }
    if (code === "!!") {
      ignored.push({ code, path });
      continue;
    }
    const x = code[0] ?? " ";
    const y = code[1] ?? " ";
    if (x !== " " && x !== "?") {
      staged.push({ code, path });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ code, path });
    }
  }
  return { staged, unstaged, untracked, ignored };
}

export async function gitStatus(vaultRoot: string): Promise<GitStatus> {
  const initialized = await isGitRepo(vaultRoot);
  if (!initialized) {
    return {
      initialized: false,
      branch: null,
      dirty: false,
      staged: [],
      unstaged: [],
      untracked: [],
      ignored: [],
    };
  }
  const branchR = await runGit(
    vaultRoot,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { allowFailure: true },
  );
  const branch =
    branchR.code === 0 ? branchR.stdout.trim() || null : null;
  const statusR = await runGit(vaultRoot, ["status", "--porcelain=v1"]);
  const sets = parsePorcelain(statusR.stdout);
  const dirty =
    sets.staged.length + sets.unstaged.length + sets.untracked.length > 0;
  return {
    initialized: true,
    branch: branch === "HEAD" ? null : branch,
    dirty,
    ...sets,
  };
}

async function commit(
  vaultRoot: string,
  message: string,
): Promise<SnapshotResult> {
  await ensureGitRepo(vaultRoot);
  await runGit(vaultRoot, ["add", "-A"]);
  // Detect "nothing to commit" case to avoid noisy failures.
  const statusR = await runGit(vaultRoot, ["status", "--porcelain=v1"]);
  if (statusR.stdout.trim().length === 0) {
    return {
      committed: false,
      hash: null,
      message,
      reason: "no-changes",
    };
  }
  const r = await runGit(vaultRoot, ["commit", "-m", message]);
  void r;
  const head = await runGit(vaultRoot, ["rev-parse", "HEAD"]);
  return {
    committed: true,
    hash: head.stdout.trim(),
    message,
    reason: "ok",
  };
}

export async function snapshot(
  vaultRoot: string,
  options: { message?: string } = {},
): Promise<SnapshotResult> {
  const stamp = new Date().toISOString();
  const msg = options.message ?? `snapshot: ${stamp}`;
  return commit(vaultRoot, msg);
}

export async function checkpoint(
  vaultRoot: string,
  message: string,
): Promise<SnapshotResult> {
  if (!message || message.trim().length === 0) {
    throw new Error("checkpoint message is required");
  }
  return commit(vaultRoot, `checkpoint: ${message.trim()}`);
}

export type WorktreeRecord = {
  path: string;
  head: string;
  branch: string | null;
};

export type ChangedFile = {
  status: string; // porcelain X (e.g. "A", "M", "D", "R", "??")
  path: string;
};

// Resolve `git rev-parse HEAD` for the main worktree. Used by the
// agent workflow to pin a base commit before forking off.
export async function headCommit(vaultRoot: string): Promise<string> {
  const r = await runGit(vaultRoot, ["rev-parse", "HEAD"]);
  return r.stdout.trim();
}

export async function listWorktrees(
  vaultRoot: string,
): Promise<WorktreeRecord[]> {
  if (!(await isGitRepo(vaultRoot))) return [];
  const r = await runGit(vaultRoot, ["worktree", "list", "--porcelain"]);
  const out: WorktreeRecord[] = [];
  let pending: Partial<WorktreeRecord> = {};
  const flush = () => {
    if (pending.path && pending.head) {
      out.push({
        path: pending.path,
        head: pending.head,
        branch: pending.branch ?? null,
      });
    }
    pending = {};
  };
  for (const line of r.stdout.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) pending.path = line.slice(9);
    else if (line.startsWith("HEAD ")) pending.head = line.slice(5);
    else if (line.startsWith("branch ")) {
      const ref = line.slice(7);
      pending.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "detached") {
      pending.branch = null;
    }
  }
  flush();
  return out;
}

export async function createWorktree(
  vaultRoot: string,
  worktreePath: string,
  branch: string,
  options: { newBranch?: boolean; from?: string } = {},
): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  const args = ["worktree", "add"];
  if (options.newBranch) args.push("-b", branch);
  args.push(worktreePath);
  if (options.newBranch && options.from) {
    args.push(options.from);
  } else if (!options.newBranch) {
    args.push(branch);
  }
  await runGit(vaultRoot, args);
}

export async function removeWorktree(
  vaultRoot: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  await runGit(vaultRoot, args, { allowFailure: true });
  // Always prune metadata in case the worktree dir was hand-removed.
  await runGit(vaultRoot, ["worktree", "prune"], { allowFailure: true });
}

export async function deleteBranch(
  vaultRoot: string,
  branch: string,
  force = false,
): Promise<void> {
  await runGit(
    vaultRoot,
    ["branch", force ? "-D" : "-d", branch],
    { allowFailure: true },
  );
}

export type DiffSummary = {
  base: string;
  target: string;
  diff: string;
  changedFiles: ChangedFile[];
};

export async function diffBranch(
  vaultRoot: string,
  target: string,
  base = "HEAD",
): Promise<DiffSummary> {
  const baseRev = (await runGit(vaultRoot, ["rev-parse", base])).stdout.trim();
  const targetRev = (
    await runGit(vaultRoot, ["rev-parse", target])
  ).stdout.trim();
  const diff = (
    await runGit(vaultRoot, ["diff", `${baseRev}..${targetRev}`])
  ).stdout;
  const namesR = await runGit(
    vaultRoot,
    ["diff", "--name-status", `${baseRev}..${targetRev}`],
  );
  const changedFiles: ChangedFile[] = [];
  for (const line of namesR.stdout.split("\n")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const status = line.slice(0, tab).trim();
    const path = line.slice(tab + 1).trim();
    changedFiles.push({ status, path });
  }
  return { base: baseRev, target: targetRev, diff, changedFiles };
}

export async function mergeBranch(
  vaultRoot: string,
  branch: string,
  options: { message?: string; ff?: "no" | "only" | "yes" } = {},
): Promise<{ commit: string }> {
  const args = ["merge"];
  if (options.ff === "only") args.push("--ff-only");
  else if (options.ff === "no") args.push("--no-ff");
  // Default: let git decide
  if (options.message) args.push("-m", options.message);
  args.push(branch);
  await runGit(vaultRoot, args);
  return { commit: await headCommit(vaultRoot) };
}

export async function recentCommits(
  vaultRoot: string,
  n: number,
): Promise<CommitRecord[]> {
  if (!(await isGitRepo(vaultRoot))) return [];
  // Split fields with NUL to avoid format ambiguity.
  const r = await runGit(
    vaultRoot,
    [
      "log",
      `-n${Math.max(1, n)}`,
      "--pretty=format:%H%x00%h%x00%aI%x00%s",
    ],
    { allowFailure: true },
  );
  if (r.code !== 0) return [];
  const out: CommitRecord[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [hash, shortHash, authorDate, subject] = line.split("\x00");
    if (!hash || !shortHash || !authorDate || subject === undefined) continue;
    out.push({ hash, shortHash, authorDate, subject });
  }
  return out;
}
