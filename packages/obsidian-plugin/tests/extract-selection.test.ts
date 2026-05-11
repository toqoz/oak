import { describe, expect, it } from "vitest";
import { composePage } from "@oak/core";

import { extractFromSelection } from "../src/extract-selection.js";

// Slice the user-body region out of a composed oak page. The file
// shape is `---\n...\n---\n\n# Title\n[\n{body}]`. Everything after
// the title-heading line is the user body; returning it raw lets
// tests assert "what the user actually sees below the title".
function bodyOf(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n\n/);
  if (!m) throw new Error(`no frontmatter in:\n${text}`);
  const afterFm = text.slice(m[0].length);
  const titleMatch = afterFm.match(/^#\s[^\n]*\n/);
  if (!titleMatch) throw new Error(`no title heading in:\n${text}`);
  // Strip the title line *and* the single blank line that separates it
  // from the body, if present. Tests assert that the remaining body
  // never begins with a blank line.
  return afterFm.slice(titleMatch[0].length).replace(/^\n/, "");
}

describe("extractFromSelection — title", () => {
  it("uses the first non-blank line as the title", () => {
    const r = extractFromSelection("Hello\nworld\n");
    expect(r.title).toBe("Hello");
  });

  it("strips heading markers", () => {
    expect(extractFromSelection("## Foo bar\nbody").title).toBe("Foo bar");
    expect(extractFromSelection("###### Six\nbody").title).toBe("Six");
  });

  it("strips list bullets", () => {
    expect(extractFromSelection("- Foo\nbody").title).toBe("Foo");
    expect(extractFromSelection("* Foo\nbody").title).toBe("Foo");
    expect(extractFromSelection("+ Foo\nbody").title).toBe("Foo");
  });

  it("strips ordered list markers", () => {
    expect(extractFromSelection("1. Foo\nbody").title).toBe("Foo");
    expect(extractFromSelection("12) Foo\nbody").title).toBe("Foo");
  });

  it("strips checkbox markers", () => {
    expect(extractFromSelection("- [ ] Todo item\nbody").title).toBe(
      "Todo item",
    );
    expect(extractFromSelection("[x] Done thing\nbody").title).toBe(
      "Done thing",
    );
  });

  it("strips blockquote markers", () => {
    expect(extractFromSelection("> Quoted\nbody").title).toBe("Quoted");
  });

  it("peels nested block markers in one pass", () => {
    expect(extractFromSelection("> - ## Foo\nbody").title).toBe("Foo");
  });

  it("strips bold and italic emphasis", () => {
    expect(extractFromSelection("**Foo**\nbody").title).toBe("Foo");
    expect(extractFromSelection("__Foo__\nbody").title).toBe("Foo");
    expect(extractFromSelection("*Foo*\nbody").title).toBe("Foo");
    expect(extractFromSelection("_Foo_\nbody").title).toBe("Foo");
  });

  it("strips strikethrough and inline code", () => {
    expect(extractFromSelection("~~Foo~~\nbody").title).toBe("Foo");
    expect(extractFromSelection("`Foo`\nbody").title).toBe("Foo");
  });

  it("combines block and inline strip", () => {
    expect(extractFromSelection("- **Foo bar**\nbody").title).toBe("Foo bar");
  });

  it("preserves wiki and markdown link labels", () => {
    expect(extractFromSelection("[[Page]]\nbody").title).toBe("Page");
    expect(extractFromSelection("[[Page|Alias]]\nbody").title).toBe("Alias");
    expect(extractFromSelection("[Label](https://x)\nbody").title).toBe(
      "Label",
    );
  });

  it("skips leading blank lines when picking the title line", () => {
    expect(extractFromSelection("\n\n  \n# Foo\nrest\n").title).toBe("Foo");
  });

  it("returns empty title when there is no usable content", () => {
    const r = extractFromSelection("   \n\n");
    expect(r.title).toBe("");
    expect(r.body).toBe("");
    expect(r.replacement).toBe("");
  });
});

