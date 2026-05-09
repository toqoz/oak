// Org-refile UI: pick a target heading from across the vault and move
// the source heading + its subtree there.
//
// Two source identifications are supported:
//   - entryId: agenda view path, robust against snapshot/disk drift
//     because the core re-derives the heading on disk via parseAgendaPage.
//   - line+level: editor command path, used when the cursor sits on a
//     plain heading that isn't an agenda entry (no TODO state, no
//     planning line, no active timestamp).
//
// Targets are collected from the latest vault snapshot; the user picks
// one via Obsidian's `FuzzySuggestModal`. Display strings put the
// vault-relative path first so a fuzzy query like `tasks/work/refactor`
// hits both file and heading components.

import {
  FuzzySuggestModal,
  Notice,
  TFile,
  type App,
} from "obsidian";

import {
  collectRefileTargets,
  frontmatterLineCount,
  refile,
  RefileError,
  type AgendaConfig,
  type RefileConfig,
  type RefileTarget,
} from "@oak/core";

import type OakPlugin from "./main.js";

const TOP_OF_FILE_LABEL = "(top of file)";

function targetDisplay(target: RefileTarget): string {
  if (target.line === null) {
    return `${target.relPath} ${TOP_OF_FILE_LABEL}`;
  }
  // headingPath[0] is the file basename without `.md`; the rest is the
  // heading hierarchy. Replacing the basename with the relPath puts the
  // full vault location in the display so two same-named files stay
  // distinguishable.
  const [, ...headings] = target.headingPath;
  return `${target.relPath} ▸ ${headings.join(" ▸ ")}`;
}

class RefileTargetModal extends FuzzySuggestModal<RefileTarget> {
  // Track whether we have already resolved the outer promise so the
  // cancel path in onClose does not race ahead of onChooseItem. Required
  // because current Obsidian fires onClose *before* onChooseItem when
  // the user picks an item (selectSuggestion calls close() first, then
  // the handler) — so we cannot resolve null synchronously in onClose
  // or every selection would silently come back as cancel.
  private settled = false;

  constructor(
    app: App,
    private targets: RefileTarget[],
    private sourceTitle: string,
    private resolve: (target: RefileTarget | null) => void,
  ) {
    super(app);
    this.setPlaceholder(`Refile "${sourceTitle}" under…`);
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "refile" },
      { command: "esc", purpose: "cancel" },
    ]);
  }

  override getItems(): RefileTarget[] {
    return this.targets;
  }

  override getItemText(item: RefileTarget): string {
    return targetDisplay(item);
  }

  override onChooseItem(item: RefileTarget): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(item);
  }

  override onClose(): void {
    super.onClose();
    // Defer the cancel resolution one microtask so an `onChooseItem`
    // dispatched right after `onClose` (the order Obsidian uses on Enter
    // / click selection) gets a chance to settle the promise with the
    // chosen item first. If we get here without onChooseItem running,
    // the user really did cancel and the microtask resolves null.
    queueMicrotask(() => {
      if (this.settled) return;
      this.settled = true;
      this.resolve(null);
    });
  }
}

function pickTarget(
  app: App,
  targets: RefileTarget[],
  sourceTitle: string,
): Promise<RefileTarget | null> {
  return new Promise((resolve) => {
    new RefileTargetModal(app, targets, sourceTitle, resolve).open();
  });
}

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
// shape based on how many headings the user grabbed. Sources are
// processed bottom-up so cutting them out doesn't shift the line
// numbers of the ones still pending; the target line is updated each
// iteration via core's `targetLineAfter` so a same-file refile where
// the destination sits below the sources still tracks correctly.
export async function refileHeadings(
  plugin: OakPlugin,
  sources: RefileSourceDescriptor[],
  refileConfig: RefileConfig,
  agendaConfig: AgendaConfig,
): Promise<void> {
  if (sources.length === 0) return;
  if (sources.length === 1) {
    await refileHeading(plugin, sources[0]!, refileConfig, agendaConfig);
    return;
  }

  const snap = plugin.state.current();
  if (!snap) {
    new Notice("oak: vault index not ready yet");
    return;
  }

  // Exclude every selected source heading from the picker so the
  // user can't choose one of them as the destination.
  const sourceKeys = new Set(
    sources.map((s) => `${s.relPath}:${s.line}`),
  );
  const targets = collectRefileTargets(snap.vault).filter((t) => {
    if (t.line === null) return true;
    return !sourceKeys.has(`${t.relPath}:${t.line}`);
  });
  if (targets.length === 0) {
    new Notice("oak: no refile targets available");
    return;
  }

  const placeholder = `${sources.length} sections`;
  const target = await pickTarget(plugin.app, targets, placeholder);
  if (!target) return;

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
    if (!lastSameFile && lastInsertedBodyLine !== null) {
      const targetFile = plugin.app.vault.getAbstractFileByPath(
        target.relPath,
      );
      if (targetFile instanceof TFile) {
        const targetRaw = await plugin.app.vault.cachedRead(targetFile);
        const fileLine =
          lastInsertedBodyLine - 1 + frontmatterLineCount(targetRaw);
        await plugin.revealRefileTarget(targetFile, fileLine);
      }
    }
  } else if (failureMessage) {
    new Notice(`oak: refile — ${failureMessage}`);
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
): Promise<void> {
  const snap = plugin.state.current();
  if (!snap) {
    new Notice("oak: vault index not ready yet");
    return;
  }
  const targets = collectRefileTargets(snap.vault).filter((t) => {
    // Exclude the source heading itself from the picker. Cross-file
    // self-refile can't happen, but for same-file we'd otherwise show
    // the entry as a target and then reject it in core.
    if (t.relPath !== source.relPath) return true;
    return t.line !== source.line;
  });
  if (targets.length === 0) {
    new Notice("oak: no refile targets available");
    return;
  }
  const target = await pickTarget(plugin.app, targets, source.title);
  if (!target) return;

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
    // Same-file refile: Obsidian's own editor already shows the
    // updated buffer at the new heading, so a peek pane would just be
    // a duplicate view of the active leaf. Skip it. For cross-file we
    // open the destination below so the user can see where the heading
    // landed without losing the source caret position (emacs-style).
    if (!result.sameFile) {
      const targetFile = plugin.app.vault.getAbstractFileByPath(
        target.relPath,
      );
      if (targetFile instanceof TFile) {
        const targetRaw = await plugin.app.vault.cachedRead(targetFile);
        const fileLine =
          result.insertedBodyLine - 1 + frontmatterLineCount(targetRaw);
        await plugin.revealRefileTarget(targetFile, fileLine);
      }
    }
  } catch (err) {
    if (err instanceof RefileError) {
      new Notice(`oak: refile — ${err.message}`);
    } else {
      console.error("oak: refile failed", err);
      new Notice("oak: refile failed (see console)");
    }
  }
}
