// Oak home view — a "vault index" surface that opens in the main pane.
//
// Sources its data from @oak/core/homeViewModel so the on-screen
// layout stays structurally consistent with the static index.html the
// publisher emits.

import {
  ItemView,
  TFile,
  WorkspaceLeaf,
  type App,
  type ViewStateResult,
} from "obsidian";
import {
  gitStatus,
  homeViewModel,
  listMountStatus,
  recentCommits,
  type CommitRecord,
  type GitStatus,
  type HomeEntry,
  type HomeViewModel,
  type MountStatus,
} from "@oak/core";

import type { VaultSnapshot, VaultState } from "../state.js";
import type { OakOpenFile } from "../open-file.js";
import { vaultRoot } from "../paths.js";

export const VIEW_TYPE_OAK_HOME = "oak-home";

export class OakHomeView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private model: HomeViewModel | null = null;
  private gitInfo: { status: GitStatus; recent: CommitRecord[] } | null = null;
  private mounts: MountStatus[] = [];
  private rendering = false;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
    private exitOakMode: () => Promise<void> | void,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OAK_HOME;
  }

  getDisplayText(): string {
    return "Oak — Home";
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
      this.gitInfo = null;
      this.mounts = [];
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
      this.render();
    } finally {
      this.rendering = false;
    }
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

    // Header
    const header = root.createDiv({ cls: "oak-home-header" });
    header.createEl("h1", { text: "Oak — Home" });
    header.createEl("p", {
      cls: "oak-home-stats",
      text: `${m.stats.pages} pages · ${m.stats.public} public · ${m.stats.unlisted} unlisted · ${m.stats.private} private · ${m.stats.redLinks} red links`,
    });

    // Recent — rendered as cards, sharing the same look as the
    // per-page "Related" cards (.oak-card / .oak-card-grid).
    if (m.recent.length > 0) {
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: "Recent updates" });
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
    for (const v of ["public", "unlisted"] as const) {
      const list = grouped[v];
      if (list.length === 0) continue;
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: `${v[0]!.toUpperCase()}${v.slice(1)} (${list.length})` });
      this.renderEntryList(sec, list);
    }

    this.renderGitSection(root);
    this.renderExternalSection(root);
    this.renderExitFooter(root);
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