describe("extractFromSelection — body dedent", () => {
  it("re-bases sub-list items by the minimum indent", () => {
    const input = "    - a\n        - b\n        - c\n            - d";
    const r = extractFromSelection(input);
    expect(r.title).toBe("a");
    expect(r.body).toBe("- b\n- c\n    - d");
  });

  it("collapses leading blank lines between title and body", () => {
    expect(extractFromSelection("# Foo\n\n\nbody line\n").body).toBe(
      "body line",
    );
  });

  it("returns empty body when only the title line is present", () => {
    expect(extractFromSelection("# Foo").body).toBe("");
  });

  it("dedents tab-indented bodies", () => {
    const r = extractFromSelection("- a\n\t- b\n\t\t- c");
    expect(r.body).toBe("- b\n\t- c");
  });

  it("dedents heterogeneous body indents to the minimum", () => {
    const r = extractFromSelection("- a\n    - b\n  - c");
    // min indent = 2
    expect(r.body).toBe("  - b\n- c");
  });

  it("preserves blank lines inside the body", () => {
    const r = extractFromSelection("- a\n  - b\n\n  - c");
    expect(r.body).toBe("- b\n\n- c");
  });
});

describe("extractFromSelection — replacement", () => {
  it("preserves the first line's indent and bullet, replaces only the title", () => {
    const r = extractFromSelection(
      "    - a\n        - b\n        - c\n            - d",
    );
    expect(r.replacement).toBe("    - [[a]]");
  });

  it("preserves heading markers in the replacement", () => {
    expect(extractFromSelection("## Foo\nbody").replacement).toBe(
      "## [[Foo]]",
    );
  });

  it("preserves blockquote markers", () => {
    expect(extractFromSelection("> Quoted\n> more").replacement).toBe(
      "> [[Quoted]]",
    );
  });

  it("preserves checkbox markers", () => {
    expect(extractFromSelection("- [ ] Todo\nbody").replacement).toBe(
      "- [ ] [[Todo]]",
    );
  });

  it("plain paragraphs are wrapped without prefix", () => {
    expect(extractFromSelection("Hello world").replacement).toBe(
      "[[Hello world]]",
    );
  });

  it("preserves the first line's leading whitespace even with no marker", () => {
    expect(extractFromSelection("    Hello\nbody").replacement).toBe(
      "    [[Hello]]",
    );
  });

  it("keeps a trailing newline when the selection ended with one", () => {
    // Line-based selections (triple-click / shift-down) typically end
    // with a newline. The replacement must keep that newline so the
    // following line in the source page doesn't get glued onto our
    // wikilink line.
    expect(
      extractFromSelection("    - a\n        - b\n").replacement,
    ).toBe("    - [[a]]\n");
  });

  it("does not add a trailing newline when the selection had none", () => {
    expect(
      extractFromSelection("    - a\n        - b").replacement,
    ).toBe("    - [[a]]");
  });
});

describe("extractFromSelection — composed file body", () => {
  // Lock down the *visible* body of the new oak page (the part after
  // the YAML frontmatter). Regression target: the body must NOT begin
  // with a blank line.

  it("nested-list selection produces a body whose first line is the dedented child", () => {
    const sel = "    - a\n        - b\n        - c\n            - d";
    const { title, body } = extractFromSelection(sel);
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    expect(visible.startsWith("\n")).toBe(false);
    expect(visible.split("\n")[0]).toBe("- b");
    expect(visible).toBe("- b\n- c\n    - d\n");
  });

  it("nested-list selection with a trailing newline still yields a clean body", () => {
    // Triple-click style selection — last char is `\n`.
    const sel = "    - a\n        - b\n        - c\n            - d\n";
    const { title, body } = extractFromSelection(sel);
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    expect(visible.startsWith("\n")).toBe(false);
    expect(visible.split("\n")[0]).toBe("- b");
    expect(visible).toBe("- b\n- c\n    - d\n");
  });

  it("heading + paragraph yields a body that starts with the paragraph", () => {
    const { title, body } = extractFromSelection("# Foo\nfirst body line");
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    expect(visible.startsWith("\n")).toBe(false);
    expect(visible.split("\n")[0]).toBe("first body line");
  });

  it("title-only selection yields an empty body (no stray blank line)", () => {
    const { title, body } = extractFromSelection("- single item");
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    expect(visible).toBe("");
  });

  it("selection with internal blank lines preserves them but never starts blank", () => {
    const sel = "- a\n  - b\n\n  - c";
    const { title, body } = extractFromSelection(sel);
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    expect(visible.split("\n")[0]).toBe("- b");
    expect(visible).toBe("- b\n\n- c\n");
  });

  it("selection with trailing blank lines does not produce extra blank tail in body", () => {
    const sel = "    - a\n        - b\n\n\n";
    const { title, body } = extractFromSelection(sel);
    const composed = composePage({ title, body });
    const visible = bodyOf(composed.text);
    // Leading: "- b". Trailing: at most a single newline terminator.
    expect(visible.split("\n")[0]).toBe("- b");
    expect(visible).toBe("- b\n");
  });
});
