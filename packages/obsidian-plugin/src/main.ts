// Plugin entry point.
//
// Lifecycle:
//   1. onload: initialise state, register sidebar view + commands +
//      file-event listeners. Optionally start the auto-snapshot timer.
//   2. onunload: dispose of state and timers. Obsidian unregisters
//      events automatically via `registerEvent`.

import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";

import {
  DEFAULT_SETTINGS,
  OakSettingTab,
  type OakPluginSettings,
} from "./settings.js";
import { VaultState, type VaultSnapshot } from "./state.js";
import { OakSidebarView, VIEW_TYPE_OAK } from "./views/sidebar.js";
import { OakHomeView, VIEW_TYPE_OAK_HOME } from "./views/home.js";
import {
  createNewPage,
  createPageFromRedlink,
  runCheckpoint,
  runMount,
  runPublish,
  runSnapshot,
  runValidate,
  setVisibility,
} from "./commands.js";
import {
  ensureGitRepo,
  excerptFrom,
  slugify,
  snapshot,
  type OakPage,
} from "@oak/core";
import { describeBacklinks, describeTwoHop } from "./format.js";
import { vaultRoot } from "./paths.js";
import type { OakOpenFile } from "./open-file.js";
import { commitTitleChange } from "./title-commit.js";

export default class OakPlugin extends Plugin {
  settings: OakPluginSettings = DEFAULT_SETTINGS;
  state!: VaultState;

  private autoSnapshotHandle: ReturnType<typeof setInterval> | null = null;
  private sidebarRef: OakSidebarView | null = null;
  private linksUnsubscribe: (() => void) | null = null;
  // The "browse" leaf — like a web browser tab. The home and sidebar
  // both target this leaf for plain-click navigation, so each click
  // replaces the current page instead of stacking new tabs.
  // Cmd/Ctrl-click bypasses reuse and opens a fresh tab.
  private browseLeaf: WorkspaceLeaf | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.state = new VaultState(this.app);

    // Make sure the vault has a git repo + managed gitignore. Do not
    // wait on it — Obsidian shouldn't block on git for a plain note open.
    void this.ensureGitInBackground();

    const openFile: OakOpenFile = (file, opts) =>
      this.openInBrowseLeaf(file, opts ?? {});

    this.registerView(VIEW_TYPE_OAK, (leaf: WorkspaceLeaf) => {
      const view = new OakSidebarView(leaf, this.state, this.app);
      this.sidebarRef = view;
      return view;
    });
    this.registerView(VIEW_TYPE_OAK_HOME, (leaf: WorkspaceLeaf) => {
      return new OakHomeView(
        leaf,
        this.state,
        this.app,
        openFile,
        () => this.toggleOakMode(),
      );
    });
    // Single "oak mode" entry — toggles between the focused oak
    // surfaces (home in main, sidebar on the right, file explorer
    // hidden) and the regular Obsidian layout (file explorer
    // restored, oak leaves closed).
    const ribbon = this.addRibbonIcon("trees", "Toggle oak mode", () => {
      void this.toggleOakMode();
    });
    // Tag our ribbon icon so the oak-mode CSS can hide everything
    // else without hiding ours.
    ribbon.addClass("oak-ribbon-icon");

