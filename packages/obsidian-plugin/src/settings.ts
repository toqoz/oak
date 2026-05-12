// Plugin settings type and the Settings tab UI. Settings are
// persisted by Obsidian via `loadData` / `saveData`.

import { App, PluginSettingTab, Setting } from "obsidian";
import type OakPlugin from "./main.js";

export type OakPluginSettings = {
  autoSnapshotIntervalMs: number; // 0 = disabled
  showRedlinksInline: boolean;
  // Internal: id of the leaf currently acting as the refile peek pane.
  // The peek itself is session-local — chrome, dim class, escape
  // handler, and engaged state are all rebuilt per session. We
  // persist the id only so the next plugin load can find and detach
  // the orphaned leaf left over in the restored workspace layout;
  // without that cleanup the first refile of the new session would
  // reuse it and surface the destination in an unrelated screen
  // position. Not in the settings UI — written by the refile flow,
  // cleared when the peek is detached.
  refilePeekLeafId: string | null;
};

// Interval applied when auto-snapshot is enabled from the home view
// without an explicit value. Power users can still tune the raw
// number from the settings tab.
export const DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export const DEFAULT_SETTINGS: OakPluginSettings = {
  autoSnapshotIntervalMs: 0,
  showRedlinksInline: true,
  refilePeekLeafId: null,
};

export class OakSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OakPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Oak settings" });

    new Setting(containerEl)
      .setName("Auto-snapshot quiet period (ms)")
      .setDesc(
        "Snapshot the vault automatically once edits stop for this many ms. Each edit pushes the timer forward; the snapshot only fires while you're idle. Set to 0 to disable.",
      )
      .addText((t) =>
        t
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.autoSnapshotIntervalMs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.autoSnapshotIntervalMs = Number.isFinite(n)
              ? Math.max(0, n)
              : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show red links inline in sidebar")
      .setDesc(
        "Render unresolved wiki links inline in the outbound link list (per directive §4: red links are link states, not a separate panel).",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showRedlinksInline).onChange(async (v) => {
          this.plugin.settings.showRedlinksInline = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
