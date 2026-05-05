// Shared commit logic for oak title edits.
//
// Both the sidebar's Title field and the editor's inline
// `.oak-page-title` input call this helper. Side effects:
//
//   1. frontmatter `title` is set to `newTitle`
//   2. frontmatter `slug` is regenerated from `slugify(newTitle)`
//      iff the old slug was auto-derived (i.e. equals
//      `slugify(oldTitle)` or is unset)
//   3. the file is renamed to `<pathSafeFilename(newTitle)>.md` (in
//      the same directory) iff the old basename was auto-derived
//
// Custom slugs and custom filenames stay put; oak only re-derives
// what it would have derived in the first place.

import type { App, TFile } from "obsidian";
import { pathSafeFilename, slugify } from "@oak/core";

export type TitlePrev = {
  title: string;
  slug: string; // empty string is fine — treated as auto-derived
  basename: string;
};

export type TitleCommitResult =
  | { status: "ok"; appliedRename: { from: string; to: string } | null }
  | { status: "frontmatter-failed"; error: string }
  | { status: "rename-skipped"; reason: string }
  | { status: "rename-failed"; error: string };

export async function commitTitleChange(
  app: App,
  file: TFile,
  prev: TitlePrev,
  newTitle: string,
): Promise<TitleCommitResult> {
  const slugWasAuto =
    prev.slug.length === 0 || slugify(prev.title) === prev.slug;
  const newSlug = slugify(newTitle);

  const basenameWasAuto = pathSafeFilename(prev.title) === prev.basename;
  const newBasename = pathSafeFilename(newTitle);

  // 1. Frontmatter
  try {
    await app.fileManager.processFrontMatter(file, (fm) => {
      const f = fm as Record<string, unknown>;
      f["title"] = newTitle;
      if (slugWasAuto && newSlug.length > 0) {
        f["slug"] = newSlug;
      }
    });
  } catch (err) {
    return {
      status: "frontmatter-failed",
      error: (err as Error).message,
    };
  }

  // 2. Rename
  if (
    !basenameWasAuto ||
    newBasename.length === 0 ||
    newBasename === prev.basename
  ) {
    return { status: "ok", appliedRename: null };
  }
  const dir =
    file.parent && file.parent.path && file.parent.path !== "/"
      ? `${file.parent.path}/`
      : "";
  const newRelPath = `${dir}${newBasename}.md`;
  const existing = app.vault.getAbstractFileByPath(newRelPath);
  if (existing && existing !== file) {
    return {
      status: "rename-skipped",
      reason: `\`${newRelPath}\` already exists`,
    };
  }
  const oldRelPath = file.path;
  try {
    await app.fileManager.renameFile(file, newRelPath);
    return {
      status: "ok",
      appliedRename: { from: oldRelPath, to: newRelPath },
    };
  } catch (err) {
    return { status: "rename-failed", error: (err as Error).message };
  }
}
