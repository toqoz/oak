// Org-refile UI: pick a target heading from across the vault and move
// the source heading + its subtree there.
//
// The source is identified by entry id so the core refile call can
// re-derive the heading on disk (mtime CAS) without trusting cached
// line numbers.
//
// Targets are collected from the latest vault snapshot; the user picks
// one via Obsidian's `FuzzySuggestModal`. Display strings put the
// vault-relative path first so a fuzzy query like `tasks/work/refactor`
// hits both file and heading components.

import {
  FuzzySuggestModal,
  Notice,
  type App,
} from "obsidian";

import {
  collectRefileTargets,
  refile,
  RefileError,
  type AgendaConfig,
  type AgendaEntry,
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
    this.resolve(item);
    this.resolve = () => undefined;
  }

  override onClose(): void {
    super.onClose();
    // FuzzySuggestModal calls onChooseItem before close, so resolving
    // null here is a no-op when the user picked an item.
    this.resolve(null);
    this.resolve = () => undefined;
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

// Run a refile against `entry`. The caller is responsible for picking
// the source — for the editor command that's the heading enclosing the
// cursor; for the agenda view it's the focused row.
export async function refileEntry(
  plugin: OakPlugin,
  entry: AgendaEntry,
  config: AgendaConfig,
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
    if (t.relPath !== entry.relPath) return true;
    return t.line !== entry.line;
  });
  if (targets.length === 0) {
    new Notice("oak: no refile targets available");
    return;
  }
  const target = await pickTarget(plugin.app, targets, entry.title);
  if (!target) return;

  try {
    const result = await refile(
      entry.filePath,
      entry.entryId,
      {
        filePath: target.filePath,
        relPath: target.relPath,
        line: target.line,
        level: target.level,
      },
      config,
      entry.relPath,
    );
    new Notice(
      result.sameFile
        ? `Refiled within ${target.relPath}`
        : `Refiled to ${target.relPath}`,
    );
    plugin.state.scheduleRefresh();
  } catch (err) {
    if (err instanceof RefileError) {
      new Notice(`oak: refile — ${err.message}`);
    } else {
      console.error("oak: refile failed", err);
      new Notice("oak: refile failed (see console)");
    }
  }
}
