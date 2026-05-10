import { describe, expect, it } from "vitest";

import { findHeadingsInEditorSelection } from "../src/refile-selection.js";

// Helper: build an Obsidian-style EditorPosition.
const pos = (line: number, ch: number) => ({ line, ch });

describe("findHeadingsInEditorSelection", () => {
  // File-line numbers below are 0-based to match Obsidian's editor.
  // Body uses `## A` / `## B` so each heading has a small subtree.
  const raw = [
    "## A",     // line 0
    "a body",   // line 1
    "",         // line 2
    "## B",     // line 3
    "b body",   // line 4
    "",         // line 5
    "## C",     // line 6
    "c body",   // line 7
  ].join("\n");

  it("returns the headings whose subtree the selection covers", () => {
    // Select from `## A` through inside `## B` body.
    const r = findHeadingsInEditorSelection(raw, pos(0, 0), pos(4, 3));
    expect(r.map((h) => h.line)).toEqual([1, 4]);
  });

  it("excludes the trailing heading when selection ends at column 0 of its line", () => {
    // User extends the selection from inside `## A` up to the start
    // of `## B`. CodeMirror reports `to` as exclusive (line=3, ch=0),
    // so `## B` was not actually consumed. The pre-fix behaviour
    // wrongly included B.
    const r = findHeadingsInEditorSelection(raw, pos(0, 0), pos(3, 0));
    expect(r.map((h) => h.line)).toEqual([1]);
  });

  it("keeps the trailing heading when selection ends past column 0", () => {
    // A single character into `## B` is enough to count as a real
    // selection of B's subtree.
    const r = findHeadingsInEditorSelection(raw, pos(0, 0), pos(3, 1));
    expect(r.map((h) => h.line)).toEqual([1, 4]);
  });

  it("does not collapse a single-line zero-width selection", () => {
    // from === to: the exclusive-end fix must not turn this into a
    // negative range. The cursor sits inside `## A` body, and A's
    // subtree intersects, so A is returned.
    const r = findHeadingsInEditorSelection(raw, pos(1, 0), pos(1, 0));
    expect(r.map((h) => h.line)).toEqual([1]);
  });

  it("returns nothing when the selection sits entirely in frontmatter", () => {
    const fm = [
      "---",
      "title: x",
      "---",
      "",
      "## A",
      "a body",
    ].join("\n");
    // Selection covers only the frontmatter lines (0..2).
    const r = findHeadingsInEditorSelection(fm, pos(0, 0), pos(2, 3));
    expect(r).toEqual([]);
  });

  it("respects frontmatter when computing body line numbers", () => {
    const fm = [
      "---",      // file 0
      "title: x", // file 1
      "---",      // file 2
      "",         // file 3 — body line 1
      "## A",     // file 4 — body line 2
      "a body",   // file 5 — body line 3
      "## B",     // file 6 — body line 4
    ].join("\n");
    // Select from inside A's body (file 5) up to the start of `## B`
    // (file 6, ch=0). The exclusive-end fix should drop B. The
    // returned `line` is the body-line number, so A → 2.
    const r = findHeadingsInEditorSelection(fm, pos(5, 0), pos(6, 0));
    expect(r.map((h) => h.line)).toEqual([2]);
  });
});
