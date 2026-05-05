// Oak sidebar view — per-file context.
//
//   Page  — title (editable), id (read-only), visibility, slug,
//           llm policy, publish status
//
// Backlinks and 2-hop live in the main pane's footer cards now, so
// the user reads relationships next to the body content rather than
// having to glance over to the sidebar. Vault-wide info (git, mounts)
// lives in the home view.

import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  type App,
} from "obsidian";
import {
  pathSafeFilename,
  slugify,
  type OakPage,
} from "@oak/core";
import { commitTitleChange } from "../title-commit.js";
import type { VaultSnapshot, VaultState } from "../state.js";

export const VIEW_TYPE_OAK = "oak-sidebar";

export class OakSidebarView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private currentPage: OakPage | null = null;

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
  }

  override async onClose(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  setActiveFile(file: TFile | null): void {
    const found = this.findPageForFile(file);
    if (found) {
      this.currentPage = found;
    } else if (file === null) {
      this.currentPage = null;
    } else {
      // Path mismatch (typically: mid-rename, the TFile has the new
      // path but the snapshot still has the old one). If our previous
      // currentPage is still in the snapshot by id, keep showing it
      // so the sidebar doesn't flash to the empty state.
      const snap = this.state.current();
      if (
        !snap ||
        !this.currentPage ||
        !snap.vault.pages.has(this.currentPage.id)
      ) {
        this.currentPage = null;
      }
    }
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
    const oldTitle = page.title;
    const oldSlug = page.slug;
    const oldBasename = page.basename;
    const oldRelPath = page.relPath;

    // Optimistically mirror what the shared helper will do, so any
    // re-render between the file ops and the next state.refresh
    // shows the new value, not the pre-commit one. The authoritative
    // snapshot overwrites these fields when parseVault runs again.
    const slugWasAuto = slugify(oldTitle) === oldSlug;
    const newSlug = slugify(newTitle);
    const basenameWasAuto = pathSafeFilename(oldTitle) === oldBasename;
    const newBasename = pathSafeFilename(newTitle);

    page.title = newTitle;
    if (slugWasAuto && newSlug.length > 0) page.slug = newSlug;
    let optimisticRenameApplied = false;
    if (
      basenameWasAuto &&
      newBasename.length > 0 &&
      newBasename !== oldBasename
    ) {
      const dir =
        file.parent && file.parent.path && file.parent.path !== "/"
          ? `${file.parent.path}/`
          : "";
      page.basename = newBasename;
      page.relPath = `${dir}${newBasename}.md`;
      optimisticRenameApplied = true;
    }

    const result = await commitTitleChange(
      this.app2,
      file,
      { title: oldTitle, slug: oldSlug, basename: oldBasename },
      newTitle,
    );

    if (result.status === "frontmatter-failed") {
      page.title = oldTitle;
      page.slug = oldSlug;
      if (optimisticRenameApplied) {
        page.basename = oldBasename;
        page.relPath = oldRelPath;
      }
      new Notice(`oak: failed to update frontmatter — ${result.error}`);
      return;
    }
    if (result.status === "rename-skipped") {
      // Frontmatter was applied but the rename couldn't proceed —
      // roll back the optimistic basename/relPath so the sidebar
      // doesn't show a path that won't exist on disk.
      if (optimisticRenameApplied) {
        page.basename = oldBasename;
        page.relPath = oldRelPath;
      }
      new Notice(`oak: rename skipped — ${result.reason}`);
      return;
    }
    if (result.status === "rename-failed") {
      if (optimisticRenameApplied) {
        page.basename = oldBasename;
        page.relPath = oldRelPath;
      }
      new Notice(`oak: rename failed — ${result.error}`);
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

}
