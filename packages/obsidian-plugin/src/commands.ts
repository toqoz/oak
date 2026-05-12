// User-facing commands. Each delegates to @oak/core; the plugin only
// owns the UI flow (modals, notices, file creation, frontmatter
// editing).

import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Setting,
  TFile,
  type EditorPosition,
} from "obsidian";
import {
  addMount,
  buildGraph,
  checkpoint,
  composePage,
  findEnclosingHeading,
  frontmatterLineCount,
  migrateFrontmatter,
  parseVault,
  partitionIssues,
  snapshot,
  validateVault,
  type FrontmatterMigrationReport,
  type Visibility,
} from "@oak/core";
import { findHeadingsInEditorSelection } from "./refile-selection.js";

import type OakPlugin from "./main.js";
import {
  SCRATCH_HISTORY_REL_DIR,
  SCRATCH_VAULT_REL_PATH,
  vaultRoot,
} from "./paths.js";
import { findWikiTargetInLine } from "./wiki-cursor.js";
import { extractFromSelection } from "./extract-selection.js";
import { refileHeading, refileHeadings } from "./refile.js";

const VISIBILITIES: Visibility[] = ["private", "unlisted", "public"];

class ChoiceModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private choices: { label: string; value: string }[],
    private resolve: (v: string | null) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    for (const c of this.choices) {
      const btn = this.contentEl.createEl("button", { text: c.label });
      btn.style.marginRight = "0.5em";
      btn.addEventListener("click", () => {
        this.resolve(c.value);
        this.close();
      });
    }
  }
  override onClose(): void {
    this.contentEl.empty();
    // If the modal closed without a click, resolve null exactly once.
    this.resolve(null);
    // Replace resolve with a no-op so duplicate calls (from button +
    // close) don't call it twice.
    this.resolve = () => undefined;
  }
}

class TextInputModal extends Modal {
  private value = "";
  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    new Setting(this.contentEl).addText((t) => {
      t.setPlaceholder(this.placeholder);
      t.onChange((v) => (this.value = v));
      t.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.submit();
        }
      });
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.submit()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()));
  }
  private submit(): void {
    const v = this.value.trim();
    this.resolve(v.length > 0 ? v : null);
    this.resolve = () => undefined;
    this.close();
  }
  private cancel(): void {
    this.resolve(null);
    this.resolve = () => undefined;
    this.close();
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

class TwoFieldModal extends Modal {
  private a = "";
  private b = "";
  constructor(
    app: App,
    private title: string,
    private aLabel: string,
    private bLabel: string,
    private resolve: (v: { a: string; b: string } | null) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    new Setting(this.contentEl)
      .setName(this.aLabel)
      .addText((t) => t.onChange((v) => (this.a = v)));
    new Setting(this.contentEl)
      .setName(this.bLabel)
      .addText((t) => t.onChange((v) => (this.b = v)));
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.submit()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()));
  }
  private submit(): void {
    const a = this.a.trim();
    const b = this.b.trim();
    if (a && b) {
      this.resolve({ a, b });
      this.resolve = () => undefined;
      this.close();
    }
  }
  private cancel(): void {
    this.resolve(null);
    this.resolve = () => undefined;
    this.close();
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

function ask(
  app: App,
  title: string,
  choices: { label: string; value: string }[],
): Promise<string | null> {
  return new Promise((resolve) => {
    new ChoiceModal(app, title, choices, resolve).open();
  });
}

function askText(
  app: App,
  title: string,
  placeholder: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    new TextInputModal(app, title, placeholder, resolve).open();
  });
}

function askTwo(
  app: App,
  title: string,
  aLabel: string,
  bLabel: string,
): Promise<{ a: string; b: string } | null> {
  return new Promise((resolve) => {
    new TwoFieldModal(app, title, aLabel, bLabel, resolve).open();
  });
}

