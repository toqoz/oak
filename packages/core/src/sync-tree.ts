// File-set sync: copy a known set of vault-relative paths from one
// directory to another, mirroring content (by size + mtime) and
// removing destination entries that aren't in the set.
//
// Used by `oak pub build` to project only publishable pages and their
// referenced assets into the publish worktree. Inclusion is explicit
// rather than exclusion-based — private content is excluded by simply
// not being in the set, so a bug in any visibility filter cannot leak
// private files into the snapshot.

import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type SyncResult = {
  copied: number; // files newly written or refreshed
  unchanged: number; // files matched dest by size + mtime
  deleted: number; // entries removed from dest (files or pruned empty dirs)
};

// Copy each path in `paths` (vault-relative, posix or platform sep) from
// srcRoot to destRoot, refreshing only those whose stat differs. Prune
// any file/dir under destRoot that isn't in `paths`.
//
// Files outside srcRoot (after resolving `..`) are silently ignored as
// a guard against malformed input — callers are expected to validate
// path containment when assembling the set, but this is the second
// line of defense.
export async function syncPaths(
  srcRoot: string,
  destRoot: string,
  paths: Iterable<string>,
): Promise<SyncResult> {
  const normalized = new Set<string>();
  for (const p of paths) {
    const norm = p.split(/[\\/]/).filter((s) => s.length > 0).join(sep);
    if (norm.length === 0) continue;
    // Reject paths that would resolve outside srcRoot.
    const abs = resolve(srcRoot, norm);
    const rel = relative(srcRoot, abs);
    if (rel.startsWith("..") || rel.length === 0) continue;
    normalized.add(rel);
  }

  await mkdir(destRoot, { recursive: true });

  let copied = 0;
  let unchanged = 0;
  let deleted = 0;

  // 1. Ensure each path exists in dest with matching content.
  for (const rel of normalized) {
    const srcAbs = resolve(srcRoot, rel);
    const destAbs = resolve(destRoot, rel);

    let srcStat;
    try {
      srcStat = await stat(srcAbs);
    } catch {
      continue; // src disappeared between collection and sync — skip.
    }
    if (!srcStat.isFile()) continue;

    let destStat;
    try {
      destStat = await stat(destAbs);
    } catch {
      destStat = null;
    }

    if (
      destStat &&
      destStat.isFile() &&
      destStat.size === srcStat.size &&
      // Compare at second precision. utimes/stat round-trip can lose
      // sub-second bits depending on the filesystem (APFS records ns,
      // but Node's fs.utimes goes through a float64-seconds path that
      // can drop precision below the ms level). Second precision is
      // what rsync's default `-t` uses for the same reason.
      Math.floor(destStat.mtimeMs / 1000) ===
        Math.floor(srcStat.mtimeMs / 1000)
    ) {
      unchanged++;
      continue;
    }

    await mkdir(dirname(destAbs), { recursive: true });
    await copyFile(srcAbs, destAbs);
    await utimes(destAbs, srcStat.mtime, srcStat.mtime);
    copied++;
  }

  // 2. Walk dest and remove anything not in `normalized`.
  //
  // Build a directory whitelist from the file paths so we don't prune
  // ancestors of files we're keeping.
  const keepDirs = new Set<string>();
  for (const rel of normalized) {
    let cur = dirname(rel);
    while (cur && cur !== "." && cur !== sep) {
      keepDirs.add(cur);
      const next = dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }

  async function prune(relDir: string): Promise<void> {
    const absDir = resolve(destRoot, relDir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = relDir ? join(relDir, entry.name) : entry.name;
      const childAbs = resolve(destRoot, childRel);
      if (entry.isDirectory()) {
        if (keepDirs.has(childRel)) {
          await prune(childRel);
        } else {
          await rm(childAbs, { recursive: true, force: true });
          deleted++;
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!normalized.has(childRel)) {
          await rm(childAbs, { force: true });
          deleted++;
        }
      }
    }
  }

  await prune("");

  return { copied, unchanged, deleted };
}
