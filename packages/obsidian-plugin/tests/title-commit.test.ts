import { describe, expect, it } from "vitest";

import { applyTitleEdit } from "../src/title-commit.js";

describe("applyTitleEdit", () => {
  it("rewrites the existing first h1 in place", () => {
    const src = "---\nid: x\n---\n\n# Old Title\n\nbody\n";
    expect(applyTitleEdit(src, "New Title")).toBe(
      "---\nid: x\n---\n\n# New Title\n\nbody\n",
    );
  });

  it("preserves the rest of the body when the title changes", () => {
    const src = "---\nid: x\nvisibility: public\n---\n\n# A\n\nLine one.\n\n## sub\n\nLine two.\n";
    expect(applyTitleEdit(src, "Z")).toBe(
      "---\nid: x\nvisibility: public\n---\n\n# Z\n\nLine one.\n\n## sub\n\nLine two.\n",
    );
  });

  it("inserts an h1 directly after the frontmatter when none exists", () => {
    const src = "---\nid: x\n---\n\nprose with no heading.\n";
    expect(applyTitleEdit(src, "Fresh")).toBe(
      "---\nid: x\n---\n\n# Fresh\n\nprose with no heading.\n",
    );
  });

  it("inserts an h1 in an empty-body file (just frontmatter)", () => {
    const src = "---\nid: x\n---\n";
    expect(applyTitleEdit(src, "Fresh")).toBe(
      "---\nid: x\n---\n\n# Fresh\n",
    );
  });

  it("inserts an h1 at the top of a frontmatter-less file", () => {
    const src = "just body, nothing else.\n";
    expect(applyTitleEdit(src, "Top")).toBe(
      "# Top\n\njust body, nothing else.\n",
    );
  });

  it("skips fenced code when locating the first h1", () => {
    // A `# Title`-looking line inside a code fence is not the title.
    const src =
      "---\nid: x\n---\n\n```\n# not a heading\n```\n\n# Real Title\n\nbody\n";
    expect(applyTitleEdit(src, "New")).toBe(
      "---\nid: x\n---\n\n```\n# not a heading\n```\n\n# New\n\nbody\n",
    );
  });

  it("preserves wikilinks and decorations in the new title verbatim", () => {
    const src = "---\nid: x\n---\n\n# Old\n";
    expect(applyTitleEdit(src, "Foo about [[Bar]]")).toBe(
      "---\nid: x\n---\n\n# Foo about [[Bar]]\n",
    );
  });
});
