// Oak sidebar view — empty stub.
//
// Per-file metadata (title, visibility, id, slug, status) is
// rendered inline in the main pane now: visibility next to the
// title at the top, id/slug/status as a meta block below the
// related-pages cards. The sidebar leaf is kept around for
// workspace-state continuity (existing layouts may still reference
// it) but it renders nothing in oak mode and is hidden via CSS.

import { ItemView, TFile, WorkspaceLeaf, type App } from "obsidian";

import type { VaultState } from "../state.js";

export const VIEW_TYPE_OAK = "oak-sidebar";

export class OakSidebarView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
  ) {
    super(leaf);
    void this.state;
    void this.app2;
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
    const root =
      (this.containerEl.children[1] as HTMLElement | undefined) ??
      this.containerEl;
    root.empty();
  }

  // Kept for backwards compatibility with main.ts's active-leaf-change
  // hook; no longer does anything.
  setActiveFile(_file: TFile | null): void {
    void _file;
  }
}
