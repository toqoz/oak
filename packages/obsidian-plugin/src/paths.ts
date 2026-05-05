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
