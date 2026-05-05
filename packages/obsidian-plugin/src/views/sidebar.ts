// Oak sidebar view.
//
// Mirrors directive §13's "Sidebar" layout exactly:
//
//   Page    — type, visibility, publish status
//   Links   — outbound (with unresolved inline), backlinks, 2-hop
//   Git     — snapshot status
//   External — mount info
//
// No "Red Links Panel": unresolved targets render inline as part of
// the outbound list.

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
import {
  gitStatus,
  recentCommits,
  listMountStatus,
  type GitStatus,
  type CommitRecord,
  type MountStatus,
  type OakPage,
} from "@oak/core";
import type { VaultSnapshot, VaultState } from "../state.js";
import { vaultRoot } from "../paths.js";

export const VIEW_TYPE_OAK = "oak-sidebar";

export class OakSidebarView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private currentPage: OakPage | null = null;
  private gitInfo: { status: GitStatus; recent: CommitRecord[] } | null = null;
  private mounts: MountStatus[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
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
    void this.refreshGitAndMounts();
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

  async refreshGitAndMounts(): Promise<void> {
    try {
      const root = vaultRoot(this.app2);
      const [status, recent, mounts] = await Promise.all([
        gitStatus(root),
        recentCommits(root, 3),
        listMountStatus(root),
      ]);
      this.gitInfo = { status, recent };
      this.mounts = mounts;
      void this.render(this.state.current());
    } catch (err) {
      console.error("oak: failed to read git/mounts", err);
    }
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
    this.renderGitSection(root);
    this.renderExternalSection(root);
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
          this.openPageById(snap, b.fromId);
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
          this.openPageById(snap, h.pageId);
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
          if (snap) this.openPageById(snap, entry.targetId);
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

  private renderGitSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "oak-section" });
    section.createEl("h3", { text: "Git" });
    if (!this.gitInfo) {
      section.createEl("p", { cls: "oak-muted", text: "(loading)" });
      return;
    }
    const { status, recent } = this.gitInfo;
    if (!status.initialized) {
      section.createEl("p", {
        cls: "oak-muted",
        text: "No git repo yet — run `oak init` or any oak command.",
      });
      return;
    }
    section.createEl("p", {
      text: `${status.branch ?? "(detached)"}: ${status.dirty ? "dirty" : "clean"} (staged ${status.staged.length}, unstaged ${status.unstaged.length}, untracked ${status.untracked.length})`,
    });
    if (recent.length > 0) {
      const ul = section.createEl("ul", { cls: "oak-list" });
      for (const c of recent) {
        ul.createEl("li", {
          cls: "oak-context",
          text: `${c.shortHash}  ${c.subject}`,
        });
      }
    }
  }

  private renderExternalSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "oak-section" });
    section.createEl("h3", { text: "External" });
    if (this.mounts.length === 0) {
      section.createEl("p", {
        cls: "oak-muted",
        text: "(no mounts configured)",
      });
      return;
    }
    const ul = section.createEl("ul", { cls: "oak-list" });
    for (const m of this.mounts) {
      const li = ul.createEl("li");
      li.createEl("strong", { text: m.entry.id });
      li.createEl("div", {
        cls: "oak-context",
        text: `${m.entry.linkPath} → ${m.entry.targetPath}`,
      });
      const ok = m.linkExists && m.targetExists;
      li.createEl("div", {
        cls: ok ? "oak-context" : "oak-error",
        text: ok
          ? "ok"
          : `${m.linkExists ? "" : "link missing "}${m.targetExists ? "" : "target missing"}`.trim(),
      });
    }
  }

  private openPageById(snap: VaultSnapshot, pageId: string): void {
    const page = snap.vault.pages.get(pageId);
    if (!page) return;
    const file = this.app2.vault.getAbstractFileByPath(page.relPath);
    if (file && "extension" in file) {
      void this.app2.workspace.getLeaf(false).openFile(file as TFile);
    }
  }
}