export async function setVisibility(plugin: OakPlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("oak: open a markdown file first");
    return;
  }
  const choice = await ask(
    plugin.app,
    `Set visibility for ${file.basename}`,
    VISIBILITIES.map((v) => ({ label: v, value: v })),
  );
  if (!choice) return;
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    fm["visibility"] = choice;
  });
  new Notice(`oak: visibility set to ${choice}`);
  plugin.state.scheduleRefresh();
}

function findWikiTargetAtCursor(
  editor: Editor,
  pos: EditorPosition,
): string | null {
  return findWikiTargetInLine(editor.getLine(pos.line), pos.ch);
}

// Confirm-then-trash dialog. Routed through `fileManager.trashFile`
// so the user's "Deleted files" preference (system trash / vault
// `.trash` / permanent) is honored — same behavior as Obsidian's
// own delete affordance.
class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: "Delete file?" });
    this.contentEl.createEl("p", {
      text: `"${this.file.basename}" will be moved to the trash.`,
    });
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => this.finish(true)),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.finish(false)),
      );
  }
  private finish(confirmed: boolean): void {
    this.resolve(confirmed);
    this.resolve = () => undefined;
    this.close();
  }
  override onClose(): void {
    this.contentEl.empty();
    this.resolve(false);
    this.resolve = () => undefined;
  }
}

export async function deleteFile(
  plugin: OakPlugin,
  file: TFile,
): Promise<void> {
  const ok = await new Promise<boolean>((resolve) => {
    new ConfirmDeleteModal(plugin.app, file, resolve).open();
  });
  if (!ok) return;
  try {
    await plugin.app.fileManager.trashFile(file);
  } catch (err) {
    new Notice(`oak: delete failed — ${(err as Error).message}`);
    return;
  }
  plugin.state.scheduleRefresh();
}

export async function deleteCurrentFile(plugin: OakPlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("oak: open a markdown file first");
    return;
  }
  await deleteFile(plugin, file);
}