    this.registerEvent(
      this.app.vault.on("modify", () => this.state.scheduleRefresh()),
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.state.scheduleRefresh()),
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.state.scheduleRefresh()),
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.state.scheduleRefresh()),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        const tfile = file instanceof TFile ? file : null;
        this.sidebarRef?.setActiveFile(tfile);
      }),
    );
    // Mode is defined by oak-leaf presence: any layout change re-syncs
    // the body class so a manual close (or workspace state restoration
    // after reload) keeps the chrome consistent.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncOakModeClass();
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
      }),
    );
    // Vault state refresh -> backlinks/2-hop change -> rerender cards
    // and meta panel.
    this.linksUnsubscribe = this.state.subscribe(() => {
      this.applyLinksCards();
      this.applyPageMeta();
    });

    this.addCommand({
      id: "oak-toggle-mode",
      name: "Toggle oak mode",
      callback: () => void this.toggleOakMode(),
    });
    this.addCommand({
      id: "oak-new-page",
      name: "New oak page",
      callback: () => void createNewPage(this),
    });
    this.addCommand({
      id: "oak-set-visibility",
      name: "Set visibility",
      callback: () => void setVisibility(this),
    });
    this.addCommand({
      id: "oak-new-from-redlink",
      name: "New page from unresolved link",
      callback: () => void createPageFromRedlink(this),
    });
    this.addCommand({
      id: "oak-validate",
      name: "Validate vault",
      callback: () => void runValidate(this),
    });
    this.addCommand({
      id: "oak-publish",
      name: "Publish",
      callback: () => void runPublish(this),
    });
    this.addCommand({
      id: "oak-snapshot",
      name: "Snapshot vault",
      callback: () => void runSnapshot(this),
    });
    this.addCommand({
      id: "oak-checkpoint",
      name: "Checkpoint",
      callback: () => void runCheckpoint(this),
    });
    this.addCommand({
      id: "oak-mount-external",
      name: "Mount external directory",
      callback: () => void runMount(this),
    });

    this.addSettingTab(new OakSettingTab(this.app, this));

    // Initial parse + auto-snapshot setup happen after layout is ready
    // so the active file detection works on the first sidebar render.
    this.app.workspace.onLayoutReady(() => {
      void this.state.refresh();
      this.applyAutoSnapshot();
      // If a previous session left oak views in the workspace state,
      // Obsidian has just re-instantiated them. Re-attach the chrome
      // class so oak mode visually resumes where the user left off.
      this.syncOakModeClass();
      this.applyTitleOverrides();
      this.applyLinksCards();
      this.applyPageMeta();
    });
  }

  override onunload(): void {
    if (this.autoSnapshotHandle) clearInterval(this.autoSnapshotHandle);
    this.autoSnapshotHandle = null;
    this.linksUnsubscribe?.();
    this.linksUnsubscribe = null;
    this.state?.dispose();
    // Clear the body class so disabling the plugin (or reloading) can
    // never leave other ribbon icons hidden.
    document.body.removeClass("oak-mode-active");
    // And drop any oak title overrides + footer cards / meta from
    // open markdown views so they return to Obsidian's defaults.
    this.applyTitleOverrides();
    this.applyLinksCards();
    this.applyPageMeta();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...(raw as Partial<OakPluginSettings>) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyAutoSnapshot();
  }

  applyAutoSnapshot(): void {
    if (this.autoSnapshotHandle) clearInterval(this.autoSnapshotHandle);
    this.autoSnapshotHandle = null;
    const ms = this.settings.autoSnapshotIntervalMs;
    if (!ms || ms <= 0) return;
    this.autoSnapshotHandle = setInterval(() => {
      void snapshot(vaultRoot(this.app)).catch((err) =>
        console.warn("oak auto-snapshot failed:", err),
      );
    }, ms);
  }

  private async ensureGitInBackground(): Promise<void> {
    try {
      await ensureGitRepo(vaultRoot(this.app));
    } catch (err) {
      console.warn("oak: ensureGitRepo failed", err);
    }
  }

  // Browser-tab-style navigation for oak link clicks.
  //
  //   plain click       reuse the existing browse leaf (or open a new
  //                     tab if there isn't one / the user closed it)
  //   Cmd / Ctrl click  always open a new tab; that new tab becomes the
  //                     new browse leaf so subsequent plain clicks
  //                     keep replacing it
  async openInBrowseLeaf(
    file: TFile,
    opts: { newTab?: boolean } = {},
  ): Promise<void> {
    const reuse =
      !opts.newTab &&
      this.browseLeaf !== null &&
      this.isLeafAlive(this.browseLeaf);
    const leaf = reuse
      ? this.browseLeaf!
      : this.app.workspace.getLeaf("tab");
    this.browseLeaf = leaf;
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  private isLeafAlive(leaf: WorkspaceLeaf): boolean {
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) alive = true;
    });
    return alive;
  }

  // Toggle "oak mode": one gesture switches between the focused oak
  // surfaces and the regular Obsidian layout.
  //
  // ON  — at least one oak leaf is open. Toggling off detaches every
  //       oak leaf and expands the left sidebar so the user's other
  //       left-pane tools (file explorer, search, bookmarks, …) come
  //       back into view.
  // OFF — no oak leaves open. Toggling on opens the sidebar (right)
  //       and the home (main), focuses the home, and collapses the
  //       left sidebar so the layout reads as oak-only.
  async toggleOakMode(): Promise<void> {
    const sidebarLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK);
    const homeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK_HOME);
    const isOn = sidebarLeaves.length > 0 || homeLeaves.length > 0;

    if (isOn) {
      for (const leaf of sidebarLeaves) leaf.detach();
      for (const leaf of homeLeaves) leaf.detach();
      this.app.workspace.leftSplit.expand();
      // Body class is updated by the layout-change listener.
      return;
    }

    await this.activateSidebar();
    await this.activateHome();
    this.app.workspace.leftSplit.collapse();
  }

  private syncOakModeClass(): void {
    const sidebarPresent =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK).length > 0;
    const homePresent =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK_HOME).length > 0;
    const isOn = sidebarPresent || homePresent;
    if (isOn) document.body.addClass("oak-mode-active");
    else document.body.removeClass("oak-mode-active");

    // Re-create the home leaf if the user closed it while still in
    // oak mode (sidebar still open). Pinning prevents the leaf from
    // being replaced by file open events; this catches the manual
    // close case.
    if (isOn && !homePresent) {
      void this.activateHome();
    }
  }

  // For each open markdown view, replace the *displayed* filename
  // with the frontmatter `title` (when present and oak mode is
  // active). Display-only — never mutate the actual textContent of
  // editable / file-bound elements, so titles can safely contain
  // characters that aren't path-safe (e.g. `:`, `/`).
  //
  // Two surfaces, both rely on CSS to do the visual override:
  //   - inline title at the top of the editor: we hide Obsidian's
  //     `.inline-title` and inject a sibling `.oak-page-title` div
  //   - tab header title: we tag `view.titleEl` with a class +
  //     `data-oak-title` attribute. CSS makes the original text
  //     transparent and overlays the data attribute via `::before`.
  private applyTitleOverrides(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      this.applyTitleForView(view, view.file, oakMode);
    }
  }

  private applyTitleForView(
    view: MarkdownView,
    file: TFile,
    oakMode: boolean,
  ): void {
    void file; // accessed via metadataCache below; kept for callers
    const cache = this.app.metadataCache.getFileCache(view.file!);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const fmTitleRaw = fm?.["title"];
    const fmTitle =
      typeof fmTitleRaw === "string" && fmTitleRaw.trim().length > 0
        ? fmTitleRaw.trim()
        : null;

    const existingRow = view.contentEl.querySelector<HTMLElement>(
      ".oak-page-title-row",
    );
    // `titleEl` is a runtime property on Obsidian's View base class
    // (the tab header text element). Not in the public types but
    // present at runtime on every view that owns a tab.
    const tabTitleEl = (view as unknown as { titleEl?: HTMLElement })
      .titleEl;

    const fmVisibilityRaw = fm?.["visibility"];
    const fmVisibility =
      typeof fmVisibilityRaw === "string" &&
      (fmVisibilityRaw === "private" ||
        fmVisibilityRaw === "unlisted" ||
        fmVisibilityRaw === "public")
        ? fmVisibilityRaw
        : "private";

    if (oakMode && fmTitle) {
      // Inject the title row *inside* the scroll container so the
      // scrollbar runs the full pane height and so the title
      // scrolls with the content. The row holds the title input on
      // the left and the visibility selector pinned to the right.
      const target = this.findTitleInjectionTarget(view);
      let row = existingRow;
      if (!row || (target && row.parentElement !== target)) {
        // Mode switch (source <-> preview) recreates the scroll
        // container; drop a stale row and inject into the new one.
        if (row) row.remove();
        row = document.createElement("div");
        row.classList.add("oak-page-title-row");

        const input = document.createElement("input");
        input.classList.add("oak-page-title");
        input.type = "text";
        input.spellcheck = false;
        row.appendChild(input);

        const select = document.createElement("select");
        select.classList.add("oak-page-visibility");
        for (const v of ["private", "unlisted", "public"]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          select.appendChild(o);
        }
        row.appendChild(select);

        if (target) {
          target.prepend(row);
          this.attachInlineTitleEditing(view, input);
          this.attachVisibilitySelect(view, select);
        }
      }
      const input = row.querySelector<HTMLInputElement>(".oak-page-title");
      const select = row.querySelector<HTMLSelectElement>(".oak-page-visibility");
      if (input) {
        // Don't clobber what the user is typing. We only push the
        // canonical value when the input isn't focused.
        if (input.value !== fmTitle && document.activeElement !== input) {
          input.value = fmTitle;
        }
      }
      if (select && select.value !== fmVisibility) {
        select.value = fmVisibility;
      }

      if (tabTitleEl) {
        tabTitleEl.dataset["oakTitle"] = fmTitle;
        tabTitleEl.classList.add("oak-tab-title-override");
      }
    } else {
      if (existingRow) existingRow.remove();
      if (tabTitleEl) {
        delete tabTitleEl.dataset["oakTitle"];
        tabTitleEl.classList.remove("oak-tab-title-override");
      }
    }
  }

  private attachVisibilitySelect(
    view: MarkdownView,
    select: HTMLSelectElement,
  ): void {
    select.addEventListener("change", () => {
      const file = view.file;
      if (!file) return;
      const next = select.value;
      void this.app.fileManager
        .processFrontMatter(file, (fm) => {
          (fm as Record<string, unknown>)["visibility"] = next;
        })
        .catch((err) =>
          new Notice(`oak: failed to update visibility — ${(err as Error).message}`),
        );
    });
  }

  // For each open markdown view, render a "Related" footer that
  // sits *inside* the scroll container (after the body), so the
  // user reaches it by scrolling down — it reads as the tail end of
  // the page rather than as separate chrome.
  private applyLinksCards(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      this.applyLinksCardForView(view, oakMode);
    }
  }

  private applyLinksCardForView(
    view: MarkdownView,
    oakMode: boolean,
  ): void {
    const existing =
      view.contentEl.querySelector<HTMLElement>(".oak-page-links");

    if (!oakMode || !view.file) {
      existing?.remove();
      return;
    }

    const snap = this.state.current();
    if (!snap) {
      existing?.remove();
      return;
    }

    let page: OakPage | null = null;
    for (const p of snap.vault.pages.values()) {
      if (p.relPath === view.file.path) {
        page = p;
        break;
      }
    }
    if (!page) {
      existing?.remove();
      return;
    }

    const target = this.findLinksInjectionTarget(view);
    if (!target) {
      existing?.remove();
      return;
    }

    let container = existing;
    if (!container || container.parentElement !== target) {
      container?.remove();
      container = document.createElement("div");
      container.classList.add("oak-page-links");
      target.appendChild(container);
    }
    container.empty();

    // Merge backlinks + 2-hop into a single deduplicated list of
    // related pages, with relation labels for the card footer.
    type RelatedItem = {
      page: OakPage;
      relation: string;
    };
    const related: RelatedItem[] = [];
    const seen = new Set<string>();
    for (const b of describeBacklinks(snap.graph, snap.vault, page.id)) {
      if (seen.has(b.fromId)) continue;
      seen.add(b.fromId);
      const p = snap.vault.pages.get(b.fromId);
      if (!p) continue;
      related.push({ page: p, relation: "backlink" });
    }
    for (const h of describeTwoHop(snap.graph, snap.vault, page.id)) {
      if (seen.has(h.pageId)) continue;
      seen.add(h.pageId);
      const p = snap.vault.pages.get(h.pageId);
      if (!p) continue;
      const via = h.via.map((v) => v.title).join(", ");
      related.push({ page: p, relation: `2-hop · via ${via}` });
    }

    if (related.length === 0) {
      // Empty state: keep the heading so the page still terminates
      // gracefully but skip the row to avoid an empty scroller.
      container.createEl("h2", {
        cls: "oak-page-links-heading",
        text: "関連項目",
      });
      container.createEl("p", {
        cls: "oak-page-links-empty",
        text: "(no backlinks or 2-hop neighbours yet)",
      });
      return;
    }

    container.createEl("h2", {
      cls: "oak-page-links-heading",
      text: "関連項目",
    });
    const row = container.createDiv({ cls: "oak-page-links-row" });
    for (const item of related) {
      this.renderRelatedCard(row, snap, item.page, item.relation);
    }
  }

  private renderRelatedCard(
    parent: HTMLElement,
    snap: VaultSnapshot,
    page: OakPage,
    relation: string,
  ): void {
    const card = parent.createDiv({ cls: "oak-page-links-card" });
    card.setAttr("role", "link");
    card.setAttr("tabindex", "0");
    card.createEl("div", {
      cls: "oak-page-links-card-title",
      text: page.title,
    });
    const excerpt = excerptFrom(page.body, 240);
    if (excerpt.length > 0) {
      card.createEl("p", {
        cls: "oak-page-links-card-excerpt",
        text: excerpt,
      });
    }
    card.createEl("div", {
      cls: "oak-page-links-card-relation",
      text: relation,
    });
    const open = (newTab: boolean) =>
      this.openLinkTarget(snap, page.id, newTab);
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

  private openLinkTarget(
    snap: VaultSnapshot,
    pageId: string,
    newTab: boolean,
  ): void {
    const page = snap.vault.pages.get(pageId);
    if (!page) return;
    const file = this.app.vault.getAbstractFileByPath(page.relPath);
    if (file instanceof TFile) {
      void this.openInBrowseLeaf(file, { newTab });
    }
  }

  // Per-page metadata (id / slug / llm / status), rendered as a
  // compact row of label-value pairs after the Related cards.
  private applyPageMeta(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      this.applyPageMetaForView(view, oakMode);
    }
  }

  private applyPageMetaForView(
    view: MarkdownView,
    oakMode: boolean,
  ): void {
    const existing =
      view.contentEl.querySelector<HTMLElement>(".oak-page-meta");

    if (!oakMode || !view.file) {
      existing?.remove();
      return;
    }

    const snap = this.state.current();
    if (!snap) {
      existing?.remove();
      return;
    }

    let page: OakPage | null = null;
    for (const p of snap.vault.pages.values()) {
      if (p.relPath === view.file.path) {
        page = p;
        break;
      }
    }
    if (!page) {
      existing?.remove();
      return;
    }

    const target = this.findLinksInjectionTarget(view);
    if (!target) {
      existing?.remove();
      return;
    }

    let container = existing;
    if (!container || container.parentElement !== target) {
      container?.remove();
      container = document.createElement("div");
      container.classList.add("oak-page-meta");
      target.appendChild(container);
    }
    container.empty();

    const file = view.file;
    this.metaRowReadonly(container, "ID", page.id);
    this.metaRowText(container, "Slug", "slug", page.slug, file);
    this.metaRowSelect(
      container,
      "LLM",
      "llm",
      page.llm,
      ["deny", "allow", "summary-only"],
      file,
    );

    const issues = snap.issues.filter((i) => i.pageId === page.id);
    const errCount = issues.filter((i) => i.severity === "error").length;
    this.metaRowReadonly(
      container,
      "Status",
      errCount === 0
        ? "ok"
        : `${errCount} error(s) blocking publish`,
      errCount > 0,
    );
  }

  private metaRowReadonly(
    parent: HTMLElement,
    label: string,
    value: string,
    isError = false,
  ): void {
    parent.createEl("span", {
      cls: "oak-page-meta-label",
      text: label,
    });
    parent.createEl("span", {
      cls: isError
        ? "oak-page-meta-value oak-page-meta-error"
        : "oak-page-meta-value oak-page-meta-readonly",
      text: value,
    });
  }

  private metaRowText(
    parent: HTMLElement,
    label: string,
    key: string,
    value: string,
    file: TFile,
  ): void {
    parent.createEl("span", {
      cls: "oak-page-meta-label",
      text: label,
    });
    const input = parent.createEl("input", {
      cls: "oak-page-meta-input",
      type: "text",
    });
    input.value = value;
    const commit = async () => {
      const next = input.value.trim();
      if (next === value) return;
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const f = fm as Record<string, unknown>;
          if (next.length === 0) delete f[key];
          else f[key] = next;
        });
      } catch (err) {
        new Notice(`oak: failed to update ${key} — ${(err as Error).message}`);
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

  private metaRowSelect(
    parent: HTMLElement,
    label: string,
    key: string,
    value: string,
    options: string[],
    file: TFile,
  ): void {
    parent.createEl("span", {
      cls: "oak-page-meta-label",
      text: label,
    });
    const select = parent.createEl("select", {
      cls: "oak-page-meta-select",
    });
    for (const opt of options) {
      const o = select.createEl("option", { text: opt });
      o.value = opt;
      if (opt === value) o.selected = true;
    }
    select.addEventListener("change", () => {
      const next = select.value;
      void this.app.fileManager
        .processFrontMatter(file, (fm) => {
          (fm as Record<string, unknown>)[key] = next;
        })
        .catch((err) =>
          new Notice(`oak: failed to update ${key} — ${(err as Error).message}`),
        );
    });
  }

  // The cards belong inside the scroll container, alongside the body
  // content, so they scroll with it.
  //   source / live-preview: `.cm-scroller` (sibling of `.cm-content`)
  //   reading view:          `.markdown-preview-view`
  private findLinksInjectionTarget(view: MarkdownView): HTMLElement | null {
    const cmScroller =
      view.contentEl.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) return cmScroller;
    const preview = view.contentEl.querySelector<HTMLElement>(
      ".markdown-preview-view",
    );
    return preview ?? null;
  }

  // Figure out which DOM node the inline title belongs in, depending
  // on the current view mode.
  //   source / live-preview: `.cm-scroller` (sibling of `.cm-content`)
  //   reading view:          `.markdown-preview-view` (the scroller)
  // Returns null if neither is present yet (the next layout-change
  // will retry).
  private findTitleInjectionTarget(view: MarkdownView): HTMLElement | null {
    const cmScroller = view.contentEl.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) return cmScroller;
    const preview = view.contentEl.querySelector<HTMLElement>(
      ".markdown-preview-view",
    );
    return preview ?? null;
  }

  private attachInlineTitleEditing(
    view: MarkdownView,
    input: HTMLInputElement,
  ): void {
    const commit = async () => {
      const file = view.file;
      if (!file) return;
      const newTitle = input.value.trim();
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      const oldTitleRaw = fm?.["title"];
      const oldTitle =
        typeof oldTitleRaw === "string" ? oldTitleRaw.trim() : "";
      if (newTitle.length === 0 || newTitle === oldTitle) {
        input.value = oldTitle;
        return;
      }
      const oldSlugRaw = fm?.["slug"];
      const oldSlug =
        typeof oldSlugRaw === "string" ? oldSlugRaw.trim() : slugify(oldTitle);
      const result = await commitTitleChange(
        this.app,
        file,
        { title: oldTitle, slug: oldSlug, basename: file.basename },
        newTitle,
      );
      if (result.status === "frontmatter-failed") {
        new Notice(`oak: failed to update title — ${result.error}`);
      } else if (result.status === "rename-skipped") {
        new Notice(`oak: rename skipped — ${result.reason}`);
      } else if (result.status === "rename-failed") {
        new Notice(`oak: rename failed — ${result.error}`);
      }
    };
    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        // Revert to the canonical value and bail.
        const cache = view.file
          ? this.app.metadataCache.getFileCache(view.file)
          : null;
        const fm = cache?.frontmatter as Record<string, unknown> | undefined;
        const t = fm?.["title"];
        if (typeof t === "string") input.value = t;
        input.blur();
      }
    });
  }

  private async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]!);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_OAK, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async activateHome(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK_HOME);
    if (existing.length > 0) {
      const leaf = existing[0]!;
      this.app.workspace.revealLeaf(leaf);
      // Re-affirm the pin in case the user toggled it off.
      leaf.setPinned(true);
      return;
    }
    // Open in the main editor area, not the sidebar.
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_OAK_HOME, active: true });
    this.app.workspace.revealLeaf(leaf);
    // Pin the home so opening a file from the sidebar / search / etc.
    // can't accidentally replace it.
    leaf.setPinned(true);
  }
}
