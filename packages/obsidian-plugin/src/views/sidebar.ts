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
  Notice,
  TFile,
  WorkspaceLeaf,
  type App,
} from "obsidian";
import {
  describeBacklinks,
  describeOutbound,
  describeTwoHop,
  type OutboundEntry,
} from "../format.js";
import {
  pathSafeFilename,
  slugify,
  type OakPage,
} from "@oak/core";
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
    const page = this.currentPage;
    const file = this.app2.vault.getAbstractFileByPath(page.relPath);
    const tfile = file instanceof TFile ? file : null;
    const form = section.createDiv({ cls: "oak-prop-form" });

    // ID — read-only by design. Treat as the immutable handle the
    // graph and publish manifest key off; renaming would orphan
    // backlinks across the vault.
    this.renderReadonlyProp(form, "ID", page.id);
    this.renderTitleProp(form, tfile, page);
    this.renderSelectProp(form, tfile, "Visibility", "visibility", page.visibility, [
      "private",
      "unlisted",
      "public",
    ]);
    this.renderTextProp(form, tfile, "Slug", "slug", page.slug);
    this.renderSelectProp(form, tfile, "LLM", "llm", page.llm, [
      "deny",
      "allow",
      "summary-only",
    ]);

    // Publish status from validation issues touching this page.
    const issues = snap.issues.filter((i) => i.pageId === page.id);
    const status = section.createDiv({ cls: "oak-prop-status" });
    if (issues.length === 0) {
      status.setText("Status: ok");
    } else {
      const errCount = issues.filter((i) => i.severity === "error").length;
      status.setText(`Status: ${errCount} error(s) blocking publish`);
      status.addClass("oak-error");
    }
  }

  private renderReadonlyProp(
    parent: HTMLElement,
    label: string,
    value: string,
  ): void {
    const row = parent.createDiv({ cls: "oak-prop-row" });
    row.createEl("label", { cls: "oak-prop-label", text: label });
    row.createEl("span", { cls: "oak-prop-readonly", text: value });
  }

  // Title is special: changing it can also rename the file (when the
  // filename was auto-derived from the old title) and refresh the
  // slug (when the slug was auto-derived from the old title). Either
  // side stays untouched if the user customised it.
  private renderTitleProp(
    parent: HTMLElement,
    file: TFile | null,
    page: OakPage,
  ): void {
    const row = parent.createDiv({ cls: "oak-prop-row" });
    row.createEl("label", { cls: "oak-prop-label", text: "Title" });
    const input = row.createEl("input", {
      cls: "oak-prop-input",
      type: "text",
    });
    input.value = page.title;
    if (!file) {
      input.disabled = true;
      return;
    }
    const commit = async () => {
      const next = input.value.trim();
      if (next.length === 0 || next === page.title) {
        input.value = page.title;
        return;
      }
      await this.commitTitleChange(file, page, next);
    };
    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      }
    });
  }

  private async commitTitleChange(
    file: TFile,
    page: OakPage,
    newTitle: string,
  ): Promise<void> {
    // "Auto-derived" detection: compare the current value to what
    // the algorithm would have produced from the old title. A match
    // means we own that derivation and should re-run it.
    const slugWasAuto = slugify(page.title) === page.slug;
    const newSlug = slugify(newTitle);

    const basenameWasAuto = pathSafeFilename(page.title) === page.basename;
    const newBasename = pathSafeFilename(newTitle);

    try {
      await this.app2.fileManager.processFrontMatter(file, (fm) => {
        const f = fm as Record<string, unknown>;
        f["title"] = newTitle;
        if (slugWasAuto && newSlug.length > 0) {
          f["slug"] = newSlug;
        }
      });
    } catch (err) {
      new Notice(`oak: failed to update frontmatter — ${(err as Error).message}`);
      return;
    }

    if (
      basenameWasAuto &&
      newBasename.length > 0 &&
      newBasename !== page.basename
    ) {
      const dir =
        file.parent && file.parent.path && file.parent.path !== "/"
          ? `${file.parent.path}/`
          : "";
      const newRelPath = `${dir}${newBasename}.md`;
      const existing = this.app2.vault.getAbstractFileByPath(newRelPath);
      if (existing && existing !== file) {
        new Notice(
          `oak: rename skipped — \`${newRelPath}\` already exists`,
        );
        return;
      }
      try {
        await this.app2.fileManager.renameFile(file, newRelPath);
      } catch (err) {
        new Notice(`oak: rename failed — ${(err as Error).message}`);
      }
    }
  }

  private renderTextProp(
    parent: HTMLElement,
    file: TFile | null,
    label: string,
    key: string,
    value: string,
  ): void {
    const row = parent.createDiv({ cls: "oak-prop-row" });
    row.createEl("label", { cls: "oak-prop-label", text: label });
    const input = row.createEl("input", {
      cls: "oak-prop-input",
      type: "text",
    });
    input.value = value;
    if (!file) {
      input.disabled = true;
      return;
    }
    // Save on blur and on Enter so the user can confirm explicitly.
    const commit = async () => {
      const next = input.value.trim();
      if (next === value) return;
      try {
        await this.app2.fileManager.processFrontMatter(file, (fm) => {
          if (next.length === 0) {
            delete (fm as Record<string, unknown>)[key];
          } else {
            (fm as Record<string, unknown>)[key] = next;
          }
        });
      } catch (err) {
        console.warn("oak: failed to update frontmatter", err);
      }
    };
    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      }
    });
  }

  private renderSelectProp(
    parent: HTMLElement,
    file: TFile | null,
    label: string,
    key: string,
    value: string,
    options: string[],
  ): void {
    const row = parent.createDiv({ cls: "oak-prop-row" });
    row.createEl("label", { cls: "oak-prop-label", text: label });
    const select = row.createEl("select", { cls: "oak-prop-select" });
    for (const opt of options) {
      const o = select.createEl("option", { text: opt });
      o.value = opt;
      if (opt === value) o.selected = true;
    }
    if (!file) {
      select.disabled = true;
      return;
    }
    select.addEventListener("change", () => {
      const next = select.value;
      if (next === value) return;
      void this.app2.fileManager
        .processFrontMatter(file, (fm) => {
          (fm as Record<string, unknown>)[key] = next;
        })
        .catch((err) =>
          console.warn("oak: failed to update frontmatter", err),
        );
    });
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