class NewPageModal extends Modal {
  private titleValue: string;
  private visibilityValue: Visibility = "private";
  constructor(
    app: App,
    initialTitle: string,
    private resolve: (
      v: { title: string; visibility: Visibility } | null,
    ) => void,
  ) {
    super(app);
    this.titleValue = initialTitle;
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: "Create new oak page" });
    new Setting(this.contentEl).setName("Title").addText((t) => {
      t.setValue(this.titleValue);
      t.onChange((v) => (this.titleValue = v));
      t.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.submit();
        }
      });
      // Focus title for fast capture.
      setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName("Visibility").addDropdown((d) => {
      d.addOption("private", "private (default)");
      d.addOption("unlisted", "unlisted");
      d.addOption("public", "public");
      d.setValue(this.visibilityValue);
      d.onChange((v) => (this.visibilityValue = v as Visibility));
    });
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Create").setCta().onClick(() => this.submit()),
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()));
  }
  private submit(): void {
    const title = this.titleValue.trim();
    if (title.length === 0) return;
    this.resolve({ title, visibility: this.visibilityValue });
    this.resolve = () => undefined;
    this.close();
  }
  private cancel(): void {
    this.resolve(null);
    this.resolve = () => undefined;
    this.close();
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

function askNewPage(
  app: App,
  initialTitle = "",
): Promise<{ title: string; visibility: Visibility } | null> {
  return new Promise((resolve) => {
    new NewPageModal(app, initialTitle, resolve).open();
  });
}

// Shared write-and-open helper. Uses Obsidian's vault.create so the
// metadata cache picks up the file immediately.
async function writeNewPage(
  plugin: OakPlugin,
  args: { title: string; visibility: Visibility },
): Promise<void> {
  const composed = composePage({
    title: args.title,
    visibility: args.visibility,
  });
  const existing = plugin.app.vault.getAbstractFileByPath(composed.vaultRelPath);
  if (existing) {
    new Notice(`oak: page already exists at ${composed.vaultRelPath}`);
    return;
  }
  const file = await plugin.app.vault.create(composed.vaultRelPath, composed.text);
  if (file instanceof TFile) {
    await plugin.app.workspace.getLeaf(false).openFile(file);
  }
  new Notice(`oak: created ${composed.vaultRelPath}`);
  plugin.state.scheduleRefresh();
}

export async function createNewPage(plugin: OakPlugin): Promise<void> {
  const ans = await askNewPage(plugin.app);
  if (!ans) return;
  await writeNewPage(plugin, ans);
}

// Cut the editor's current selection out into a new oak page. The
// first non-blank line of the selection becomes the new page's title
// (with markdown decoration stripped); the remaining lines become the
// body. The selection in the source page is replaced with a wikilink
// to the new page so the structural reference stays in place.
export async function extractSelectionToPage(
  plugin: OakPlugin,
): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice("oak: open a markdown file first");
    return;
  }
  const editor = view.editor;
  const selection = editor.getSelection();
  if (selection.trim().length === 0) {
    new Notice("oak: nothing selected");
    return;
  }
  const { title, body, replacement } = extractFromSelection(selection);
  if (title.length === 0) {
    new Notice("oak: cannot derive a title from the selection");
    return;
  }
  let composed;
  try {
    composed = composePage({ title, body });
  } catch (err) {
    new Notice(`oak: extract failed — ${(err as Error).message}`);
    return;
  }
  const existing = plugin.app.vault.getAbstractFileByPath(composed.vaultRelPath);
  if (existing) {
    new Notice(`oak: page already exists at ${composed.vaultRelPath}`);
    return;
  }
  let file: TFile | null = null;
  try {
    const created = await plugin.app.vault.create(
      composed.vaultRelPath,
      composed.text,
    );
    if (created instanceof TFile) file = created;
  } catch (err) {
    new Notice(`oak: extract failed — ${(err as Error).message}`);
    return;
  }
  editor.replaceSelection(replacement);
  new Notice(`oak: extracted to ${composed.vaultRelPath}`);
  plugin.state.scheduleRefresh();
  if (file) {
    await plugin.app.workspace.getLeaf("tab").openFile(file);
  }
}

export async function createPageFromRedlink(plugin: OakPlugin): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  let initial = "";
  if (view) {
    const editor = view.editor;
    const pos = editor.getCursor();
    initial = findWikiTargetAtCursor(editor, pos) ?? "";
  }
  const ans = await askNewPage(plugin.app, initial);
  if (!ans) return;
  await writeNewPage(plugin, ans);
}

export async function runValidate(plugin: OakPlugin): Promise<void> {
  const root = vaultRoot(plugin.app);
  const vault = await parseVault(root);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);
  const { errors, warnings } = partitionIssues(issues);
  new Notice(`oak: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const e of errors.slice(0, 5)) {
    console.warn("oak validate:", e);
  }
}

export async function runSnapshot(plugin: OakPlugin): Promise<void> {
  const root = vaultRoot(plugin.app);
  const r = await snapshot(root);
  if (r.committed) {
    new Notice(`oak: snapshot ${r.hash?.slice(0, 7)}`);
  } else {
    new Notice("oak: no changes to snapshot");
  }
}

export async function runCheckpoint(plugin: OakPlugin): Promise<void> {
  const message = await askText(
    plugin.app,
    "Checkpoint message",
    "before agent run",
  );
  if (!message) return;
  const root = vaultRoot(plugin.app);
  const r = await checkpoint(root, message);
  if (r.committed) {
    new Notice(`oak: checkpoint ${r.hash?.slice(0, 7)} ${r.message}`);
  } else {
    new Notice("oak: no changes — checkpoint not recorded");
  }
}

// Scratch buffer — emacs `*scratch*` analogue. Lives at
// `scratch.md` (vault root) so Obsidian's indexed `vault.create` API
// can create and open it. The core indexer (parse.ts SYSTEM_ROOT_FILES)
// treats it as out-of-band so it stays out of search, graph, validation,
// and publish. Obsidian's autosave keeps content alive within a session;
// the "Clear scratch" command wipes it back to empty (after backing up
// the prior contents to `.oak/scratch.history/<ts>.md` so an accidental
// clear is recoverable). The buffer ships empty — the "scratch" identity
// is shown in the header link, not in the file body.

const SCRATCH_INITIAL = "";

export async function ensureScratchFile(app: App): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(SCRATCH_VAULT_REL_PATH);
  if (existing instanceof TFile) return existing;
  return await app.vault.create(SCRATCH_VAULT_REL_PATH, SCRATCH_INITIAL);
}

export async function openScratch(plugin: OakPlugin): Promise<void> {
  await plugin.toggleScratch();
}

function scratchHistoryName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`
  );
}

