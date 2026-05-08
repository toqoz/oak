// CodeMirror extension that highlights org-style markup inside
// markdown headings.
//
// Two kinds of marks are added per visible heading line:
//   - the leading word (TODO / DONE / WAITING / …) when it matches
//     a configured keyword. Open and closed states get separate
//     classes so CSS can paint them in different palettes.
//   - the priority cookie `[#A]` / `[#B]` / `[#C]`. Recognised when
//     it appears immediately after the keyword (or as the first
//     word, for plain prioritised headings without a keyword).
//
// The decorations are pure overlays via `Decoration.mark`: the
// underlying heading text is unchanged, so the parser, editing, and
// search behavior stay identical.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const HEADING_RE = /^(#{1,6})(\s+)(\S+)/;
const PRIORITY_BLOCK_RE = /^\[#([A-Z])\]$/;

export type HeadingDecorationsOpts = {
  todoKeywords: () => readonly string[];
  doneKeywords: () => readonly string[];
};

export function headingDecorationsExtension(
  opts: HeadingDecorationsOpts,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.view, opts);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

function build(view: EditorView, opts: HeadingDecorationsOpts): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const todoSet = new Set(opts.todoKeywords());
  const doneSet = new Set(opts.doneKeywords());
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      processLine(builder, line.from, line.text, todoSet, doneSet);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function processLine(
  builder: RangeSetBuilder<Decoration>,
  lineFrom: number,
  text: string,
  todoSet: Set<string>,
  doneSet: Set<string>,
): void {
  const m = text.match(HEADING_RE);
  if (!m) return;
  const hashes = m[1]!;
  const ws = m[2]!;
  const firstWord = m[3]!;
  const wordStart = hashes.length + ws.length;
  const wordEnd = wordStart + firstWord.length;

  if (todoSet.has(firstWord) || doneSet.has(firstWord)) {
    // Two classes per keyword: a generic open/closed marker plus the
    // lowercase keyword itself, so CSS can paint TODO red, NEXT
    // blue, etc., and still fall back to one shared style for any
    // user-defined keyword that doesn't have its own rule.
    const variant = todoSet.has(firstWord) ? "open" : "closed";
    builder.add(
      lineFrom + wordStart,
      lineFrom + wordEnd,
      Decoration.mark({
        class: `oak-md-keyword oak-md-keyword-${variant} oak-md-keyword-${firstWord.toLowerCase()}`,
      }),
    );
    // After a keyword, optionally a priority cookie. Skip
    // intervening whitespace so the mark range covers exactly
    // `[#X]` (no leading space).
    let cursor = wordEnd;
    while (
      cursor < text.length &&
      (text[cursor] === " " || text[cursor] === "\t")
    ) {
      cursor++;
    }
    if (cursor >= text.length) return;
    const pm = text.slice(cursor).match(/^\[#([A-Z])\]/);
    if (!pm) return;
    const letter = pm[1]!.toLowerCase();
    builder.add(
      lineFrom + cursor,
      lineFrom + cursor + 4,
      Decoration.mark({
        class: `oak-md-priority oak-md-priority-${letter}`,
      }),
    );
    return;
  }

  // No keyword: the first word might itself be a priority cookie
  // (e.g. `## [#A] Some title`). org's grammar pairs the priority
  // with the keyword slot, so we don't look further on this branch.
  const pm = firstWord.match(PRIORITY_BLOCK_RE);
  if (pm) {
    const letter = pm[1]!.toLowerCase();
    builder.add(
      lineFrom + wordStart,
      lineFrom + wordEnd,
      Decoration.mark({
        class: `oak-md-priority oak-md-priority-${letter}`,
      }),
    );
  }
}
