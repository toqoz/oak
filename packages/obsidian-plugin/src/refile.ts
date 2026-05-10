// Org-refile orchestration. Two source identifications are supported:
//   - entryId: agenda view path, robust against snapshot/disk drift
//     because the core re-derives the heading on disk via parseAgendaPage.
//   - line+level: editor command path, used when the cursor sits on a
//     plain heading that isn't an agenda entry (no TODO state, no
//     planning line, no active timestamp).
//
// The target picker itself is a 2-column ItemView rendered in the peek
// pane (see views/refile-picker.ts) — the plugin's `openRefilePicker`
// handles peek-leaf placement (including the peek-to-peek promote
// dance) and resolves with the user's choice.

import { Notice, TFile, type WorkspaceLeaf } from "obsidian";

import {
  frontmatterLineCount,
  refile,
  RefileError,
  type AgendaConfig,
  type RefileConfig,
} from "@oak/core";

import type OakPlugin from "./main.js";

// Caller-supplied description of the heading being moved. `entryId` is
// optional: present when the agenda view dispatches the refile (we want
// the snapshot-drift-resistant entry-id lookup), absent for the editor
// command (where the cursor's body line + level is the only handle on
// a heading that may not be agenda-worthy).
export type RefileSourceDescriptor = {
  filePath: string;
  relPath: string;
  // 1-based body line of the heading.
  line: number;
  // 1..6.
  level: number;
  // Heading text, used for the picker's placeholder.
  title: string;
  entryId?: string;
};

// Refile every heading in `sources` to one user-picked destination.
// Falls through to `refileHeading` when only one source is supplied so
// the call site (editor command with selection) doesn't have to switch
// shape based on how many headings the user grabbed.
//
// Sources are expected to come from a single file — the only caller is
// the editor-selection command, which collects headings from the active
// editor. The line bookkeeping below assumes that invariant: a single
// `cumulativeCut` counter is shared across all sources, so feeding in
// sources from multiple files would silently miscount.
//
// Sources are processed top-down (smallest line first) so the moved
// subtrees land at the destination in document order — bottom-up would
// reverse them. Each prior cut sits above the next source, so the
// `cumulativeCut` of removed lines is subtracted from each subsequent
// source line. The target line is updated each iteration via core's
// `targetLineAfter` so a same-file refile where the destination sits
// below the sources still tracks correctly.
export async function refileHeadings(
  plugin: OakPlugin,
  sources: RefileSourceDescriptor[],
  refileConfig: RefileConfig,
  agendaConfig: AgendaConfig,
  opts: { sourceLeaf?: WorkspaceLeaf; isPeekSource?: boolean } = {},
): Promise<void> {
  if (sources.length === 0) return;
  if (sources.length === 1) {
    await refileHeading(plugin, sources[0]!, refileConfig, agendaConfig, opts);
    return;
  }
  // Exclude every selected source heading from the picker so the
  // user can't choose one of them as the destination.
  const excludeKeys = new Set(
    sources.map((s) => `${s.relPath}:${s.line}`),
  );

  // Resolve the source TFile up front — the peek-promotion path in
  // openRefilePicker can't depend on `peek.view.file` because core's
  // atomic-rename writes can leave it transiently null. Multi-source
  // calls share a single source file (single-file invariant), so the
  // first source's relPath is fine.
  const firstSource = sources[0]!;
  const sourceAbs = plugin.app.vault.getAbstractFileByPath(firstSource.relPath);
  const sourceFile = sourceAbs instanceof TFile ? sourceAbs : undefined;

  const target = await plugin.openRefilePicker({
    sourceTitle: `${sources.length} sections`,
    excludeKeys,
    sourceLeaf: opts.sourceLeaf,
    sourceFile,
    isPeekSource: opts.isPeekSource,
  });
  if (!target) {
    plugin.closeRefilePeek();
    return;
  }

  // Top-down: smallest line number first. Each refile inserts at the
  // end of the destination's subtree, so processing in document order
  // makes the moved sections land in document order at the
  // destination — bottom-up would reverse them. Top-down also requires
  // tracking the cumulative cut size so subsequent source lines are
  // adjusted (every prior refile sits above the current source and
  // has shifted later lines up). Target line is tracked separately
  // via core's `targetLineAfter`, which folds in same-file shifts.
  const ordered = [...sources].sort((a, b) => a.line - b.line);
  let currentTargetLine = target.line;
  let cumulativeCut = 0;
  let lastInsertedBodyLine: number | null = null;
  let lastSameFile = false;
  let success = 0;
  let failureMessage: string | null = null;
  for (const source of ordered) {
    const adjustedLine = source.line - cumulativeCut;
    try {
      const result = await refile(
        source.filePath,
        source.entryId !== undefined
          ? { kind: "entry", entryId: source.entryId }
          : { kind: "heading", line: adjustedLine, level: source.level },
        {
          filePath: target.filePath,
          relPath: target.relPath,
          line: currentTargetLine,
          level: target.level,
        },
        refileConfig,
        agendaConfig,
        source.relPath,
      );
      currentTargetLine = result.targetLineAfter;
      lastInsertedBodyLine = result.insertedBodyLine;
      lastSameFile = result.sameFile;
      // Same-file cuts shift later source lines up; cross-file cuts
      // also remove the same number of lines from the source file so
      // the bookkeeping is identical.
      cumulativeCut += result.movedLines;
      success += 1;
    } catch (err) {
      failureMessage =
        err instanceof RefileError
          ? err.message
          : (err as Error).message ?? "unknown error";
      if (!(err instanceof RefileError)) {
        console.error("oak: refile failed", err);
      }
      break;
    }
  }

  if (success > 0) {
    new Notice(
      `Refiled ${success}/${sources.length} sections to ${target.relPath}` +
        (failureMessage ? ` (stopped: ${failureMessage})` : ""),
    );
    plugin.state.scheduleRefresh();
    if (lastSameFile || lastInsertedBodyLine === null) {
      // Same-file refile: the source pane is already showing the
      // updated buffer, so the picker pane has nothing useful to
      // display — close it.
      plugin.closeRefilePeek();
    } else {
      const targetFile = plugin.app.vault.getAbstractFileByPath(
        target.relPath,
      );
      if (targetFile instanceof TFile) {
        const targetRaw = await plugin.app.vault.cachedRead(targetFile);
        const fileLine =
          lastInsertedBodyLine - 1 + frontmatterLineCount(targetRaw);
        // Swap the peek's view from the picker back to a markdown
        // view of the destination, scrolled to the moved heading.
        await plugin.revealRefileTarget(targetFile, fileLine);
      }
    }
  } else {
    // Refile failed before any section landed — drop the picker pane
    // so the user isn't stuck staring at it.
    plugin.closeRefilePeek();
    if (failureMessage) {
      new Notice(`oak: refile — ${failureMessage}`);
    }
  }
}

