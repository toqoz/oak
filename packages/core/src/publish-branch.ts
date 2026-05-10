// `oak pub init` and `oak pub build`: the new publish flow.
//
// Responsibilities are split:
//   - init  : create the publish orphan branch (locally only) and copy
//             the @oak/publish-template files into the vault.
//   - build : take an already-built artifact directory (default `dist/`)
//             and put it on the publish branch as a new commit, then
//             push.
//
// Everything that used to live in the old publish.ts (HTML rendering,
// home page generation, manifest cleanup) has moved to user-land. oak
// only owns: the branch, the worktree dance, and the commit message
// convention.

import { mkdtemp, mkdir, readdir, readFile, stat, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  branchExists,
  checkpoint,
  commitTreeToBranch,
  createOrphanBranch,
  gitStatus,
  headCommit,
  isGitRepo,
} from "./git.js";

export const DEFAULT_PUBLISH_BRANCH = "public";
export const DEFAULT_BUILD_DIR = "dist";

export type PubInitOptions = {
  vaultRoot: string;
  templateDir: string; // absolute path to a publish-template package root
  branch?: string;
};

export type PubInitResult = {
  branch: string;
  branchCreated: boolean;
  branchAlreadyExisted: boolean;
  initialCommit: string | null;
  scaffolded: string[]; // vault-relative paths
  skipped: string[]; // vault-relative paths (already existed)
  // workspace:* deps that got rewritten to file: refs because oak was
  // running from source (typically the monorepo). Empty in the
  // post-publish path because pnpm publish has already replaced them
  // with semver ranges before the template was distributed.
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
// a user's vault (build artifacts, vendored deps, package metadata).
const SCAFFOLD_SKIP = new Set([
  "node_modules",
  "dist",
  ".astro",
  ".turbo",
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
    const s = await stat(p);
    return s.isDirectory();
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

// Resolve the on-disk directory of an installed package, by way of its
// package.json. Returns null if the package can't be found from the
// caller's resolution context.
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

// Rewrite any `workspace:` dep specs in a package.json to absolute
// `file:` refs pointing at the resolved on-disk package directory.
//
// The point: when oak is running from source (monorepo), the template
// it copies still has `workspace:*` in its package.json — npm/pnpm
// outside a workspace can't resolve that. By rewriting we let the
// scaffolded project install via filesystem links to the local oak
// checkout. After `pnpm publish` the source no longer contains any
// `workspace:` specs, so this branch never fires in production.
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
      if (!dir) {
        // No installed copy resolvable — leave as-is. The caller
        // should surface this so the user knows install will fail.
        continue;
      }
      map[name] = `file:${dir}`;
      rewrites.push({ name, resolvedTo: dir });
    }
  }
  if (rewrites.length === 0) return rewrites;
  await writeFile(filePath, JSON.stringify(json, null, 2) + "\n", "utf8");
  return rewrites;
}

// Walk `dir` recursively and return paths relative to `dir`. Skips
// entries listed in SCAFFOLD_SKIP at any depth.
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

export async function pubInit(
  options: PubInitOptions,
): Promise<PubInitResult> {
  const { vaultRoot, templateDir } = options;
  const branch = options.branch ?? DEFAULT_PUBLISH_BRANCH;

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

  // 1. Branch — local only, no push.
  const existed = await branchExists(vaultRoot, branch);
  let initialCommit: string | null = null;
  if (!existed) {
    const r = await createOrphanBranch(
      vaultRoot,
      branch,
      `init: oak ${branch} branch`,
    );
    initialCommit = r.commit;
  }

  // 2. Scaffold — copy template files in, skip any that already exist.
  const files = await listFiles(templateDir);
  const scaffolded: string[] = [];
  const skipped: string[] = [];
  const rewrittenDevDeps: PubInitResult["rewrittenDevDeps"] = [];
  for (const rel of files) {
    const srcAbs = resolve(templateDir, rel);
    const destAbs = resolve(vaultRoot, rel);
    if (await pathExists(destAbs)) {
      skipped.push(rel);
      continue;
    }
    await mkdir(dirname(destAbs), { recursive: true });
    await copyFile(srcAbs, destAbs);
    scaffolded.push(rel);

    // Any package.json copied in (root or nested) might reference
    // workspace deps that won't resolve outside the monorepo.
    if (rel === "package.json" || rel.endsWith("/package.json")) {
      const rewrites = await rewriteWorkspaceDeps(destAbs, templateDir);
      for (const r of rewrites) {
        rewrittenDevDeps.push({ file: rel, ...r });
      }
    }
  }

  return {
    branch,
    branchCreated: !existed,
    branchAlreadyExisted: existed,
    initialCommit,
    scaffolded,
    skipped,
    rewrittenDevDeps,
  };
}

