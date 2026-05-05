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
import { ulid } from "ulid";
import {
  addMount,
  buildGraph,
  checkpoint,
  parseVault,
  partitionIssues,
  publish,
  PublishError,
  snapshot,
  validateVault,
  type Visibility,
} from "@oak/core";

import type OakPlugin from "./main.js";
import { vaultRoot } from "./paths.js";

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

import { findWikiTargetInLine } from "./wiki-cursor.js";

function findWikiTargetAtCursor(
  editor: Editor,
  pos: EditorPosition,
): string | null {
  return findWikiTargetInLine(editor.getLine(pos.line), pos.ch);
}

export async function createPageFromRedlink(plugin: OakPlugin): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  let target: string | null = null;
  if (view) {
    const editor = view.editor;
    const pos = editor.getCursor();
    target = findWikiTargetAtCursor(editor, pos);
  }
  if (!target) {
    target = await askText(
      plugin.app,
      "Create new oak page",
      "Page title",
    );
  }
  if (!target) return;

  const safe = target.replace(/[\/\\:*?"<>|]/g, "-");
  const path = `${safe}.md`;
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing) {
    new Notice(`oak: page already exists at ${path}`);
    return;
  }
  const id = ulid();
  const body = `---\nid: ${id}\ntitle: ${target}\nvisibility: private\n---\n\n`;
  const file = await plugin.app.vault.create(path, body);
  if (file instanceof TFile) {
    await plugin.app.workspace.getLeaf(false).openFile(file);
  }
  new Notice(`oak: created ${path}`);
  plugin.state.scheduleRefresh();
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

export async function runPublish(plugin: OakPlugin): Promise<void> {
  const root = vaultRoot(plugin.app);
  try {
    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const issues = validateVault(vault, graph);
    // Per directive: checkpoint before publish.
    await checkpoint(root, "before publish");
    const stats = await publish(vault, graph, issues, {
      baseUrl: plugin.settings.baseUrl,
    });
    new Notice(
      `oak: published ${stats.pages.length} page(s), ${stats.assets.length} asset(s)`,
    );
  } catch (err) {
    if (err instanceof PublishError) {
      new Notice(`oak: publish blocked (${err.issues.length} error(s))`);
      for (const i of err.issues) console.warn("oak publish:", i);
      return;
    }
    new Notice(`oak: publish failed — ${(err as Error).message}`);
    console.error(err);
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

