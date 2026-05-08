// CodeMirror extension that highlights org-style markup inside
// markdown headings.
//
// Two kinds of decorations are added per visible heading line:
//   - the leading word (TODO / DONE / WAITING / …) when it matches
//     a configured keyword. A `Decoration.mark` adds classes for
//     the keyword bucket and the literal name; CSS paints the
//     pill. Marks don't replace the underlying chars, so editing
//     and search continue to see the literal heading.
//   - the priority cookie `[#A]` / `[#B]` / `[#C]`. We use
//     `Decoration.replace` at the highest precedence here, not a
//     plain mark: Obsidian's Live Preview parser treats the
//     `[…]` brackets as link / reference syntax and adds its own
//     decorations on top, which clip our mark and collapse the
//     pill into a tiny coloured rectangle. Owning the range with
//     our own widget at `Prec.highest` (same trick `heading-
//     markers.ts` uses for `#`) renders the literal `[#X]` in
//     full and the pill stays intact.
//
// The keyword path stays a `mark` because the keyword text itself
// (TODO, NEXT, …) doesn't trip up Obsidian's parser the way the
// bracketed priority does.

import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const HEADING_RE = /^(#{1,6})(\s+)(\S+)/;
const PRIORITY_BLOCK_RE = /^\[#([A-Z])\]$/;

export type HeadingDecorationsOpts = {
  todoKeywords: () => readonly string[];
  doneKeywords: () => readonly string[];
};

class PriorityWidget extends WidgetType {
  constructor(
    public readonly text: string,
    public readonly letter: string,
    public readonly key: string,
  ) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return (
      other instanceof PriorityWidget &&
      other.text === this.text &&
      other.letter === this.letter &&
      other.key === this.key
    );
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `oak-md-priority oak-md-priority-${this.letter}`;
    span.textContent = this.text;
    return span;
  }
  // Pointer events pass through so a click on the pill places
  // the editor caret at its boundary, the same way clicking on
  // any other decorated text does.
  override ignoreEvent(): boolean {
    return false;
  }
}

export function headingDecorationsExtension(
  opts: HeadingDecorationsOpts,
) {
  return Prec.highest(
    ViewPlugin.fromClass(
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
    ),
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
    // intervening whitespace so the replace range covers
    // exactly `[#X]` (no leading space).
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
    addPriorityReplace(builder, lineFrom + cursor, pm[0], pm[1]!);
    return;
  }

  // No keyword: the first word might itself be a priority cookie
  // (e.g. `## [#A] Some title`). org's grammar pairs the priority
  // with the keyword slot, so we don't look further on this branch.
  const pm = firstWord.match(PRIORITY_BLOCK_RE);
  if (pm) {
    addPriorityReplace(builder, lineFrom + wordStart, firstWord, pm[1]!);
  }
}

function addPriorityReplace(
  builder: RangeSetBuilder<Decoration>,
  from: number,
  text: string,
  letter: string,
): void {
  builder.add(
    from,
    from + text.length,
    Decoration.replace({
      widget: new PriorityWidget(
        text,
        letter.toLowerCase(),
        String(from),
      ),
      inclusive: false,
    }),
  );
}
