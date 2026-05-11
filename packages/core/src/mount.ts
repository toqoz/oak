// External mount configuration and lifecycle.
//
// Mount config lives at `.oak/mounts.local.yml`. Each mount creates a
// symlink under `_external/<id>` pointing at the user's external
// directory (e.g. a code repo). The directive is explicit that external
// directories are mounts — never owned content — so we:
//   - keep the symlink absolute so it survives vault moves
//   - never modify files inside the target
//   - default policies to readonly / git-status-only

import { mkdir, readFile, stat, lstat, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";

import type { GitPolicy, Issue, MountMode } from "./types.js";

const DEFAULT_MOUNT_MODE: MountMode = "readonly";
const DEFAULT_GIT_POLICY: GitPolicy = "status-only";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export type MountConfigEntry = {
  id: string;
  targetPath: string;
  linkPath: string;
  mode: MountMode;
  publishable: false;
  gitPolicy: GitPolicy;
};

export type MountConfig = {
  mounts: MountConfigEntry[];
};

export type MountStatus = {
  entry: MountConfigEntry;
  linkAbsPath: string;
  linkExists: boolean;
  linkResolvedTo: string | null;
  targetAbsPath: string;
  targetExists: boolean;
};

const CONFIG_REL = ".oak/mounts.local.yml";

function configPathFor(vaultRoot: string): string {
  return resolve(vaultRoot, CONFIG_REL);
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

export async function loadMountConfig(vaultRoot: string): Promise<MountConfig> {
  const path = configPathFor(vaultRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { mounts: [] };
  }
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object") return { mounts: [] };
  const mountsObj = (parsed as Record<string, unknown>)["mounts"];
  if (!mountsObj || typeof mountsObj !== "object") return { mounts: [] };

  const out: MountConfigEntry[] = [];
  for (const [id, value] of Object.entries(
    mountsObj as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const targetPath = typeof v["targetPath"] === "string" ? v["targetPath"] : "";
    const linkPath =
      typeof v["linkPath"] === "string" ? v["linkPath"] : `_external/${id}`;
    const mode: MountMode =
      v["mode"] === "readwrite" ? "readwrite" : "readonly";
    const gitPolicy: GitPolicy =
      v["gitPolicy"] === "ignore" ? "ignore" : "status-only";
    out.push({
      id,
      targetPath,
      linkPath,
      mode,
      publishable: false,
      gitPolicy,
    });
  }
  return { mounts: out };
}

export async function saveMountConfig(
  vaultRoot: string,
  config: MountConfig,
): Promise<void> {
  const path = configPathFor(vaultRoot);
  await mkdir(dirname(path), { recursive: true });
  const obj: Record<string, Record<string, unknown>> = {};
  for (const m of config.mounts) {
    obj[m.id] = {
      targetPath: m.targetPath,
      linkPath: m.linkPath,
      mode: m.mode,
      publishable: m.publishable,
      gitPolicy: m.gitPolicy,
    };
  }
  const yamlText = yaml.dump({ mounts: obj }, { sortKeys: false, lineWidth: 120 });
  await writeFile(path, yamlText, "utf8");
}

export type AddMountOptions = {
  id: string;
  target: string;
  mode?: MountMode;
  gitPolicy?: GitPolicy;
  baseDir?: string; // for resolving relative `target`; defaults to process.cwd()
};

export async function addMount(
  vaultRoot: string,
  opts: AddMountOptions,
): Promise<MountConfigEntry> {
  if (!ID_RE.test(opts.id)) {
    throw new Error(
      `Invalid mount id \`${opts.id}\`: must match ${ID_RE.toString()}`,
    );
  }

  const baseDir = opts.baseDir ?? process.cwd();
  const targetAbs = isAbsolute(opts.target)
    ? resolve(opts.target)
    : resolve(baseDir, opts.target);

  let targetStat;
  try {
    targetStat = await stat(targetAbs);
  } catch {
    throw new Error(`Mount target does not exist: ${targetAbs}`);
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`Mount target is not a directory: ${targetAbs}`);
  }

  const linkRel = `_external/${opts.id}`;
  const linkAbs = resolve(vaultRoot, linkRel);
  await mkdir(dirname(linkAbs), { recursive: true });

  // Refuse to clobber an existing entry (real or symlink) — caller must
  // remove first or use a different id. This avoids accidental data loss.
  let existing = false;
  try {
    await lstat(linkAbs);
    existing = true;
  } catch {
    existing = false;
  }
  if (existing) {
    throw new Error(
      `${linkRel} already exists; remove it first or pick a different mount id`,
    );
  }

  await symlink(targetAbs, linkAbs);

  const config = await loadMountConfig(vaultRoot);
  if (config.mounts.some((m) => m.id === opts.id)) {
    // Roll back the symlink we just made; config already had this id.
    await unlink(linkAbs).catch(() => undefined);
    throw new Error(`Mount id \`${opts.id}\` already configured`);
  }

  const entry: MountConfigEntry = {
    id: opts.id,
    targetPath: targetAbs,
    linkPath: toPosix(linkRel),
    mode: opts.mode ?? DEFAULT_MOUNT_MODE,
    publishable: false,
    gitPolicy: opts.gitPolicy ?? DEFAULT_GIT_POLICY,
  };
  config.mounts.push(entry);
  await saveMountConfig(vaultRoot, config);
  return entry;
}

export async function describeMount(
  vaultRoot: string,
  entry: MountConfigEntry,
): Promise<MountStatus> {
  const linkAbs = resolve(vaultRoot, entry.linkPath);
  let linkExists = false;
  let linkResolvedTo: string | null = null;
  try {
    const ls = await lstat(linkAbs);
    if (ls.isSymbolicLink()) {
      linkResolvedTo = await readlink(linkAbs);
    }
    linkExists = true;
  } catch {
    linkExists = false;
  }

  const targetAbs = isAbsolute(entry.targetPath)
    ? entry.targetPath
    : resolve(vaultRoot, entry.targetPath);

  let targetExists = false;
  try {
    const ts = await stat(targetAbs);
    targetExists = ts.isDirectory();
  } catch {
    targetExists = false;
  }

  return {
    entry,
    linkAbsPath: linkAbs,
    linkExists,
    linkResolvedTo,
    targetAbsPath: targetAbs,
    targetExists,
  };
}

export async function listMountStatus(
  vaultRoot: string,
): Promise<MountStatus[]> {
  const cfg = await loadMountConfig(vaultRoot);
  return Promise.all(cfg.mounts.map((m) => describeMount(vaultRoot, m)));
}

export async function mountDoctor(vaultRoot: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const statuses = await listMountStatus(vaultRoot);

  const linkPaths = new Map<string, string[]>();
  const targets = new Map<string, string[]>();

  for (const s of statuses) {
    const lp = toPosix(relative(vaultRoot, s.linkAbsPath));
    const list = linkPaths.get(lp) ?? [];
    list.push(s.entry.id);
    linkPaths.set(lp, list);

    const tList = targets.get(s.targetAbsPath) ?? [];
    tList.push(s.entry.id);
    targets.set(s.targetAbsPath, tList);

    if (!s.linkExists) {
      issues.push({
        severity: "error",
        code: "broken-mount",
        message: `Mount \`${s.entry.id}\` link missing at ${s.entry.linkPath}`,
      });
      continue;
    }
    if (!s.targetExists) {
      issues.push({
        severity: "error",
        code: "broken-mount-target",
        message: `Mount \`${s.entry.id}\` target missing: ${s.targetAbsPath}`,
      });
    }
    if (
      s.linkResolvedTo !== null &&
      resolve(s.linkAbsPath, "..", s.linkResolvedTo) !== s.targetAbsPath
    ) {
      issues.push({
        severity: "warning",
        code: "mount-link-divergence",
        message: `Mount \`${s.entry.id}\` symlink points to ${s.linkResolvedTo} but config targetPath is ${s.entry.targetPath}`,
      });
    }
  }

  for (const [lp, ids] of linkPaths) {
    if (ids.length > 1) {
      issues.push({
        severity: "error",
        code: "overlapping-mount-link",
        message: `Multiple mounts share linkPath \`${lp}\`: ${ids.join(", ")}`,
      });
    }
  }
  for (const [tp, ids] of targets) {
    if (ids.length > 1) {
      issues.push({
        severity: "warning",
        code: "overlapping-mount-target",
        message: `Multiple mounts target the same path \`${tp}\`: ${ids.join(", ")}`,
      });
    }
  }

  return issues;
}
