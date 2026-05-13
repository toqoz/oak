// Full-pane search view: live substring search across the vault, with
// a Zed-flavoured two-pane layout (results on the left, snippet
// preview on the right). Opens via the `oak-search` command (bind a
// hotkey in Obsidian's settings if desired) or the search icon next
// to the home button. Arrow keys (and C-n / C-p) navigate; Enter
// opens; ⌘-Enter opens in a new tab; Esc clears the query, then
// steps back through leaf history.

import {
  ItemView,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type App,
  type ViewStateResult,
} from "obsidian";

import {
  searchVault,
  type SearchHit,
  type SearchSnippet,
} from "@oak/core";

import type { VaultState } from "../state.js";
import type { OakOpenFile } from "../open-file.js";

export const VIEW_TYPE_OAK_SEARCH = "oak-search";

export type SearchGoBackFn = () => void;

export class OakSearchView extends ItemView {
  private query = "";
  private hits: SearchHit[] = [];
  private selectedIdx = 0;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
    private goBack: SearchGoBackFn,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OAK_SEARCH;
  }

  getDisplayText(): string {
    return "oak — Search";
  }

  override getIcon(): string {
    return "search";
  }

  // Same rationale as OakHomeView / OakGhostView — opt into leaf
  // history so ← / → step through search ↔ page ↔ home like a
  // browser tab.
  override navigation = true;

  override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    if (state && typeof state === "object" && "query" in state) {
      const q = (state as { query?: unknown }).query;
      if (typeof q === "string") this.query = q;
    }
    await super.setState(state, result);
    result.history = true;
    if (this.inputEl) {
      this.inputEl.value = this.query;
      this.runSearch();
    }
  }

  override getState(): Record<string, unknown> {
    return { query: this.query };
  }

  override async onOpen(): Promise<void> {
    this.renderShell();
    this.unsubscribe = this.state.subscribe(() => this.runSearch());
    // Defer focus until after the layout settles; otherwise the focus
    // happens before the input is in the DOM in some workspace
    // restoration flows.
    queueMicrotask(() => this.inputEl?.focus());
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // External entry point — the command handler calls this so that
  // re-running the command while already on the search view refocuses
  // the input and selects the existing query for fast replacement.
  focusInput(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  private root(): HTMLElement {
    return (
      (this.containerEl.children[1] as HTMLElement | undefined) ??
      this.containerEl
    );
  }

  private renderShell(): void {
    const root = this.root();
    root.empty();
    root.addClass("oak-search");

    const inputRow = root.createDiv({ cls: "oak-search-input-row" });
    const iconEl = inputRow.createDiv({ cls: "oak-search-input-icon" });
    setIcon(iconEl, "search");
    const input = inputRow.createEl("input", {
      cls: "oak-search-input",
      type: "text",
    });
    input.setAttr("placeholder", "Search vault…");
    input.spellcheck = false;
    input.value = this.query;
    this.inputEl = input;
    this.summaryEl = inputRow.createDiv({ cls: "oak-search-summary" });

    const body = root.createDiv({ cls: "oak-search-body" });
    this.resultsEl = body.createDiv({ cls: "oak-search-results" });
    this.previewEl = body.createDiv({ cls: "oak-search-preview" });

    input.addEventListener("input", () => {
      this.query = input.value;
      this.selectedIdx = 0;
      this.runSearch();
      this.app2.workspace.requestSaveLayout();
    });
    input.addEventListener("keydown", (ev) => {
      // Emacs-style C-n / C-p mirror ArrowDown / ArrowUp so the user
      // never has to move off the home row. We deliberately match on
      // ctrlKey only (no metaKey) — ⌘N is "new note" in Obsidian.
      const ctrlOnly = ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
      if (ev.key === "ArrowDown" || (ctrlOnly && ev.key === "n")) {
        ev.preventDefault();
        this.move(1);
      } else if (ev.key === "ArrowUp" || (ctrlOnly && ev.key === "p")) {
        ev.preventDefault();
        this.move(-1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        this.openSelected(ev.metaKey || ev.ctrlKey);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (this.query.length > 0) {
          this.query = "";
          input.value = "";
          this.selectedIdx = 0;
          this.runSearch();
        } else {
          this.goBack();
        }
      }
    });

    this.runSearch();
  }

  private runSearch(): void {
    const snap = this.state.current();
    this.hits = snap ? searchVault(snap.vault, this.query) : [];
    if (this.selectedIdx >= this.hits.length) {
      this.selectedIdx = Math.max(0, this.hits.length - 1);
    }
    this.renderResults();
    this.renderPreview();
    this.renderSummary();
  }

  private renderSummary(): void {
    const el = this.summaryEl;
    if (!el) return;
    el.empty();
    if (this.query.trim().length === 0) {
      el.setText("Type to search title, aliases, and body.");
      return;
    }
    if (this.hits.length === 0) {
      el.setText("No matches.");
      return;
    }
    const totalBody = this.hits.reduce((acc, h) => acc + h.bodyMatchCount, 0);
    el.setText(
      `${this.hits.length} page${this.hits.length === 1 ? "" : "s"} · ${totalBody} body match${totalBody === 1 ? "" : "es"}`,
    );
  }

  private renderResults(): void {
    const el = this.resultsEl;
    if (!el) return;
    el.empty();
    if (this.hits.length === 0) return;

    for (let i = 0; i < this.hits.length; i++) {
      const hit = this.hits[i]!;
      const row = el.createDiv({ cls: "oak-search-result" });
      if (i === this.selectedIdx) row.addClass("is-selected");
      row.setAttr("role", "option");

      const titleRow = row.createDiv({ cls: "oak-search-result-title-row" });
      titleRow.createEl("span", {
        cls: "oak-search-result-title",
        text: hit.title,
      });
      titleRow.createEl("span", {
        cls: `oak-search-result-vis oak-vis-${hit.visibility}`,
        text: hit.visibility,
      });
      row.createEl("div", {
        cls: "oak-search-result-path",
        text: hit.path,
      });

      for (const snip of hit.snippets) {
        renderSnippetRow(row, snip);
      }

      const shown = hit.snippets.filter((s) => s.kind === "body").length;
      const more = hit.bodyMatchCount - shown;
      if (more > 0) {
        row.createEl("div", {
          cls: "oak-search-snip-more",
          text: `+${more} more match${more === 1 ? "" : "es"} in body`,
        });
      }

      row.addEventListener("click", (ev) => {
        this.updateSelection(i, false);
        this.openSelected(ev.metaKey || ev.ctrlKey);
      });
      row.addEventListener("mouseenter", () => {
        if (this.selectedIdx === i) return;
        this.updateSelection(i, false);
      });
    }
  }

  // Cheap selection update — toggles the `is-selected` class on the
  // relevant row instead of re-rendering the whole list, and re-renders
  // only the preview pane. Arrow keys, hover, and click all go through
  // here so a long result list stays responsive.
  private updateSelection(idx: number, scroll: boolean): void {
    const el = this.resultsEl;
    if (!el) return;
    this.selectedIdx = idx;
    const rows = el.querySelectorAll<HTMLElement>(".oak-search-result");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (i === idx) r.addClass("is-selected");
      else r.removeClass("is-selected");
    }
    if (scroll) {
      rows[idx]?.scrollIntoView({ block: "nearest" });
    }
    this.renderPreview();
  }

  private renderPreview(): void {
    const el = this.previewEl;
    if (!el) return;
    el.empty();

    if (this.hits.length === 0) {
      el.createEl("div", {
        cls: "oak-search-preview-empty",
        text:
          this.query.trim().length === 0
            ? "Start typing to search."
            : "No matches.",
      });
      return;
    }
    const hit = this.hits[this.selectedIdx];
    if (!hit) return;

    const head = el.createDiv({ cls: "oak-search-preview-head" });
    head.createEl("h2", {
      cls: "oak-search-preview-title",
      text: hit.title,
    });
    const metaParts: string[] = [hit.visibility, hit.path];
    if (hit.bodyMatchCount > 0) {
      metaParts.push(
        `${hit.bodyMatchCount} body match${hit.bodyMatchCount === 1 ? "" : "es"}`,
      );
    }
    head.createEl("div", {
      cls: "oak-search-preview-meta",
      text: metaParts.join(" · "),
    });
    if (hit.aliases.length > 0) {
      head.createEl("div", {
        cls: "oak-search-preview-meta",
        text: `aliases: ${hit.aliases.join(", ")}`,
      });
    }

    const list = el.createDiv({ cls: "oak-search-preview-snippets" });
    for (const snip of hit.snippets) {
      renderSnippetRow(list, snip, true);
    }
  }

  private move(delta: number): void {
    if (this.hits.length === 0) return;
    const n = this.hits.length;
    const next = (this.selectedIdx + delta + n) % n;
    this.updateSelection(next, true);
  }

  private openSelected(newTab: boolean): void {
    const hit = this.hits[this.selectedIdx];
    if (!hit) return;
    const file = this.app2.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) {
      void this.openFile(file, { newTab });
    }
  }
}

