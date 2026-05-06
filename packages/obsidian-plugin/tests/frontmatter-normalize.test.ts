import { describe, expect, it } from "vitest";

import { ensureBlankAfterFrontmatter } from "../src/frontmatter-normalize.js";

describe("ensureBlankAfterFrontmatter", () => {
  it("inserts a blank line when frontmatter is followed directly by body", () => {
    const input = "---\nid: x\ntitle: y\n---\n- item\n";
    expect(ensureBlankAfterFrontmatter(input)).toBe(
      "---\nid: x\ntitle: y\n---\n\n- item\n",
    );
  });

  it("inserts when body starts with text right after the fence", () => {
    expect(
      ensureBlankAfterFrontmatter("---\nid: x\n---\nHello\n"),
    ).toBe("---\nid: x\n---\n\nHello\n");
  });

  it("leaves files that already have the blank alone", () => {
    const input = "---\nid: x\n---\n\n- item\n";
    expect(ensureBlankAfterFrontmatter(input)).toBe(input);
  });

  it("leaves files with multiple blank lines alone (does not collapse)", () => {
    const input = "---\nid: x\n---\n\n\n- item\n";
    expect(ensureBlankAfterFrontmatter(input)).toBe(input);
  });

  it("leaves files with no frontmatter alone", () => {
    expect(ensureBlankAfterFrontmatter("- just body\n")).toBe("- just body\n");
  });

  it("leaves a frontmatter-only file (no body) alone", () => {
    expect(ensureBlankAfterFrontmatter("---\nid: x\n---\n")).toBe(
      "---\nid: x\n---\n",
    );
  });

  it("leaves a malformed (unclosed) frontmatter alone", () => {
    expect(ensureBlankAfterFrontmatter("---\nid: x\nno close\n")).toBe(
      "---\nid: x\nno close\n",
    );
  });

  it("only acts on the *first* `---` block (not inline horizontal rules)", () => {
    // Body contains `---\n` as a horizontal rule; we must not touch it.
    const input = "---\nid: x\n---\n\nbefore\n\n---\n\nafter\n";
    expect(ensureBlankAfterFrontmatter(input)).toBe(input);
  });
});
