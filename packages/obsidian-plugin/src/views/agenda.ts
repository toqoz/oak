// Oak agenda view — port of emacs `org-agenda` adapted for the
// Obsidian editor surface.
//
// Five tabs (named, not single letters):
//   Today    — today's bucket only. Scheduled-on-day, deadlines-on-day,
//              overdue scheduled and deadline warnings/overdues all
//              roll up here per the existing weekly-view rules.
//   Upcoming — today + N days. Span chips switch N (1/3/7/14).
//   TODO     — global open-TODO list. Keyword chips filter by state.
//   Tags     — `org-tags-view`. Inline input for `+work-someday` etc.
//   Search   — body regex. Inline input.
//
// Keybindings (focus must be in the agenda leaf):
//   j / ArrowDown   focus next item
//   k / ArrowUp     focus previous item
//   Enter           open focused item's source line
//   d               mark focused entry DONE / advance repeater
//   r               force vault refresh
//
// The previous build wired `m` and `s` through `window.prompt`, which
// Electron renderer blocks — so those modes were silently broken.
// Inline inputs replace the prompts and let the user edit/re-run the
// query without leaving the view.

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
  daysBetween,
  extractVaultAgendaEntries,
  loadAgendaConfig,
  markDone,
  runAgenda,
  todayIso,
  WriteBackError,
  type AgendaConfig,
  type AgendaEntry,
  type AgendaItem,
  type AgendaQuery,
  type AgendaView,
} from "@oak/core";

import { vaultRoot } from "../paths.js";
import type { OakOpenFile } from "../open-file.js";
import type { VaultSnapshot, VaultState } from "../state.js";

export const VIEW_TYPE_OAK_AGENDA = "oak-agenda";

type TabKind = "upcoming" | "todo" | "tags" | "search";

type Filter =
  | { tab: "upcoming"; days: 1 | 3 | 7 | 14 }
  | { tab: "todo"; keyword: string | null }
  | { tab: "tags"; expression: string }
  | { tab: "search"; regex: string };

const TAB_LABELS: Record<TabKind, string> = {
  upcoming: "Upcoming",
  todo: "TODO",
  tags: "Tags",
  search: "Search",
};

const UPCOMING_SPANS: Array<1 | 3 | 7 | 14> = [1, 3, 7, 14];

