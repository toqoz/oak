// `oak pub init` and `oak pub build`: the new publish flow.
//
// Layout the user sees:
//   - main worktree (the vault repo's normal branch) keeps notes only.
//   - publish orphan branch `oak/pub` is checked out into a dedicated
//     worktree at `<vault>/.oak/pub/`. The Astro app source, its
//     `package.json`, and a `vault/` mirror of the publishable subset of
//     the vault all live in that worktree.
//
// `.oak/` (not `.git/oak/`) — keeping the worktree out of `.git/`
// matters because Vite's dev server enforces a `**/.git/**` deny rule
// that blocks `npm run dev` from serving worktree files. `pub init`
// adds `.oak` to `.git/info/exclude` so the source branch's
// `git status` stays clean without modifying the tracked .gitignore.
//
// Responsibilities are split:
//   - init  : create the orphan branch (locally only, or fetch from
//             origin if it already exists there), add the worktree at
//             the canonical path, and scaffold the pub-template
//             into the worktree when the branch is freshly created.
//   - build : refresh `<worktree>/vault/` with a snapshot of every
//             publishable page plus its referenced assets, commit if
//             changed, force-push.
//
// The visibility filter is enforced at sync time: only pages whose
// frontmatter visibility is in {public, unlisted} are sync'd. Private
// pages never enter the publish branch, so even a bug downstream
// cannot leak their content into deployed output.

import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  branchExists,
  createOrphanBranch,
  createWorktree,
  gitStatus,
  headCommit,
  isGitRepo,
} from "./git.js";
import { parseVault } from "./parse.js";
import { extractAssetRefs } from "./assets.js";
import { resolveAssetSource } from "./asset-process.js";
import type { Visibility } from "./types.js";
import { syncPaths } from "./sync-tree.js";
import { spawn } from "node:child_process";

export const DEFAULT_PUBLISH_BRANCH = "oak/pub";

// Worktree path is fixed at `.oak/pub` under the vault. The path
// mirrors the branch name (`oak/pub`) so the directory and the ref
// read the same. `pub init` writes `.oak` into `.git/info/exclude`
// so it stays out of the source branch's git status without
// touching the tracked .gitignore.
export const PUBLISH_WORKTREE_REL = ".oak/pub";

export type PubInitOptions = {
  vaultRoot: string;
  templateDir: string; // absolute path to a pub-template package root
  branch?: string;
  remote?: string; // default "origin"; used to detect a pre-existing branch
};

export type PubInitResult = {
  branch: string;
  worktreePath: string;
  branchCreated: boolean;
  branchAlreadyExisted: boolean;
  // The empty-tree marker commit at the root of the orphan branch.
  // Null when the branch already existed (local or fetched).
  initialCommit: string | null;
  // The follow-up commit that lands the scaffolded template files.
  // Null when no scaffolding happened (existing branch was reused).
  scaffoldCommit: string | null;
  scaffolded: string[]; // worktree-relative paths
  // Tracked workspace dep rewrites (workspace:* → file:) applied to
  // package.json files copied from the template. Empty in published
  // installs because pnpm/npm strips workspace specs on publish.
  rewrittenDevDeps: Array<{ file: string; name: string; resolvedTo: string }>;
};

export class PubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PubError";
  }
}

