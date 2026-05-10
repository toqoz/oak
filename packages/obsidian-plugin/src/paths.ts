// Translate between Obsidian's vault-relative paths and absolute
// filesystem paths. @oak/core operates on absolute paths.

import type { App, TFile } from "obsidian";

interface FileSystemAdapterLike {
  basePath?: string;
  getBasePath?: () => string;
}

export function vaultRoot(app: App): string {
  const adapter = app.vault.adapter as unknown as FileSystemAdapterLike;
  if (typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }
  if (typeof adapter.basePath === "string") {
    return adapter.basePath;
  }
  throw new Error(
    "oak: cannot determine vault root (FileSystemAdapter unavailable; plugin requires desktop Obsidian)",
  );
}

export function fileAbsPath(app: App, file: TFile): string {
  return `${vaultRoot(app)}/${file.path}`;
}

// Scratch buffer sits at the vault root so Obsidian's vault index
// (which skips dotfile directories) can see it and open it in a
// regular MarkdownView. The core indexer treats it as an out-of-band
// system file (parse.ts SYSTEM_ROOT_FILES) so it stays out of search,
// graph, validation, and publish. History backups live under `.oak/`
// — they're written via Node fs (vault.adapter), not the indexed API,
// so the dotfile placement is fine for them.
export const SCRATCH_VAULT_REL_PATH = "scratch.md";
export const SCRATCH_HISTORY_REL_DIR = ".oak/scratch.history";
