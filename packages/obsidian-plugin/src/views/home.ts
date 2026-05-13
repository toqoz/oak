// oak home view — a "vault index" surface that opens in the main pane.
//
// Sources its data from @oak/core/homeViewModel so the on-screen
// layout stays structurally consistent with the static index.html the
// publisher emits.

import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  WorkspaceLeaf,
  type App,
  type ViewStateResult,
} from "obsidian";
import {
  buildWeeklyAgenda,
  extractVaultAgendaEntries,
  frontmatterLineCount,
  gitStatus,
  homeViewModel,
  listMountStatus,
  newId,
  plainTextTitle,
  recentCommits,
  slugify,
  todayIso,
  type AgendaConfig,
  type AgendaItem,
  type CommitRecord,
  type GitStatus,
  type HomeContent,
  type HomeEntry,
  type HomeViewModel,
  type MountStatus,
  type UnmanagedEntry,
} from "@oak/core";

import { applyTitleEdit } from "../title-commit.js";

import type { VaultSnapshot, VaultState } from "../state.js";
import type { OakOpenFile } from "../open-file.js";
import { vaultRoot } from "../paths.js";
import { DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS } from "../settings.js";

export const VIEW_TYPE_OAK_HOME = "oak-home";

export type AgendaSummaryTarget = "today" | "week" | "month" | "all";

// Mirrors the public surface of OakAgendaView's setUpcomingSpan /
// showAllTodos pair plus the navigation step. Returned as an unawaitable
// callback so the home view doesn't need a direct dependency on the
// agenda view module.
export type AgendaSummaryNavigator = (
  target: AgendaSummaryTarget,
) => Promise<void> | void;

