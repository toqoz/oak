// Oak agenda view — port of emacs `org-agenda` adapted for the
// Obsidian editor surface.
//
// Default surface is Upcoming (today + N days, weekly bucket layout).
// Three alternate "modes" — All TODOs, Tags, Search — are reachable
// via quiet text links rather than tabs; the Upcoming view also
// offers `← upcoming` from any alt mode to return.
//
// Keybindings while focused:
//   j / ArrowDown / Ctrl-n   focus next item
//   k / ArrowUp / Ctrl-p     focus previous item
//   Enter                    open focused item's source line
//   d                        mark focused entry DONE / advance repeater
//   r                        force vault refresh

import {
  ItemView,
  Notice,
  Scope,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type App,
} from "obsidian";

import {
  DEFAULT_AGENDA_CONFIG,
  daysBetween,
  extractVaultAgendaEntries,
  frontmatterLineCount,
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
import type OakPlugin from "../main.js";
import { refileHeading } from "../refile.js";
import type { VaultSnapshot, VaultState } from "../state.js";

export const VIEW_TYPE_OAK_AGENDA = "oak-agenda";

type ViewKind = "upcoming" | "todo" | "find";

// All three spans start from today. `"today"` is a one-day window;
// `"week"` / `"month"` snap to the current week/month boundary (so
// the span shrinks as the period progresses — "what's left this
// week / this month").
type UpcomingSpan = "today" | "week" | "month";

type Filter =
  | { view: "upcoming"; span: UpcomingSpan }
  | { view: "todo"; keyword: string | null }
  | { view: "find"; query: string };

const UPCOMING_SPANS: UpcomingSpan[] = ["today", "week", "month"];

// Display labels for the upcoming-span links. "today" reads as
// "DAY" in the row so the three options share a one-word, all-caps
// shape (DAY / WEEK / MONTH) and sit visually balanced.
const SPAN_LABELS: Record<UpcomingSpan, string> = {
  today: "DAY",
  week: "WEEK",
  month: "MONTH",
};

function spanDays(
  span: UpcomingSpan,
  todayIso: string,
  weekStartsOn: 0 | 1,
): number {
  if (span === "today") return 1;
  const y = parseInt(todayIso.slice(0, 4), 10);
  const m = parseInt(todayIso.slice(5, 7), 10);
  const d = parseInt(todayIso.slice(8, 10), 10);
  if (span === "week") {
    // Days from today (inclusive) through end-of-week. Week is anchored
    // by config.weekStartsOn (0=Sun, 1=Mon).
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const offsetFromStart = (dow - weekStartsOn + 7) % 7;
    return 7 - offsetFromStart;
  }
  // "month": today (inclusive) through last day of current calendar month.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return lastDay - d + 1;
}

// Tag-expression syntax leads with + / - / @ / # / %; anything else
// falls through to a regex search. Lets one input handle both
// org-agenda `tags-view` (m) and `search-view` (s) without a mode
// toggle. Grouping parentheses are not supported by `compileMatch`, so
// `(` is intentionally excluded from the trigger set.
function parseFindQuery(
  raw: string,
): { kind: "match" | "search"; payload: string } | null {
  const q = raw.trim();
  if (q.length === 0) return null;
  if (/^[+\-@#%]/.test(q)) return { kind: "match", payload: q };
  return { kind: "search", payload: q };
}

export class OakAgendaView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private filter: Filter = { view: "upcoming", span: "today" };
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
    private plugin: OakPlugin,
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
    // Wrap every binding so a focused input/textarea (e.g. the Find
    // query box) gets the keystroke instead of triggering the agenda
    // shortcut. Returning `false` tells Obsidian's Scope this binding
    // did not handle the event, letting the DOM continue propagation.
    const ifNotEditing = (fn: () => void) => () => {
      if (isEditableFocused()) return false;
      fn();
      return undefined;
    };
    scope.register([], "j", ifNotEditing(() => moveFocus(1)));
    scope.register([], "ArrowDown", ifNotEditing(() => moveFocus(1)));
    // Emacs-style C-n / C-p mirror the j / ArrowDown bindings; Ctrl
    // (not Mod) so ⌘N stays bound to "new note" in Obsidian.
    scope.register(["Ctrl"], "n", ifNotEditing(() => moveFocus(1)));
    scope.register([], "k", ifNotEditing(() => moveFocus(-1)));
    scope.register([], "ArrowUp", ifNotEditing(() => moveFocus(-1)));
    scope.register(["Ctrl"], "p", ifNotEditing(() => moveFocus(-1)));
    scope.register([], "Enter", ifNotEditing(() => this.openFocused()));
    scope.register([], "d", ifNotEditing(() => void this.markFocusedDone()));
    scope.register([], "r", ifNotEditing(() => void this.state.refresh()));
    // Capital `R` is org-mode's refile binding. We use Shift-R rather
    // than `R` directly because Obsidian's Scope normalises to the
    // physical key — registering "R" without modifiers also matches
    // lowercase `r`, which would shadow the refresh binding above.
    scope.register(["Shift"], "r", ifNotEditing(() => void this.refileFocused()));
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    this.recompute();
  }

  private switchView(view: ViewKind): void {
    if (view === this.filter.view) return;
    switch (view) {
      case "upcoming":
        this.setFilter({ view: "upcoming", span: "today" });
        return;
      case "todo":
        this.setFilter({ view: "todo", keyword: null });
        return;
      case "find":
        this.setFilter({ view: "find", query: "" });
        return;
    }
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

  private currentQuery(): AgendaQuery | null {
    const today = todayIso(new Date());
    switch (this.filter.view) {
      case "upcoming":
        return {
          kind: "weekly",
          from: today,
          days: spanDays(this.filter.span, today, this.config.weekStartsOn),
        };
      case "todo": {
        const q: AgendaQuery = { kind: "todo" };
        if (this.filter.keyword) q.keyword = this.filter.keyword;
        return q;
      }
      case "find": {
        const parsed = parseFindQuery(this.filter.query);
        if (!parsed) return null;
        if (parsed.kind === "match") {
          return { kind: "match", expression: parsed.payload };
        }
        return { kind: "search", regex: parsed.payload };
      }
    }
  }

  private recompute(): void {
    if (!this.latestSnapshot) {
      this.latestView = null;
      this.render();
      return;
    }
    const query = this.currentQuery();
    // null query = empty find input. Render placeholder guidance.
    if (!query) {
      this.latestView = null;
      this.render();
      return;
    }
    try {
      this.latestView = runAgenda(this.latestEntries, query, this.config);
    } catch (err) {
      console.warn("oak agenda: query failed", err);
      this.latestView = null;
    }
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
    this.renderHeader(header);

    const main = root.createDiv({ cls: "oak-agenda-main" });
    this.renderMain(main);

    const footer = root.createDiv({ cls: "oak-agenda-footer" });
    footer.createEl("span", {
      cls: "oak-agenda-footer-keys",
      text: "j/k focus · Enter open · d done · r refresh",
    });
  }

  // Header is two rows. The top row is the title with the three view
  // switchers (upcoming / all-todos / find) as icon buttons aligned
  // to the right edge — the active view's icon is highlighted. The
  // second row is the per-view controls (span selector / state chips
  // / find input).
  private renderHeader(parent: HTMLElement): void {
    const titlerow = parent.createDiv({ cls: "oak-agenda-titlerow" });
    titlerow.createEl("h1", { cls: "oak-agenda-title", text: "Agenda" });
    this.renderActions(titlerow.createDiv({ cls: "oak-agenda-actions" }));
    const controls = parent.createDiv({ cls: "oak-agenda-controls" });
    this.renderViewControls(controls);
  }

  private renderActions(parent: HTMLElement): void {
    const items: { view: ViewKind; icon: string; label: string }[] = [
      { view: "upcoming", icon: "calendar-days", label: "Upcoming" },
      { view: "todo", icon: "list-todo", label: "All TODOs" },
      { view: "find", icon: "search", label: "Find" },
    ];
    for (const it of items) {
      const btn = parent.createEl("button", { cls: "oak-agenda-action" });
      setIcon(btn, it.icon);
      btn.setAttribute("aria-label", it.label);
      btn.setAttribute("title", it.label);
      if (it.view === this.filter.view) btn.addClass("is-active");
      btn.addEventListener("click", () => this.switchView(it.view));
    }
  }

  private renderViewControls(parent: HTMLElement): void {
    switch (this.filter.view) {
      case "upcoming":
        this.renderSpanLinks(parent);
        return;
      case "todo":
        this.renderTodoStateLinks(parent);
        return;
      case "find":
        this.renderTextInput(
          parent,
          "+work-someday  or  budget|invoice",
          this.filter.query,
          (v) => this.setFilter({ view: "find", query: v }),
        );
        return;
    }
  }

  private renderSpanLinks(parent: HTMLElement): void {
    if (this.filter.view !== "upcoming") return;
    const current = this.filter.span;
    for (const span of UPCOMING_SPANS) {
      const btn = parent.createEl("button", {
        cls: "oak-agenda-link",
        text: SPAN_LABELS[span],
      });
      if (span === current) btn.addClass("is-active");
      btn.addEventListener("click", () =>
        this.setFilter({ view: "upcoming", span }),
      );
    }
  }

  private renderTodoStateLinks(parent: HTMLElement): void {
    if (this.filter.view !== "todo") return;
    const current = this.filter.keyword;
    const all = parent.createEl("button", {
      cls: "oak-agenda-link",
      text: "all",
    });
    if (current === null) all.addClass("is-active");
    all.addEventListener("click", () =>
      this.setFilter({ view: "todo", keyword: null }),
    );
    for (const k of this.config.todoKeywords) {
      const btn = parent.createEl("button", {
        cls: "oak-agenda-link",
        text: k.toLowerCase(),
      });
      if (current === k) btn.addClass("is-active");
      btn.addEventListener("click", () =>
        this.setFilter({ view: "todo", keyword: k }),
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
    window.setTimeout(() => input.focus(), 0);
  }

  private renderMain(root: HTMLElement): void {
    if (!this.latestSnapshot) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text: "Indexing vault…",
      });
      return;
    }
    if (this.filter.view === "find" && this.filter.query.trim().length === 0) {
      root.createEl("div", {
        cls: "oak-agenda-empty",
        text:
          "Type a tag expression (+work-someday) or a regex (budget|invoice) and press Enter.",
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
      if (bucket.items.length === 0 && this.filter.view !== "upcoming") {
        continue;
      }
      const sec = root.createDiv({ cls: "oak-agenda-bucket" });
      if (this.shouldShowBucketHeader()) {
        this.renderBucketHeader(sec, bucket.key, todayIsoDate, bucket.label);
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
          void this.openItem(item);
          this.render();
        });
        this.renderItem(row, item, todayIsoDate);
      }
    }
  }

  private shouldShowBucketHeader(): boolean {
    return this.filter.view === "upcoming";
  }

  // Render the bucket header as `YYYY-MM-DD Day` (matching org's
  // `<2026-05-07 Thu>` timestamp style). No special styling for the
  // today bucket — Upcoming always starts from today so the first
  // row is always today by construction; the accent would carry no
  // information.
  private renderBucketHeader(
    sec: HTMLElement,
    key: string,
    todayIsoDate: string,
    fallback: string,
  ): void {
    void todayIsoDate;
    const h = sec.createEl("h2", { cls: "oak-agenda-bucket-label" });
    if (key === "all") {
      h.setText(fallback);
      return;
    }
    const dow = new Date(
      Date.UTC(
        parseInt(key.slice(0, 4), 10),
        parseInt(key.slice(5, 7), 10) - 1,
        parseInt(key.slice(8, 10), 10),
      ),
    ).getUTCDay();
    const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    h.setText(`${key} ${DAYS_SHORT[dow]}`);
  }

  private emptyMessage(): string {
    switch (this.filter.view) {
      case "upcoming":
        return this.filter.span === "today"
          ? "Nothing on today."
          : "Nothing scheduled in this window.";
      case "todo":
        return "No open TODOs.";
      case "find":
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
    if (item) void this.openItem(item);
  }

  private async openItem(item: AgendaItem): Promise<void> {
    const file = this.app2.vault.getAbstractFileByPath(item.entry.relPath);
    if (!(file instanceof TFile)) {
      new Notice(`oak: ${item.entry.relPath} not found`);
      return;
    }
    // `entry.line` is 1-based and body-relative (post-frontmatter).
    // Obsidian's `eState.line` and `editor.setCursor` both want
    // 0-based file-relative lines, so we adjust by the frontmatter
    // line count before navigating.
    const fileLine = await this.entryFileLine(file, item.entry.line);
    await this.openFile(file, { newTab: false, line: fileLine });
    void this.placeCursorAtFileLine(fileLine);
  }

  // Returns the 0-based file-relative line for an entry whose `line`
  // field is body-relative. Reads from Obsidian's cache so we don't
  // hit disk; the shared `frontmatterLineCount` keeps this in lock-
  // step with the writeback path so navigate-target and write-target
  // can never diverge.
  private async entryFileLine(file: TFile, bodyLine: number): Promise<number> {
    const raw = await this.app2.vault.cachedRead(file);
    return Math.max(0, bodyLine - 1 + frontmatterLineCount(raw));
  }

  // Place the editor caret on the heading line. The MarkdownView may
  // not be mounted on the same tick that openFile resolves (Obsidian
  // sometimes defers leaf rendering), so we poll briefly. eState.line
  // already handles the initial scroll for fresh opens — this is a
  // belt-and-suspenders pass for source mode where we want the caret
  // on the line as well.
  private async placeCursorAtFileLine(fileLine: number): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const leaf = this.app2.workspace.getMostRecentLeaf();
      const view = leaf?.view as unknown as {
        editor?: { setCursor: (pos: { line: number; ch: number }) => void };
      };
      if (view?.editor) {
        view.editor.setCursor({ line: fileLine, ch: 0 });
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    }
  }

  private async refileFocused(): Promise<void> {
    const target = this.findFocused();
    if (!target) {
      new Notice("oak: focus an entry first (j/k or click)");
      return;
    }
    await refileHeading(
      this.plugin,
      {
        filePath: target.entry.filePath,
        relPath: target.entry.relPath,
        line: target.entry.line,
        level: target.entry.level,
        title: target.entry.title,
        entryId: target.entry.entryId,
      },
      this.plugin.refileConfig,
      this.config,
    );
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

// True when the currently focused element accepts text input. Used to
// gate agenda keybindings so typing into the Find box doesn't trigger
// `d` (mark DONE) etc. as a side effect.
function isEditableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
