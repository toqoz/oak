// Shared commit logic for oak title edits.
//
// Both the sidebar's Title field and the editor's inline
// `.oak-page-title` input call this helper. Side effects:
//
//   1. The first `# ...` heading in the body is rewritten to
//      `# {newTitle}`. If the body has no h1 yet, one is inserted
//      directly after the frontmatter (or at the top if there is no
//      frontmatter), separated by a blank line on each side.
//   2. frontmatter `slug` is regenerated from `slugify(newTitle)` iff
//      the old slug was auto-derived (i.e. equals `slugify(oldTitle)`
//      or is unset).
//   3. The file is renamed to `<pathSafeFilename(newTitle)>.md` (in
//      the same directory) iff the old basename was auto-derived.
//
// Custom slugs and custom filenames stay put; oak only re-derives
// what it would have derived in the first place.

import type { App, TFile } from "obsidian";
import { pathSafeFilename, plainTextTitle, slugify } from "@oak/core";

export type TitlePrev = {
  title: string;
  slug: string; // empty string is fine — treated as auto-derived
  basename: string;
};

export type TitleCommitResult =
  | { status: "ok"; appliedRename: { from: string; to: string } | null }
  | { status: "heading-failed"; error: string }
  | { status: "rename-skipped"; reason: string }
  | { status: "rename-failed"; error: string };

const FRONTMATTER_FENCE = /^---\r?\n/;

// Splice a new h1 into the source text. Replaces the first existing
// `# ...` heading; inserts one after the frontmatter (or at the very
// top) when none is present.
export function applyTitleEdit(source: string, newTitle: string): string {
  const fmEnd = findFrontmatterEnd(source);
  const bodyStart = fmEnd;
  const body = source.slice(bodyStart);

  const h1 = findFirstH1Line(body);
  if (h1) {
    const before = body.slice(0, h1.start);
    const after = body.slice(h1.end);
    return source.slice(0, bodyStart) + before + `# ${newTitle}` + after;
  }

  // Insert: skip leading blank lines so the heading sits next to the
  // frontmatter fence with exactly one blank between them.
  const trimmedBody = body.replace(/^\s*\n/, "");
  const sep = bodyStart === 0 ? "" : "\n";
  const trailing = trimmedBody.length === 0 ? "\n" : "\n\n";
  return (
    source.slice(0, bodyStart) +
    sep +
    `# ${newTitle}` +
    trailing +
    trimmedBody
  );
}

function findFrontmatterEnd(source: string): number {
  if (!FRONTMATTER_FENCE.test(source)) return 0;
  // Find closing `---` line.
  const closeRe = /\r?\n---[ \t]*\r?\n/;
  const m = closeRe.exec(source);
  if (!m) return 0;
  return m.index + m[0].length;
}

function findFirstH1Line(
  body: string,
): { start: number; end: number; text: string } | null {
  // Skip fenced code blocks. Mirrors the parser-side rule in slug.ts.
  const lines = body.split("\n");
  let inFence = false;
  let offset = 0;
  for (const line of lines) {
    const lineLen = line.length;
    if (/^(?:`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = /^#\s+(.*)$/.exec(line);
      if (m) {
        const text = m[1]!.replace(/\s+#+\s*$/, "").trim();
        if (text.length > 0) {
          return { start: offset, end: offset + lineLen, text };
        }
      }
    }
    offset += lineLen + 1; // account for `\n`
  }
  return null;
}

export async function commitTitleChange(
  app: App,
  file: TFile,
  prev: TitlePrev,
  newTitle: string,
): Promise<TitleCommitResult> {
  const slugWasAuto =
    prev.slug.length === 0 ||
    slugify(plainTextTitle(prev.title)) === prev.slug;
  const newSlug = slugify(plainTextTitle(newTitle));

  const basenameWasAuto =
    pathSafeFilename(plainTextTitle(prev.title)) === prev.basename;
  const newBasename = pathSafeFilename(plainTextTitle(newTitle));

  // 1. Rewrite the body's first h1 (and refresh the slug when auto).
  try {
    const original = await app.vault.read(file);
    const rewritten = applyTitleEdit(original, newTitle);
    if (rewritten !== original) {
      await app.vault.modify(file, rewritten);
    }
    if (slugWasAuto && newSlug.length > 0) {
      await app.fileManager.processFrontMatter(file, (fm) => {
        (fm as Record<string, unknown>)["slug"] = newSlug;
      });
    }
  } catch (err) {
    return {
      status: "heading-failed",
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
