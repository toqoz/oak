// Shared callback type for "open this file" used by oak views. The
// plugin instance owns the actual implementation (browse-leaf reuse +
// new-tab behaviour); views receive it as a function so they don't
// need to import the plugin class.

import type { TFile } from "obsidian";

export type OakOpenFile = (
  file: TFile,
  opts?: { newTab?: boolean },
) => Promise<void> | void;