export async function clearScratch(plugin: OakPlugin): Promise<void> {
  let file: TFile;
  try {
    file = await ensureScratchFile(plugin.app);
  } catch (err) {
    new Notice(`oak: clear scratch failed — ${(err as Error).message}`);
    return;
  }
  const current = await plugin.app.vault.read(file);
  if (current.trim().length === 0) {
    new Notice("oak: scratch already empty");
    return;
  }
  // History lives under `.oak/scratch.history/` — a dotfile directory
  // Obsidian doesn't index, so we go through `vault.adapter` (the
  // raw filesystem layer) instead of the indexed `vault.create`.
  const adapter = plugin.app.vault.adapter;
  const backupPath = `${SCRATCH_HISTORY_REL_DIR}/${scratchHistoryName()}`;
  try {
    if (!(await adapter.exists(SCRATCH_HISTORY_REL_DIR))) {
      await adapter.mkdir(SCRATCH_HISTORY_REL_DIR);
    }
    await adapter.write(backupPath, current);
  } catch (err) {
    new Notice(`oak: scratch backup failed — ${(err as Error).message}`);
    return;
  }
  await plugin.app.vault.modify(file, SCRATCH_INITIAL);
  new Notice(`oak: scratch cleared (backup at ${backupPath})`);
}

// Render `20260508T123456.md` as `2026-05-08 12:34:56` for the
// history list. Falls back to the raw filename for anything that
// doesn't match the expected pattern.
function formatHistoryName(name: string): string {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.md$/);
  if (!m) return name;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// Browser of past scratch backups (`.oak/scratch.history/*.md`).
// Reads via `vault.adapter` because the directory is dotfile-prefixed
// and Obsidian's indexed API skips it. Selecting an entry previews
// the backup as plain text inside the modal; copy / restore wire
// the selected backup back out — copy to the clipboard, restore
// overwrites scratch.md (creating a fresh backup of the current
// content first via `clearScratch`'s logic isn't called: the user
// already knows they're discarding the live buffer, and the prior
// backup chain is intact).
class ScratchHistoryModal extends Modal {
  private entries: { path: string; name: string }[] = [];
  private selectedIdx = 0;
  private content = "";
  private listEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private copyBtn!: HTMLButtonElement;
  private restoreBtn!: HTMLButtonElement;

