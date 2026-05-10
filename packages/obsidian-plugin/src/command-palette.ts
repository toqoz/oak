// Bespoke command palette: lists only oak commands, plus a small
// allowlist of Obsidian built-ins (e.g. `app:reload` for the dev/test
// loop) and an explicit escape hatch to fall back to Obsidian's native
// palette. Mirrors the "show default menu" entry on the oak-mode editor
// context menu — a curated surface for oak commands, with a few extra
// rows for users who need broader access.
//
// Implementation notes:
//   - Enumerates commands from the live `app.commands.commands` map
//     (cast through `unknown` because it isn't on the public types)
//     and filters by the `oak:` prefix that Obsidian prepends to every
//     command id registered by this plugin (manifest id = `oak`).
//   - `EXTRA_COMMAND_IDS` is the allowlist of non-oak built-ins to
//     surface here. Entries are looked up in the live command map so a
//     missing or renamed id silently drops out instead of showing a
//     dead row.
//   - Selecting the "Open system palette…" sentinel defers via
//     `setTimeout(0)` so this modal finishes closing before Obsidian
//     opens the system palette — otherwise the system palette closes
//     itself when our modal's onClose tears down.
//   - `executeCommandById` honours each command's `checkCallback`, so
//     editor-only commands behave the same as in the native palette.

import { App, FuzzySuggestModal, type Command, type FuzzyMatch } from "obsidian";

const SYSTEM_PALETTE_SENTINEL = "__oak_open_system_palette__";
const OAK_COMMAND_PREFIX = "oak:";
// Extra Obsidian built-ins we want available from the oak palette
// without forcing the user to fall back to the system palette.
const EXTRA_COMMAND_IDS = ["app:reload"] as const;

interface PaletteItem {
  id: string;
  name: string;
  isSystem?: boolean;
}

interface ObsidianCommandsRuntime {
  commands?: Record<string, Command>;
  executeCommandById?: (id: string) => boolean;
}

function commandsRuntime(app: App): ObsidianCommandsRuntime | undefined {
  return (app as unknown as { commands?: ObsidianCommandsRuntime }).commands;
}

export class OakCommandPaletteModal extends FuzzySuggestModal<PaletteItem> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("oak command…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "run" },
      { command: "esc", purpose: "close" },
    ]);
    this.modalEl.addClass("oak-command-palette");
  }

  getItems(): PaletteItem[] {
    const items = listOakCommands(this.app);
    items.push({
      id: SYSTEM_PALETTE_SENTINEL,
      name: "Open system command palette…",
      isSystem: true,
    });
    return items;
  }

  getItemText(item: PaletteItem): string {
    return item.name;
  }

  override renderSuggestion(match: FuzzyMatch<PaletteItem>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    if (match.item.isSystem) el.addClass("oak-command-palette-system");
  }

  onChooseItem(item: PaletteItem): void {
    const runtime = commandsRuntime(this.app);
    if (item.id === SYSTEM_PALETTE_SENTINEL) {
      // Defer until this modal has fully closed; otherwise its
      // teardown closes whatever modal opens synchronously after.
      window.setTimeout(() => {
        runtime?.executeCommandById?.("command-palette:open");
      }, 0);
      return;
    }
    runtime?.executeCommandById?.(item.id);
  }
}

function listOakCommands(app: App): PaletteItem[] {
  const map = commandsRuntime(app)?.commands;
  if (!map) return [];
  const out: PaletteItem[] = [];
  for (const cmd of Object.values(map)) {
    if (!cmd.id.startsWith(OAK_COMMAND_PREFIX)) continue;
    out.push({ id: cmd.id, name: stripOakLabelPrefix(cmd.name) });
  }
  for (const id of EXTRA_COMMAND_IDS) {
    const cmd = map[id];
    if (cmd) out.push({ id: cmd.id, name: cmd.name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Obsidian renders palette entries as `Oak: <name>`. The plugin name
// is implicit here, so strip a leading `Oak: ` if Obsidian (or a
// future rename) ever bakes it into `command.name`.
function stripOakLabelPrefix(name: string): string {
  return name.replace(/^Oak:\s*/i, "");
}

export function openOakCommandPalette(app: App): void {
  new OakCommandPaletteModal(app).open();
}
