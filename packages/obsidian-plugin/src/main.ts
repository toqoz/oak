// Plugin entry point.
//
// Lifecycle:
//   1. onload: initialise state, register sidebar view + commands +
//      file-event listeners. Optionally start the auto-snapshot timer.
//   2. onunload: dispose of state and timers. Obsidian unregisters
//      events automatically via `registerEvent`.

import { Plugin, TFile, WorkspaceLeaf } from "obsidian";

import {
  DEFAULT_SETTINGS,
  OakSettingTab,
  type OakPluginSettings,
} from "./settings.js";
import { VaultState } from "./state.js";
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
import { ensureGitRepo, snapshot } from "@oak/core";
import { vaultRoot } from "./paths.js";
import type { OakOpenFile } from "./open-file.js";

export default class OakPlugin extends Plugin {
  settings: OakPluginSettings = DEFAULT_SETTINGS;
  state!: VaultState;

  private autoSnapshotHandle: ReturnType<typeof setInterval> | null = null;
  private sidebarRef: OakSidebarView | null = null;
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
      const view = new OakSidebarView(leaf, this.state, this.app, openFile);
      this.sidebarRef = view;
      return view;
    });
    this.registerView(VIEW_TYPE_OAK_HOME, (leaf: WorkspaceLeaf) => {
      return new OakHomeView(leaf, this.state, this.app, openFile);
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
    });
  }

  override onunload(): void {
    if (this.autoSnapshotHandle) clearInterval(this.autoSnapshotHandle);
    this.autoSnapshotHandle = null;
    this.state?.dispose();
    // Clear the body class so disabling the plugin (or reloading) can
    // never leave other ribbon icons hidden.
    document.body.removeClass("oak-mode-active");
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
      document.body.removeClass("oak-mode-active");
      return;
    }

    await this.activateSidebar();
    await this.activateHome();
    this.app.workspace.leftSplit.collapse();
    document.body.addClass("oak-mode-active");
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
      this.app.workspace.revealLeaf(existing[0]!);
      return;
    }
    // Open in the main editor area, not the sidebar.
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_OAK_HOME, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