  constructor(private plugin: OakPlugin) {
    super(plugin.app);
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.classList.add("oak-scratch-history-modal");
    this.titleEl.textContent = "Scratch history";

    this.listEl = this.contentEl.createDiv({
      cls: "oak-scratch-history-list",
    });
    this.previewEl = this.contentEl.createDiv({
      cls: "oak-scratch-history-preview",
    });
    const actions = this.contentEl.createDiv({
      cls: "oak-scratch-history-actions",
    });
    this.copyBtn = actions.createEl("button", {
      text: "Copy",
      cls: "oak-scratch-history-action",
    });
    this.copyBtn.addEventListener("click", () => void this.copy());
    this.restoreBtn = actions.createEl("button", {
      text: "Restore",
      cls: "oak-scratch-history-action mod-cta",
    });
    this.restoreBtn.addEventListener("click", () => void this.restore());

    await this.load();
    this.renderList();
    if (this.entries.length > 0) {
      await this.select(0);
      // Focus the first item on open so j/k/arrow navigation works
      // immediately without an extra Tab press.
      this.focusItem(0);
    } else {
      this.renderPreview();
      this.refreshActions();
    }

    // Modal-level keyboard navigation. Capture phase so the keys
    // work no matter what's focused inside (list item, preview, or
    // one of the action buttons). Bindings:
    //   j / Ctrl+n / ArrowDown   move selection one entry down
    //   k / Ctrl+p / ArrowUp     move selection one entry up
    // Movement updates the preview *and* DOM focus, so the focus
    // ring tracks the active row.
    this.contentEl.addEventListener(
      "keydown",
      (ev) => this.handleNav(ev),
      true,
    );
  }

  private handleNav(ev: KeyboardEvent): void {
    if (this.entries.length === 0) return;
    const target = ev.target as HTMLElement | null;
    // Don't intercept while typing in a text field. There are none
    // in this modal today, but the guard is cheap insurance.
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      return;
    }
    let next: number | null = null;
    if (
      ev.key === "ArrowDown" ||
      ev.key === "j" ||
      (ev.ctrlKey && (ev.key === "n" || ev.key === "N"))
    ) {
      next = Math.min(this.selectedIdx + 1, this.entries.length - 1);
    } else if (
      ev.key === "ArrowUp" ||
      ev.key === "k" ||
      (ev.ctrlKey && (ev.key === "p" || ev.key === "P"))
    ) {
      next = Math.max(this.selectedIdx - 1, 0);
    }
    if (next === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (next === this.selectedIdx) {
      // Already at the edge — at least keep focus parked on the row
      // so a follow-up Enter / click still has somewhere to land.
      this.focusItem(next);
      return;
    }
    // `select` re-renders the list and re-focuses the selected row.
    void this.select(next);
  }

