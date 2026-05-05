// Oak home view — a "vault index" surface that opens in the main pane.
//
// Sources its data from @oak/core/homeViewModel so the on-screen
// layout stays structurally consistent with the static index.html the
// publisher emits.

import { ItemView, TFile, WorkspaceLeaf, type App } from "obsidian";
import {
  homeViewModel,
  type HomeEntry,
  type HomeViewModel,
} from "@oak/core";

import type { VaultSnapshot, VaultState } from "../state.js";

export const VIEW_TYPE_OAK_HOME = "oak-home";

export class OakHomeView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private model: HomeViewModel | null = null;
  private rendering = false;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
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
      this.render();
      return;
    }
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.model = await homeViewModel(snap.vault, snap.graph, {
        recentLimit: 10,
        hubLimit: 10,
      });
      this.render();
    } finally {
      this.rendering = false;
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

    // Recent
    if (m.recent.length > 0) {
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: "Recent updates" });
      this.renderEntryList(sec, m.recent);
    }

    // Hubs
    if (m.hubs.length > 0) {
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: "Hubs (most-linked-to)" });
      this.renderEntryList(sec, m.hubs);
    }

    // Group by visibility
    const grouped: Record<string, HomeEntry[]> = {
      public: [],
      unlisted: [],
      private: [],
    };
    for (const p of m.pages) {
      grouped[p.visibility]?.push(p);
    }
    for (const v of ["public", "unlisted", "private"] as const) {
      const list = grouped[v];
      if (!list || list.length === 0) continue;
      const sec = root.createDiv({ cls: "oak-home-section" });
      sec.createEl("h2", { text: `${v[0]!.toUpperCase()}${v.slice(1)} (${list.length})` });
      this.renderEntryList(sec, list);
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
        this.openByRelPath(e.vaultRelPath);
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

  private openByRelPath(relPath: string): void {
    const file = this.app2.vault.getAbstractFileByPath(relPath);
    if (file instanceof TFile) {
      void this.app2.workspace.getLeaf(false).openFile(file);
    }
  }
}
