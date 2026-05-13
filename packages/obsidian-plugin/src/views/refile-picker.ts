// Refile target picker, rendered in the peek pane as a 2-column view:
//   - Left:  filterable list of vault files (or, after Shift-Enter, the
//            heading tree of the selected file).
//   - Right: live preview of the selected file, rendered with
//            Obsidian's MarkdownRenderer.
//   - Top:   filter input. Substring match on the relPath in file mode
//            and on the heading title chain in section mode.
//
// Replaces the FuzzySuggestModal-based picker. The point of the
// 2-column shape is that "where will my heading land?" becomes
// inspectable rather than blind: the user sees the destination's
// surrounding content before confirming.
//
// Keyboard model:
//   Type:        filter
//   ↓ / Ctrl-n   move selection down
//   ↑ / Ctrl-p   move selection up
//   Enter        commit
//                  • in file mode  → refile under the file's first
//                    heading (the page title)
//                  • in section mode → refile under that heading
//   Shift+Enter  in file mode → drill into the file's heading tree
//   Esc          in section mode → back to file mode
//                in file mode    → cancel the picker
//
// The view runs as an ItemView inside the existing peek leaf. Once a
// target is chosen, the caller (plugin.openRefilePicker) resolves the
// pending promise; the refile flow then runs the actual move and swaps
// the leaf's view back to a MarkdownView of the destination.

import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";

import { collectRefileTargets, type RefileTarget } from "@oak/core";

import type OakPlugin from "../main.js";

export const VIEW_TYPE_OAK_REFILE_PICKER = "oak-refile-picker";

// One file's targets, keyed by relPath. `headings` is the file's
// heading list (already filtered by the caller's exclude set); the
// first entry is the page's h1 title and serves as the default
// destination when the user commits in file mode without drilling.
type FileEntry = {
  relPath: string;
  filePath: string;
  headings: RefileTarget[];
};

type Mode =
  | { kind: "files" }
  | { kind: "sections"; file: FileEntry };

export type RefilePickerInit = {
  sourceTitle: string;
  // "relPath:line" keys to omit from the picker. The caller passes
  // the source heading itself (and, for multi-source flows, every
  // selected heading) so the user can't pick one of them as the
  // destination.
  excludeKeys: Set<string>;
  resolve: (target: RefileTarget | null) => void;
};

export class OakRefilePickerView extends ItemView {
  private resolve: ((target: RefileTarget | null) => void) | null = null;
  private sourceTitle = "";

  private allFiles: FileEntry[] = [];
  private filteredFiles: FileEntry[] = [];
  private filteredHeadings: RefileTarget[] = [];
  private filter = "";
  private mode: Mode = { kind: "files" };
  private selectedIdx = 0;

  // Cache the most recent preview render so quick navigation through
  // a file's headings doesn't re-render markdown each tick. Keyed by
  // relPath of the file the preview is for.
  private previewedRelPath: string | null = null;

