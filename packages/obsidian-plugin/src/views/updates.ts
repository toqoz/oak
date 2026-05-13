// oak updates view — paginated "all pages by recency" surface reached
// from the home view's `ALL (N)` Read More link. The home view caps the
// recent list to keep the index scannable; this view shows the same
// stream without the cap, sliced into fixed-size pages.

import {
  ItemView,
  TFile,
  WorkspaceLeaf,
  type App,
  type ViewStateResult,
} from "obsidian";
import { homeViewModel, type HomeEntry } from "@oak/core";

import type { VaultSnapshot, VaultState } from "../state.js";
import type { OakOpenFile } from "../open-file.js";

export const VIEW_TYPE_OAK_UPDATES = "oak-updates";

const PAGE_SIZE = 20;

export class OakUpdatesView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private entries: HomeEntry[] = [];
  private total = 0;
  private page = 0;
  private loaded = false;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OAK_UPDATES;
  }

  getDisplayText(): string {
    return "oak — Updates";
  }

  override getIcon(): string {
    return "history";
  }

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
      this.entries = [];
      this.total = 0;
      this.loaded = false;
      this.render();
      return;
    }
    // Unbounded recent list — the home model's `recentLimit` defaults
    // to 10, which is exactly what we want to escape here.
    const model = await homeViewModel(snap.vault, snap.graph, {
      recentLimit: Number.POSITIVE_INFINITY,
    });
    this.entries = model.recent;
    this.total = model.recentTotal;
    this.loaded = true;
    // Clamp the current page after the data refreshes so a delete that
    // shrinks the list past the active page doesn't strand the view on
    // an empty screen.
    const maxPage = Math.max(0, Math.ceil(this.total / PAGE_SIZE) - 1);
    if (this.page > maxPage) this.page = maxPage;
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
    root.addClass("oak-updates");

    const header = root.createDiv({ cls: "oak-updates-header" });
    header.createEl("h1", { text: "Updates" });
    header.createEl("p", {
      cls: "oak-updates-stats",
      text: this.loaded ? `${this.total} pages` : "Indexing vault…",
    });

    if (!this.loaded) return;
    if (this.total === 0) {
      root.createEl("div", { cls: "oak-empty", text: "No pages yet." });
      return;
    }

    const start = this.page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, this.entries.length);
    const slice = this.entries.slice(start, end);

    const ul = root.createEl("ul", { cls: "oak-home-list" });
    for (const e of slice) {
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

    this.renderPager(root, start, end);
  }

  private renderPager(parent: HTMLElement, start: number, end: number): void {
    const pages = Math.max(1, Math.ceil(this.total / PAGE_SIZE));
    const pager = parent.createDiv({ cls: "oak-updates-pager" });
    pager.createEl("span", {
      cls: "oak-updates-pager-info",
      text: `${start + 1}–${end} of ${this.total} · page ${this.page + 1} of ${pages}`,
    });
    const controls = pager.createDiv({ cls: "oak-updates-pager-controls" });
    const prev = controls.createEl("button", {
      cls: "oak-updates-pager-btn",
      text: "← Prev",
    });
    prev.disabled = this.page === 0;
    prev.addEventListener("click", () => {
      if (this.page === 0) return;
      this.page -= 1;
      this.render();
      this.container().scrollTo({ top: 0 });
    });
    const next = controls.createEl("button", {
      cls: "oak-updates-pager-btn",
      text: "Next →",
    });
    next.disabled = this.page >= pages - 1;
    next.addEventListener("click", () => {
      if (this.page >= pages - 1) return;
      this.page += 1;
      this.render();
      this.container().scrollTo({ top: 0 });
    });
  }

  private openByRelPath(relPath: string, newTab: boolean): void {
    const file = this.app2.vault.getAbstractFileByPath(relPath);
    if (file instanceof TFile) {
      void this.openFile(file, { newTab });
    }
  }
}