// Files inside the template package that should never be copied into
// the publish worktree (build artifacts, vendored deps, monorepo
// internals, the template's own test infra).
const SCAFFOLD_SKIP = new Set([
  "node_modules",
  "dist",
  ".astro",
  ".turbo",
  "tests",
  "vitest.config.ts",
]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function resolveInstalledPackageDir(
  name: string,
  fromDir: string,
): string | null {
  try {
    const requireFn = createRequire(resolve(fromDir, "package.json"));
    const pkgJson = requireFn.resolve(`${name}/package.json`);
    return dirname(pkgJson);
  } catch {
    return null;
  }
}

async function rewriteWorkspaceDeps(
  filePath: string,
  resolveFromDir: string,
): Promise<Array<{ name: string; resolvedTo: string }>> {
  const raw = await readFile(filePath, "utf8");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const rewrites: Array<{ name: string; resolvedTo: string }> = [];
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps || typeof deps !== "object") continue;
    const map = deps as Record<string, string>;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const dir = resolveInstalledPackageDir(name, resolveFromDir);
      if (!dir) continue;
      map[name] = `file:${dir}`;
      rewrites.push({ name, resolvedTo: dir });
    }
  }
  if (rewrites.length === 0) return rewrites;
  await writeFile(filePath, JSON.stringify(json, null, 2) + "\n", "utf8");
  return rewrites;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, relPrefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SCAFFOLD_SKIP.has(entry.name)) continue;
      const childRel = relPrefix ? join(relPrefix, entry.name) : entry.name;
      const childAbs = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(dir, "");
  return out;
}

// Run git in a given directory. Inlined here so this module doesn't
// take a hard dependency on git.ts internals.
type RunResult = { stdout: string; stderr: string; code: number };

