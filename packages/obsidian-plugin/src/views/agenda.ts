// Oak agenda view — port of emacs `org-agenda` into the plugin.
//
// The view subscribes to VaultState; on each snapshot it parses every
// page's body for org-style task syntax (TODO/SCHEDULED/DEADLINE/...)
// and runs the current AgendaQuery (weekly | todo | match | search)
// against the result.
//
// Keybindings while focused, mirroring `org-agenda`:
//   a  weekly agenda (default span 7 days starting on weekStartsOn)
//   t  global TODO list
//   m  prompt for tag/property match expression
//   s  prompt for body regex search
//   f  shift weekly window forward by `span` days
//   b  shift weekly window backward by `span` days
//   .  jump to today
//   r  rebuild (forces VaultState.refresh)
//   d  mark the focused entry DONE / advance its repeater
//  Enter  open the entry's source file at the heading line

import {
  ItemView,
  Notice,
  Scope,
  TFile,
  WorkspaceLeaf,
  type App,
} from "obsidian";

import {
  DEFAULT_AGENDA_CONFIG,
  addUnits,
  extractVaultAgendaEntries,
  loadAgendaConfig,
  markDone,
  runAgenda,
  startOfWeek,
  todayIso,
  WriteBackError,
  type AgendaConfig,
  type AgendaItem,
  type AgendaQuery,
  type AgendaView,
} from "@oak/core";

import { vaultRoot } from "../paths.js";
import type { OakOpenFile } from "../open-file.js";
import type { VaultSnapshot, VaultState } from "../state.js";

export const VIEW_TYPE_OAK_AGENDA = "oak-agenda";