// Run a refile against `source`. The caller is responsible for picking
// the source — for the editor command that's the heading enclosing the
// cursor; for the agenda view it's the focused row.
export async function refileHeading(
  plugin: OakPlugin,
  source: RefileSourceDescriptor,
  refileConfig: RefileConfig,
  agendaConfig: AgendaConfig,
  opts: { sourceLeaf?: WorkspaceLeaf; isPeekSource?: boolean } = {},
): Promise<void> {
  // Exclude the source heading itself from the picker so the user
  // can't pick the heading they're trying to move (same-file
  // self-refile is rejected by core anyway, but we keep it out of
  // the list so the UX stays clean).
  const excludeKeys = new Set([`${source.relPath}:${source.line}`]);

  const sourceAbs = plugin.app.vault.getAbstractFileByPath(source.relPath);
  const sourceFile = sourceAbs instanceof TFile ? sourceAbs : undefined;

  const target = await plugin.openRefilePicker({
    sourceTitle: source.title,
    excludeKeys,
    sourceLeaf: opts.sourceLeaf,
    sourceFile,
    isPeekSource: opts.isPeekSource,
  });
  if (!target) {
    plugin.closeRefilePeek();
    return;
  }

  try {
    const result = await refile(
      source.filePath,
      source.entryId !== undefined
        ? { kind: "entry", entryId: source.entryId }
        : { kind: "heading", line: source.line, level: source.level },
      {
        filePath: target.filePath,
        relPath: target.relPath,
        line: target.line,
        level: target.level,
      },
      refileConfig,
      agendaConfig,
      source.relPath,
    );
    new Notice(
      result.sameFile
        ? `Refiled within ${target.relPath}`
        : `Refiled to ${target.relPath}`,
    );
    plugin.state.scheduleRefresh();
    if (result.sameFile) {
      // Same-file refile: the source pane already shows the updated
      // buffer, so the picker pane is no longer useful — close it.
      plugin.closeRefilePeek();
    } else {
      const targetFile = plugin.app.vault.getAbstractFileByPath(
        target.relPath,
      );
      if (targetFile instanceof TFile) {
        const targetRaw = await plugin.app.vault.cachedRead(targetFile);
        const fileLine =
          result.insertedBodyLine - 1 + frontmatterLineCount(targetRaw);
        // Swap the peek's view from the picker back to a markdown
        // view of the destination, scrolled to the moved heading.
        await plugin.revealRefileTarget(targetFile, fileLine);
      }
    }
  } catch (err) {
    plugin.closeRefilePeek();
    if (err instanceof RefileError) {
      new Notice(`oak: refile — ${err.message}`);
    } else {
      console.error("oak: refile failed", err);
      new Notice("oak: refile failed (see console)");
    }
  }
}