export type PubBuildOptions = {
  vaultRoot: string;
  source?: string; // default "dist", relative to vaultRoot or absolute
  branch?: string; // default DEFAULT_PUBLISH_BRANCH
  push?: boolean; // default true
  remote?: string; // default "origin"
  noCheckpoint?: boolean; // skip auto-checkpoint when dirty
  allowDirty?: boolean; // proceed without checkpoint, embed dirty flag
};

export type PubBuildResult = {
  branch: string;
  publishedCommit: string;
  sourceCommit: string;
  sourceDirty: boolean;
  checkpointCommit: string | null;
  pushed: boolean;
  pushedRemote: string | null;
};

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

  const sourceRel = options.source ?? DEFAULT_BUILD_DIR;
  const sourceAbs = isAbsolute(sourceRel)
    ? sourceRel
    : resolve(vaultRoot, sourceRel);
  if (!(await isDirectory(sourceAbs))) {
    throw new PubError(
      "source-missing",
      `build artifact directory \`${sourceRel}\` not found at ${sourceAbs}`,
    );
  }
  const sourceEntries = await readdir(sourceAbs);
  if (sourceEntries.length === 0) {
    throw new PubError(
      "source-empty",
      `build artifact directory \`${sourceRel}\` is empty`,
    );
  }

  // Checkpoint dance: by default we want the source-side commit message
  // to refer to a commit whose tree matches what we're publishing. So
  // if the working tree is dirty and the user hasn't opted out, take a
  // checkpoint commit before reading HEAD.
  const status = await gitStatus(vaultRoot);
  const sourceDirty = status.dirty;
  let checkpointCommit: string | null = null;
  if (sourceDirty && !options.allowDirty) {
    if (options.noCheckpoint) {
      throw new PubError(
        "dirty-tree",
        `working tree is dirty; commit, run with --allow-dirty, or omit --no-checkpoint`,
      );
    }
    const cp = await checkpoint(vaultRoot, "before publish");
    if (cp.committed && cp.hash) {
      checkpointCommit = cp.hash;
    }
  }

  const sourceCommit = await headCommit(vaultRoot);
  const dirtyTag = sourceDirty && options.allowDirty ? " (dirty)" : "";
  const message = `publish: ${sourceCommit}${dirtyTag}`;

  // Lay the worktree outside the vault so it can't accidentally collide
  // with vault content or get picked up by tooling.
  const tmp = await mkdtemp(join(tmpdir(), "oak-pub-"));
  const worktreePath = join(tmp, "worktree");

  const result = await commitTreeToBranch(vaultRoot, {
    branch,
    sourceDir: sourceAbs,
    worktreePath,
    message,
    push,
    remote,
  });

  return {
    branch,
    publishedCommit: result.commit,
    sourceCommit,
    sourceDirty,
    checkpointCommit,
    pushed: result.pushed,
    pushedRemote: result.pushed ? remote : null,
  };
}

// Helpers exported for the CLI's status display.

export async function pubStatus(
  vaultRoot: string,
  branch: string = DEFAULT_PUBLISH_BRANCH,
): Promise<{
  branch: string;
  branchExists: boolean;
}> {
  return {
    branch,
    branchExists: await branchExists(vaultRoot, branch),
  };
}

