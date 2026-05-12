// Plugin entry point.
//
// Lifecycle:
//   1. onload: initialise state, register sidebar view + commands +
//      file-event listeners. Optionally start the auto-snapshot timer.
//   2. onunload: dispose of state and timers. Obsidian unregisters
//      events automatically via `registerEvent`.

import {
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  Scope,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

import {
  DEFAULT_SETTINGS,
  OakSettingTab,
  type OakPluginSettings,
} from "./settings.js";
import { VaultState, type VaultSnapshot } from "./state.js";
import { OakSidebarView, VIEW_TYPE_OAK } from "./views/sidebar.js";
import { OakHomeView, VIEW_TYPE_OAK_HOME } from "./views/home.js";
import { OakGhostView, VIEW_TYPE_OAK_GHOST } from "./views/ghost.js";
import { OakAgendaView, VIEW_TYPE_OAK_AGENDA } from "./views/agenda.js";
import { OakSearchView, VIEW_TYPE_OAK_SEARCH } from "./views/search.js";
import {
  OakRefilePickerView,
  VIEW_TYPE_OAK_REFILE_PICKER,
  type RefilePickerInit,
} from "./views/refile-picker.js";
import {
  clearScratch,
  createNewPage,
  createPageFromRedlink,
  deleteCurrentFile,
  deleteFile,
  ensureScratchFile,
  extractSelectionToPage,
  openScratch,
  openScratchHistory,
  runCheckpoint,
  runMigrateFrontmatter,
  runMount,
  runRefileFromEditor,
  runSnapshot,
  runValidate,
  setVisibility,
} from "./commands.js";
import { openOakCommandPalette } from "./command-palette.js";
import {
  composePage,
  DEFAULT_AGENDA_CONFIG,
  DEFAULT_REFILE_CONFIG,
  ensureGitRepo,
  excerptFrom,
  loadAgendaConfig,
  loadRefileConfig,
  nowIsoSecond,
  pullRebase,
  recoverCreatedTimestamp,
  setCreatedIfMissing,
  setModified,
  shouldBumpModified,
  slugify,
  snapshot,
  type AgendaConfig,
  type OakPage,
  type RefileConfig,
  type RefileTarget,
} from "@oak/core";
import { agendaTooltipExtension } from "./agenda-tooltip.js";
import { headingDecorationsExtension } from "./heading-decorations.js";
import { headingMarkersExtension } from "./heading-markers.js";
import { describeBacklinks, describeTwoHop } from "./format.js";
import { ensureBlankAfterFrontmatter } from "./frontmatter-normalize.js";
import { SCRATCH_VAULT_REL_PATH, vaultRoot } from "./paths.js";
import type { OakOpenFile } from "./open-file.js";
import { commitTitleChange } from "./title-commit.js";

export default class OakPlugin extends Plugin {
  settings: OakPluginSettings = DEFAULT_SETTINGS;
  state!: VaultState;

  // Pending debounced snapshot. Set by `bumpAutoSnapshot` on each
  // vault edit, fired once the editor has been quiet for
  // `autoSnapshotIntervalMs`. While the user is actively typing,
  // the timer keeps getting pushed forward so we never snapshot
  // mid-edit.
  private autoSnapshotHandle: ReturnType<typeof setTimeout> | null = null;
  private sidebarRef: OakSidebarView | null = null;
  private linksUnsubscribe: (() => void) | null = null;
  // Live copy of `.oak/agenda.yml`. Used by editor extensions (e.g. the
  // SCHEDULED/DEADLINE tooltip) that need to know the active TODO
  // keyword set without re-reading the file on every keystroke.
  agendaConfig: AgendaConfig = DEFAULT_AGENDA_CONFIG;
  // Live copy of `.oak/refile.yml`. Refile is its own feature with its
  // own config (heading-level conventions for top-of-file refile and
  // similar knobs); kept on the plugin so command callbacks pick up
  // edits on the next vault refresh without re-reading on every call.
  refileConfig: RefileConfig = DEFAULT_REFILE_CONFIG;
  // Last redlink target the user clicked plus when. Used by the
  // vault.on("create") fallback to detect a file that Obsidian
  // auto-created in response to the click and roll it back into a
  // ghost view.
  private lastRedlinkTarget: string | null = null;
  private lastRedlinkClickAt = 0;
  // Reused horizontal-split leaf used to peek at the destination file
  // after a refile. Mirrors the scratch toggle: focus stays on the
  // source so a follow-up refile can run immediately, and the peek
  // pane updates in place instead of stacking new splits.
  private refilePeekLeaf: WorkspaceLeaf | null = null;
  // The leaf the current peek was split from. We hang onto it so a
  // peek-to-peek refile (the user refiles again while focused inside
  // the peek) can promote the peek's file back into this main slot
  // — keeping the "source-of-refile = main, destination = peek"
  // invariant after every hop. Cleared when the peek closes, and not
  // persisted: a workspace reload starts from a clean peek.
  private refilePeekBaseLeaf: WorkspaceLeaf | null = null;
  // Tracks whether the user has actually focused the peek pane at
  // least once. We only auto-close on focus-leave once the user has
  // engaged with the peek — otherwise the peek would dismiss itself
  // immediately on creation (the source leaf retains focus by
  // design).
  private refilePeekEngaged = false;
  // Suppresses the peek auto-close during the setup phase of
  // openRefilePicker. The promote dance calls
  // `setActiveLeaf(mainLeaf)` to force the source-file swap, which
  // fires active-leaf-change and would otherwise trigger
  // closeRefilePeek (the leaf we're about to turn into the picker).
  // We hold the gate only across setup; once the picker view is up
  // and waiting for input, the gate releases so click-elsewhere can
  // dismiss the picker normally.
  private refilePickerSettingUp = 0;
  // When the user picks "Show default menu" from the oak context
  // menu, we re-dispatch a fresh `contextmenu` event so Obsidian's
  // own handler runs and shows the native menu. This flag tells our
  // capture-phase listener to wave that re-dispatch through.
  private oakContextmenuBypass = false;
  // Per-path snapshot of the last content we observed (after our own
  // modified-bump, when applicable). The vault.on("modify") handler
  // diffs the live content against this baseline to decide whether a
  // save warrants bumping `modified`. Without a baseline we can't tell
  // a body edit apart from a metadata tweak — so the very first
  // modify after plugin load just primes the entry and skips the
  // bump. Memory cost grows only with the set of files actually
  // edited in the session.
  private lastSeenContent = new Map<string, string>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.state = new VaultState(this.app);

    // Make sure the vault has a git repo + managed gitignore. Do not
    // wait on it — Obsidian shouldn't block on git for a plain note open.
    void this.ensureGitInBackground();

    const openFile: OakOpenFile = (file, opts) =>
      this.openInBrowseLeaf(file, opts ?? {});

    this.registerView(VIEW_TYPE_OAK, (leaf: WorkspaceLeaf) => {
      const view = new OakSidebarView(leaf, this.state, this.app);
      this.sidebarRef = view;
      return view;
    });
    this.registerView(VIEW_TYPE_OAK_HOME, (leaf: WorkspaceLeaf) => {
      return new OakHomeView(
        leaf,
        this.state,
        this.app,
        openFile,
        () => this.toggleOakMode(),
        {
          get: () => this.settings.autoSnapshotIntervalMs,
          set: async (ms) => {
            this.settings.autoSnapshotIntervalMs = ms;
            await this.saveSettings();
          },
        },
      );
    });
    this.registerView(VIEW_TYPE_OAK_GHOST, (leaf: WorkspaceLeaf) => {
      return new OakGhostView(
        leaf,
        this.state,
        this.app,
        (target, hostLeaf) => this.materialiseGhost(target, hostLeaf),
        async (page, newTab) => {
          const file = this.app.vault.getAbstractFileByPath(page.relPath);
          if (file instanceof TFile) {
            await this.openInBrowseLeaf(file, { newTab });
          }
        },
      );
    });
    this.registerView(VIEW_TYPE_OAK_AGENDA, (leaf: WorkspaceLeaf) => {
      return new OakAgendaView(leaf, this.state, this.app, openFile, this);
    });
    this.registerView(VIEW_TYPE_OAK_SEARCH, (leaf: WorkspaceLeaf) => {
      return new OakSearchView(
        leaf,
        this.state,
        this.app,
        openFile,
        () => this.navigateLeafBack(),
      );
    });
    this.registerView(VIEW_TYPE_OAK_REFILE_PICKER, (leaf: WorkspaceLeaf) => {
      return new OakRefilePickerView(leaf, this);
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
      this.app.vault.on("modify", (file) => {
        this.state.scheduleRefresh();
        if (file instanceof TFile && file.extension === "md") {
          void this.normalizeFrontmatterSeparator(file);
          void this.maybeBumpModified(file);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.lastSeenContent.delete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const prev = this.lastSeenContent.get(oldPath);
        this.lastSeenContent.delete(oldPath);
        if (prev !== undefined && file instanceof TFile) {
          this.lastSeenContent.set(file.path, prev);
        }
      }),
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
    // Auto-snapshot is debounced on vault activity: each edit pushes
    // the snapshot timer forward so it only fires once the editor
    // has been quiet for `autoSnapshotIntervalMs`.
    this.registerEvent(
      this.app.vault.on("modify", () => this.bumpAutoSnapshot()),
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.bumpAutoSnapshot()),
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.bumpAutoSnapshot()),
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.bumpAutoSnapshot()),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (newLeaf) => {
        const file = this.app.workspace.getActiveFile();
        const tfile = file instanceof TFile ? file : null;
        this.sidebarRef?.setActiveFile(tfile);
        this.handleActiveLeafChangeForPeek(newLeaf);
      }),
    );
    // Mode is defined by oak-leaf presence: any layout change re-syncs
    // the body class so a manual close (or workspace state restoration
    // after reload) keeps the chrome consistent.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncOakModeClass();
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
        this.applyHomeButton();
        this.applyAgendaButton();
        this.applySearchButton();
        this.applyActionsMenu();
        this.applyCenteredViewTitle();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
        this.applyHomeButton();
        this.applyAgendaButton();
        this.applySearchButton();
        this.applyActionsMenu();
        this.applyCenteredViewTitle();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.applyTitleOverrides();
        this.applyLinksCards();
        this.applyPageMeta();
      }),
    );
    // Vault state refresh -> backlinks/2-hop change -> rerender cards
    // and meta panel.
    this.linksUnsubscribe = this.state.subscribe(() => {
      this.applyLinksCards();
      this.applyPageMeta();
      // The user may have edited `.oak/agenda.yml` (TODO keywords,
      // etc.) or `.oak/refile.yml` (top-of-file level, etc.); pick
      // those up on the next vault refresh.
      void this.refreshAgendaConfig();
      void this.refreshRefileConfig();
    });

    // Intercept red-link clicks while in oak mode and route them to
    // the ghost view instead of letting Obsidian create the file.
    // Capture phase so we win over Obsidian's bubble-phase handler.
    this.registerDomEvent(
      document,
      "click",
      (ev) => this.maybeInterceptRedlinkClick(ev),
      { capture: true },
    );
    this.registerDomEvent(
      document,
      "mousedown",
      (ev) => this.maybeInterceptRedlinkClick(ev),
      { capture: true },
    );

    // Fallback: Live Preview registers its click handler inside
    // CodeMirror, where document-level capture doesn't always reach
    // first. If a file gets auto-created for the target the user
    // just clicked, undo the create and route into the Ghost View
    // after the fact.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;
        if (!document.body.classList.contains("oak-mode-active")) return;
        if (!this.lastRedlinkTarget) return;
        const ageMs = Date.now() - this.lastRedlinkClickAt;
        if (ageMs > 800) return;
        // Match the basename to the click target. Obsidian uses the
        // raw target as the basename for redlink-creates.
        const target = this.lastRedlinkTarget;
        if (file.basename !== target) return;
        // Guard: only act on empty (or just-created) files; refuse
        // to delete anything that's already got content.
        if (file.stat.size > 0) return;
        this.lastRedlinkTarget = null;
        void this.rollbackAutoCreatedRedlink(file, target);
      }),
    );

    this.addCommand({
      id: "oak-toggle-mode",
      name: "Toggle oak mode",
      callback: () => void this.toggleOakMode(),
    });
    this.addCommand({
      id: "oak-command-palette",
      name: "Open oak command palette",
      callback: () => openOakCommandPalette(this.app),
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
      id: "oak-extract-selection",
      name: "Extract selection to new page",
      editorCheckCallback: (checking, editor) => {
        if (editor.getSelection().trim().length === 0) return false;
        if (!checking) void extractSelectionToPage(this);
        return true;
      },
    });
    // In oak mode, replace Obsidian's editor right-click menu with a
    // bespoke one — capture-phase `contextmenu` plus `preventDefault`
    // suppresses the native menu entirely, then we show our own with
    // only oak entries.
    this.registerDomEvent(
      document,
      "contextmenu",
      (ev) => this.maybeShowOakEditorMenu(ev),
      { capture: true },
    );
    // Same idea for Mod+P: in oak mode, the system command palette gets
    // pre-empted by our oak-only palette. Raw keydown listeners (even at
    // window-capture) can't preempt Obsidian's own hotkey dispatcher —
    // its listener was registered first, runs first, and opens the
    // system palette before our handler gets a chance. Instead we push
    // a scope onto `app.keymap`, so when Obsidian's dispatcher walks
    // the scope chain it hits our `Mod+P` handler at the top of the
    // stack and never gets to the built-in `command-palette:open`
    // binding. Returning `false` calls preventDefault and stops further
    // dispatch in the scope chain. When oak mode is off we return
    // `undefined` so the dispatcher falls through to the parent scope.
    // The oak palette itself carries an "Open system command palette…"
    // escape hatch for the times the full set is needed.
    const oakKeyScope = new Scope(this.app.scope);
    oakKeyScope.register(["Mod"], "p", (ev) => {
      if (!document.body.classList.contains("oak-mode-active")) return;
      ev.preventDefault();
      openOakCommandPalette(this.app);
      return false;
    });
    // Same hijack pattern for Mod+N: Obsidian's "Create new note" runs
    // off the same dispatcher chain, so a scope-level binding wins
    // over it while oak mode is active. The oak version routes through
    // `createNewPage` (frontmatter + slug + visibility-aware) instead
    // of dropping a blank `Untitled.md` in the vault root.
    oakKeyScope.register(["Mod"], "n", (ev) => {
      if (!document.body.classList.contains("oak-mode-active")) return;
      ev.preventDefault();
      void createNewPage(this);
      return false;
    });
    this.app.keymap.pushScope(oakKeyScope);
    this.register(() => this.app.keymap.popScope(oakKeyScope));
    this.addCommand({
      id: "oak-validate",
      name: "Validate vault",
      callback: () => void runValidate(this),
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
    this.addCommand({
      id: "oak-migrate-frontmatter",
      name: "Migrate frontmatter…",
      callback: () => void runMigrateFrontmatter(this),
    });
    this.addCommand({
      id: "oak-agenda",
      name: "Open agenda",
      callback: () => void this.openAgenda(),
    });
    this.addCommand({
      id: "oak-refile",
      name: "Refile heading at cursor",
      callback: () => void runRefileFromEditor(this),
    });
    this.addCommand({
      id: "oak-search",
      name: "Search vault",
      callback: () => void this.openSearch(),
    });
    this.addCommand({
      id: "oak-open-scratch",
      name: "Toggle scratch",
      hotkeys: [{ modifiers: ["Alt"], key: "s" }],
      callback: () => void openScratch(this),
    });
    this.addCommand({
      id: "oak-clear-scratch",
      name: "Clear scratch",
      callback: () => void clearScratch(this),
    });
    this.addCommand({
      id: "oak-delete-file",
      name: "Delete current file…",
      callback: () => void deleteCurrentFile(this),
    });

    // Editor surface: SCHEDULED/DEADLINE tooltip on TODO heading lines.
    // Reads `todoKeywords` lazily so changes to .oak/agenda.yml take
    // effect on the next state refresh without re-registering the
    // extension.
    this.registerEditorExtension(
      agendaTooltipExtension({
        todoKeywords: () => this.agendaConfig.todoKeywords,
        weekStartsOn: () => this.agendaConfig.weekStartsOn,
      }),
    );
    // Inline highlight for TODO / DONE keywords + `[#A]` priority
    // cookies inside markdown headings. Pure overlay: never mutates
    // the underlying text so editing, search, and the agenda parser
    // all see the literal heading.
    this.registerEditorExtension(
      headingDecorationsExtension({
        todoKeywords: () => this.agendaConfig.todoKeywords,
        doneKeywords: () => this.agendaConfig.doneKeywords,
      }),
    );
    // Keep `#` heading markers visible (and copyable) on inactive
    // lines too — overrides Obsidian's Live Preview hider so the
    // raw markdown stays selectable text instead of being replaced
    // by a hidden widget.
    this.registerEditorExtension(headingMarkersExtension());

    this.addSettingTab(new OakSettingTab(this.app, this));

    // Initial parse + auto-snapshot setup happen after layout is ready
    // so the active file detection works on the first sidebar render.
    this.app.workspace.onLayoutReady(() => {
      void this.state.refresh();
      void this.refreshAgendaConfig();
      void this.refreshRefileConfig();
      this.applyAutoSnapshot();
      // If a previous session left oak views in the workspace state,
      // Obsidian has just re-instantiated them. Re-attach the chrome
      // class so oak mode visually resumes where the user left off.
      this.syncOakModeClass();
      // Discard any peek leaf left over from the previous session
      // *before* the chrome appliers run, so applyTitleForView never
      // sees a stale `isRefilePeek` candidate. (Peek state is
      // session-local and the saved id is only useful as an orphan
      // marker — see settings.refilePeekLeafId.)
      this.discardOrphanedPeekLeaf();
      this.applyTitleOverrides();
      this.applyLinksCards();
      this.applyPageMeta();
      this.applyHomeButton();
      this.applyAgendaButton();
      this.applySearchButton();
      this.applyActionsMenu();
      this.applyCenteredViewTitle();
    });
  }

  override onunload(): void {
    if (this.autoSnapshotHandle) clearTimeout(this.autoSnapshotHandle);
    this.autoSnapshotHandle = null;
    this.linksUnsubscribe?.();
    this.linksUnsubscribe = null;
    this.state?.dispose();
    // Clear the body class so disabling the plugin (or reloading) can
    // never leave other ribbon icons hidden.
    document.body.removeClass("oak-mode-active");
    // And drop any oak title overrides + footer cards / meta + the
    // home button from open views so they return to Obsidian's
    // defaults.
    this.applyTitleOverrides();
    this.applyLinksCards();
    this.applyPageMeta();
    this.applyHomeButton();
    this.applyAgendaButton();
    this.applySearchButton();
    this.applyActionsMenu();
    this.applyCenteredViewTitle();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...(raw as Partial<OakPluginSettings>) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyAutoSnapshot();
  }

  // Reset the debounced snapshot timer to match the current settings.
  // Called on plugin load and whenever settings change. When enabled,
  // arm the timer immediately so a snapshot fires after the configured
  // idle period even without a subsequent vault edit — otherwise a
  // user who toggles auto-snapshot on (e.g. from the home view) and
  // then stays idle would never see a commit.
  applyAutoSnapshot(): void {
    if (this.autoSnapshotHandle) clearTimeout(this.autoSnapshotHandle);
    this.autoSnapshotHandle = null;
    this.bumpAutoSnapshot();
  }

  // Called from every vault edit (modify / create / delete / rename).
  // Resets the debounce window so the snapshot only fires once the
  // editor has been quiet for the configured interval.
  bumpAutoSnapshot(): void {
    const ms = this.settings.autoSnapshotIntervalMs;
    if (!ms || ms <= 0) return;
    if (this.autoSnapshotHandle) clearTimeout(this.autoSnapshotHandle);
    this.autoSnapshotHandle = setTimeout(() => {
      this.autoSnapshotHandle = null;
      void this.runAutoSnapshot();
    }, ms);
  }

  // Auto-snapshot fire: commit any pending local edits, pull remote
  // changes on top, then refresh any open home views so their Git
  // inspector reflects the new HEAD. Pull runs unconditionally — even
  // when nothing was committed — so a vault synced across machines
  // picks up external commits during the same idle window.
  private async runAutoSnapshot(): Promise<void> {
    const root = vaultRoot(this.app);
    try {
      await snapshot(root);
    } catch (err) {
      console.warn("oak auto-snapshot failed:", err);
    }
    try {
      const r = await pullRebase(root);
      if (r.attempted && !r.ok) {
        console.warn("oak auto-snapshot pull --rebase failed:", r.details);
      }
    } catch (err) {
      console.warn("oak auto-snapshot pull --rebase failed:", err);
    }
    this.refreshHomeViews();
  }

  private refreshHomeViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK_HOME);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof OakHomeView) {
        void view.refreshGit();
      }
    }
  }

  private async refreshAgendaConfig(): Promise<void> {
    try {
      this.agendaConfig = await loadAgendaConfig(vaultRoot(this.app));
    } catch (err) {
      console.warn("oak: loadAgendaConfig failed", err);
      this.agendaConfig = DEFAULT_AGENDA_CONFIG;
    }
  }

  private async refreshRefileConfig(): Promise<void> {
    try {
      this.refileConfig = await loadRefileConfig(vaultRoot(this.app));
    } catch (err) {
      console.warn("oak: loadRefileConfig failed", err);
      this.refileConfig = DEFAULT_REFILE_CONFIG;
    }
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
  //   plain click       reuse the currently-focused main-pane leaf
  //                     so the click replaces in place (browser-tab
  //                     semantics; combined with leaf history, ←
  //                     walks back to where the user came from).
  //   Cmd / Ctrl click  always open a new tab.
  async openInBrowseLeaf(
    file: TFile,
    opts: { newTab?: boolean; line?: number } = {},
  ): Promise<void> {
    const leaf = opts.newTab
      ? this.app.workspace.getLeaf("tab")
      : this.currentMainLeaf();
    // Forward `line` as `eState.line` so Obsidian scrolls/centers the
    // viewport on the heading we want, including in reading mode where
    // we have no editor handle to call `setCursor` on.
    const openState =
      opts.line !== undefined ? { eState: { line: opts.line } } : undefined;
    await leaf.openFile(file, openState);
    this.app.workspace.revealLeaf(leaf);
  }

  // Most-recent leaf in the rootSplit (sidebars excluded). Falls
  // back to a fresh tab if the workspace somehow has no eligible
  // leaf — shouldn't happen in oak mode but keeps the call total.
  private currentMainLeaf(): WorkspaceLeaf {
    const recent = this.app.workspace.getMostRecentLeaf();
    return recent ?? this.app.workspace.getLeaf("tab");
  }

  private isLeafAlive(leaf: WorkspaceLeaf): boolean {
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) alive = true;
    });
    return alive;
  }

  // Intercept clicks on internal-link surfaces (reading mode and
  // live preview) while oak mode is active. If the target doesn't
  // resolve to an existing file, route into the Ghost View instead
  // of letting Obsidian create the file as a side effect.
  //
  // The selector intentionally casts a wide net (different surfaces
  // use different classes; some don't expose `data-href` at all) and
  // we filter by metadataCache resolution to confirm the target is
  // actually unresolved.
  private maybeInterceptRedlinkClick(ev: MouseEvent): void {
    if (!document.body.classList.contains("oak-mode-active")) return;
    const t = ev.target as HTMLElement | null;
    if (!t) return;

    const link = t.closest<HTMLElement>(
      "a.internal-link, span.cm-hmd-internal-link, [data-href]",
    );
    if (!link) return;

    const href =
      link.getAttribute("data-href") ??
      link.getAttribute("href") ??
      link.textContent ??
      "";
    const target = href.split("#")[0]!.split("|")[0]!.trim();
    if (target.length === 0) return;

    const sourcePath =
      this.app.workspace.getActiveFile()?.path ?? "";
    const file = this.app.metadataCache.getFirstLinkpathDest(
      target,
      sourcePath,
    );
    if (file) return; // resolved — let Obsidian handle normally

    // Even if our preventDefault doesn't cleanly stop Obsidian's
    // own click handler (Live Preview registers in CodeMirror, not
    // on the document), record the target so the create-event
    // fallback below can roll the auto-created file back into a
    // ghost view.
    this.lastRedlinkTarget = target;
    this.lastRedlinkClickAt = Date.now();

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    void this.openGhostView(target, ev.metaKey || ev.ctrlKey);
  }

  // In oak mode, suppress the native Obsidian editor context menu and
  // show a bespoke one whose only entries are oak commands. The
  // capture-phase listener fires before Obsidian's own contextmenu
  // handler, so `preventDefault` actually blocks the native menu.
  //
  // The last entry (`Show default menu`) re-dispatches a fresh
  // contextmenu event with `oakContextmenuBypass` set, so the user
  // can fall back to Obsidian's native menu when they want it.
  //
  // Scope: only the editing surface (`.cm-content`, source / live
  // preview). Reading view, sidebars, and other UI keep their native
  // menus untouched.
  private maybeShowOakEditorMenu(ev: MouseEvent): void {
    if (this.oakContextmenuBypass) {
      this.oakContextmenuBypass = false;
      return;
    }
    if (!document.body.classList.contains("oak-mode-active")) return;
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    if (!t.closest(".cm-content")) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor.getSelection() ?? "";
    const hasSelection = selection.trim().length > 0;

    const menu = new Menu();
    if (hasSelection) {
      menu.addItem((item) => {
        item
          .setTitle("Extract to new oak page")
          .setIcon("scissors")
          .onClick(() => {
            void extractSelectionToPage(this);
          });
      });
      menu.addSeparator();
    }
    menu.addItem((item) => {
      item
        .setTitle("Show default menu")
        .setIcon("more-horizontal")
        .onClick(() => this.replayDefaultContextmenu(ev));
    });
    menu.showAtMouseEvent(ev);
  }

  // Replay the original right-click as a fresh contextmenu event so
  // Obsidian's own handler builds and shows the native menu at the
  // same screen position.
  private replayDefaultContextmenu(original: MouseEvent): void {
    const target = original.target as HTMLElement | null;
    if (!target) return;
    this.oakContextmenuBypass = true;
    const replay = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: original.clientX,
      clientY: original.clientY,
      button: 2,
      view: window,
    });
    target.dispatchEvent(replay);
  }

  // Open (or refocus) a Ghost View for a redlink target. Plain
  // click replaces the current main-pane leaf in place; Cmd /
  // Ctrl-click opens a new tab.
  async openGhostView(target: string, newTab = false): Promise<void> {
    const leaf = newTab
      ? this.app.workspace.getLeaf("tab")
      : this.currentMainLeaf();
    await leaf.setViewState({
      type: VIEW_TYPE_OAK_GHOST,
      state: { target },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  // Materialise a ghost target into a real page. Uses @oak/core's
  // `composePage` for the file content (id, default frontmatter,
  // sanitised filename) but writes via Obsidian's `vault.create`
  // so the resulting `TFile` is available immediately — the
  // alternative (fs.writeFile via @oak/core's `createPage`) makes
  // the file visible to Obsidian only on the next adapter scan,
  // which is too late to reopen in the ghost's leaf.
  private async materialiseGhost(
    target: string,
    hostLeaf: WorkspaceLeaf,
  ): Promise<void> {
    try {
      const composed = composePage({ title: target });
      const existing = this.app.vault.getAbstractFileByPath(
        composed.vaultRelPath,
      );
      if (existing) {
        new Notice(
          `oak: \`${composed.vaultRelPath}\` already exists — opening it instead`,
        );
        if (existing instanceof TFile) {
          await hostLeaf.openFile(existing);
        }
        return;
      }
      const file = await this.app.vault.create(
        composed.vaultRelPath,
        composed.text,
      );
      if (file instanceof TFile) {
        await hostLeaf.openFile(file);
      }
      this.state.scheduleRefresh();
    } catch (err) {
      new Notice(
        `oak: failed to create page — ${(err as Error).message}`,
      );
    }
  }

  // On every modify of an oak-managed markdown file, ensure the
  // frontmatter is followed by a blank line. Files always go to disk
  // with `---\n\n`, but a user editing in source mode can delete the
  // blank — and the styles.css rule that hides it in Live Preview
  // depends on it being there. Restoring it on save keeps the on-disk
  // shape stable.
  //
  // We gate on `id:` in the frontmatter so we never rewrite notes
  // that aren't oak-managed (the user's other vault content stays
  // exactly as they typed it). The early `===` check on the resulting
  // string prevents a feedback loop: when our `vault.modify` triggers
  // another `modify` event, the second pass sees the blank already in
  // place and skips the write.
  private async normalizeFrontmatterSeparator(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      if (!/^---\n[\s\S]*?\bid:/.test(content)) return;
      const fixed = ensureBlankAfterFrontmatter(content);
      if (fixed === content) return;
      await this.app.vault.modify(file, fixed);
    } catch (err) {
      console.warn("oak: normalizeFrontmatterSeparator failed", err);
    }
  }

  // Bump frontmatter `modified` to "now" when the just-applied save
  // changed body content or the title — but not when the change was
  // pure metadata (visibility, alias, slug flip). The diff is
  // computed against the in-memory baseline cached from the previous
  // observation; a missing baseline means this is the first modify we
  // see for the file, so we just prime the cache and skip the bump
  // (better to occasionally miss one bump than to fabricate an edit
  // out of thin air for files we have no history of).
  //
  // The early `shouldBumpModified` check also keeps our own writeback
  // from looping: when we call `vault.modify` below, the modify event
  // re-fires; the second pass sees `lastSeenContent[path]` already set
  // to the bumped content and the diff is empty, so it short-circuits.
  private async maybeBumpModified(file: TFile): Promise<void> {
    try {
      const current = await this.app.vault.read(file);
      const previous = this.lastSeenContent.get(file.path);
      if (previous === undefined) {
        this.lastSeenContent.set(file.path, current);
        return;
      }
      const bump = shouldBumpModified(previous, current);
      // The recovery path also fires when `created` is missing — even
      // if the bump rule itself decided to skip. That way a metadata-
      // only edit on a legacy file still backfills `created` once.
      const needCreated =
        /^---\n[\s\S]*?\bid:/.test(current) &&
        !/\bcreated:\s*\S/.test(current);
      if (!bump && !needCreated) {
        this.lastSeenContent.set(file.path, current);
        return;
      }
      const now = nowIsoSecond();
      let stamped = current;
      if (needCreated) {
        const recovered = await recoverCreatedTimestamp(
          vaultRoot(this.app),
          `${vaultRoot(this.app)}/${file.path}`,
          now,
        );
        stamped = setCreatedIfMissing(stamped, recovered);
      }
      if (bump) stamped = setModified(stamped, now);
      this.lastSeenContent.set(file.path, stamped);
      if (stamped !== current) {
        await this.app.vault.modify(file, stamped);
      }
    } catch (err) {
      console.warn("oak: maybeBumpModified failed", err);
    }
  }

  // Roll back a file Obsidian auto-created in response to a redlink
  // click that bypassed our capture-phase preventDefault. Delete the
  // empty file and switch to the Ghost View for the same target,
  // preserving the read-only / red state.
  private async rollbackAutoCreatedRedlink(
    file: TFile,
    target: string,
  ): Promise<void> {
    try {
      // Trash via vault.trash if available; otherwise hard delete.
      await this.app.vault.delete(file);
    } catch (err) {
      console.warn("oak: failed to delete auto-created redlink file", err);
    }
    await this.openGhostView(target, false);
    this.state.scheduleRefresh();
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
      // Body class is updated by the layout-change listener.
      return;
    }

    await this.activateSidebar();
    await this.activateHome();
    this.app.workspace.leftSplit.collapse();
  }

  private syncOakModeClass(): void {
    const sidebarPresent =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK).length > 0;
    const homePresent =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_OAK_HOME).length > 0;
    const isOn = sidebarPresent || homePresent;
    if (isOn) document.body.addClass("oak-mode-active");
    else document.body.removeClass("oak-mode-active");
    // Note: we deliberately don't auto-recreate a missing home
    // leaf here. With browser-tab navigation, a "missing" home
    // is the normal state right after the user clicked into a
    // page from home — they get back via ← or the home button.
  }

  // For each open markdown view, replace the *displayed* filename
  // with the frontmatter `title` (when present and oak mode is
  // active). Display-only — never mutate the actual textContent of
  // editable / file-bound elements, so titles can safely contain
  // characters that aren't path-safe (e.g. `:`, `/`).
  //
  // Two surfaces, both rely on CSS to do the visual override:
  //   - inline title at the top of the editor: we hide Obsidian's
  //     `.inline-title` and inject a sibling `.oak-page-title` div
  //   - tab header title: we tag `view.titleEl` with a class +
  //     `data-oak-title` attribute. CSS makes the original text
  //     transparent and overlays the data attribute via `::before`.
  private applyTitleOverrides(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const isRefilePeek = leaf === this.refilePeekLeaf;
      this.applyTitleForView(view, view.file, oakMode, isRefilePeek);
    }
  }

  private applyTitleForView(
    view: MarkdownView,
    file: TFile,
    oakMode: boolean,
    isRefilePeek = false,
  ): void {
    void file; // accessed via metadataCache below; kept for callers
    const cache = this.app.metadataCache.getFileCache(view.file!);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const fmTitleRaw = fm?.["title"];
    const fmTitle =
      typeof fmTitleRaw === "string" && fmTitleRaw.trim().length > 0
        ? fmTitleRaw.trim()
        : null;

    let existingRow = view.contentEl.querySelector<HTMLElement>(
      ".oak-page-title-row",
    );
    // `titleEl` is a runtime property on Obsidian's View base class
    // (the tab header text element). Not in the public types but
    // present at runtime on every view that owns a tab.
    const tabTitleEl = (view as unknown as { titleEl?: HTMLElement })
      .titleEl;

    const fmVisibilityRaw = fm?.["visibility"];
    const fmVisibility =
      typeof fmVisibilityRaw === "string" &&
      (fmVisibilityRaw === "private" ||
        fmVisibilityRaw === "unlisted" ||
        fmVisibilityRaw === "public")
        ? fmVisibilityRaw
        : "private";

    const isScratch = view.file?.path === SCRATCH_VAULT_REL_PATH;

    // The scratch row lives in the view-header bar (replacing the
    // standard back/forward chrome via CSS); regular oak rows live
    // inside the cm-scroller. Look up both candidates so we can
    // clean up a stale row in the wrong place when the leaf
    // transitions between scratch and a regular page.
    const headerEl = view.containerEl.querySelector<HTMLElement>(
      ".view-header",
    );
    const headerScratchRow =
      headerEl?.querySelector<HTMLElement>(
        ".oak-page-title-row.oak-row-scratch",
      ) ?? null;
    const headerRefilePeekRow =
      headerEl?.querySelector<HTMLElement>(
        ".oak-page-title-row.oak-row-refile-peek",
      ) ?? null;

    // Refile peek pane: hide standard view-header navigation and the
    // tab strip via the marker class + a × close button injected into
    // the view-header. We *don't* return from this branch — the
    // regular oak title row (editable title + visibility selector,
    // injected into the scroll container further below) still runs,
    // so the peek pane shows the destination file's page title in the
    // same place a regular oak md file would.
    if (oakMode && isRefilePeek) {
      view.containerEl.classList.add("oak-leaf-refile-peek");
      if (headerScratchRow) headerScratchRow.remove();
      if (headerEl) {
        let row = headerRefilePeekRow;
        if (!row || row.parentElement !== headerEl) {
          if (row) row.remove();
          row = document.createElement("div");
          row.classList.add("oak-page-title-row", "oak-row-refile-peek");
          const closeBtn = document.createElement("button");
          closeBtn.classList.add("clickable-icon", "oak-refile-peek-close");
          closeBtn.setAttribute("type", "button");
          closeBtn.setAttribute("aria-label", "Close refile peek");
          setIcon(closeBtn, "x");
          closeBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            this.closeRefilePeek();
          });
          row.appendChild(closeBtn);
          headerEl.appendChild(row);
        }
      }
    } else {
      // Drop the marker class + close row in case the leaf was
      // previously a peek and is now repurposed.
      view.containerEl.classList.remove("oak-leaf-refile-peek");
      if (headerRefilePeekRow) headerRefilePeekRow.remove();
    }

    if (oakMode && isScratch) {
      // Drop any stale cm-scroller row left over from before this
      // file became the scratch buffer (or from an earlier version
      // that injected scratch chrome there).
      if (existingRow) {
        existingRow.remove();
        existingRow = null;
      }
      if (!headerEl) return;
      let row = headerScratchRow;
      if (!row || row.parentElement !== headerEl) {
        if (row) row.remove();
        row = document.createElement("div");
        row.classList.add("oak-page-title-row", "oak-row-scratch");

        // Left cluster: scratch sub-actions (clear / history). Lives
        // at the leading edge of the row so the chrome reads as
        // "actions on the left, title in the middle, close on the
        // right" — same convention as a typical app window.
        const actions = document.createElement("div");
        actions.classList.add("oak-scratch-actions");

        const clearBtn = document.createElement("button");
        clearBtn.classList.add("clickable-icon", "oak-scratch-clear");
        clearBtn.setAttribute("type", "button");
        clearBtn.setAttribute("aria-label", "Clear scratch");
        setIcon(clearBtn, "eraser");
        clearBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          void clearScratch(this);
        });
        actions.appendChild(clearBtn);

        // History icon — opens a modal listing every backup written
        // by `clearScratch` (under `.oak/scratch.history/`). The
        // modal previews each backup as plain text and offers
        // copy / restore actions.
        const historyBtn = document.createElement("button");
        historyBtn.classList.add("clickable-icon", "oak-scratch-history");
        historyBtn.setAttribute("type", "button");
        historyBtn.setAttribute("aria-label", "Scratch history");
        setIcon(historyBtn, "history");
        historyBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          void openScratchHistory(this);
        });
        actions.appendChild(historyBtn);

        row.appendChild(actions);

        // Center column: `Scratch` heading. Wrapped in
        // `.oak-scratch-title-group` so future sub-elements (e.g. an
        // unsaved-marker dot) have somewhere to land without
        // restructuring.
        const titleGroup = document.createElement("div");
        titleGroup.classList.add("oak-scratch-title-group");
        const heading = document.createElement("div");
        heading.classList.add("oak-scratch-page-title");
        heading.textContent = "Scratch";
        titleGroup.appendChild(heading);
        row.appendChild(titleGroup);

        // Right: × close button. Detaches the scratch leaf —
        // autosave keeps content on disk, so closing is
        // non-destructive. Mirrors what clicking the `Scratch`
        // header link does from another pane (toggle close).
        const closeBtn = document.createElement("button");
        closeBtn.classList.add("clickable-icon", "oak-scratch-close");
        closeBtn.setAttribute("type", "button");
        closeBtn.setAttribute("aria-label", "Close scratch");
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.toggleScratch();
        });
        row.appendChild(closeBtn);

        headerEl.appendChild(row);
      }
      if (tabTitleEl) {
        tabTitleEl.dataset["oakTitle"] = "Scratch";
        tabTitleEl.classList.add("oak-tab-title-override");
      }
      return;
    }

    // Non-scratch path: drop any stale scratch row from the view-
    // header so it doesn't outlive the file transition.
    if (headerScratchRow) headerScratchRow.remove();

    if (oakMode && fmTitle) {
      // Inject the title row *inside* the scroll container so the
      // scrollbar runs the full pane height and so the title
      // scrolls with the content. The row holds the title input on
      // the left and the visibility selector pinned to the right.
      // Drop a stale scratch row from a prior file before creating
      // the editable row in its place.
      if (existingRow && existingRow.classList.contains("oak-row-scratch")) {
        existingRow.remove();
        existingRow = null;
      }
      const target = this.findTitleInjectionTarget(view);
      let row = existingRow;
      if (!row || (target && row.parentElement !== target)) {
        // Mode switch (source <-> preview) recreates the scroll
        // container; drop a stale row and inject into the new one.
        if (row) row.remove();
        row = document.createElement("div");
        row.classList.add("oak-page-title-row");

        const input = document.createElement("input");
        input.classList.add("oak-page-title");
        input.type = "text";
        input.spellcheck = false;
        row.appendChild(input);

        const select = document.createElement("select");
        select.classList.add("oak-page-visibility");
        for (const v of ["private", "unlisted", "public"]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          select.appendChild(o);
        }
        row.appendChild(select);

        if (target) {
          target.prepend(row);
          this.attachInlineTitleEditing(view, input);
          this.attachVisibilitySelect(view, select);
        }
      }
      const input = row.querySelector<HTMLInputElement>(".oak-page-title");
      const select = row.querySelector<HTMLSelectElement>(".oak-page-visibility");
      if (input) {
        // Don't clobber what the user is typing. We only push the
        // canonical value when the input isn't focused.
        if (input.value !== fmTitle && document.activeElement !== input) {
          input.value = fmTitle;
        }
      }
      if (select && select.value !== fmVisibility) {
        select.value = fmVisibility;
      }

      if (tabTitleEl) {
        tabTitleEl.dataset["oakTitle"] = fmTitle;
        tabTitleEl.classList.add("oak-tab-title-override");
      }
    } else {
      if (existingRow) existingRow.remove();
      if (tabTitleEl) {
        delete tabTitleEl.dataset["oakTitle"];
        tabTitleEl.classList.remove("oak-tab-title-override");
      }
    }
  }

  private attachVisibilitySelect(
    view: MarkdownView,
    select: HTMLSelectElement,
  ): void {
    select.addEventListener("change", () => {
      const file = view.file;
      if (!file) return;
      const next = select.value;
      void this.app.fileManager
        .processFrontMatter(file, (fm) => {
          (fm as Record<string, unknown>)["visibility"] = next;
        })
        .catch((err) =>
          new Notice(`oak: failed to update visibility — ${(err as Error).message}`),
        );
    });
  }

  // For each open markdown view, render a "Related" footer that
  // sits *inside* the scroll container (after the body), so the
  // user reaches it by scrolling down — it reads as the tail end of
  // the page rather than as separate chrome.
  private applyLinksCards(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      this.applyLinksCardForView(view, oakMode);
    }
  }

  private applyLinksCardForView(
    view: MarkdownView,
    oakMode: boolean,
  ): void {
    const existing =
      view.contentEl.querySelector<HTMLElement>(".oak-page-links");

    if (!oakMode || !view.file) {
      existing?.remove();
      return;
    }

    const snap = this.state.current();
    if (!snap) {
      existing?.remove();
      return;
    }

    let page: OakPage | null = null;
    for (const p of snap.vault.pages.values()) {
      if (p.relPath === view.file.path) {
        page = p;
        break;
      }
    }
    if (!page) {
      existing?.remove();
      return;
    }

    const target = this.findLinksInjectionTarget(view);
    if (!target) {
      existing?.remove();
      return;
    }

    let container = existing;
    if (!container || container.parentElement !== target) {
      container?.remove();
      container = document.createElement("div");
      container.classList.add("oak-page-links");
      target.appendChild(container);
    }
    container.empty();

    // Merge backlinks + 2-hop into a single deduplicated list of
    // related pages, with relation labels for the card footer.
    type RelatedItem = {
      page: OakPage;
      relation: string;
    };
    const related: RelatedItem[] = [];
    const seen = new Set<string>();
    for (const b of describeBacklinks(snap.graph, snap.vault, page.id)) {
      if (seen.has(b.fromId)) continue;
      seen.add(b.fromId);
      const p = snap.vault.pages.get(b.fromId);
      if (!p) continue;
      related.push({ page: p, relation: "backlink" });
    }
    for (const h of describeTwoHop(snap.graph, snap.vault, page.id)) {
      if (seen.has(h.pageId)) continue;
      seen.add(h.pageId);
      const p = snap.vault.pages.get(h.pageId);
      if (!p) continue;
      const via = h.via
        .map((v) => (v.kind === "page" ? v.title : `[[${v.display}]]`))
        .join(", ");
      related.push({ page: p, relation: `2-hop · via ${via}` });
    }

    if (related.length === 0) {
      // Empty state: keep the heading so the page still terminates
      // gracefully but skip the row to avoid an empty scroller.
      container.createEl("h2", {
        cls: "oak-page-links-heading",
        text: "関連項目",
      });
      container.createEl("p", {
        cls: "oak-page-links-empty",
        text: "(no backlinks or 2-hop neighbours yet)",
      });
      return;
    }

    container.createEl("h2", {
      cls: "oak-page-links-heading",
      text: "関連項目",
    });
    const row = container.createDiv({ cls: "oak-card-grid" });
    for (const item of related) {
      this.renderRelatedCard(row, snap, item.page, item.relation);
    }
  }

  private renderRelatedCard(
    parent: HTMLElement,
    snap: VaultSnapshot,
    page: OakPage,
    relation: string,
  ): void {
    const card = parent.createDiv({ cls: "oak-card" });
    card.setAttr("role", "link");
    card.setAttr("tabindex", "0");
    card.createEl("div", {
      cls: "oak-card-title",
      text: page.title,
    });
    const excerpt = excerptFrom(page.body, 240);
    if (excerpt.length > 0) {
      card.createEl("p", {
        cls: "oak-card-excerpt",
        text: excerpt,
      });
    }
    card.createEl("div", {
      cls: "oak-card-meta",
      text: relation,
    });
    const open = (newTab: boolean) =>
      this.openLinkTarget(snap, page.id, newTab);
    card.addEventListener("click", (ev) => {
      open(ev.metaKey || ev.ctrlKey);
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        open(ev.metaKey || ev.ctrlKey);
      }
    });
  }

  private openLinkTarget(
    snap: VaultSnapshot,
    pageId: string,
    newTab: boolean,
  ): void {
    const page = snap.vault.pages.get(pageId);
    if (!page) return;
    const file = this.app.vault.getAbstractFileByPath(page.relPath);
    if (file instanceof TFile) {
      void this.openInBrowseLeaf(file, { newTab });
    }
  }

  // Per-page metadata (id / slug / status), rendered as a
  // compact row of label-value pairs after the Related cards.
  private applyPageMeta(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      this.applyPageMetaForView(view, oakMode);
    }
  }

  private applyPageMetaForView(
    view: MarkdownView,
    oakMode: boolean,
  ): void {
    const existing =
      view.contentEl.querySelector<HTMLElement>(".oak-page-meta");

    if (!oakMode || !view.file) {
      existing?.remove();
      return;
    }

    const snap = this.state.current();
    if (!snap) {
      existing?.remove();
      return;
    }

    let page: OakPage | null = null;
    for (const p of snap.vault.pages.values()) {
      if (p.relPath === view.file.path) {
        page = p;
        break;
      }
    }
    if (!page) {
      existing?.remove();
      return;
    }

    const target = this.findLinksInjectionTarget(view);
    if (!target) {
      existing?.remove();
      return;
    }

    let container = existing;
    if (!container || container.parentElement !== target) {
      container?.remove();
      container = document.createElement("div");
      container.classList.add("oak-page-meta");
      target.appendChild(container);
    }
    container.empty();

    const file = view.file;
    this.metaRowReadonly(container, "ID", page.id);
    this.metaRowText(container, "Slug", "slug", page.slug, file);

    const issues = snap.issues.filter((i) => i.pageId === page.id);
    const errCount = issues.filter((i) => i.severity === "error").length;
    this.metaRowReadonly(
      container,
      "Status",
      errCount === 0
        ? "ok"
        : `${errCount} error(s) blocking publish`,
      errCount > 0,
    );
  }

  private metaRowReadonly(
    parent: HTMLElement,
    label: string,
    value: string,
    isError = false,
  ): void {
    parent.createEl("span", {
      cls: "oak-page-meta-label",
      text: label,
    });
    parent.createEl("span", {
      cls: isError
        ? "oak-page-meta-value oak-page-meta-error"
        : "oak-page-meta-value oak-page-meta-readonly",
      text: value,
    });
  }

  private metaRowText(
    parent: HTMLElement,
    label: string,
    key: string,
    value: string,
    file: TFile,
  ): void {
    parent.createEl("span", {
      cls: "oak-page-meta-label",
      text: label,
    });
    const input = parent.createEl("input", {
      cls: "oak-page-meta-input",
      type: "text",
    });
    input.value = value;
    const commit = async () => {
      const next = input.value.trim();
      if (next === value) return;
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const f = fm as Record<string, unknown>;
          if (next.length === 0) delete f[key];
          else f[key] = next;
        });
      } catch (err) {
        new Notice(`oak: failed to update ${key} — ${(err as Error).message}`);
      }
    };
    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      }
    });
  }

  // Inject a "go to oak home" icon button right after the ← / →
  // history buttons in every visible view header. Clicking the
  // button turns *that* tab into the home view (browser-tab
  // semantics). Rendered on every view including the home view
  // itself — when the view matches, the button shows up disabled
  // so the icon row stays in a fixed position.
  private applyHomeButton(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { containerEl?: HTMLElement; getViewType?: () => string };
      const root = view.containerEl;
      if (!root) return;
      const headerLeft = root.querySelector<HTMLElement>(".view-header-left");
      if (!headerLeft) return;
      const isCurrent = view.getViewType?.() === VIEW_TYPE_OAK_HOME;
      this.applyHomeButtonForHeader(headerLeft, leaf, oakMode, isCurrent);
    });
  }

  private applyHomeButtonForHeader(
    headerLeft: HTMLElement,
    leaf: WorkspaceLeaf,
    oakMode: boolean,
    isCurrent: boolean,
  ): void {
    const existing =
      headerLeft.querySelector<HTMLButtonElement>(".oak-home-button");
    if (!oakMode) {
      existing?.remove();
      return;
    }
    if (existing) {
      this.setNavButtonCurrent(existing, isCurrent);
      return;
    }
    const navButtons = headerLeft.querySelector<HTMLElement>(
      ".view-header-nav-buttons",
    );
    if (!navButtons) return;
    // Append inside `.view-header-nav-buttons` so the home icon
    // inherits the same `--icon-size` + flex alignment Obsidian
    // applies to the back / forward buttons. Sitting outside the
    // container would render the icon a touch larger and slightly
    // off-baseline.
    const button = document.createElement("button");
    button.classList.add("clickable-icon", "oak-home-button");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Oak Home");
    setIcon(button, "house");
    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.navigateLeafToHome(leaf);
    });
    this.setNavButtonCurrent(button, isCurrent);
    // Keep order home → agenda → search regardless of which apply was
    // called first. (Scratch lives outside the nav cluster, on the
    // right edge of the header.)
    const successor = navButtons.querySelector<HTMLElement>(
      ".oak-agenda-button, .oak-search-button",
    );
    navButtons.insertBefore(button, successor ?? null);
  }

  // Mark a nav button as representing the current view: visually
  // de-emphasised (looks "you are here, no-op") and disabled so a
  // click can't fire.
  private setNavButtonCurrent(
    button: HTMLButtonElement,
    isCurrent: boolean,
  ): void {
    button.disabled = isCurrent;
    button.classList.toggle("is-active", isCurrent);
    if (isCurrent) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  // Replace the contents of `leaf` with the oak-home view. We do
  // *not* pin the resulting leaf: clicking a link from home should
  // navigate this same tab to the target (browser-tab semantics),
  // and pinning would block that.
  private async navigateLeafToHome(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.isLeafAlive(leaf)) return;
    if (leaf.view.getViewType() === VIEW_TYPE_OAK_HOME) {
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_OAK_HOME, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // Twin of applyHomeButton — sits between the home and search icons
  // in the view header. Rendered on every view including the agenda
  // view itself (disabled there) so the icon row stays in a fixed
  // position.
  private applyAgendaButton(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { containerEl?: HTMLElement; getViewType?: () => string };
      const root = view.containerEl;
      if (!root) return;
      const headerLeft = root.querySelector<HTMLElement>(".view-header-left");
      if (!headerLeft) return;
      const isCurrent = view.getViewType?.() === VIEW_TYPE_OAK_AGENDA;
      this.applyAgendaButtonForHeader(headerLeft, leaf, oakMode, isCurrent);
    });
  }

  private applyAgendaButtonForHeader(
    headerLeft: HTMLElement,
    leaf: WorkspaceLeaf,
    oakMode: boolean,
    isCurrent: boolean,
  ): void {
    const existing =
      headerLeft.querySelector<HTMLButtonElement>(".oak-agenda-button");
    if (!oakMode) {
      existing?.remove();
      return;
    }
    if (existing) {
      this.setNavButtonCurrent(existing, isCurrent);
      return;
    }
    const navButtons = headerLeft.querySelector<HTMLElement>(
      ".view-header-nav-buttons",
    );
    if (!navButtons) return;
    const button = document.createElement("button");
    button.classList.add("clickable-icon", "oak-agenda-button");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Oak Agenda");
    setIcon(button, "calendar-days");
    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.navigateLeafToAgenda(leaf);
    });
    this.setNavButtonCurrent(button, isCurrent);
    // Insert before the search button when present so the order in
    // every header is home → agenda → search regardless of which
    // button was applied first.
    const successor = navButtons.querySelector<HTMLElement>(
      ".oak-search-button",
    );
    navButtons.insertBefore(button, successor ?? null);
  }

  private async navigateLeafToAgenda(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.isLeafAlive(leaf)) return;
    if (leaf.view.getViewType() === VIEW_TYPE_OAK_AGENDA) {
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_OAK_AGENDA, active: true });
    this.app.workspace.revealLeaf(leaf);
    // Make sure the vault has been parsed at least once.
    void this.state.refresh();
  }

  // Twin of applyHomeButton — sits right after the agenda icon in the
  // view header. Rendered on every view including the search view
  // itself (disabled there) so the icon row stays in a fixed position.
  private applySearchButton(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { containerEl?: HTMLElement; getViewType?: () => string };
      const root = view.containerEl;
      if (!root) return;
      const headerLeft = root.querySelector<HTMLElement>(".view-header-left");
      if (!headerLeft) return;
      const isCurrent = view.getViewType?.() === VIEW_TYPE_OAK_SEARCH;
      this.applySearchButtonForHeader(headerLeft, leaf, oakMode, isCurrent);
    });
  }

  private applySearchButtonForHeader(
    headerLeft: HTMLElement,
    leaf: WorkspaceLeaf,
    oakMode: boolean,
    isCurrent: boolean,
  ): void {
    const existing =
      headerLeft.querySelector<HTMLButtonElement>(".oak-search-button");
    if (!oakMode) {
      existing?.remove();
      return;
    }
    if (existing) {
      this.setNavButtonCurrent(existing, isCurrent);
      return;
    }
    const navButtons = headerLeft.querySelector<HTMLElement>(
      ".view-header-nav-buttons",
    );
    if (!navButtons) return;
    const button = document.createElement("button");
    button.classList.add("clickable-icon", "oak-search-button");
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Oak Search");
    setIcon(button, "search");
    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.navigateLeafToSearch(leaf);
    });
    this.setNavButtonCurrent(button, isCurrent);
    // Search is the last entry in the nav cluster — scratch lives on
    // the right edge of the header, outside this group.
    navButtons.appendChild(button);
  }

  // Browser-tab semantics for opening search: replace `leaf` in
  // place, recording the prior view in leaf history so ← brings the
  // user back to whatever they came from. If the leaf already shows
  // the search view, just refocus the input so re-pressing ⌘F always
  // ends up "ready to type".
  private async navigateLeafToSearch(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.isLeafAlive(leaf)) return;
    const view = leaf.view;
    if (view instanceof OakSearchView) {
      this.app.workspace.revealLeaf(leaf);
      view.focusInput();
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_OAK_SEARCH, active: true });
    this.app.workspace.revealLeaf(leaf);
    const newView = leaf.view;
    if (newView instanceof OakSearchView) newView.focusInput();
  }

  // Top-level entry for the `oak-search` command. Always opens in the
  // currently-focused main-pane leaf (browser-tab semantics).
  async openSearch(): Promise<void> {
    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    await this.navigateLeafToSearch(leaf);
  }

  // Single dropdown affordance at the right edge of every view-header.
  // Consolidates the per-pane oak actions (toggle scratch, new page,
  // and — on a markdown leaf — delete-file…) behind one `…` button so
  // the chrome stays terse regardless of which view the leaf shows.
  // Same `clickable-icon` chrome as the back/forward + home/agenda/
  // search cluster on the left, so the icon row reads as one bar.
  // Accent-tinted while a scratch leaf is open elsewhere in the
  // workspace — the menu is the only entry point for closing it, so
  // the tint preserves the at-a-glance "scratch is up" cue the
  // standalone link used to provide.
  //
  // We also tag the scratch leaf's container with `oak-leaf-scratch`
  // so the stylesheet can hide the per-pane tab strip — the scratch
  // row inside the leaf's own view-header carries enough identity
  // that the tab is redundant.
  private applyActionsMenu(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    const isScratchOpen = this.findScratchLeaf() !== null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { containerEl?: HTMLElement };
      const root = view.containerEl;
      if (!root) return;
      const header = root.querySelector<HTMLElement>(".view-header");
      if (header)
        this.applyActionsMenuForHeader(header, leaf, oakMode, isScratchOpen);
      this.applyScratchLeafClass(leaf);
    });
  }

  private applyActionsMenuForHeader(
    header: HTMLElement,
    leaf: WorkspaceLeaf,
    oakMode: boolean,
    isScratchOpen: boolean,
  ): void {
    const existing = header.querySelector<HTMLButtonElement>(
      ".oak-actions-menu",
    );
    if (!oakMode) {
      existing?.remove();
      return;
    }
    let btn = existing;
    if (!btn) {
      btn = document.createElement("button");
      btn.classList.add("clickable-icon", "oak-actions-menu");
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-label", "Oak actions");
      setIcon(btn, "ellipsis-vertical");
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.showActionsMenuForLeaf(leaf, ev);
      });
      header.appendChild(btn);
    }
    btn.classList.toggle("is-active", isScratchOpen);
  }

  private showActionsMenuForLeaf(leaf: WorkspaceLeaf, ev: MouseEvent): void {
    const menu = new Menu();
    const isScratchOpen = this.findScratchLeaf() !== null;
    menu.addItem((item) => {
      item
        .setTitle(isScratchOpen ? "Close scratch" : "Open scratch")
        .setIcon("line-squiggle")
        .onClick(() => void this.toggleScratch(leaf));
    });
    menu.addItem((item) => {
      item
        .setTitle("New page")
        .setIcon("file-plus")
        .onClick(() => void createNewPage(this));
    });
    // File-pane extras: only when the leaf shows a real markdown
    // file (skip oak-home / agenda / search / ghost / scratch).
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file) {
      const file = view.file;
      const isScratchFile = file.path === SCRATCH_VAULT_REL_PATH;
      if (!isScratchFile) {
        menu.addSeparator();
        menu.addItem((item) => {
          item
            .setTitle("Delete file…")
            .setIcon("trash-2")
            .onClick(() => void deleteFile(this, file));
        });
      }
    }
    menu.showAtMouseEvent(ev);
  }

  // Inject a static, centered title into each oak view's
  // view-header so the title position doesn't drift with the body
  // content. Applies to oak-home / oak-agenda / oak-search;
  // markdown leaves keep their inline editor title (preserving the
  // plain-text feel of a note). Scratch already has its title in
  // the view-header via the scratch row.
  private applyCenteredViewTitle(): void {
    const oakMode = document.body.classList.contains("oak-mode-active");
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as {
        containerEl?: HTMLElement;
        getViewType?: () => string;
      };
      const root = view.containerEl;
      if (!root) return;
      const headerEl = root.querySelector<HTMLElement>(".view-header");
      if (!headerEl) return;
      const viewType = view.getViewType?.() ?? "";
      let label: string | null = null;
      if (viewType === VIEW_TYPE_OAK_HOME) label = "Home";
      else if (viewType === VIEW_TYPE_OAK_AGENDA) label = "Agenda";
      else if (viewType === VIEW_TYPE_OAK_SEARCH) label = "Search";
      const existing =
        headerEl.querySelector<HTMLElement>(".oak-view-title");
      if (!oakMode || !label) {
        existing?.remove();
        return;
      }
      let el = existing;
      if (!el) {
        el = document.createElement("div");
        el.classList.add("oak-view-title");
        headerEl.appendChild(el);
      }
      if (el.textContent !== label) el.textContent = label;
    });
  }

  private applyScratchLeafClass(leaf: WorkspaceLeaf): void {
    const view = leaf.view as { containerEl?: HTMLElement };
    const root = view.containerEl;
    if (!root) return;
    const isScratch =
      leaf.view instanceof MarkdownView &&
      leaf.view.file?.path === SCRATCH_VAULT_REL_PATH;
    root.classList.toggle("oak-leaf-scratch", isScratch);
  }

  private findScratchLeaf(): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (
        view instanceof MarkdownView &&
        view.file?.path === SCRATCH_VAULT_REL_PATH
      ) {
        found = leaf;
      }
    });
    return found;
  }

  // Open the refile target picker in the peek pane and resolve with
  // the user's choice (or null on cancel). The picker is a custom
  // ItemView (`OakRefilePickerView`) — file list on the left, live
  // preview on the right — that replaces the old FuzzySuggestModal.
  //
  // The peek leaf is set up before the picker opens:
  //   - peek-to-peek hop: the user is invoking refile from inside
  //     the existing peek. Promote the peek's file (the source) into
  //     the main slot first, then turn the peek into the picker.
  //     That way "source = main, destination = peek" stays true
  //     across hops.
  //   - existing peek (from a prior refile): reuse the leaf, just
  //     swap its view to the picker.
  //   - no peek yet: split a new horizontal leaf below the source
  //     leaf and open the picker in it.
  //
  // After the user picks, the caller (`refile.ts`) runs the actual
  // core refile and then calls `revealRefileTarget` to swap the peek
  // view back to a MarkdownView of the destination.
  async openRefilePicker(opts: {
    sourceTitle: string;
    excludeKeys: Set<string>;
    sourceLeaf?: WorkspaceLeaf;
    sourceFile?: TFile;
    isPeekSource?: boolean;
  }): Promise<RefileTarget | null> {
    const { sourceLeaf, sourceFile, isPeekSource } = opts;

    // Hold the auto-close gate across the setup phase. The promote
    // path activates the main leaf to force the source-file swap,
    // and that focus shift would otherwise call closeRefilePeek and
    // detach the very leaf we're about to turn into the picker.
    // Released in the finally block so the user-interaction phase
    // sees normal click-to-dismiss behavior.
    this.refilePickerSettingUp += 1;

    let view: OakRefilePickerView;
    try {
      let peekLeaf: WorkspaceLeaf;

      if (
        isPeekSource &&
        sourceLeaf &&
        sourceFile &&
        this.isLeafAlive(sourceLeaf)
      ) {
        // Promote: open the source file in the main leaf the peek
        // was split from. We activate `main` eagerly to force the
        // file-swap to land (Obsidian otherwise can defer the
        // visual change on a non-active leaf).
        let main: WorkspaceLeaf | null =
          this.refilePeekBaseLeaf &&
          this.isLeafAlive(this.refilePeekBaseLeaf) &&
          this.refilePeekBaseLeaf !== sourceLeaf
            ? this.refilePeekBaseLeaf
            : null;
        if (!main) {
          main = this.findMainLeafExcluding(sourceLeaf);
        }
        if (main) {
          this.app.workspace.setActiveLeaf(main, { focus: false });
          await main.openFile(sourceFile);
          this.app.workspace.revealLeaf(main);
          this.refilePeekBaseLeaf = main;
        }
        peekLeaf = sourceLeaf;
      } else if (
        this.refilePeekLeaf &&
        this.isLeafAlive(this.refilePeekLeaf)
      ) {
        peekLeaf = this.refilePeekLeaf;
      } else {
        const base =
          sourceLeaf && this.isLeafAlive(sourceLeaf)
            ? sourceLeaf
            : (this.app.workspace.activeLeaf ?? this.currentMainLeaf());
        peekLeaf = this.app.workspace.createLeafBySplit(
          base,
          "horizontal",
          false,
        );
        this.refilePeekBaseLeaf = base;
      }

      this.refilePeekLeaf = peekLeaf;
      this.refilePeekEngaged = true;
      const persistId = leafId(peekLeaf);
      if (persistId && this.settings.refilePeekLeafId !== persistId) {
        this.settings.refilePeekLeafId = persistId;
        void this.saveSettings();
      }

      // Swap the leaf to the picker view. setViewState rebuilds the
      // view DOM; the resolve callback gets wired in afterwards via
      // `init()` so the picker can settle the awaiting promise.
      await peekLeaf.setViewState({
        type: VIEW_TYPE_OAK_REFILE_PICKER,
        active: true,
      });
      const v = peekLeaf.view;
      if (!(v instanceof OakRefilePickerView)) {
        // setViewState should have produced our view; if Obsidian
        // ended up with something else, surface as cancel rather
        // than hanging the caller.
        return null;
      }
      view = v;
      this.app.workspace.setActiveLeaf(peekLeaf, { focus: true });
    } finally {
      this.refilePickerSettingUp -= 1;
    }

    return new Promise<RefileTarget | null>((resolve) => {
      const init: RefilePickerInit = {
        sourceTitle: opts.sourceTitle,
        excludeKeys: opts.excludeKeys,
        resolve,
      };
      view.init(init);
    });
  }

  // Swap the peek leaf's view back to a MarkdownView of `file` after
  // the picker resolved and the core refile succeeded. The peek leaf
  // is the same one the picker was rendered into — `openFile` simply
  // replaces the picker view with a markdown view of the destination.
  async revealRefileTarget(
    file: TFile,
    fileLine: number | null,
  ): Promise<void> {
    const peek = this.refilePeekLeaf;
    if (!peek || !this.isLeafAlive(peek)) {
      // openRefilePicker should always have set this. If we arrive
      // here without a live peek leaf, fall back to opening the
      // file in a fresh split so the destination at least surfaces.
      const base = this.app.workspace.activeLeaf ?? this.currentMainLeaf();
      const fresh = this.app.workspace.createLeafBySplit(
        base,
        "horizontal",
        false,
      );
      this.refilePeekLeaf = fresh;
      this.refilePeekBaseLeaf = base;
      const openState =
        fileLine !== null ? { eState: { line: fileLine } } : undefined;
      await fresh.openFile(file, openState);
      this.applyTitleOverrides();
      this.bindRefilePeekEscape(fresh);
      this.app.workspace.setActiveLeaf(fresh, { focus: true });
      return;
    }
    const openState =
      fileLine !== null ? { eState: { line: fileLine } } : undefined;
    await peek.openFile(file, openState);
    this.applyTitleOverrides();
    this.bindRefilePeekEscape(peek);
    this.refilePeekEngaged = true;
    const id = leafId(peek);
    if (id && this.settings.refilePeekLeafId !== id) {
      this.settings.refilePeekLeafId = id;
      void this.saveSettings();
    }
    this.app.workspace.setActiveLeaf(peek, { focus: true });
  }

  // Detach the peek leaf, if any, and forget the reference so the next
  // refile creates a fresh split. Wired to the × button injected into
  // the peek pane's view-header, the auto-close on focus-leave, and
  // the Esc-key binding inside the peek.
  closeRefilePeek(): void {
    const leaf = this.refilePeekLeaf;
    this.refilePeekLeaf = null;
    this.refilePeekBaseLeaf = null;
    this.refilePeekEngaged = false;
    document.body.classList.remove("oak-refile-peek-active");
    if (this.settings.refilePeekLeafId !== null) {
      this.settings.refilePeekLeafId = null;
      void this.saveSettings();
    }
    if (leaf && this.isLeafAlive(leaf)) leaf.detach();
  }

  private findMainLeafExcluding(
    excluded: WorkspaceLeaf,
  ): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      if (leaf === excluded) return;
      if (this.isMainPaneLeaf(leaf)) found = leaf;
    });
    return found;
  }

  // active-leaf-change hook for the peek pane:
  //   - `mod-active` on the peek leaf flips the body dim class on so
  //     the source pane fades while the peek is in focus.
  //   - Once the user has actually engaged with the peek (focused it
  //     at least once), the *next* main-pane focus shift away from
  //     the peek detaches it — emulating a transient floating panel.
  //     Sidebar focus changes are ignored so clicking the file
  //     explorer doesn't dismiss the peek.
  private handleActiveLeafChangeForPeek(
    newLeaf: WorkspaceLeaf | null,
  ): void {
    const peek = this.refilePeekLeaf;
    if (!peek || !this.isLeafAlive(peek)) {
      this.refilePeekEngaged = false;
      document.body.classList.remove("oak-refile-peek-active");
      return;
    }
    if (newLeaf === peek) {
      this.refilePeekEngaged = true;
      document.body.classList.add("oak-refile-peek-active");
      return;
    }
    document.body.classList.remove("oak-refile-peek-active");
    if (!this.refilePeekEngaged) return;
    if (this.refilePickerSettingUp > 0) return;
    if (newLeaf && this.isMainPaneLeaf(newLeaf)) {
      this.closeRefilePeek();
    }
  }

  // Snapshot of the current peek leaf for callers that need to
  // decide, at command-start time, whether the source leaf they're
  // about to refile from IS the peek. Captured early so a transient
  // closeRefilePeek mid-flow doesn't strand the promotion logic.
  peekLeaf(): WorkspaceLeaf | null {
    return this.refilePeekLeaf;
  }

  private isMainPaneLeaf(leaf: WorkspaceLeaf): boolean {
    const root = (
      leaf as unknown as { getRoot?: () => unknown }
    ).getRoot?.();
    return root === this.app.workspace.rootSplit;
  }

  // Capture-phase Esc handler scoped to the peek leaf's container.
  // Capture so it wins over Obsidian's own Esc bindings (which would
  // otherwise close suggestion menus / clear selection inside the
  // editor before our handler ever sees the key). Stored on the DOM
  // node so a later openFile (which rebuilds the container) replaces
  // a stale handler instead of stacking.
  private bindRefilePeekEscape(leaf: WorkspaceLeaf): void {
    const container = (
      leaf.view as { containerEl?: HTMLElement }
    ).containerEl;
    if (!container) return;
    type Slot = { __oakPeekEsc?: (ev: KeyboardEvent) => void };
    const slot = container as unknown as Slot;
    if (slot.__oakPeekEsc) {
      container.removeEventListener("keydown", slot.__oakPeekEsc, true);
    }
    const handler = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      // Let `<input>` / `<textarea>` swallow Esc themselves so the
      // editable title input retains its commit-or-cancel behaviour
      // (Esc inside the input would otherwise dismiss the peek
      // before the input could process the keystroke).
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.closeRefilePeek();
    };
    container.addEventListener("keydown", handler, true);
    slot.__oakPeekEsc = handler;
  }

  // Detach the leaf left over from the previous session's peek, if
  // Obsidian's workspace restoration brought it back. Peek state
  // (chrome, dim class, escape handler, refilePeekBaseLeaf,
  // refilePeekEngaged) is ephemeral and lost across reload — re-
  // claiming the leaf as a peek without that state would surface the
  // next refile's destination in whatever screen position Obsidian
  // placed the leaf in, unrelated to the user's current main.
  // Detaching is cleaner: the next refile creates a fresh peek below
  // the current main via the normal split path.
  private discardOrphanedPeekLeaf(): void {
    const id = this.settings.refilePeekLeafId;
    if (!id) return;
    this.settings.refilePeekLeafId = null;
    void this.saveSettings();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leafId(leaf) === id) leaf.detach();
    });
  }

  async toggleScratch(triggerLeaf?: WorkspaceLeaf): Promise<void> {
    const existing = this.findScratchLeaf();
    if (existing) {
      existing.detach();
      return;
    }
    let file: TFile;
    try {
      file = await ensureScratchFile(this.app);
    } catch (err) {
      new Notice(`oak: open scratch failed — ${(err as Error).message}`);
      return;
    }
    const base =
      triggerLeaf && this.isLeafAlive(triggerLeaf)
        ? triggerLeaf
        : this.currentMainLeaf();
    const newLeaf = this.app.workspace.createLeafBySplit(
      base,
      "horizontal",
      false,
    );
    await newLeaf.openFile(file);
    this.app.workspace.revealLeaf(newLeaf);
  }

  // Walk one step back in the active leaf's history. Used by the
  // search view's Esc handler when the query is already empty.
  private navigateLeafBack(): void {
    // `app.commands` is on the runtime App but not in the public
    // types — cast through `unknown` to access it.
    const commands = (
      this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }
    ).commands;
    commands?.executeCommandById?.("app:go-back");
  }


  // The cards belong inside the scroll container, alongside the body
  // content, so they scroll with it.
  //   source / live-preview: `.cm-scroller` (sibling of `.cm-content`)
  //   reading view:          `.markdown-preview-view`
  private findLinksInjectionTarget(view: MarkdownView): HTMLElement | null {
    const cmScroller =
      view.contentEl.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) return cmScroller;
    const preview = view.contentEl.querySelector<HTMLElement>(
      ".markdown-preview-view",
    );
    return preview ?? null;
  }

  // Figure out which DOM node the inline title belongs in, depending
  // on the current view mode.
  //   source / live-preview: `.cm-scroller` (sibling of `.cm-content`)
  //   reading view:          `.markdown-preview-view` (the scroller)
  // Returns null if neither is present yet (the next layout-change
  // will retry).
  private findTitleInjectionTarget(view: MarkdownView): HTMLElement | null {
    const cmScroller = view.contentEl.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) return cmScroller;
    const preview = view.contentEl.querySelector<HTMLElement>(
      ".markdown-preview-view",
    );
    return preview ?? null;
  }

  private attachInlineTitleEditing(
    view: MarkdownView,
    input: HTMLInputElement,
  ): void {
    const commit = async () => {
      const file = view.file;
      if (!file) return;
      const newTitle = input.value.trim();
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      const oldTitleRaw = fm?.["title"];
      const oldTitle =
        typeof oldTitleRaw === "string" ? oldTitleRaw.trim() : "";
      if (newTitle.length === 0 || newTitle === oldTitle) {
        input.value = oldTitle;
        return;
      }
      const oldSlugRaw = fm?.["slug"];
      const oldSlug =
        typeof oldSlugRaw === "string" ? oldSlugRaw.trim() : slugify(oldTitle);
      const result = await commitTitleChange(
        this.app,
        file,
        { title: oldTitle, slug: oldSlug, basename: file.basename },
        newTitle,
      );
      if (result.status === "frontmatter-failed") {
        new Notice(`oak: failed to update title — ${result.error}`);
      } else if (result.status === "rename-skipped") {
        new Notice(`oak: rename skipped — ${result.reason}`);
      } else if (result.status === "rename-failed") {
        new Notice(`oak: rename failed — ${result.error}`);
      }
    };
    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        // Revert to the canonical value and bail.
        const cache = view.file
          ? this.app.metadataCache.getFileCache(view.file)
          : null;
        const fm = cache?.frontmatter as Record<string, unknown> | undefined;
        const t = fm?.["title"];
        if (typeof t === "string") input.value = t;
        input.blur();
      }
    });
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
    // Open in the main editor area, not the sidebar. The home is
    // *not* pinned: with browser-tab navigation, a plain click on
    // a home entry should replace the home in place (and ← brings
    // it back via leaf history).
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_OAK_HOME, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openAgenda(): Promise<void> {
    const leaf =
      this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    await this.navigateLeafToAgenda(leaf);
  }
}

// Obsidian's runtime `WorkspaceLeaf` carries an `id` string that is
// part of the workspace JSON layout — stable across save/restore. The
// public type doesn't expose it, so we cast through `unknown`. Returns
// null when the runtime didn't materialise an id (defensive: should
// never happen for a leaf currently attached to the workspace).
function leafId(leaf: WorkspaceLeaf): string | null {
  const id = (leaf as unknown as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
