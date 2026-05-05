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
import {
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

export default class OakPlugin extends Plugin {
  settings: OakPluginSettings = DEFAULT_SETTINGS;
  state!: VaultState;

  private autoSnapshotHandle: ReturnType<typeof setInterval> | null = null;
  private sidebarRef: OakSidebarView | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.state = new VaultState(this.app);

    // Make sure the vault has a git repo + managed gitignore. Do not
    // wait on it — Obsidian shouldn't block on git for a plain note open.
    void this.ensureGitInBackground();

    this.registerView(VIEW_TYPE_OAK, (leaf: WorkspaceLeaf) => {
      const view = new OakSidebarView(leaf, this.state, this.app);
      this.sidebarRef = view;
      return view;
    });
    this.addRibbonIcon("trees", "Open oak sidebar", () => {
      void this.activateSidebar();
    });

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
      id: "oak-set-visibility",
      name: "Set visibility",
      callback: () => void setVisibility(this),
    });
    this.addCommand({
      id: "oak-create-from-redlink",
      name: "Create page from unresolved link",
      callback: () => void createPageFromRedlink(this),
    });
    this.addCommand({
      id: "oak-show-backlinks",
      name: "Show backlinks (open Oak sidebar)",
      callback: () => void this.activateSidebar(),
    });
    this.addCommand({
      id: "oak-show-twohop",
      name: "Show 2-hop neighbours (open Oak sidebar)",
      callback: () => void this.activateSidebar(),
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

  async activateSidebar(): Promise<void> {
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
}