function renderSnippetRow(
  parent: HTMLElement,
  snip: SearchSnippet,
  large = false,
): void {
  const row = parent.createDiv({
    cls: large
      ? `oak-search-snip oak-search-snip-${snip.kind} oak-search-snip-large`
      : `oak-search-snip oak-search-snip-${snip.kind}`,
  });
  const label =
    snip.kind === "body" ? `L${snip.line}` : snip.kind === "title" ? "title" : "alias";
  row.createEl("span", { cls: "oak-search-snip-line", text: label });
  const textEl = row.createEl("span", { cls: "oak-search-snip-text" });
  renderHighlighted(textEl, snip);
}

function renderHighlighted(
  parent: HTMLElement,
  snip: SearchSnippet,
): void {
  // Multi-term queries can land more than one match on the same line;
  // `ranges` is sorted + merged so we walk it linearly with a cursor.
  let cursor = 0;
  for (const r of snip.ranges) {
    if (r.start > cursor) {
      parent.createSpan({ text: snip.text.slice(cursor, r.start) });
    }
    parent.createEl("mark", {
      cls: "oak-search-mark",
      text: snip.text.slice(r.start, r.end),
    });
    cursor = r.end;
  }
  if (cursor < snip.text.length) {
    parent.createSpan({ text: snip.text.slice(cursor) });
  }
}