export class OakAgendaView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private filter: Filter = { tab: "upcoming", days: 1 };
  private config: AgendaConfig = DEFAULT_AGENDA_CONFIG;
  private latestSnapshot: VaultSnapshot | null = null;
  private latestEntries: AgendaEntry[] = [];
  private latestView: AgendaView | null = null;
  private focusedKey: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
  ) {
    super(leaf);
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
    const moveFocus = (delta: 1 | -1) => this.moveFocus(delta);
    scope.register([], "j", () => moveFocus(1));
    scope.register([], "ArrowDown", () => moveFocus(1));
    scope.register([], "k", () => moveFocus(-1));
    scope.register([], "ArrowUp", () => moveFocus(-1));
    scope.register([], "Enter", () => this.openFocused());
    scope.register([], "d", () => void this.markFocusedDone());
    scope.register([], "r", () => void this.state.refresh());
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    this.recompute();
  }

  private refresh(snap: VaultSnapshot | null): void {
    this.latestSnapshot = snap;
    if (snap) {
      this.latestEntries = extractVaultAgendaEntries(snap.vault, this.config);
    } else {
      this.latestEntries = [];
    }
    this.recompute();
  }

  private currentQuery(): AgendaQuery {
    const today = todayIso(new Date());
    switch (this.filter.tab) {
      case "upcoming":
        return { kind: "weekly", from: today, days: this.filter.days };
      case "todo": {
        const q: AgendaQuery = { kind: "todo" };
        if (this.filter.keyword) q.keyword = this.filter.keyword;
        return q;
      }
      case "tags":
        return { kind: "match", expression: this.filter.expression };
      case "search":
        return { kind: "search", regex: this.filter.regex };
    }
  }

  private recompute(): void {
    if (!this.latestSnapshot) {
      this.latestView = null;
      this.render();
      return;
    }
    const query = this.currentQuery();
    // Tags / Search with an empty expression should show empty rather
    // than throw a regex error from runAgenda.
    if (
      (query.kind === "match" && query.expression.length === 0) ||
      (query.kind === "search" && query.regex.length === 0)
    ) {
      this.latestView = {
        query,
        generatedAt: new Date().toISOString(),
        buckets: [{ key: "all", label: "", items: [] }],
      };
      this.render();
      return;
    }
    try {
      this.latestView = runAgenda(
        this.latestEntries,
        query,
        this.config,
      );
    } catch (err) {
      console.warn("oak agenda: query failed", err);
      this.latestView = null;
    }
    // Keep focus stable across recomputes when the focused item still
    // exists; otherwise drop it.
    if (this.focusedKey && !this.findFocused()) this.focusedKey = null;
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
    header.createEl("h1", { cls: "oak-agenda-title", text: "Agenda" });
    this.renderTabs(header);
    this.renderFilterStrip(header);

    const main = root.createDiv({ cls: "oak-agenda-main" });
    this.renderMain(main);

    const footer = root.createDiv({ cls: "oak-agenda-footer" });
    footer.createEl("span", {
      cls: "oak-agenda-footer-keys",
      text: "j/k focus · Enter open · d done · r refresh",
    });
  }

  private renderTabs(parent: HTMLElement): void {
    const tabs = parent.createDiv({ cls: "oak-agenda-tabs" });
    const counts = this.computeTabCounts();
    for (const kind of ["upcoming", "todo", "tags", "search"] as TabKind[]) {
      const btn = tabs.createEl("button", { cls: "oak-agenda-tab" });
      btn.createEl("span", {
        cls: "oak-agenda-tab-label",
        text: TAB_LABELS[kind],
      });
      const count = counts[kind];
      if (count !== null) {
        btn.createEl("span", {
          cls: "oak-agenda-tab-count",
          text: String(count),
        });
      }
      if (kind === this.filter.tab) btn.addClass("is-active");
      btn.addEventListener("click", () => this.activateTab(kind));
    }
  }

  // For Upcoming/TODO we can pre-count items cheaply. Tags and Search
  // have no useful "count" until the user types something; we omit
  // a count there. Upcoming counts items across the currently selected
  // span so the badge tracks the chip the user picked.
  private computeTabCounts(): Record<TabKind, number | null> {
    const today = todayIso(new Date());
    const counts: Record<TabKind, number | null> = {
      upcoming: 0,
      todo: 0,
      tags: null,
      search: null,
    };
    if (this.latestEntries.length === 0) return counts;
    try {
      const span =
        this.filter.tab === "upcoming" ? this.filter.days : 7;
      const upcomingView = runAgenda(
        this.latestEntries,
        { kind: "weekly", from: today, days: span },
        this.config,
      );
      counts.upcoming = upcomingView.buckets.reduce(
        (n, b) => n + b.items.length,
        0,
      );
      const todoView = runAgenda(
        this.latestEntries,
        { kind: "todo" },
        this.config,
      );
      counts.todo = todoView.buckets[0]?.items.length ?? 0;
    } catch {
      // Counts are best-effort — fall back to zeros on regex errors etc.
    }
    return counts;
  }

  private activateTab(kind: TabKind): void {
    if (kind === this.filter.tab) return;
    switch (kind) {
      case "upcoming":
        this.setFilter({ tab: "upcoming", days: 1 });
        return;
      case "todo":
        this.setFilter({ tab: "todo", keyword: null });
        return;
      case "tags":
        this.setFilter({ tab: "tags", expression: "" });
        return;
      case "search":
        this.setFilter({ tab: "search", regex: "" });
        return;
    }
  }

  private renderFilterStrip(parent: HTMLElement): void {
    const strip = parent.createDiv({ cls: "oak-agenda-filter" });
    switch (this.filter.tab) {
      case "upcoming":
        this.renderSpanChips(strip);
        return;
      case "todo":
        this.renderTodoStateChips(strip);
        return;
      case "tags":
        this.renderTextInput(
          strip,
          "tag expression  e.g. +work-someday",
          this.filter.expression,
          (v) => this.setFilter({ tab: "tags", expression: v }),
        );
        return;
      case "search":
        this.renderTextInput(
          strip,
          "search regex  e.g. budget|invoice",
          this.filter.regex,
          (v) => this.setFilter({ tab: "search", regex: v }),
        );
        return;
    }
  }

  private renderSpanChips(parent: HTMLElement): void {
    if (this.filter.tab !== "upcoming") return;
    const current = this.filter.days;
    for (const days of UPCOMING_SPANS) {
      const btn = parent.createEl("button", {
        cls: "oak-agenda-chip",
        text: `${days}d`,
      });
      if (days === current) btn.addClass("is-active");
      btn.addEventListener("click", () =>
        this.setFilter({ tab: "upcoming", days }),
      );
    }
  }

  private renderTodoStateChips(parent: HTMLElement): void {
    if (this.filter.tab !== "todo") return;
    const current = this.filter.keyword;
    const all = parent.createEl("button", {
      cls: "oak-agenda-chip",
      text: "All",
    });
    if (current === null) all.addClass("is-active");
    all.addEventListener("click", () =>
      this.setFilter({ tab: "todo", keyword: null }),
    );
    for (const k of this.config.todoKeywords) {
      const btn = parent.createEl("button", {
        cls: "oak-agenda-chip",
        text: k,
      });
      if (current === k) btn.addClass("is-active");
      btn.addEventListener("click", () =>
        this.setFilter({ tab: "todo", keyword: k }),
      );
    }
  }

  private renderTextInput(
    parent: HTMLElement,
    placeholder: string,
    value: string,
    apply: (v: string) => void,
  ): void {
    const input = parent.createEl("input", {
      cls: "oak-agenda-input",
      type: "text",
    });
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = value;
    let pending = value;
    input.addEventListener("input", () => {
      pending = input.value;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        apply(pending.trim());
      }
    });
    // Auto-focus the input when the tab activates so the user can
    // start typing immediately. setTimeout queues past the current
    // render so focus actually lands.
    window.setTimeout(() => input.focus(), 0);
    const submit = parent.createEl("button", {
      cls: "oak-agenda-chip",
      text: "Apply",
    });
    submit.addEventListener("click", () => apply(pending.trim()));
  }

  private renderMain(root: HTMLElement): void {
    if (!this.latestSnapshot) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text: "Indexing vault…",
      });
      return;
    }
    if (
      (this.filter.tab === "tags" && this.filter.expression.length === 0) ||
      (this.filter.tab === "search" && this.filter.regex.length === 0)
    ) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text:
          this.filter.tab === "tags"
            ? "Type a tag expression and press Enter."
            : "Type a search regex and press Enter.",
      });
      return;
    }
    if (!this.latestView) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text: "Query failed (see console).",
      });
      return;
    }
    const totalItems = this.latestView.buckets.reduce(
      (n, b) => n + b.items.length,
      0,
    );
    if (totalItems === 0) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text: this.emptyMessage(),
      });
      return;
    }

    const todayIsoDate = todayIso(new Date());
    for (const bucket of this.latestView.buckets) {
      if (bucket.items.length === 0 && this.filter.tab !== "upcoming") {
        continue;
      }
      const sec = root.createDiv({ cls: "oak-agenda-bucket" });
      // For weekly views the bucket label IS the date; otherwise we
      // hide the heading (single bucket).
      if (this.shouldShowBucketHeader()) {
        const h = sec.createEl("h2", { cls: "oak-agenda-bucket-label" });
        h.setText(this.bucketLabelFor(bucket.key, todayIsoDate, bucket.label));
        if (bucket.key === todayIsoDate) h.addClass("is-today");
      }
      if (bucket.items.length === 0) {
        sec.createEl("p", {
          cls: "oak-agenda-bucket-empty",
          text: "—",
        });
        continue;
      }
      const list = sec.createDiv({ cls: "oak-agenda-list" });
      for (const item of bucket.items) {
        const key = itemKey(item);
        const row = list.createDiv({ cls: "oak-agenda-item" });
        if (this.focusedKey === key) row.addClass("is-focused");
        row.dataset.itemKey = key;
        row.addEventListener("click", () => {
          this.focusedKey = key;
          this.openItem(item);
          this.render();
        });
        this.renderItem(row, item, todayIsoDate);
      }
    }
  }

  private shouldShowBucketHeader(): boolean {
    return this.filter.tab === "upcoming";
  }

  private bucketLabelFor(
    key: string,
    todayIsoDate: string,
    fallback: string,
  ): string {
    if (key === "all") return fallback;
    const delta = daysBetween(todayIsoDate, key);
    const dayName = new Date(
      Date.UTC(
        parseInt(key.slice(0, 4), 10),
        parseInt(key.slice(5, 7), 10) - 1,
        parseInt(key.slice(8, 10), 10),
      ),
    ).getUTCDay();
    const DAYS = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dayLabel = DAYS[dayName];
    let suffix = "";
    if (delta === 0) suffix = " · today";
    else if (delta === 1) suffix = " · tomorrow";
    else if (delta === -1) suffix = " · yesterday";
    else if (delta > 0) suffix = ` · in ${delta}d`;
    else suffix = ` · ${-delta}d ago`;
    return `${dayLabel} · ${key}${suffix}`;
  }

  private emptyMessage(): string {
    switch (this.filter.tab) {
      case "upcoming":
        return this.filter.days === 1
          ? "Nothing on today."
          : "Nothing scheduled in this window.";
      case "todo":
        return "No open TODOs.";
      case "tags":
        return "No matches.";
      case "search":
        return "No matches.";
    }
  }

  private renderItem(
    row: HTMLElement,
    item: AgendaItem,
    todayIsoDate: string,
  ): void {
    const cat = row.createEl("span", { cls: "oak-agenda-cat" });
    cat.setText(item.entry.category);
    if (item.time) {
      const t = row.createEl("span", { cls: "oak-agenda-time" });
      t.setText(item.endTime ? `${item.time}–${item.endTime}` : item.time);
    }
    if (item.marker) {
      const m = row.createEl("span", {
        cls: `oak-agenda-marker oak-marker-${item.marker}`,
      });
      m.setText(this.markerLabel(item));
    }
    if (item.entry.todoState) {
      const k = row.createEl("span", {
        cls: `oak-agenda-keyword oak-keyword-${item.entry.todoState.toLowerCase()}`,
      });
      k.setText(item.entry.todoState);
    }
    if (item.entry.priority) {
      const p = row.createEl("span", {
        cls: `oak-agenda-priority oak-priority-${item.entry.priority.toLowerCase()}`,
      });
      p.setText(`#${item.entry.priority}`);
    }
    row.createEl("span", {
      cls: "oak-agenda-item-title",
      text: item.entry.title,
    });
    // For non-bucketed views, show an absolute date when present so
    // the user knows when this is for.
    if (!this.shouldShowBucketHeader() && item.date) {
      const d = row.createEl("span", { cls: "oak-agenda-item-date" });
      const delta = daysBetween(todayIsoDate, item.date);
      d.setText(this.relativeDate(item.date, delta));
      if (delta < 0) d.addClass("is-past");
      else if (delta === 0) d.addClass("is-today");
    }
    if (item.entry.tags.length > 0) {
      const tagWrap = row.createEl("span", { cls: "oak-agenda-tag-wrap" });
      for (const tag of item.entry.tags) {
        tagWrap.createEl("span", {
          cls: "oak-agenda-tag",
          text: tag,
        });
      }
    }
  }

  private relativeDate(iso: string, delta: number): string {
    if (delta === 0) return "today";
    if (delta === 1) return "tomorrow";
    if (delta === -1) return "yesterday";
    if (delta > 0 && delta <= 7) return `+${delta}d`;
    if (delta < 0 && delta >= -7) return `${delta}d`;
    return iso;
  }

  private markerLabel(item: AgendaItem): string {
    switch (item.marker) {
      case "scheduled":
        return "Sched";
      case "scheduled-overdue":
        return `Sched +${item.daysDelta}d`;
      case "deadline":
        return "Due";
      case "deadline-warning":
        return `Due +${item.daysDelta}d`;
      case "deadline-overdue":
        return `Due −${item.daysDelta}d`;
      case "timestamp":
        return "";
      default:
        return "";
    }
  }

  // ---------------------- focus / actions --------------------------

  private allItems(): AgendaItem[] {
    if (!this.latestView) return [];
    const out: AgendaItem[] = [];
    for (const b of this.latestView.buckets) {
      for (const it of b.items) out.push(it);
    }
    return out;
  }

  private findFocused(): AgendaItem | null {
    if (!this.focusedKey) return null;
    for (const it of this.allItems()) {
      if (itemKey(it) === this.focusedKey) return it;
    }
    return null;
  }

  private moveFocus(delta: 1 | -1): void {
    const items = this.allItems();
    if (items.length === 0) return;
    const idx = this.focusedKey
      ? items.findIndex((it) => itemKey(it) === this.focusedKey)
      : -1;
    let next: number;
    if (idx === -1) {
      next = delta === 1 ? 0 : items.length - 1;
    } else {
      next = (idx + delta + items.length) % items.length;
    }
    this.focusedKey = itemKey(items[next]!);
    this.render();
    this.scrollFocusedIntoView();
  }

  private scrollFocusedIntoView(): void {
    const root = this.container();
    const el = root.querySelector<HTMLElement>(".oak-agenda-item.is-focused");
    el?.scrollIntoView({ block: "nearest" });
  }

  private openFocused(): void {
    const item = this.findFocused();
    if (item) this.openItem(item);
  }

  private openItem(item: AgendaItem): void {
    const file = this.app2.vault.getAbstractFileByPath(item.entry.relPath);
    if (!(file instanceof TFile)) {
      new Notice(`oak: ${item.entry.relPath} not found`);
      return;
    }
    void this.openFile(file, { newTab: false });
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

  private async markFocusedDone(): Promise<void> {
    const target = this.findFocused();
    if (!target) {
      new Notice("oak: focus an entry first (j/k or click)");
      return;
    }
    try {
      const result = await markDone(
        target.entry.filePath,
        target.entry.entryId,
        this.config,
        undefined,
        target.entry.relPath,
      );
      new Notice(result.repeated ? "Advanced repeater" : "Marked DONE");
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

function itemKey(item: AgendaItem): string {
  return `${item.entry.relPath}:${item.entry.line}:${item.date ?? ""}:${item.marker ?? ""}`;
}