export class OakAgendaView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private query: AgendaQuery;
  private config: AgendaConfig = DEFAULT_AGENDA_CONFIG;
  private latestSnapshot: VaultSnapshot | null = null;
  private latestView: AgendaView | null = null;
  private focusedItemKey: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
  ) {
    super(leaf);
    const today = todayIso(new Date());
    this.query = {
      kind: "weekly",
      from: startOfWeek(today, this.config.weekStartsOn),
      days: 7,
    };
  }

  override getViewType(): string {
    return VIEW_TYPE_OAK_AGENDA;
  }

  override getDisplayText(): string {
    return "Oak — Agenda";
  }

  override getIcon(): string {
    return "calendar-days";
  }

  override async onOpen(): Promise<void> {
    this.config = await loadAgendaConfig(vaultRoot(this.app2));
    if (this.query.kind === "weekly") {
      this.query = {
        ...this.query,
        from: startOfWeek(todayIso(new Date()), this.config.weekStartsOn),
      };
    }
    this.installKeybindings();
    this.unsubscribe = this.state.subscribe((snap) => this.refresh(snap));
  }

  override async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  private installKeybindings(): void {
    const scope = new Scope(this.app2.scope);
    this.scope = scope;
    scope.register([], "a", () => this.setQuery({
      kind: "weekly",
      from: startOfWeek(todayIso(new Date()), this.config.weekStartsOn),
      days: 7,
    }));
    scope.register([], "t", () => this.setQuery({ kind: "todo" }));
    scope.register([], "m", () => this.promptMatch());
    scope.register([], "s", () => this.promptSearch());
    scope.register([], "f", () => this.shiftWeekly(+1));
    scope.register([], "b", () => this.shiftWeekly(-1));
    scope.register([], ".", () => {
      if (this.query.kind === "weekly") {
        this.setQuery({
          kind: "weekly",
          from: startOfWeek(todayIso(new Date()), this.config.weekStartsOn),
          days: this.query.days,
        });
      }
    });
    scope.register([], "r", () => {
      void this.state.refresh();
    });
    scope.register([], "d", () => void this.markFocusedDone());
    scope.register([], "Enter", () => this.openFocused());
  }

  private setQuery(query: AgendaQuery): void {
    this.query = query;
    this.recompute();
  }

  private shiftWeekly(direction: 1 | -1): void {
    if (this.query.kind !== "weekly") return;
    const next = addUnits(this.query.from, direction * this.query.days, "d");
    this.setQuery({ kind: "weekly", from: next, days: this.query.days });
  }

  private promptMatch(): void {
    const expr = window.prompt("Match expression (e.g. work+urgent-someday)");
    if (!expr) return;
    this.setQuery({ kind: "match", expression: expr.trim() });
  }

  private promptSearch(): void {
    const regex = window.prompt("Search regex");
    if (!regex) return;
    this.setQuery({ kind: "search", regex: regex.trim() });
  }

  private refresh(snap: VaultSnapshot | null): void {
    this.latestSnapshot = snap;
    this.recompute();
  }

  private recompute(): void {
    if (!this.latestSnapshot) {
      this.latestView = null;
      this.render();
      return;
    }
    try {
      const entries = extractVaultAgendaEntries(
        this.latestSnapshot.vault,
        this.config,
      );
      this.latestView = runAgenda(entries, this.query, this.config);
    } catch (err) {
      console.warn("oak agenda: query failed", err);
      this.latestView = null;
    }
    this.render();
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
    root.addClass("oak-agenda");

    const header = root.createDiv({ cls: "oak-agenda-header" });
    header.createEl("h1", { text: "Oak — Agenda" });
    this.renderTabs(header);
    this.renderQueryLine(header);

    if (!this.latestView) {
      root.createEl("div", {
        cls: "oak-empty",
        text: "Indexing vault…",
      });
      return;
    }

    for (const bucket of this.latestView.buckets) {
      const sec = root.createDiv({ cls: "oak-agenda-bucket" });
      sec.createEl("h2", { text: bucket.label });
      if (bucket.items.length === 0) {
        sec.createEl("p", { cls: "oak-empty", text: "(nothing)" });
        continue;
      }
      const ul = sec.createEl("ul", { cls: "oak-agenda-list" });
      for (const item of bucket.items) {
        const key = `${item.entry.relPath}:${item.entry.line}:${item.date ?? ""}`;
        const li = ul.createEl("li", { cls: "oak-agenda-item" });
        if (this.focusedItemKey === key) li.addClass("is-focused");
        li.dataset.itemKey = key;
        li.addEventListener("click", () => {
          this.focusedItemKey = key;
          this.openItem(item);
        });
        this.renderItem(li, item);
      }
    }

    const footer = root.createDiv({ cls: "oak-agenda-footer" });
    footer.createEl("p", {
      cls: "oak-home-meta",
      text: "a/t/m/s · f/b · . · r · d · Enter",
    });
  }

  private renderTabs(parent: HTMLElement): void {
    const tabs = parent.createDiv({ cls: "oak-agenda-tabs" });
    const make = (label: string, q: AgendaQuery, active: boolean) => {
      const btn = tabs.createEl("button", { text: label });
      if (active) btn.addClass("is-active");
      btn.addEventListener("click", () => this.setQuery(q));
    };
    make("a", {
      kind: "weekly",
      from: startOfWeek(todayIso(new Date()), this.config.weekStartsOn),
      days: 7,
    }, this.query.kind === "weekly");
    make("t", { kind: "todo" }, this.query.kind === "todo");
    make("m", { kind: "match", expression: "" }, this.query.kind === "match");
    make("s", { kind: "search", regex: "" }, this.query.kind === "search");
  }

  private renderQueryLine(parent: HTMLElement): void {
    const p = parent.createEl("p", { cls: "oak-home-meta" });
    if (this.query.kind === "weekly") {
      p.setText(
        `Weekly · ${this.query.from} → ${addUnits(this.query.from, this.query.days - 1, "d")}`,
      );
    } else if (this.query.kind === "todo") {
      p.setText(
        `Global TODO list${this.query.keyword ? ` (${this.query.keyword})` : ""}`,
      );
    } else if (this.query.kind === "match") {
      p.setText(`Match: ${this.query.expression || "(none)"}`);
    } else {
      p.setText(`Search: /${this.query.regex || ""}/i`);
    }
  }

  private renderItem(li: HTMLElement, item: AgendaItem): void {
    const cat = li.createEl("span", { cls: "oak-agenda-cat" });
    cat.setText(item.entry.category);
    if (item.time) {
      const t = li.createEl("span", { cls: "oak-agenda-time" });
      t.setText(item.endTime ? `${item.time}-${item.endTime}` : item.time);
    }
    if (item.marker) {
      const m = li.createEl("span", { cls: `oak-agenda-marker oak-marker-${item.marker}` });
      m.setText(this.markerLabel(item));
    }
    if (item.entry.todoState) {
      const k = li.createEl("span", {
        cls: `oak-agenda-keyword oak-keyword-${item.entry.todoState.toLowerCase()}`,
      });
      k.setText(item.entry.todoState);
    }
    if (item.entry.priority) {
      const p = li.createEl("span", { cls: "oak-agenda-priority" });
      p.setText(`[#${item.entry.priority}]`);
    }
    li.createEl("span", {
      cls: "oak-agenda-title",
      text: item.entry.title,
    });
    if (item.entry.tags.length > 0) {
      const tags = li.createEl("span", { cls: "oak-agenda-tags" });
      tags.setText(`:${item.entry.tags.join(":")}:`);
    }
  }

  private markerLabel(item: AgendaItem): string {
    switch (item.marker) {
      case "scheduled":
        return "Scheduled:";
      case "scheduled-overdue":
        return `Sched.${item.daysDelta}xD:`;
      case "deadline":
        return "Deadline:";
      case "deadline-warning":
        return `In  ${item.daysDelta} d.:`;
      case "deadline-overdue":
        return `${item.daysDelta} d. ago:`;
      case "timestamp":
        return "";
      default:
        return "";
    }
  }

  private openItem(item: AgendaItem): void {
    const file = this.app2.vault.getAbstractFileByPath(item.entry.relPath);
    if (!(file instanceof TFile)) {
      new Notice(`oak: ${item.entry.relPath} not found`);
      return;
    }
    void this.openFile(file, { newTab: false });
    // Best-effort line jump: schedule after the leaf has loaded.
    window.setTimeout(() => {
      const leaf = this.app2.workspace.getMostRecentLeaf();
      const view = leaf?.view as unknown as {
        editor?: { setCursor: (pos: { line: number; ch: number }) => void };
      };
      if (view?.editor) {
        view.editor.setCursor({ line: Math.max(0, item.entry.line - 1), ch: 0 });
      }
    }, 60);
  }

  private openFocused(): void {
    if (!this.focusedItemKey || !this.latestView) return;
    for (const b of this.latestView.buckets) {
      for (const it of b.items) {
        const k = `${it.entry.relPath}:${it.entry.line}:${it.date ?? ""}`;
        if (k === this.focusedItemKey) {
          this.openItem(it);
          return;
        }
      }
    }
  }

  private async markFocusedDone(): Promise<void> {
    if (!this.focusedItemKey || !this.latestView) {
      new Notice("oak: focus an entry first (click)");
      return;
    }
    let target: AgendaItem | null = null;
    for (const b of this.latestView.buckets) {
      for (const it of b.items) {
        const k = `${it.entry.relPath}:${it.entry.line}:${it.date ?? ""}`;
        if (k === this.focusedItemKey) {
          target = it;
          break;
        }
      }
      if (target) break;
    }
    if (!target) return;
    try {
      const result = await markDone(
        target.entry.filePath,
        target.entry.entryId,
        this.config,
        undefined,
        target.entry.relPath,
      );
      new Notice(
        result.repeated
          ? "Advanced repeater"
          : "Marked DONE",
      );
      this.state.scheduleRefresh();
    } catch (err) {
      if (err instanceof WriteBackError) {
        new Notice(`oak: ${err.message}`);
      } else {
        console.error("oak agenda: markDone failed", err);
        new Notice("oak: failed to mark DONE (see console)");
      }
    }
  }
}
