// "Ghost" view: a placeholder that stands in for an unresolved
// wiki link target. Clicking a red link in oak mode opens this
// view instead of creating a file, so the user can read related
// context (which pages reference it) without committing to a new
// page. The user materialises the target into a real page via the
// "Create page" button — that's the explicit transition from
// reading to writing.

import {
  ItemView,
  WorkspaceLeaf,
  type App,
  type ViewStateResult,
} from "obsidian";

import type { VaultSnapshot, VaultState } from "../state.js";
import { normalizeKey, type OakPage } from "@oak/core";

export const VIEW_TYPE_OAK_GHOST = "oak-ghost";

export type GhostMaterialiseFn = (
  target: string,
  leaf: WorkspaceLeaf,
) => Promise<void>;

export type GhostOpenFileFn = (
  page: OakPage,
  newTab: boolean,
) => Promise<void> | void;

type GhostReference = {
  page: OakPage;
  line: number;
  raw: string;
};

export class OakGhostView extends ItemView {
  private target = "";
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private state: VaultState,
    private app2: App,
    private materialise: GhostMaterialiseFn,
    private openPage: GhostOpenFileFn,
  ) {
    super(leaf);
    void this.app2;
  }

  getViewType(): string {
    return VIEW_TYPE_OAK_GHOST;
  }

  getDisplayText(): string {
    return this.target ? this.target : "Red link";
  }

  override getIcon(): string {
    return "circle-slash";
  }

  // See OakHomeView for rationale — opt the ghost view into the
  // leaf's navigation history so ← / → can step back to whatever
  // the user came from (typically a markdown page) and forward
  // again to this redlink target.
  override navigation = true;

  override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    if (state && typeof state === "object" && "target" in state) {
      const t = (state as { target?: unknown }).target;
      if (typeof t === "string") this.target = t;
    }
    await super.setState(state, result);
    result.history = true;
    this.render();
  }

  override getState(): Record<string, unknown> {
    return { target: this.target };
  }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.state.subscribe(() => this.render());
    this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private root(): HTMLElement {
    return (
      (this.containerEl.children[1] as HTMLElement | undefined) ??
      this.containerEl
    );
  }

  private render(): void {
    const root = this.root();
    root.empty();
    root.addClass("oak-ghost");

    if (!this.target) {
      root.createEl("p", {
        cls: "oak-ghost-empty",
        text: "(no target — open a red link from a page)",
      });
      return;
    }

    const header = root.createDiv({ cls: "oak-ghost-header" });
    header.createEl("div", {
      cls: "oak-ghost-badge",
      text: "RED LINK · doesn't exist yet",
    });
    header.createEl("h1", {
      cls: "oak-ghost-target",
      text: this.target,
    });
    header.createEl("p", {
      cls: "oak-ghost-explainer",
      text: "Reading mode for an unresolved link. The page is not created yet — explore where it would fit, then click Create when you're ready to write.",
    });

    const refs = this.collectReferences(this.state.current());
    const refSection = root.createDiv({ cls: "oak-ghost-section" });
    refSection.createEl("h2", {
      cls: "oak-ghost-section-title",
      text:
        refs.length === 0
          ? "No references yet"
          : `Referenced from ${refs.length} page${refs.length === 1 ? "" : "s"}`,
    });
    if (refs.length > 0) {
      const ul = refSection.createEl("ul", { cls: "oak-ghost-ref-list" });
      for (const ref of refs) {
        const li = ul.createEl("li");
        const link = li.createEl("a", {
          cls: "oak-ghost-ref-link",
          text: ref.page.title,
          href: "#",
        });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.openPage(ref.page, ev.metaKey || ev.ctrlKey);
        });
        li.createEl("div", {
          cls: "oak-ghost-ref-context",
          text: `line ${ref.line} · ${ref.raw}`,
        });
      }
    }

    const actions = root.createDiv({ cls: "oak-ghost-actions" });
    const createBtn = actions.createEl("button", {
      cls: "oak-ghost-create-btn",
      text: `Create page "${this.target}"`,
    });
    createBtn.addEventListener("click", () => {
      void this.materialise(this.target, this.leaf);
    });
    actions.createEl("p", {
      cls: "oak-ghost-actions-hint",
      text: "ID is auto-generated. Visibility defaults to private; LLM defaults to deny.",
    });
  }

  private collectReferences(snap: VaultSnapshot | null): GhostReference[] {
    if (!snap) return [];
    const targetKey = normalizeKey(this.target);
    const out: GhostReference[] = [];
    for (const page of snap.vault.pages.values()) {
      const resolved = snap.graph.outgoing.get(page.id) ?? [];
      for (let i = 0; i < page.links.length; i++) {
        const raw = page.links[i]!;
        if (normalizeKey(raw.target) !== targetKey) continue;
        const r = resolved[i];
        // Only count references where the link is *still* unresolved.
        // (Once we materialise the page, those references will resolve
        // naturally and drop out of this list.)
        if (r && r.resolution.status !== "unresolved") continue;
        out.push({ page, line: raw.line, raw: raw.raw });
      }
    }
    return out;
  }
}