  private async load(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(SCRATCH_HISTORY_REL_DIR))) {
      this.entries = [];
      return;
    }
    const listing = await adapter.list(SCRATCH_HISTORY_REL_DIR);
    this.entries = (listing.files ?? [])
      .filter((p: string) => p.endsWith(".md"))
      .map((p: string) => ({ path: p, name: p.split("/").pop() ?? p }))
      // Newest first: filenames are zero-padded timestamps so
      // descending lexicographic == descending chronological.
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.entries.length === 0) {
      this.listEl.createDiv({
        cls: "oak-scratch-history-empty",
        text: "(no backups yet — clear scratch to record one)",
      });
      return;
    }
    this.entries.forEach((e, i) => {
      const item = this.listEl.createDiv({
        cls: "oak-scratch-history-item",
        text: formatHistoryName(e.name),
      });
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      if (i === this.selectedIdx) item.classList.add("is-selected");
      item.addEventListener("click", () => void this.select(i));
      item.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void this.select(i);
        }
        // ArrowUp/Down + j/k + Ctrl+n/p are handled at modal level
        // (capture phase) so they work from anywhere in the dialog.
      });
    });
  }

  private focusItem(idx: number): void {
    const items = this.listEl.querySelectorAll<HTMLElement>(
      ".oak-scratch-history-item",
    );
    items[idx]?.focus();
  }

  private renderPreview(): void {
    this.previewEl.empty();
    if (this.entries.length === 0) {
      this.previewEl.classList.add("is-empty");
      this.previewEl.textContent = "";
      return;
    }
    this.previewEl.classList.remove("is-empty");
    const pre = this.previewEl.createEl("pre", {
      cls: "oak-scratch-history-content",
    });
    pre.textContent = this.content;
  }

  private refreshActions(): void {
    const hasSelection = this.entries.length > 0;
    this.copyBtn.disabled = !hasSelection;
    this.restoreBtn.disabled = !hasSelection;
  }

  private async select(idx: number): Promise<void> {
    this.selectedIdx = idx;
    const entry = this.entries[idx];
    if (!entry) {
      this.content = "";
    } else {
      try {
        this.content = await this.plugin.app.vault.adapter.read(entry.path);
      } catch (err) {
        this.content = "";
        new Notice(
          `oak: failed to read backup — ${(err as Error).message}`,
        );
      }
    }
    this.renderList();
    this.renderPreview();
    this.refreshActions();
    // `renderList` rebuilds the DOM so the previously-focused item
    // is gone. Re-focus the selected row so keyboard navigation
    // stays parked on the active entry.
    this.focusItem(idx);
  }

  private async copy(): Promise<void> {
    if (this.entries.length === 0) return;
    try {
      await navigator.clipboard.writeText(this.content);
      new Notice("oak: copied scratch backup");
    } catch (err) {
      new Notice(`oak: copy failed — ${(err as Error).message}`);
    }
  }

  private async restore(): Promise<void> {
    if (this.entries.length === 0) return;
    try {
      const file = await ensureScratchFile(this.plugin.app);
      await this.plugin.app.vault.modify(file, this.content);
      new Notice("oak: scratch restored from backup");
      this.close();
    } catch (err) {
      new Notice(`oak: restore failed — ${(err as Error).message}`);
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export async function openScratchHistory(plugin: OakPlugin): Promise<void> {
  new ScratchHistoryModal(plugin).open();
}

// Editor entrypoint for `oak-refile`. Resolves the cursor position to
// the immediately enclosing heading (any heading — TODO state, planning
// line, and active timestamp are NOT required, mirroring emacs
// `org-refile` which works on any heading). Returns null when the
// cursor sits in frontmatter or above the first heading.
export function findHeadingAtCursor(
  raw: string,
  cursorFileLine: number,
): { line: number; level: number; title: string } | null {
  const fmLines = frontmatterLineCount(raw);
  const cursorBodyLine = cursorFileLine - fmLines + 1;
  if (cursorBodyLine < 1) return null;
  const body = raw.split("\n").slice(fmLines).join("\n");
  return findEnclosingHeading(body, cursorBodyLine);
}

export async function runRefileFromEditor(plugin: OakPlugin): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || !view.file) {
    new Notice("oak: open a markdown file first");
    return;
  }
  const editor = view.editor;
  // Capture the source-is-peek flag synchronously, BEFORE any await.
  // A transient closeRefilePeek (auto-close on focus shift, Esc) can
  // null the plugin's `refilePeekLeaf` mid-flow; this snapshot
  // preserves the truth as seen at command-start time so the peek
  // promotion logic still fires.
  const sourceLeaf = view.leaf;
  const isPeekSource = sourceLeaf === plugin.peekLeaf();
  const raw = await plugin.app.vault.cachedRead(view.file);
  const filePath = `${vaultRoot(plugin.app)}/${view.file.path}`;
  const relPath = view.file.path;

  // Multi-section path: when the user has a non-empty selection that
  // spans two or more headings' subtrees, refile all of them to one
  // user-picked destination. A 0- or 1-heading selection falls back
  // to the cursor-based single-heading flow so a casual selection of
  // a body line still does the obvious thing.
  if (editor.somethingSelected()) {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const headings = findHeadingsInEditorSelection(raw, from, to);
    if (headings.length >= 2) {
      await refileHeadings(
        plugin,
        headings.map((h) => ({
          filePath,
          relPath,
          line: h.line,
          level: h.level,
          title: h.title,
        })),
        plugin.refileConfig,
        plugin.agendaConfig,
        { sourceLeaf, isPeekSource },
      );
      return;
    }
  }

  const cursor = editor.getCursor();
  const heading = findHeadingAtCursor(raw, cursor.line);
  if (!heading) {
    new Notice("oak: place the cursor inside a heading to refile");
    return;
  }
  await refileHeading(
    plugin,
    {
      filePath,
      relPath,
      line: heading.line,
      level: heading.level,
      title: heading.title,
    },
    plugin.refileConfig,
    plugin.agendaConfig,
    { sourceLeaf, isPeekSource },
  );
}