export class OakHomeView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private model: HomeViewModel | null = null;
  private editorHome: HomeContent | null = null;
  private gitInfo: { status: GitStatus; recent: CommitRecord[] } | null = null;
  private mounts: MountStatus[] = [];
  private agendaToday: AgendaItem[] | null = null;
  private rendering = false;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
    private exitOakMode: () => Promise<void> | void,
    private autoSnapshot: {
      get: () => number;
      set: (ms: number) => Promise<void>;
    },
    private editEditorHome: () => Promise<void> | void,
    private getAgendaConfig: () => AgendaConfig,
    private openAgendaWith: AgendaSummaryNavigator,
    private openUpdates: () => Promise<void> | void,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OAK_HOME;
  }

  getDisplayText(): string {
    return "oak — Home";
  }

  override getIcon(): string {
    return "trees";
  }

  // Mark the home view as a navigation target. With this set,
  // Obsidian's leaf history records transitions into / out of the
  // view (combined with `setState` flagging `result.history`), so
  // ← / → in the view header walks back through home → file →
  // home → … like a browser tab.
  override navigation = true;

  override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    await super.setState(state, result);
    result.history = true;
  }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.state.subscribe((snap) => {
      void this.refresh(snap);
    });
  }

  override async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  private async refresh(snap: VaultSnapshot | null): Promise<void> {
    if (!snap) {
      this.model = null;
      this.editorHome = null;
      this.gitInfo = null;
      this.mounts = [];
      this.agendaToday = null;
      this.render();
      return;
    }
    if (this.rendering) return;
    this.rendering = true;
    try {
      const [model] = await Promise.all([
        homeViewModel(snap.vault, snap.graph, { recentLimit: 10 }),
        this.refreshGitAndMounts(),
      ]);
      this.model = model;
      this.agendaToday = this.computeAgendaToday(snap);
      // `snap.vault.homeEditor` is populated by parseVault from
      // `_home/editor.md`. We render the body as a prelude above the
      // auto-generated sections so the user can hand-author an intro
      // (TODO links, today's agenda, etc.) without losing the index.
      this.editorHome = snap.vault.homeEditor;
      this.render();
    } finally {
      this.rendering = false;
    }
  }

  private computeAgendaToday(snap: VaultSnapshot): AgendaItem[] | null {
    try {
      const config = this.getAgendaConfig();
      const entries = extractVaultAgendaEntries(snap.vault, config);
      const today = todayIso(new Date());
      const view = buildWeeklyAgenda(entries, config, today, 1, today);
      return view.buckets[0]?.items ?? [];
    } catch (err) {
      console.warn("oak home: agenda today failed", err);
      return null;
    }
  }

  // Re-fetch git status / recent commits / mounts and re-render.
  // Called from the plugin when an external event (auto-snapshot,
  // manual snapshot/checkpoint) changes git state without touching
  // any vault file — `state.subscribe` wouldn't fire on its own.
  async refreshGit(): Promise<void> {
    await this.refreshGitAndMounts();
    this.render();
  }

  private async refreshGitAndMounts(): Promise<void> {
    try {
      const root = vaultRoot(this.app2);
      const [status, recent, mounts] = await Promise.all([
        gitStatus(root),
        recentCommits(root, 3),
        listMountStatus(root),
      ]);
      this.gitInfo = { status, recent };
      this.mounts = mounts;
    } catch (err) {
      console.warn("oak: failed to read git/mounts", err);
    }
  }

  private container(): HTMLElement {
    return (this.containerEl.children[1] as HTMLElement | undefined) ?? this.containerEl;
  }

  private render(): void {
    const root = this.container();
    root.empty();
    root.addClass("oak-home");

    if (!this.model) {
      root.createEl("div", { cls: "oak-empty", text: "Indexing vault…" });
      return;
    }

    const m = this.model;

    // User-authored prelude from `_home/editor.md`. Rendered first so
    // the auto-generated index that follows feels like a footer to the
    // hand-written content, not the other way around.
    this.renderEditorHome(root);

    // Header
    const header = root.createDiv({ cls: "oak-home-header" });
    header.createEl("h1", { text: "oak — Home" });
    header.createEl("p", {
      cls: "oak-home-stats",
      text: `${m.stats.pages} pages · ${m.stats.public} public · ${m.stats.unlisted} unlisted · ${m.stats.private} private · ${m.stats.redLinks} red links`,
    });

    // AGENDA — today's items rendered inline with an "Open agenda" link
    // for the full surface. Rendered even when empty so the affordance is
    // discoverable.
    this.renderAgendaSection(root);

    // ALL (N) — pages by recency. Cards for the top slice with a
    // "Read More" link to the paginated updates view for the tail.
    if (m.recentTotal > 0) {
      const sec = root.createDiv({ cls: "oak-home-section" });
      const more =
        m.recentTotal > m.recent.length
          ? {
              text: `Read more (${m.recentTotal - m.recent.length} more) →`,
              onClick: () => void this.openUpdates(),
            }
          : undefined;
      this.renderSectionHead(sec, `ALL (${m.recentTotal})`, more);
      this.renderEntryCards(sec, m.recent);
    }

    // Visibility groups (private hidden — the home view is a working
    // index and private pages are intentionally noise here).
    const grouped: Record<"public" | "unlisted", HomeEntry[]> = {
      public: [],
      unlisted: [],
    };
    for (const p of m.pages) {
      if (p.visibility === "public" || p.visibility === "unlisted") {
        grouped[p.visibility].push(p);
      }
    }
    // PUBLIC + FEED side-by-side. Both are vertical title-only lists so
    // they read as parallel roll-calls; the row collapses to stacked
    // columns on narrow panes via CSS. Both columns render even when
    // empty so the parallel layout stays balanced and the FEED channel
    // remains discoverable on vaults that haven't opted any page in yet.
    if (grouped.public.length > 0 || m.feed.length > 0) {
      const row = root.createDiv({ cls: "oak-home-row" });
      this.renderPublicFeedColumn(row, "PUBLIC", grouped.public);
      this.renderPublicFeedColumn(row, "FEED", m.feed);
    }
    // Unlisted keeps the expanded entry layout so backlinks/excerpts
    // stay visible on those drafts.
    if (grouped.unlisted.length > 0) {
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: `Unlisted (${grouped.unlisted.length})` });
      this.renderEntryList(sec, grouped.unlisted);
    }

    this.renderUnmanagedSection(root, m.unmanaged);
    this.renderGitSection(root);
    this.renderExternalSection(root);
    this.renderExitFooter(root);
  }

  private renderAgendaSection(parent: HTMLElement): void {
    const items = this.agendaToday;
    if (!items) return;
    const sec = parent.createDiv({ cls: "oak-home-section" });
    this.renderSectionHead(sec, `AGENDA (${items.length})`, {
      text: "Open agenda →",
      onClick: () => void this.openAgendaWith("today"),
    });
    if (items.length === 0) {
      sec.createEl("p", {
        cls: "oak-home-meta",
        text: "Nothing on today.",
      });
      return;
    }
    const list = sec.createDiv({ cls: "oak-agenda-list" });
    for (const item of items) {
      this.renderAgendaTodayItem(list, item);
    }
  }

  // Section header with optional right-aligned action link (e.g.
  // "Read more →" / "Open agenda →"). Action sits on the same baseline
  // as the h2 so the section title and its escape hatch read as one row.
  private renderSectionHead(
    sec: HTMLElement,
    title: string,
    action?: { text: string; onClick: () => void },
  ): void {
    const head = sec.createDiv({ cls: "oak-home-section-head" });
    head.createEl("h2", { text: title });
    if (action) {
      const link = head.createEl("a", {
        cls: "oak-home-more",
        text: action.text,
        href: "#",
      });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        action.onClick();
      });
    }
  }

  private renderAgendaTodayItem(parent: HTMLElement, item: AgendaItem): void {
    const row = parent.createDiv({ cls: "oak-agenda-item" });
    row.createEl("span", {
      cls: "oak-agenda-cat",
      text: item.entry.category,
    });
    if (item.time) {
      row.createEl("span", {
        cls: "oak-agenda-time",
        text: item.endTime ? `${item.time}–${item.endTime}` : item.time,
      });
    }
    if (item.marker) {
      const label = agendaMarkerLabel(item);
      if (label.length > 0) {
        row.createEl("span", {
          cls: `oak-agenda-marker oak-marker-${item.marker}`,
          text: label,
        });
      }
    }
    if (item.entry.todoState) {
      row.createEl("span", {
        cls: `oak-agenda-keyword oak-keyword-${item.entry.todoState.toLowerCase()}`,
        text: item.entry.todoState,
      });
    }
    if (item.entry.priority) {
      row.createEl("span", {
        cls: `oak-agenda-priority oak-priority-${item.entry.priority.toLowerCase()}`,
        text: `#${item.entry.priority}`,
      });
    }
    row.createEl("span", {
      cls: "oak-agenda-item-title",
      text: item.entry.title,
    });
    if (item.entry.tags.length > 0) {
      const tagWrap = row.createEl("span", { cls: "oak-agenda-tag-wrap" });
      for (const tag of item.entry.tags) {
        tagWrap.createEl("span", { cls: "oak-agenda-tag", text: tag });
      }
    }
    row.addEventListener("click", () => {
      void this.openAgendaEntry(item);
    });
  }

  private async openAgendaEntry(item: AgendaItem): Promise<void> {
    const file = this.app2.vault.getAbstractFileByPath(item.entry.relPath);
    if (!(file instanceof TFile)) {
      new Notice(`oak: ${item.entry.relPath} not found`);
      return;
    }
    // `entry.line` is body-relative (1-based, post-frontmatter). Translate
    // into a 0-based file-relative line so `openFile` can scroll the
    // viewport to the heading rather than the file top — matches what
    // OakAgendaView does when opening an item.
    const raw = await this.app2.vault.cachedRead(file);
    const fileLine = Math.max(0, item.entry.line - 1 + frontmatterLineCount(raw));
    await this.openFile(file, { newTab: false, line: fileLine });
  }

  private renderPublicFeedColumn(
    parent: HTMLElement,
    label: string,
    entries: HomeEntry[],
  ): void {
    const sec = parent.createDiv({ cls: "oak-home-section oak-home-col" });
    sec.createEl("h2", { text: `${label} (${entries.length})` });
    if (entries.length === 0) {
      sec.createEl("p", { cls: "oak-home-meta", text: "—" });
      return;
    }
    this.renderTitleList(sec, entries);
  }

  private renderTitleList(parent: HTMLElement, entries: HomeEntry[]): void {
    const ul = parent.createEl("ul", { cls: "oak-home-titles" });
    for (const e of entries) {
      const li = ul.createEl("li");
      const link = li.createEl("a", {
        cls: "oak-home-link",
        text: e.title,
        href: "#",
      });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.openByRelPath(e.vaultRelPath, ev.metaKey || ev.ctrlKey);
      });
    }
  }

  private renderEditorHome(parent: HTMLElement): void {
    const home = this.editorHome;
    const hasBody = !!home && home.body.trim().length > 0;
    // Always render the section so the floating "Customize" affordance
    // sits in a consistent spot — top-right of the prelude — whether or
    // not the user has filled in `_home/editor.md` yet.
    const sec = parent.createDiv({ cls: "oak-home-editor" });
    if (!hasBody) sec.addClass("is-empty");

    const link = sec.createEl("a", {
      cls: "oak-home-customize",
      text: "Customize",
      href: "#",
    });
    link.setAttr(
      "aria-label",
      "Edit _home/editor.md (the prelude shown above this view)",
    );
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.editEditorHome();
    });

    if (hasBody && home) {
      // sourcePath drives how relative links and embeds resolve.
      // Passing `_home/editor.md` lets `[[wiki]]` and `![[image]]`
      // references resolve against the vault's normal lookup.
      void MarkdownRenderer.render(
        this.app2,
        home.body,
        sec,
        home.relPath,
        this,
      );
    }
  }

  private renderUnmanagedSection(
    parent: HTMLElement,
    entries: UnmanagedEntry[],
  ): void {
    if (entries.length === 0) return;
    const sec = parent.createDiv({ cls: "oak-home-section" });
    sec.createEl("h2", { text: `Unmanaged files (${entries.length})` });
    sec.createEl("p", {
      cls: "oak-home-meta",
      text: "Markdown files in the vault without an oak `id`. Import to add the standard frontmatter.",
    });
    const ul = sec.createEl("ul", { cls: "oak-home-list" });
    for (const entry of entries) {
      const li = ul.createEl("li", { cls: "oak-unmanaged-item" });
      const head = li.createDiv({ cls: "oak-unmanaged-head" });
      head.createEl("span", {
        cls: "oak-home-link oak-unmanaged-path",
        text: entry.vaultRelPath,
      });
      const importBtn = head.createEl("button", {
        cls: "oak-unmanaged-import",
        text: "Import",
      });
      importBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        importBtn.disabled = true;
        void this.importUnmanaged(entry).finally(() => {
          importBtn.disabled = false;
        });
      });
      const meta: string[] = [];
      if (entry.updatedAt) meta.push(`updated ${entry.updatedAt.slice(0, 10)}`);
      if (meta.length > 0) {
        li.createEl("div", { cls: "oak-home-meta", text: meta.join(" · ") });
      }
    }
  }

  private async importUnmanaged(entry: UnmanagedEntry): Promise<void> {
    const file = this.app2.vault.getAbstractFileByPath(entry.vaultRelPath);
    if (!(file instanceof TFile)) {
      new Notice(`oak: cannot import — file not found: ${entry.vaultRelPath}`);
      return;
    }
    try {
      // Pick the canonical title: a body `# ...` heading wins (it's
      // the storage location under the post-v3 schema); otherwise
      // lift the legacy `title:` field; otherwise the filename basename.
      // Any stray `title:` is dropped from the frontmatter below.
      const cache = this.app2.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      const fmTitleRaw = fm?.["title"];
      const fmTitle =
        typeof fmTitleRaw === "string" ? fmTitleRaw.trim() : "";
      const bodyH1 =
        cache?.headings?.find((h) => h.level === 1)?.heading?.trim() ?? "";
      const titleStr =
        bodyH1.length > 0
          ? bodyH1
          : fmTitle.length > 0
            ? fmTitle
            : file.basename;

      if (bodyH1.length === 0) {
        const raw = await this.app2.vault.read(file);
        const rewritten = applyTitleEdit(raw, titleStr);
        if (rewritten !== raw) {
          await this.app2.vault.modify(file, rewritten);
        }
      }

      await this.app2.fileManager.processFrontMatter(file, (fm) => {
        const f = fm as Record<string, unknown>;
        delete f["title"];
        if (typeof f["id"] !== "string" || (f["id"] as string).length === 0) {
          f["id"] = newId();
        }
        if (typeof f["visibility"] !== "string") {
          f["visibility"] = "private";
        }
        if (typeof f["slug"] !== "string" || (f["slug"] as string).length === 0) {
          const s = slugify(plainTextTitle(titleStr));
          if (s.length > 0) f["slug"] = s;
        }
      });
      new Notice(`oak: imported ${entry.vaultRelPath}`);
      this.state.scheduleRefresh();
    } catch (err) {
      console.error("oak: import failed", err);
      new Notice(`oak: import failed — ${(err as Error).message}`);
    }
  }

  private renderExitFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: "oak-home-exit" });
    const link = footer.createEl("a", {
      cls: "oak-home-exit-link",
      text: "Exit oak mode",
      href: "#",
    });
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.exitOakMode();
    });
  }

  private renderGitSection(parent: HTMLElement): void {
    const sec = parent.createDiv({ cls: "oak-home-section" });
    sec.createEl("h2", { text: "Git" });
    if (!this.gitInfo) {
      sec.createEl("p", { cls: "oak-home-meta", text: "(loading)" });
      return;
    }
    const { status, recent } = this.gitInfo;
    if (!status.initialized) {
      sec.createEl("p", {
        cls: "oak-home-meta",
        text: "No git repo yet — any oak command will initialise one.",
      });
      return;
    }
    sec.createEl("p", {
      text: `${status.branch ?? "(detached)"}: ${status.dirty ? "dirty" : "clean"} (staged ${status.staged.length}, unstaged ${status.unstaged.length}, untracked ${status.untracked.length})`,
    });
    this.renderAutoSnapshotToggle(sec);
    if (recent.length > 0) {
      const ul = sec.createEl("ul", { cls: "oak-home-list" });
      for (const c of recent) {
        ul.createEl("li", {
          cls: "oak-home-meta",
          text: `${c.shortHash}  ${c.subject}`,
        });
      }
    }
  }

  private renderAutoSnapshotToggle(parent: HTMLElement): void {
    const ms = this.autoSnapshot.get();
    const enabled = ms > 0;
    const row = parent.createDiv({
      cls: "oak-home-meta oak-home-auto-snapshot",
    });
    row.createSpan({
      text: enabled
        ? `Auto-snapshot: after ${Math.round(ms / 60000)} min idle`
        : "Auto-snapshot: off",
    });
    const btn = row.createEl("button", {
      cls: "oak-home-auto-snapshot-toggle",
      text: enabled ? "Disable" : "Enable",
    });
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      const next = enabled ? 0 : DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS;
      void this.autoSnapshot
        .set(next)
        .then(() => {
          new Notice(
            next > 0 ? "oak: auto-snapshot enabled" : "oak: auto-snapshot disabled",
          );
          this.render();
        })
        .catch((err) => {
          console.error("oak: toggle auto-snapshot failed", err);
          new Notice(`oak: ${(err as Error).message}`);
          btn.disabled = false;
        });
    });
  }

  private renderExternalSection(parent: HTMLElement): void {
    const sec = parent.createDiv({ cls: "oak-home-section" });
    sec.createEl("h2", { text: "External" });
    if (this.mounts.length === 0) {
      sec.createEl("p", {
        cls: "oak-home-meta",
        text: "(no mounts configured)",
      });
      return;
    }
    const ul = sec.createEl("ul", { cls: "oak-home-list" });
    for (const m of this.mounts) {
      const li = ul.createEl("li");
      li.createEl("strong", { text: m.entry.id });
      li.createEl("div", {
        cls: "oak-home-meta",
        text: `${m.entry.linkPath} → ${m.entry.targetPath}`,
      });
      const ok = m.linkExists && m.targetExists;
      li.createEl("div", {
        cls: ok ? "oak-home-meta" : "oak-error",
        text: ok
          ? "ok"
          : `${m.linkExists ? "" : "link missing "}${m.targetExists ? "" : "target missing"}`.trim(),
      });
    }
  }

  private renderEntryCards(parent: HTMLElement, entries: HomeEntry[]): void {
    const grid = parent.createDiv({ cls: "oak-card-grid" });
    for (const e of entries) {
      const card = grid.createDiv({ cls: "oak-card" });
      card.setAttr("role", "link");
      card.setAttr("tabindex", "0");
      card.createEl("div", { cls: "oak-card-title", text: e.title });
      if (e.excerpt.length > 0) {
        card.createEl("p", { cls: "oak-card-excerpt", text: e.excerpt });
      }
      const metaParts: string[] = [];
      if (e.updatedAt) metaParts.push(`updated ${e.updatedAt.slice(0, 10)}`);
      if (e.inboundCount > 0) metaParts.push(`${e.inboundCount} backlinks`);
      if (metaParts.length > 0) {
        card.createEl("div", {
          cls: "oak-card-meta",
          text: metaParts.join(" · "),
        });
      }
      const open = (newTab: boolean) =>
        this.openByRelPath(e.vaultRelPath, newTab);
      card.addEventListener("click", (ev) => {
        open(ev.metaKey || ev.ctrlKey);
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          open(ev.metaKey || ev.ctrlKey);
        }
      });
    }
  }

  private renderEntryList(parent: HTMLElement, entries: HomeEntry[]): void {
    const ul = parent.createEl("ul", { cls: "oak-home-list" });
    for (const e of entries) {
      const li = ul.createEl("li");
      const link = li.createEl("a", {
        cls: "oak-home-link",
        text: e.title,
        href: "#",
      });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.openByRelPath(e.vaultRelPath, ev.metaKey || ev.ctrlKey);
      });
      const meta: string[] = [];
      meta.push(e.visibility);
      if (e.updatedAt) meta.push(`updated ${e.updatedAt.slice(0, 10)}`);
      if (e.inboundCount > 0) meta.push(`${e.inboundCount} backlinks`);
      li.createEl("div", { cls: "oak-home-meta", text: meta.join(" · ") });
      if (e.excerpt.length > 0) {
        li.createEl("p", { cls: "oak-home-excerpt", text: e.excerpt });
      }
    }
  }

  private openByRelPath(relPath: string, newTab: boolean): void {
    const file = this.app2.vault.getAbstractFileByPath(relPath);
    if (file instanceof TFile) {
      void this.openFile(file, { newTab });
    }
  }
}

// Inline-friendly marker label. Mirrors OakAgendaView.markerLabel so the
// home agenda section reads the same as the dedicated agenda view.
function agendaMarkerLabel(item: AgendaItem): string {
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