  // DOM refs, set in render().
  private filterInputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: OakPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_OAK_REFILE_PICKER;
  }

  override getDisplayText(): string {
    return "Refile target";
  }

  override getIcon(): string {
    return "move-right";
  }

  // Called by the plugin right after `setViewState` resolves. Wires
  // the resolve callback, builds the file list from the latest vault
  // snapshot, and kicks off the first render. Kept off the public
  // ItemView API because the resolve callback isn't a serializable
  // view-state field.
  init(opts: RefilePickerInit): void {
    this.sourceTitle = opts.sourceTitle;
    this.resolve = opts.resolve;

    const snap = this.plugin.state.current();
    if (!snap) {
      new Notice("oak: vault index not ready yet");
      this.resolveAndClose(null);
      return;
    }

    const grouped = new Map<string, FileEntry>();
    for (const t of collectRefileTargets(snap.vault)) {
      if (opts.excludeKeys.has(`${t.relPath}:${t.line}`)) continue;
      const existing = grouped.get(t.relPath);
      if (existing) {
        existing.headings.push(t);
      } else {
        grouped.set(t.relPath, {
          relPath: t.relPath,
          filePath: t.filePath,
          headings: [t],
        });
      }
    }
    // A file with no headings has no refile target — drop it from
    // the picker.
    this.allFiles = [...grouped.values()]
      .filter((f) => f.headings.length > 0)
      .sort((a, b) => a.relPath.localeCompare(b.relPath));

    this.applyFilter();
    this.render();
    // Focus the input on next tick so DOM is settled.
    window.setTimeout(() => this.filterInputEl?.focus(), 0);
  }

  override async onOpen(): Promise<void> {
    // Borrow the peek-pane chrome class so the existing CSS rules
    // (hide the tab strip, hide the default view-header chrome,
    // skip dim while peek-active) apply to the picker the same way
    // they do to a markdown peek.
    this.containerEl.classList.add("oak-leaf-refile-peek");
    // Initial render shows the empty shell — `init` populates it
    // when the plugin calls in.
    this.render();
  }

  override async onClose(): Promise<void> {
    // If the leaf was closed (× / Esc / external swap) without a
    // resolved selection, treat it as cancel so the awaiting refile
    // flow doesn't hang.
    this.resolveAndClose(null);
  }

  private resolveAndClose(target: RefileTarget | null): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r(target);
    }
  }

  private applyFilter(): void {
    const f = this.filter.trim().toLowerCase();
    if (this.mode.kind === "files") {
      this.filteredFiles =
        f === ""
          ? this.allFiles.slice()
          : this.allFiles.filter((fe) =>
              fe.relPath.toLowerCase().includes(f),
            );
      if (this.selectedIdx >= this.filteredFiles.length) this.selectedIdx = 0;
    } else {
      const headings = this.mode.file.headings;
      this.filteredHeadings =
        f === ""
          ? headings.slice()
          : headings.filter((h) =>
              h.headingPath
                .slice(1)
                .join(" ")
                .toLowerCase()
                .includes(f),
            );
      if (this.selectedIdx >= this.filteredHeadings.length) this.selectedIdx = 0;
    }
  }

  private container(): HTMLElement {
    return (
      (this.containerEl.children[1] as HTMLElement | undefined) ??
      this.containerEl
    );
  }

  private render(): void {
    const root = this.container();
    root.empty();
    root.addClass("oak-refile-picker");

    const header = root.createDiv({ cls: "oak-refile-picker-header" });
    const placeholder = this.placeholderText();
    const input = header.createEl("input", {
      cls: "oak-refile-picker-filter",
      type: "text",
    });
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = this.filter;
    input.addEventListener("input", () => {
      this.filter = input.value;
      this.applyFilter();
      this.renderList();
      this.renderPreview();
    });
    input.addEventListener("keydown", (ev) => this.handleInputKeydown(ev));
    this.filterInputEl = input;

    const main = root.createDiv({ cls: "oak-refile-picker-main" });
    this.listEl = main.createDiv({ cls: "oak-refile-picker-list" });
    this.previewEl = main.createDiv({ cls: "oak-refile-picker-preview" });

    const hint = root.createDiv({ cls: "oak-refile-picker-hint" });
    this.hintEl = hint;

    this.renderList();
    this.renderPreview();
    this.renderHint();
  }

  private placeholderText(): string {
    if (this.mode.kind === "files") {
      return `Refile "${this.sourceTitle}" — pick a file…`;
    }
    return `Refile "${this.sourceTitle}" → ${this.mode.file.relPath} — pick a heading…`;
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    if (this.mode.kind === "files") {
      if (this.filteredFiles.length === 0) {
        this.listEl.createDiv({
          cls: "oak-refile-picker-empty",
          text: "No matching files.",
        });
        return;
      }
      this.filteredFiles.forEach((fe, idx) => {
        const row = this.listEl!.createDiv({
          cls: "oak-refile-picker-row",
        });
        if (idx === this.selectedIdx) row.addClass("is-selected");
        row.dataset.idx = String(idx);
        row.createSpan({ cls: "oak-refile-picker-row-path", text: fe.relPath });
        // Sections excluding the title heading the file mode Enter
        // already targets — gives a sense of how much there is to
        // drill into.
        const sectionCount = Math.max(0, fe.headings.length - 1);
        if (sectionCount > 0) {
          row.createSpan({
            cls: "oak-refile-picker-row-count",
            text: `${sectionCount} §`,
          });
        }
        row.addEventListener("click", () => {
          this.selectedIdx = idx;
          this.renderList();
          this.renderPreview();
          this.filterInputEl?.focus();
        });
        row.addEventListener("dblclick", () => {
          this.selectedIdx = idx;
          this.commitSelection(false);
        });
      });
    } else {
      if (this.filteredHeadings.length === 0) {
        this.listEl.createDiv({
          cls: "oak-refile-picker-empty",
          text: "No matching headings — Esc to go back to files.",
        });
        return;
      }
      this.filteredHeadings.forEach((h, idx) => {
        const row = this.listEl!.createDiv({
          cls: "oak-refile-picker-row",
        });
        if (idx === this.selectedIdx) row.addClass("is-selected");
        row.dataset.idx = String(idx);
        const indent = "  ".repeat(Math.max(0, h.level - 1));
        const titleChain = h.headingPath.slice(1).join(" ▸ ");
        row.createSpan({
          cls: "oak-refile-picker-row-section",
          text: `${indent}${titleChain}`,
        });
        row.createSpan({
          cls: "oak-refile-picker-row-level",
          text: `H${h.level}`,
        });
        row.addEventListener("click", () => {
          this.selectedIdx = idx;
          this.renderList();
          this.renderPreview();
          this.filterInputEl?.focus();
        });
        row.addEventListener("dblclick", () => {
          this.selectedIdx = idx;
          this.commitSelection(false);
        });
      });
    }
    // Scroll selection into view.
    const selected = this.listEl.querySelector<HTMLElement>(".is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }

  private renderHint(): void {
    if (!this.hintEl) return;
    this.hintEl.empty();
    if (this.mode.kind === "files") {
      this.hintEl.setText(
        "↵ under page title · ⇧↵ pick section · ↑↓ navigate · esc cancel",
      );
    } else {
      this.hintEl.setText(
        "↵ refile under heading · ↑↓ navigate · esc back to files",
      );
    }
  }

  // Render the preview pane: shows the full markdown of the file
  // currently selected (file mode) or the file containing the
  // currently selected heading (section mode). Re-rendering on every
  // arrow-key press would be expensive, so we cache by relPath and
  // skip re-render when the underlying file hasn't changed.
  private async renderPreview(): Promise<void> {
    if (!this.previewEl) return;
    const file = this.currentPreviewFile();
    if (!file) {
      this.previewEl.empty();
      this.previewEl.createDiv({
        cls: "oak-refile-picker-preview-empty",
        text: "Select a file to preview.",
      });
      this.previewedRelPath = null;
      return;
    }
    if (this.previewedRelPath === file.relPath) {
      // Already rendered; section-mode arrow nav within the same file
      // doesn't require a re-render. We could scroll-to-heading here
      // but defer that to a later iteration.
      return;
    }
    const tfile = this.plugin.app.vault.getAbstractFileByPath(file.relPath);
    if (!(tfile instanceof TFile)) return;
    let raw = "";
    try {
      raw = await this.plugin.app.vault.cachedRead(tfile);
    } catch {
      this.previewEl.empty();
      this.previewEl.createDiv({
        cls: "oak-refile-picker-preview-empty",
        text: "Could not read file.",
      });
      return;
    }
    this.previewEl.empty();
    const inner = this.previewEl.createDiv({
      cls: "oak-refile-picker-preview-content",
    });
    try {
      await MarkdownRenderer.render(
        this.plugin.app,
        raw,
        inner,
        file.relPath,
        this,
      );
    } catch (err) {
      console.warn("oak: refile picker preview render failed", err);
      inner.setText(raw);
    }
    this.previewedRelPath = file.relPath;
  }

  // The file the preview pane should display: in file mode it's the
  // currently highlighted file row; in section mode it's the file the
  // section list belongs to (not whichever heading is highlighted —
  // they all live in the same file).
  private currentPreviewFile(): FileEntry | null {
    if (this.mode.kind === "files") {
      return this.filteredFiles[this.selectedIdx] ?? null;
    }
    return this.mode.file;
  }

  private handleInputKeydown(ev: KeyboardEvent): void {
    // Modifier-aware switch. We deliberately swallow arrow keys so the
    // input cursor doesn't jump while the user is navigating the list.
    if (ev.key === "ArrowDown" || (ev.ctrlKey && ev.key === "n")) {
      ev.preventDefault();
      this.moveSelection(1);
      return;
    }
    if (ev.key === "ArrowUp" || (ev.ctrlKey && ev.key === "p")) {
      ev.preventDefault();
      this.moveSelection(-1);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.commitSelection(ev.shiftKey);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.handleEscape();
      return;
    }
    // Other keys (typing, backspace, etc.) flow through to the input
    // handler which fires the input event and calls applyFilter().
  }

  private moveSelection(delta: 1 | -1): void {
    const len =
      this.mode.kind === "files"
        ? this.filteredFiles.length
        : this.filteredHeadings.length;
    if (len === 0) return;
    this.selectedIdx = (this.selectedIdx + delta + len) % len;
    this.renderList();
    if (this.mode.kind === "files") this.renderPreview();
  }

  private commitSelection(drillIntoSections: boolean): void {
    if (this.mode.kind === "files") {
      const fe = this.filteredFiles[this.selectedIdx];
      if (!fe) return;
      const defaultTarget = fe.headings[0];
      if (!defaultTarget) return;
      if (drillIntoSections && fe.headings.length > 1) {
        this.mode = { kind: "sections", file: fe };
        this.filter = "";
        this.selectedIdx = 0;
        this.applyFilter();
        if (this.filterInputEl) {
          this.filterInputEl.value = "";
          this.filterInputEl.placeholder = this.placeholderText();
        }
        this.renderList();
        this.renderHint();
        this.renderPreview();
        return;
      }
      // Either Enter, or Shift-Enter on a file with only its title
      // heading (nothing useful to drill into) — commit to the title.
      this.resolveAndClose(defaultTarget);
    } else {
      const h = this.filteredHeadings[this.selectedIdx];
      if (!h) return;
      this.resolveAndClose(h);
    }
  }

  private handleEscape(): void {
    if (this.mode.kind === "sections") {
      // Pop back to file mode, restoring "remembered" position by
      // file path so users feel like they're in the same place.
      const prevRel = this.mode.file.relPath;
      this.mode = { kind: "files" };
      this.filter = "";
      this.applyFilter();
      const idx = this.filteredFiles.findIndex(
        (fe) => fe.relPath === prevRel,
      );
      this.selectedIdx = Math.max(0, idx);
      if (this.filterInputEl) {
        this.filterInputEl.value = "";
        this.filterInputEl.placeholder = this.placeholderText();
      }
      this.renderList();
      this.renderHint();
      this.renderPreview();
      return;
    }
    // Top-level cancel.
    this.resolveAndClose(null);
  }
}