// Confirmation dialog for the frontmatter migration. The plan is
// computed up-front with a dry-run pass so the user sees exactly
// which pages move and what fields will be added before any file is
// rewritten. Apply re-runs the migration without dry-run; we don't
// reuse the dry-run text because the second pass may pick up files
// that landed between the two runs (a long-running session may sit
// on this modal for a while).
class MigrateFrontmatterModal extends Modal {
  constructor(
    app: App,
    private plan: FrontmatterMigrationReport,
    private resolve: (apply: boolean) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: "Migrate frontmatter" });
    this.contentEl.createEl("p", {
      text:
        `${this.plan.changed} page(s) will be upgraded ` +
        `(${this.plan.unchanged} already current, ${this.plan.scanned} scanned).`,
    });
    if (this.plan.entries.length > 0) {
      const list = this.contentEl.createEl("ul");
      list.style.maxHeight = "16em";
      list.style.overflowY = "auto";
      for (const entry of this.plan.entries.slice(0, 50)) {
        const parts: string[] = [`v${entry.fromVersion}→v${entry.toVersion}`];
        if (entry.added.created !== undefined) {
          parts.push(`+created=${entry.added.created}`);
        }
        if (entry.added.modified !== undefined) {
          parts.push(`+modified=${entry.added.modified}`);
        }
        list.createEl("li", {
          text: `${entry.relPath}  ${parts.join(" ")}`,
        });
      }
      if (this.plan.entries.length > 50) {
        this.contentEl.createEl("p", {
          text: `…and ${this.plan.entries.length - 50} more.`,
        });
      }
    }
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText("Apply")
          .setCta()
          .onClick(() => this.finish(true)),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.finish(false)),
      );
  }
  private finish(apply: boolean): void {
    this.resolve(apply);
    this.resolve = () => undefined;
    this.close();
  }
  override onClose(): void {
    this.contentEl.empty();
    this.resolve(false);
    this.resolve = () => undefined;
  }
}

export async function runMigrateFrontmatter(plugin: OakPlugin): Promise<void> {
  const root = vaultRoot(plugin.app);
  let plan: FrontmatterMigrationReport;
  try {
    plan = await migrateFrontmatter({ vaultRoot: root, dryRun: true });
  } catch (err) {
    new Notice(`oak: migrate plan failed — ${(err as Error).message}`);
    return;
  }
  if (plan.changed === 0) {
    new Notice(
      `oak: migrate frontmatter — all ${plan.scanned} page(s) at latest version`,
    );
    return;
  }
  const apply = await new Promise<boolean>((resolve) => {
    new MigrateFrontmatterModal(plugin.app, plan, resolve).open();
  });
  if (!apply) return;
  try {
    const report = await migrateFrontmatter({ vaultRoot: root });
    new Notice(
      `oak: migrated ${report.changed} page(s) ` +
        `(${report.unchanged} unchanged, ${report.scanned} scanned)`,
    );
    plugin.state.scheduleRefresh();
  } catch (err) {
    new Notice(`oak: migrate failed — ${(err as Error).message}`);
  }
}

export async function runMount(plugin: OakPlugin): Promise<void> {
  const ans = await askTwo(
    plugin.app,
    "Mount external directory",
    "Mount id (e.g. codebase)",
    "Absolute path on disk",
  );
  if (!ans) return;
  try {
    const root = vaultRoot(plugin.app);
    const entry = await addMount(root, { id: ans.a, target: ans.b });
    new Notice(`oak: mounted ${entry.id} at ${entry.linkPath}`);
    plugin.state.scheduleRefresh();
  } catch (err) {
    new Notice(`oak: mount failed — ${(err as Error).message}`);
  }
}

