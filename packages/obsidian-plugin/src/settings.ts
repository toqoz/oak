// Plugin settings type and the Settings tab UI. Settings are
// persisted by Obsidian via `loadData` / `saveData`.

import { App, PluginSettingTab, Setting } from "obsidian";
import type OakPlugin from "./main.js";

export type OakPluginSettings = {
  autoSnapshotIntervalMs: number; // 0 = disabled
  showRedlinksInline: boolean;
};

export const DEFAULT_SETTINGS: OakPluginSettings = {
  autoSnapshotIntervalMs: 0,
  showRedlinksInline: true,
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
      .setName("Auto-snapshot interval (ms)")
      .setDesc(
        "Snapshot the vault automatically when the editor goes quiet. Set to 0 to disable.",
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