async function runGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      const c = code ?? 0;
      if (c !== 0 && !options.allowFailure) {
        rejectP(
          new Error(
            `git ${args.join(" ")} (in ${cwd}) exited ${c}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolveP({ stdout, stderr, code: c });
    });
  });
}

async function remoteBranchExists(
  vaultRoot: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const r = await runGit(
    vaultRoot,
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
    { allowFailure: true },
  );
  return r.code === 0;
}

async function remoteConfigured(
  vaultRoot: string,
  remote: string,
): Promise<boolean> {
  const r = await runGit(vaultRoot, ["remote"], { allowFailure: true });
  if (r.code !== 0) return false;
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .includes(remote);
}

function worktreePath(vaultRoot: string): string {
  return resolve(vaultRoot, PUBLISH_WORKTREE_REL);
}

// Append a path to `.git/info/exclude` if it's not already there. This
// is git's per-clone local ignore — invisible to tracked .gitignore
// (no source-branch modification) but effective immediately on the
// current clone.
async function ensureLocalGitIgnore(
  vaultRoot: string,
  pattern: string,
): Promise<void> {
  const excludePath = resolve(vaultRoot, ".git", "info", "exclude");
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    // First-time use: ensure the directory exists. `.git/info/` is
    // present in every clone but defensive mkdir doesn't hurt.
    await mkdir(dirname(excludePath), { recursive: true });
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern)) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${current}${prefix}${pattern}\n`, "utf8");
}

export async function pubInit(
  options: PubInitOptions,
): Promise<PubInitResult> {
  const { vaultRoot, templateDir } = options;
  const branch = options.branch ?? DEFAULT_PUBLISH_BRANCH;
  const remote = options.remote ?? "origin";

  if (!(await isGitRepo(vaultRoot))) {
    throw new PubError(
      "not-a-git-repo",
      `oak pub init requires a git repository at ${vaultRoot}`,
    );
  }
  if (!(await isDirectory(templateDir))) {
    throw new PubError(
      "template-not-found",
      `publish template not found at ${templateDir}`,
    );
  }

  const wt = worktreePath(vaultRoot);
  if (await pathExists(wt)) {
    throw new PubError(
      "worktree-exists",
      `publish worktree already exists at ${wt} — remove it first or use it as-is`,
    );
  }

  // Decide whether the branch needs creating, and whether scaffold is
  // needed once the worktree is laid down.
  const hasLocal = await branchExists(vaultRoot, branch);
  let initialCommit: string | null = null;
  let scaffoldExpected = false;

  if (!hasLocal) {
    const hasRemote =
      (await remoteConfigured(vaultRoot, remote)) &&
      (await remoteBranchExists(vaultRoot, remote, branch));
    if (hasRemote) {
      // Branch already lives on origin (someone else ran `oak pub init`
      // and pushed). Pull it down as a local tracking branch — we want
      // its contents, not a fresh scaffold.
      await runGit(vaultRoot, [
        "branch",
        "--track",
        branch,
        `${remote}/${branch}`,
      ]);
    } else {
      const r = await createOrphanBranch(
        vaultRoot,
        branch,
        `init: oak ${branch} branch`,
      );
      initialCommit = r.commit;
      scaffoldExpected = true;
    }
  }

  // Ensure `.oak` is locally ignored before the worktree appears, so
  // the source branch's `git status` never reports it as untracked.
  await ensureLocalGitIgnore(vaultRoot, ".oak");

  // Lay down the worktree.
  await createWorktree(vaultRoot, wt, branch);

  // If the branch already had content (existing local or fetched
  // remote), don't scaffold over it. Detect by presence of any
  // tracked file other than `.git`.
  let scaffolded: string[] = [];
  let scaffoldCommit: string | null = null;
  const rewrittenDevDeps: PubInitResult["rewrittenDevDeps"] = [];
  const wtEntries = (await readdir(wt)).filter((e) => e !== ".git");
  if (scaffoldExpected || wtEntries.length === 0) {
    const files = await listFiles(templateDir);
    for (const rel of files) {
      const srcAbs = resolve(templateDir, rel);
      const destAbs = resolve(wt, rel);
      await mkdir(dirname(destAbs), { recursive: true });
      await copyFile(srcAbs, destAbs);
      scaffolded.push(rel);

      if (rel === "package.json" || rel.endsWith("/package.json")) {
        const rewrites = await rewriteWorkspaceDeps(destAbs, templateDir);
        for (const r of rewrites) {
          rewrittenDevDeps.push({ file: rel, ...r });
        }
      }
    }

    // Commit the scaffold so the branch has a real baseline above the
    // empty-tree init commit. Future template edits diff against this.
    if (scaffolded.length > 0) {
      await runGit(wt, ["add", "-A"]);
      await runGit(wt, ["commit", "-m", "scaffold: oak pub-template"]);
      const head = await runGit(wt, ["rev-parse", "HEAD"]);
      scaffoldCommit = head.stdout.trim();
    }
  }

  return {
    branch,
    worktreePath: wt,
    branchCreated: !hasLocal && scaffoldExpected,
    branchAlreadyExisted: hasLocal,
    initialCommit,
    scaffoldCommit,
    scaffolded,
    rewrittenDevDeps,
  };
}

export type PubBuildOptions = {
  vaultRoot: string;
  branch?: string; // default DEFAULT_PUBLISH_BRANCH
  push?: boolean; // default true
  remote?: string; // default "origin"
  // Which visibilities make it into the snapshot. Defaults to
  // {public, unlisted}. Private is always excluded.
  visibilityFilter?: Visibility[];
};

export type PubBuildResult = {
  branch: string;
  worktreePath: string;
  publishedCommit: string;
  sourceCommit: string;
  sourceDirty: boolean;
  syncCopied: number;
  syncUnchanged: number;
  syncDeleted: number;
  committed: boolean; // false if snapshot was already up-to-date
  pushed: boolean;
  pushedRemote: string | null;
};

const DEFAULT_VISIBILITY: Visibility[] = ["public", "unlisted"];

// Subdir inside the publish worktree that mirrors publishable vault
// content. The pub-template's astro.config.mjs points at this.
const VAULT_SNAPSHOT_REL = "vault";

// Collect vault-relative paths that should appear in the publish
// snapshot: every page whose visibility is in the filter set, plus
// every asset those pages reference (resolved via oak's standard
// asset-path conventions) that lives inside the vault. External
// mounts (`publishable: false`) are skipped by construction.
export async function collectPublishablePaths(
  vaultRoot: string,
  visibilityFilter: Visibility[] = DEFAULT_VISIBILITY,
): Promise<Set<string>> {
  const visible = new Set(visibilityFilter);
  const vault = await parseVault(vaultRoot);
  const paths = new Set<string>();
  for (const page of vault.pages.values()) {
    if (!visible.has(page.visibility)) continue;
    const rel = relative(vaultRoot, page.filePath);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    paths.add(rel);

    for (const ref of extractAssetRefs(page.body)) {
      const sourceAbs = resolveAssetSource(page.filePath, ref.target, vaultRoot);
      if (!sourceAbs) continue;
      const assetRel = relative(vaultRoot, sourceAbs);
      if (assetRel.startsWith("..") || isAbsolute(assetRel)) continue;
      try {
        const s = await stat(sourceAbs);
        if (s.isFile()) paths.add(assetRel);
      } catch {
        // Missing asset — leave it out; the loader will flag it later.
      }
    }
  }
  return paths;
}

export async function pubBuild(
  options: PubBuildOptions,
): Promise<PubBuildResult> {
  const { vaultRoot } = options;
  const branch = options.branch ?? DEFAULT_PUBLISH_BRANCH;
  const push = options.push ?? true;
  const remote = options.remote ?? "origin";

  if (!(await isGitRepo(vaultRoot))) {
    throw new PubError(
      "not-a-git-repo",
      `oak pub build requires a git repository at ${vaultRoot}`,
    );
  }
  if (!(await branchExists(vaultRoot, branch))) {
    throw new PubError(
      "branch-missing",
      `publish branch \`${branch}\` does not exist — run \`oak pub init\` first`,
    );
  }

  const wt = worktreePath(vaultRoot);
  if (!(await isDirectory(wt))) {
    throw new PubError(
      "worktree-missing",
      `publish worktree not found at ${wt} — run \`oak pub init\` first`,
    );
  }

  // Source SHA and dirty flag — used only for the commit message so
  // operators can correlate publish branch history with the source.
  const sourceCommit = await headCommit(vaultRoot);
  const status = await gitStatus(vaultRoot);
  const sourceDirty = status.dirty;

  // Sync the publishable subset of the vault into <worktree>/vault/.
  const paths = await collectPublishablePaths(
    vaultRoot,
    options.visibilityFilter,
  );
  const destDir = resolve(wt, VAULT_SNAPSHOT_REL);
  const syncResult = await syncPaths(vaultRoot, destDir, paths);

  // Stage everything and check for changes.
  await runGit(wt, ["add", "-A"]);
  const diff = await runGit(
    wt,
    ["diff", "--cached", "--quiet"],
    { allowFailure: true },
  );
  const hasChanges = diff.code !== 0;

  let publishedCommit: string;
  let committed = false;
  if (hasChanges) {
    const dirtyTag = sourceDirty ? " (dirty)" : "";
    await runGit(wt, [
      "commit",
      "-m",
      `publish: ${sourceCommit}${dirtyTag}`,
    ]);
    committed = true;
  }
  const head = await runGit(wt, ["rev-parse", "HEAD"]);
  publishedCommit = head.stdout.trim();

  let pushed = false;
  if (push) {
    const remoteOk = await remoteConfigured(vaultRoot, remote);
    if (!remoteOk) {
      throw new PubError(
        "remote-missing",
        `remote \`${remote}\` is not configured — add it or pass --no-push`,
      );
    }
    const r = await runGit(
      wt,
      ["push", "--force", remote, `${branch}:${branch}`],
      { allowFailure: true },
    );
    if (r.code !== 0) {
      throw new PubError(
        "push-failed",
        `git push to ${remote}/${branch} failed: ${r.stderr.trim()}`,
      );
    }
    pushed = true;
  }

  return {
    branch,
    worktreePath: wt,
    publishedCommit,
    sourceCommit,
    sourceDirty,
    syncCopied: syncResult.copied,
    syncUnchanged: syncResult.unchanged,
    syncDeleted: syncResult.deleted,
    committed,
    pushed,
    pushedRemote: pushed ? remote : null,
  };
}

export async function pubStatus(
  vaultRoot: string,
  branch: string = DEFAULT_PUBLISH_BRANCH,
): Promise<{
  branch: string;
  branchExists: boolean;
  worktreePath: string;
  worktreeExists: boolean;
}> {
  const wt = worktreePath(vaultRoot);
  return {
    branch,
    branchExists: await branchExists(vaultRoot, branch),
    worktreePath: wt,
    worktreeExists: await pathExists(wt),
  };
}
