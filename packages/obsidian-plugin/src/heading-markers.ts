// Keep the leading `#` characters of heading lines visible — and
// selectable — in Obsidian's Live Preview.
//
// Live Preview hides those characters by registering a
// `Decoration.replace` over them: on inactive heading lines the
// markers are removed from the DOM entirely, so plain CSS visibility
// tricks (display: inline, visibility: visible, …) can't bring them
// back. CSS `::before` pseudo-elements *can* paint the markers, but
// the projected text is not part of the document and therefore
// can't be selected or copied — defeating the "raw markdown
// reading and editing" experience we want for org-style notes.
//
// We work around this by registering our own extension at the
// highest precedence. It applies its own `Decoration.replace` to
// the heading marker range with a widget whose DOM is a single
// `<span>` containing the literal `#` chars. With higher precedence,
// our replace wins over Obsidian's hider, so the user sees real
// text — and because CodeMirror's selection works on document
// positions (not the rendered DOM), selecting through the widget
// still captures the underlying `#` chars on copy.
//
// We use two widget shapes per heading, picked by whether the
// editor cursor is on the line:
//
//   - active line (cursor on it): one Decoration.replace per
//     character in the prefix. Each replace is atomic over a
//     single column, so the caret can sit between the two hashes,
//     Backspace removes a single `#` at a time, and the trailing
//     whitespace is its own deletable character — matching the
//     experience of editing the raw markdown.
//
//   - inactive line (cursor elsewhere or editor unfocused): one
//     Decoration.replace covering the whole prefix. The per-char
//     approach doesn't survive on inactive lines because of how
//     CM6 resolves overlapping replaces: the renderer iterates
//     decorations in (from, startSide) order, applies each in
//     turn, and once a decoration is applied its range becomes
//     "occupied". When the *next* decoration overlaps an already-
//     occupied range, CM6 clips it to the unoccupied remainder
//     instead of dropping it. So with our `[0, 1)`, Obsidian's
//     `[0, prefix]`, our `[1, 2)`, our `[2, 3)` lined up at
//     `from = 0, 0, 1, 2` respectively:
//
//        1. `us [0, 1)` wins at from = 0 (precedence + sort order)
//           → occupies [0, 1).
//        2. `obs [0, prefix]` runs next; clipped against [0, 1)
//           it applies as [1, prefix] → occupies [1, prefix].
//        3. `us [1, 2)` and `us [2, 3)` are now fully covered by
//           the occupied range and get dropped.
//
//     Sort-order tricks (`inclusive: true`) don't help: even with
//     all of us sorted strictly ahead of Obsidian at every
//     `from`, step 2 still happens at from = 0 immediately after
//     step 1 — the clipped Obsidian range claims the rest of the
//     prefix before steps 3 and 4 ever run. The only way out is
//     to own the entire range Obsidian targets in one decoration,
//     which is what the inactive shape does.
//
// The two shapes render the same `## ` text with the same styling,
// so the swap on focus change is visually a no-op. Inactive
// readers lose the ability to drop their caret between the hashes,
// but they're not editing — and as soon as they click into the
// line it becomes active and per-char editing kicks in.
//
// Window blur is treated as inactive across the board: Obsidian's
// hider runs over the cursor's line too while the editor lacks
// focus, so we route every line through the single-widget shape
// and never lose the visible markers.

import { Prec, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

// Cover the hashes *plus* the trailing whitespace. Obsidian's own
// hider decoration runs across that whole prefix, so a tighter
// regex would let the space fall back to Obsidian's hide and
// disappear from the rendering, even though our widget restores
// the hashes themselves.
const HEADING_MARKER_RE = /^#{1,6}\s+/;

class HeadingMarkerWidget extends WidgetType {
  constructor(
    public readonly text: string,
    public readonly key: string,
  ) {
    super();
  }
  // `key` carries the absolute document position of the char we're
  // rendering. Without it, two of our active-line per-char widgets
  // for adjacent identical `#` chars would satisfy `eq` against
  // each other; CM6 might then reuse a single DOM node across the
  // positions and drop the rendering down to one visible hash even
  // when two replaces are in the range set.
  override eq(other: WidgetType): boolean {
    return (
      other instanceof HeadingMarkerWidget &&
      other.text === this.text &&
      other.key === this.key
    );
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "oak-md-heading-marker";
    span.textContent = this.text;
    return span;
  }
  // Pointer events pass through so a click on the widget still
  // places the editor caret at its boundary — required for the
  // inactive shape so that clicking the displayed `## ` enters the
  // line and switches it over to the per-char (editable) shape.
  override ignoreEvent(): boolean {
    return false;
  }
}

export function headingMarkersExtension() {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          // selectionSet → cursor moved between lines, swapping
          // active-line per-char widgets with inactive single
          // widgets. focusChanged → blur/refocus flips every line
          // between the two modes (Obsidian hides markers across
          // the board when the editor loses focus).
          if (
            u.docChanged ||
            u.viewportChanged ||
            u.selectionSet ||
            u.focusChanged
          ) {
            this.decorations = build(u.view);
          }
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    ),
  );
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // When the editor is unfocused, Obsidian re-applies its hider to
  // every line including the cursor's. Treat that case as inactive
  // across the board so the visible markers are preserved by our
  // single-widget shape on every heading.
  const cursorLineNum = view.hasFocus
    ? view.state.doc.lineAt(view.state.selection.main.head).number
    : -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const m = line.text.match(HEADING_MARKER_RE);
      if (m) {
        const prefix = m[0];
        if (line.number === cursorLineNum) {
          // Active line: per-char widgets so the caret can sit
          // between the hashes and Backspace removes one at a time.
          for (let i = 0; i < prefix.length; i++) {
            const at = line.from + i;
            ranges.push(
              Decoration.replace({
                widget: new HeadingMarkerWidget(
                  prefix[i]!,
                  String(at),
                ),
                inclusive: false,
              }).range(at, at + 1),
            );
          }
        } else {
          // Inactive line: single widget covering the whole prefix.
          // Atomic for cursor motion, but we own the range outright
          // so Obsidian's hider can't clip into it.
          ranges.push(
            Decoration.replace({
              widget: new HeadingMarkerWidget(
                prefix,
                String(line.from),
              ),
              inclusive: false,
            }).range(line.from, line.from + prefix.length),
          );
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}
