// Shared callback type for "open this file" used by oak views. The
// plugin instance owns the actual implementation (browse-leaf reuse +
// new-tab behaviour); views receive it as a function so they don't
// need to import the plugin class.

import type { TFile } from "obsidian";

export type OakOpenFile = (
  file: TFile,
  opts?: {
    newTab?: boolean;
    // 0-based file-relative line to scroll to. Forwarded into Obsidian's
    // `OpenViewState.eState.line`, which makes the editor open with the
    // viewport already focused on this line — needed for agenda-style
    // navigation that wants to land on a specific heading rather than
    // the file's top.
    line?: number;
  },
) => Promise<void> | void;
