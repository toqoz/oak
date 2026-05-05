// Oak sidebar view — per-file context.
//
//   Page   — type, visibility, publish status
//   Links  — outbound (with unresolved inline), backlinks, 2-hop
//
// Vault-wide info (git status, mounts) lives in the home view since
// it doesn't change with the active file.
//
// No "Red Links Panel": unresolved targets render inline as part of
// the outbound list (per directive §4).

import {
  ItemView,
  TFile,
  WorkspaceLeaf,
  type App,
} from "obsidian";
import {
  describeBacklinks,
  describeOutbound,
  describeTwoHop,
  summarizePage,
  type OutboundEntry,
} from "../format.js";
import type { OakPage } from "@oak/core";
import type { VaultSnapshot, VaultState } from "../state.js";
import type { OakOpenFile } from "../open-file.js";

export const VIEW_TYPE_OAK = "oak-sidebar";

export class OakSidebarView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private currentPage: OakPage | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private openFile: OakOpenFile,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OAK;
  }

  getDisplayText(): string {
    return "Oak";
  }

  override getIcon(): string {
    return "trees";
  }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.state.subscribe((snap) => {
      void this.render(snap);
    });
  }

  override async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  setActiveFile(file: TFile | null): void {
    this.currentPage = this.findPageForFile(file);
    void this.render(this.state.current());
  }

  private findPageForFile(file: TFile | null): OakPage | null {
    if (!file) return null;
    const snap = this.state.current();
    if (!snap) return null;
    for (const page of snap.vault.pages.values()) {
      if (page.relPath === file.path) return page;
    }
    return null;
  }

  private async render(snap: VaultSnapshot | null): Promise<void> {
    const root =
      (this.containerEl.children[1] as HTMLElement | undefined) ??
      this.containerEl;
    root.empty();
    root.addClass("oak-sidebar");

    if (!snap) {
      root.createEl("div", {
        cls: "oak-empty",
        text: "Indexing vault…",
      });
      return;
    }

    if (this.currentPage === null) {
      this.currentPage = this.findPageForFile(this.activeFile());
    }

    this.renderPageSection(root, snap);
    this.renderLinksSection(root, snap);
  }

  private activeFile(): TFile | null {
    const af = this.app2.workspace.getActiveFile();
    return af ?? null;
  }

  private renderPageSection(parent: HTMLElement, snap: VaultSnapshot): void {
    const section = parent.createDiv({ cls: "oak-section" });
    section.createEl("h3", { text: "Page" });

    if (!this.currentPage) {
      section.createEl("p", {
        cls: "oak-muted",
        text: "Open a markdown file inside the vault to see oak metadata.",
      });
      return;
    }
    const sum = summarizePage(this.currentPage);
    const list = section.createEl("ul", { cls: "oak-meta" });
    list.createEl("li", { text: `Title: ${sum.title}` });
    list.createEl("li", {
      text: `Visibility: ${sum.visibility}${sum.publishable ? " (publishable)" : " (private)"}`,
    });
    list.createEl("li", { text: `Slug: ${sum.slug}` });
    list.createEl("li", { text: `LLM policy: ${sum.llm}` });

    // Publish status from validation issues touching this page.
    const issues = snap.issues.filter((i) => i.pageId === this.currentPage!.id);
    if (issues.length === 0) {
      list.createEl("li", { text: "Status: ok" });
    } else {
      const errCount = issues.filter((i) => i.severity === "error").length;
      list.createEl("li", {
        text: `Status: ${errCount} error(s) blocking publish`,
        cls: "oak-error",
      });
    }
  }

  private renderLinksSection(parent: HTMLElement, snap: VaultSnapshot): void {
    const section = parent.createDiv({ cls: "oak-section" });
    section.createEl("h3", { text: "Links" });

    if (!this.currentPage) return;

    const outgoing =
      snap.graph.outgoing.get(this.currentPage.id) ?? [];
    const outBlock = section.createDiv({ cls: "oak-block" });
    outBlock.createEl("h4", { text: `Outbound (${outgoing.length})` });
    if (outgoing.length === 0) {
      outBlock.createEl("p", { cls: "oak-muted", text: "(none)" });
    } else {
      const ul = outBlock.createEl("ul", { cls: "oak-list" });
      for (const link of outgoing) {
        const entry = describeOutbound(link, snap.vault);
        this.renderOutboundEntry(ul.createEl("li"), entry);
      }
    }

    const back = describeBacklinks(snap.graph, snap.vault, this.currentPage.id);
    const backBlock = section.createDiv({ cls: "oak-block" });
    backBlock.createEl("h4", { text: `Backlinks (${back.length})` });
    if (back.length === 0) {
      backBlock.createEl("p", { cls: "oak-muted", text: "(none)" });
    } else {
      const ul = backBlock.createEl("ul", { cls: "oak-list" });
      for (const b of back) {
        const li = ul.createEl("li");
        const link = li.createEl("a", {
          cls: "oak-link",
          text: b.fromTitle,
          href: "#",
        });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.openPageById(snap, b.fromId, ev.metaKey || ev.ctrlKey);
        });
        if (b.context.length > 0) {
          li.createEl("div", { cls: "oak-context", text: b.context });
        }
      }
    }

    const twohop = describeTwoHop(
      snap.graph,
      snap.vault,
      this.currentPage.id,
    );
    const twoBlock = section.createDiv({ cls: "oak-block" });
    twoBlock.createEl("h4", { text: `2-hop (${twohop.length})` });
    if (twohop.length === 0) {
      twoBlock.createEl("p", { cls: "oak-muted", text: "(none)" });
    } else {
      const ul = twoBlock.createEl("ul", { cls: "oak-list" });
      for (const h of twohop) {
        const li = ul.createEl("li");
        const link = li.createEl("a", {
          cls: "oak-link",
          text: `${h.title} [score=${h.score}]`,
          href: "#",
        });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.openPageById(snap, h.pageId, ev.metaKey || ev.ctrlKey);
        });
        const via = h.via.map((v) => v.title).join(", ");
        li.createEl("div", { cls: "oak-context", text: `via ${via}` });
      }
    }
  }

  private renderOutboundEntry(li: HTMLLIElement, entry: OutboundEntry): void {
    switch (entry.kind) {
      case "page": {
        const a = li.createEl("a", {
          cls: "oak-link",
          text: entry.label,
          href: "#",
        });
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          const snap = this.state.current();
          if (snap) this.openPageById(snap, entry.targetId, ev.metaKey || ev.ctrlKey);
        });
        return;
      }
      case "external":
        li.createSpan({
          cls: "oak-external",
          text: `${entry.label} (external)`,
        });
        return;
      case "redlink":
        li.createSpan({
          cls: "oak-redlink",
          text: `${entry.label} (red link)`,
        });
        return;
      case "invalid":
        li.createSpan({
          cls: "oak-error",
          text: `${entry.label} (invalid: ${entry.reason})`,
        });
        return;
    }
  }

  private openPageById(
    snap: VaultSnapshot,
    pageId: string,
    newTab: boolean,
  ): void {
    const page = snap.vault.pages.get(pageId);
    if (!page) return;
    const file = this.app2.vault.getAbstractFileByPath(page.relPath);
    if (file instanceof TFile) {
      void this.openFile(file, { newTab });
    }
  }
}
