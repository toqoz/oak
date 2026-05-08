// CodeMirror extension for editing SCHEDULED / DEADLINE on TODO
// heading lines.
//
// UX:
//   - Cursor anywhere inside a TODO heading's scope    → a calendar
//     icon appears in the left margin of the heading line. "Scope"
//     means the heading line itself or any line of its body content
//     (including nested non-TODO subsections), per org-mode's
//     ancestor semantics.
//   - Click the icon                                   → a tooltip
//     opens below the heading, displaying the current SCHEDULED and
//     DEADLINE and offering edit / clear on each.
//   - Move the cursor out of the scope or press Esc    → the tooltip
//     and icon both disappear.
//
// The TODO keyword set comes from the live agenda config (.oak/agenda.yml)
// via the `todoKeywords` callback the plugin passes in.
//
// Each tooltip row independently transitions between two states:
//   view  →  shows the current value (or `—`) plus `edit`/`set`/`clear`
//   cal   →  month grid with ◀ / ▶ navigation, plus quick-pick links
//            (today / tomorrow / next mon / +7d) above the grid
//
// Commit reuses core's parsePlanningLine + formatTimestamp so the
// resulting line stays equivalent to whatever writeback would produce.

import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type TooltipView,
  type ViewUpdate,
  WidgetType,
  keymap,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";

import {
  addUnits,
  dateOnly,
  dayOfWeek,
  formatTimestamp,
  parsePlanningLine,
  todayIso,
  type AgendaTimestamp,
} from "@oak/core";

const HEADING_RE = /^(#{1,6})\s+(\S+)/;
const MS_PER_DAY = 86_400_000;

type PlanningField = "SCHEDULED" | "DEADLINE";

// Toggle: open if not already open at this line, otherwise close.
const toggleAgendaTooltip = StateEffect.define<{ line: number }>();
// Force-close (Esc, dismiss button).
const closeAgendaTooltip = StateEffect.define<void>();

export type AgendaTooltipOpts = {
  todoKeywords: () => readonly string[];
  // 0 = Sunday-first column, 1 = Monday-first.
  weekStartsOn: () => 0 | 1;
};

// Inline calendar icon — same lucide-style stroke set Obsidian itself
// uses, kept tiny so it sits in the left margin without crowding the
// heading.
const CALENDAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';

class IconWidget extends WidgetType {
  constructor(public readonly line: number) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return other instanceof IconWidget && other.line === this.line;
  }
  override toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "oak-agenda-line-icon";
    btn.setAttribute("aria-label", "Edit SCHEDULED / DEADLINE");
    btn.innerHTML = CALENDAR_SVG;
    // Suppress mousedown so clicking the icon doesn't move the editor
    // caret (which would close the tooltip a tick later when the
    // cursor lands somewhere else inside the widget).
    btn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
    });
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      view.dispatch({ effects: toggleAgendaTooltip.of({ line: this.line }) });
    });
    return btn;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

type FieldVal = {
  cursorLine: number | null;
  decorations: DecorationSet;
  openLine: number | null;
  tooltips: readonly Tooltip[];
};

const EMPTY_FV: FieldVal = {
  cursorLine: null,
  decorations: Decoration.none,
  openLine: null,
  tooltips: [],
};

// Find the nearest TODO heading whose scope contains the cursor.
// "Scope" follows org-mode parent semantics: walk back from the
// cursor line through ancestor headings (each strictly higher in the
// hierarchy than the last one seen). The first such heading whose
// keyword is in `todoKeywords` is the answer.
//
// Returns null when there is no TODO ancestor — e.g., the cursor is
// in a section under a non-TODO heading at the top level, or the
// cursor sits in front-matter / a code fence above any heading.
function detectCursorHeading(
  state: EditorState,
  todoKeywords: readonly string[],
): { line: number; from: number } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const startLine = state.doc.lineAt(sel.head).number;

  // Acceptable headings shrink as we walk back: once we see a
  // heading at level L, only strictly higher-level (smaller number)
  // headings can be ancestors of the cursor's location.
  let acceptableLevel = 7;
  for (let n = startLine; n >= 1; n--) {
    const l = state.doc.line(n);
    const m = l.text.match(HEADING_RE);
    if (!m) continue;
    const level = m[1]!.length;
    if (level >= acceptableLevel) continue;
    const firstWord = m[2]!;
    if (todoKeywords.includes(firstWord)) {
      return { line: n, from: l.from };
    }
    acceptableLevel = level;
  }
  return null;
}

export function agendaTooltipExtension(opts: AgendaTooltipOpts) {
  const field = StateField.define<FieldVal>({
    create(state) {
      return computeFV(state, opts, EMPTY_FV);
    },
    update(prev, tr) {
      let openOverride: number | null | undefined;
      for (const e of tr.effects) {
        if (e.is(toggleAgendaTooltip)) {
          openOverride =
            prev.openLine === e.value.line ? null : e.value.line;
        } else if (e.is(closeAgendaTooltip)) {
          openOverride = null;
        }
      }
      const intermediate =
        openOverride === undefined
          ? prev
          : { ...prev, openLine: openOverride };
      if (
        !tr.docChanged &&
        !tr.selection &&
        openOverride === undefined
      ) {
        return prev;
      }
      return computeFV(tr.state, opts, intermediate);
    },
    provide: (f) => [
      EditorView.decorations.compute([f], (s) => s.field(f).decorations),
      showTooltip.computeN([f], (s) => s.field(f).tooltips),
    ],
  });

  // Capture Escape only while our tooltip is visible. When it isn't,
  // returning false lets the keystroke through so other Esc handlers
  // (Obsidian's own, vim mode, etc.) still work normally.
  const escapeBinding = Prec.high(
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          const fv = view.state.field(field, false);
          if (!fv || fv.tooltips.length === 0) return false;
          view.dispatch({ effects: closeAgendaTooltip.of(undefined) });
          return true;
        },
      },
    ]),
  );
  return [field, escapeBinding];
}

function computeFV(
  state: EditorState,
  opts: AgendaTooltipOpts,
  prev: FieldVal,
): FieldVal {
  const detected = detectCursorHeading(state, opts.todoKeywords());
  if (!detected) return EMPTY_FV;

  const sameLine = prev.cursorLine === detected.line;

  // Tooltip only stays open while the cursor remains on the same
  // heading line that opened it. Any cursor move outside the line
  // tears it down (handled by the EMPTY_FV early-return above for
  // non-heading lines, and here for moves between headings).
  let openLine = prev.openLine;
  if (openLine !== null && openLine !== detected.line) openLine = null;

  let decorations = prev.decorations;
  if (!sameLine || decorations === Decoration.none) {
    decorations = Decoration.set(
      [
        Decoration.line({ class: "oak-agenda-line-anchor" }).range(
          detected.from,
        ),
        // side: 1 keeps the widget on this line (vs. trailing the
        // previous line's break). Block widgets would push the heading
        // text down; we want the icon inline so it can hang into the
        // left padding without disturbing the heading position.
        Decoration.widget({
          widget: new IconWidget(detected.line),
          side: 1,
        }).range(detected.from),
      ],
      true,
    );
  }

  let tooltips: readonly Tooltip[] = [];
  if (openLine === detected.line) {
    if (
      prev.openLine === detected.line &&
      prev.tooltips.length > 0 &&
      sameLine
    ) {
      // Preserve the tooltip identity so CM6 keeps the existing DOM
      // (and any per-row state inside it) instead of remounting on
      // every keystroke.
      tooltips = prev.tooltips;
    } else {
      const headingFrom = detected.from;
      tooltips = [
        {
          pos: headingFrom,
          above: false,
          strictSide: false,
          arrow: false,
          create: (view) => makeTooltipView(view, headingFrom, opts),
        },
      ];
    }
  }

  return {
    cursorLine: detected.line,
    decorations,
    openLine,
    tooltips,
  };
}

type RowMode =
  | { kind: "view" }
  | { kind: "cal"; year: number; month: number };

function makeTooltipView(
  view: EditorView,
  headingFrom: number,
  opts: AgendaTooltipOpts,
): TooltipView {
  const wrapper = document.createElement("div");
  wrapper.className = "oak-agenda-tooltip";

  const rowModes: Record<PlanningField, RowMode> = {
    SCHEDULED: { kind: "view" },
    DEADLINE: { kind: "view" },
  };

  const dismiss = () => {
    view.dispatch({ effects: closeAgendaTooltip.of(undefined) });
    view.focus();
  };

  const renderAll = () => {
    wrapper.replaceChildren();

    const header = document.createElement("div");
    header.className = "oak-agenda-tooltip-header";
    const title = document.createElement("span");
    title.className = "oak-agenda-tooltip-title";
    title.textContent = "Plan";
    header.appendChild(title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "oak-agenda-tooltip-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.preventDefault();
      dismiss();
    });
    header.appendChild(close);
    wrapper.appendChild(header);

    const planning = readPlanningTimestamps(view, headingFrom);

    for (const field of ["SCHEDULED", "DEADLINE"] as PlanningField[]) {
      const row = document.createElement("div");
      row.className = "oak-agenda-tooltip-row";

      const label = document.createElement("span");
      label.className = "oak-agenda-tooltip-label";
      label.textContent = field;
      row.appendChild(label);

      const ts =
        field === "SCHEDULED" ? planning.scheduled : planning.deadline;
      const mode = rowModes[field];

      if (mode.kind === "view") {
        renderViewMode(row, field, ts);
      } else {
        renderCalMode(row, field, mode.year, mode.month);
      }

      wrapper.appendChild(row);
    }
  };

  const renderViewMode = (
    row: HTMLElement,
    field: PlanningField,
    ts: AgendaTimestamp | undefined,
  ): void => {
    // The value itself is the affordance to open the picker — no
    // separate "edit" button. When the field is empty there is
    // nothing to click on, so we fall back to a `set` link.
    const openPicker = () => {
      const seed = splitYearMonth(
        ts ? dateOnly(ts.iso) : todayIso(new Date()),
      );
      rowModes[field] = { kind: "cal", year: seed.year, month: seed.month };
      renderAll();
    };

    if (ts) {
      const value = document.createElement("button");
      value.type = "button";
      value.className = "oak-agenda-tooltip-value";
      value.textContent = formatTsForDisplay(ts);
      value.setAttribute("aria-label", `Edit ${field}`);
      value.addEventListener("click", (ev) => {
        ev.preventDefault();
        openPicker();
      });
      row.appendChild(value);

      const clear = makeLink("clear", () => {
        // Same ordering caveat as `commit`: reset the row mode before
        // dispatching so the synchronous re-render sees "view".
        rowModes[field] = { kind: "view" };
        clearPlanningField(view, headingFrom, field);
      });
      clear.classList.add("oak-agenda-tooltip-clear");
      clear.setAttribute("aria-label", `Clear ${field}`);
      row.appendChild(clear);
    } else {
      const empty = document.createElement("span");
      empty.className = "oak-agenda-tooltip-value is-empty";
      empty.textContent = "—";
      row.appendChild(empty);

      const setBtn = makeLink("set", openPicker);
      row.appendChild(setBtn);
    }
  };

  const renderCalMode = (
    row: HTMLElement,
    field: PlanningField,
    year: number,
    month: number,
  ): void => {
    row.classList.add("oak-agenda-tooltip-row-cal");

    const header = document.createElement("div");
    header.className = "oak-agenda-tooltip-cal-header";
    header.appendChild(
      makeBtn("◀", () => {
        const next = shiftMonth(year, month, -1);
        rowModes[field] = {
          kind: "cal",
          year: next.year,
          month: next.month,
        };
        renderAll();
      }),
    );
    const label = document.createElement("span");
    label.className = "oak-agenda-tooltip-cal-label";
    label.textContent = `${year}-${pad2(month)}`;
    header.appendChild(label);
    header.appendChild(
      makeBtn("▶", () => {
        const next = shiftMonth(year, month, 1);
        rowModes[field] = {
          kind: "cal",
          year: next.year,
          month: next.month,
        };
        renderAll();
      }),
    );
    const cancel = makeBtn("cancel", () => {
      rowModes[field] = { kind: "view" };
      renderAll();
    });
    cancel.classList.add("oak-agenda-tooltip-back");
    header.appendChild(cancel);
    row.appendChild(header);

    // Quick-pick shortcuts above the grid — keeps `today` / `next mon`
    // a single click instead of forcing the user to hunt through the
    // grid and switch months.
    const today = todayIso(new Date());
    const presets: { label: string; iso: string }[] = [
      { label: "today", iso: today },
      { label: "tomorrow", iso: addUnits(today, 1, "d") },
      { label: "next mon", iso: nextMonday(today) },
      { label: "+7d", iso: addUnits(today, 7, "d") },
    ];
    const presetRow = document.createElement("div");
    presetRow.className = "oak-agenda-tooltip-cal-presets";
    for (const p of presets) {
      presetRow.appendChild(
        makeLink(p.label, () => {
          commit(field, { iso: p.iso, hasTime: false, active: true });
        }),
      );
    }
    row.appendChild(presetRow);

    const grid = document.createElement("div");
    grid.className = "oak-agenda-tooltip-cal-grid";
    const weekStart = opts.weekStartsOn();
    const dowLabels =
      weekStart === 1
        ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (const d of dowLabels) {
      const cell = document.createElement("span");
      cell.className = "oak-agenda-tooltip-cal-dow";
      cell.textContent = d;
      grid.appendChild(cell);
    }
    const cells = monthGrid(year, month, weekStart);
    for (const c of cells) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oak-agenda-tooltip-cal-day";
      if (!c.inMonth) btn.classList.add("is-off-month");
      if (c.iso === today) btn.classList.add("is-today");
      btn.textContent = String(c.day);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        commit(field, { iso: c.iso, hasTime: false, active: true });
      });
      grid.appendChild(btn);
    }
    row.appendChild(grid);
  };

  const commit = (field: PlanningField, ts: AgendaTimestamp) => {
    // Reset the row mode *before* dispatching, since dispatch can
    // synchronously trigger our `update()` callback — which renders
    // from `rowModes` and would otherwise still see "presets" / "cal".
    rowModes[field] = { kind: "view" };
    insertPlanningField(view, headingFrom, field, ts);
  };

  wrapper.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    dismiss();
  });

  renderAll();

  return {
    dom: wrapper,
    update: (update: ViewUpdate) => {
      // Re-render after a doc change so SCHEDULED / DEADLINE values
      // displayed in the tooltip stay in sync with whatever was just
      // written.
      if (update.docChanged) renderAll();
    },
  };
}

function makeRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "oak-agenda-tooltip-row";
  return row;
}

function makeBtn(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "oak-agenda-tooltip-btn";
  btn.textContent = label;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  return btn;
}

function makeLink(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "oak-agenda-tooltip-link";
  btn.textContent = label;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  return btn;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function splitYearMonth(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-");
  return { year: parseInt(y!, 10), month: parseInt(m!, 10) };
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return { year: y, month: m };
}

// Strictly-next Monday: if `today` is itself Monday, returns today + 7d.
export function nextMonday(today: string): string {
  const dow = dayOfWeek(today); // 0=Sun..6=Sat
  let delta = (1 - dow + 7) % 7;
  if (delta === 0) delta = 7;
  return addUnits(today, delta, "d");
}

type CalCell = {
  iso: string;
  day: number;
  inMonth: boolean;
};

// 6 weeks (42 cells) starting on `weekStart`, covering `month`.
export function monthGrid(
  year: number,
  month: number,
  weekStart: 0 | 1,
): CalCell[] {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const startOffset = (firstDow - weekStart + 7) % 7;
  const startMs = Date.UTC(year, month - 1, 1) - startOffset * MS_PER_DAY;
  const out: CalCell[] = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(startMs + i * MS_PER_DAY);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    out.push({
      iso: `${y}-${pad2(m)}-${pad2(d)}`,
      day: d,
      inMonth: m === month,
    });
  }
  return out;
}

// Strip the surrounding `<…>` / `[…]` brackets that `formatTimestamp`
// emits, since the tooltip frame already supplies the visual chrome
// and brackets just add noise inline.
function formatTsForDisplay(ts: AgendaTimestamp): string {
  return formatTimestamp(ts).replace(/^[<\[]/, "").replace(/[>\]]$/, "");
}

function findPlanningLineBelow(
  state: EditorState,
  headingLineNumber: number,
): { from: number; to: number; text: string } | null {
  let probeNum = headingLineNumber + 1;
  while (probeNum <= state.doc.lines) {
    const l = state.doc.line(probeNum);
    if (l.text.trim().length === 0) {
      probeNum++;
      continue;
    }
    const parsed = parsePlanningLine(l.text);
    if (parsed.matched) return { from: l.from, to: l.to, text: l.text };
    return null;
  }
  return null;
}

function readPlanningTimestamps(
  view: EditorView,
  headingFrom: number,
): {
  scheduled?: AgendaTimestamp;
  deadline?: AgendaTimestamp;
  closed?: AgendaTimestamp;
} {
  const state = view.state;
  const headingLine = state.doc.lineAt(headingFrom);
  const pl = findPlanningLineBelow(state, headingLine.number);
  if (!pl) return {};
  const parsed = parsePlanningLine(pl.text);
  const out: ReturnType<typeof readPlanningTimestamps> = {};
  if (parsed.scheduled) out.scheduled = parsed.scheduled;
  if (parsed.deadline) out.deadline = parsed.deadline;
  if (parsed.closed) out.closed = parsed.closed;
  return out;
}

export function insertPlanningField(
  view: EditorView,
  headingFrom: number,
  field: PlanningField,
  ts: AgendaTimestamp,
): void {
  const state = view.state;
  const headingLine = state.doc.lineAt(headingFrom);
  const planningLine = findPlanningLineBelow(state, headingLine.number);

  let scheduled: AgendaTimestamp | undefined;
  let deadline: AgendaTimestamp | undefined;
  let closed: AgendaTimestamp | undefined;
  let indent = "";
  if (planningLine) {
    const parsed = parsePlanningLine(planningLine.text);
    scheduled = parsed.scheduled;
    deadline = parsed.deadline;
    closed = parsed.closed;
    indent = planningLine.text.match(/^\s*/)?.[0] ?? "";
  }
  if (field === "SCHEDULED") scheduled = ts;
  else deadline = ts;

  const newLine = renderPlanningLine(indent, scheduled, deadline, closed);
  if (planningLine) {
    view.dispatch({
      changes: {
        from: planningLine.from,
        to: planningLine.to,
        insert: newLine,
      },
    });
  } else {
    const insertAt = headingLine.to;
    view.dispatch({
      changes: { from: insertAt, to: insertAt, insert: `\n${newLine}` },
    });
  }
}

export function clearPlanningField(
  view: EditorView,
  headingFrom: number,
  field: PlanningField,
): void {
  const state = view.state;
  const headingLine = state.doc.lineAt(headingFrom);
  const planningLine = findPlanningLineBelow(state, headingLine.number);
  if (!planningLine) return;

  const parsed = parsePlanningLine(planningLine.text);
  let scheduled = parsed.scheduled;
  let deadline = parsed.deadline;
  const closed = parsed.closed;
  if (field === "SCHEDULED") scheduled = undefined;
  else deadline = undefined;
  const indent = planningLine.text.match(/^\s*/)?.[0] ?? "";

  if (!scheduled && !deadline && !closed) {
    // No tokens left: remove the entire planning line, including the
    // newline that separates it from the heading. Falling back to
    // trimming the trailing newline keeps the doc tidy when the
    // planning line is the very last line in the buffer.
    let from = planningLine.from;
    let to = planningLine.to;
    if (from > 0) from -= 1;
    else if (to < state.doc.length) to += 1;
    view.dispatch({ changes: { from, to, insert: "" } });
    return;
  }

  const newLine = renderPlanningLine(indent, scheduled, deadline, closed);
  view.dispatch({
    changes: {
      from: planningLine.from,
      to: planningLine.to,
      insert: newLine,
    },
  });
}

function renderPlanningLine(
  indent: string,
  scheduled: AgendaTimestamp | undefined,
  deadline: AgendaTimestamp | undefined,
  closed: AgendaTimestamp | undefined,
): string {
  const parts: string[] = [];
  if (scheduled) parts.push(`SCHEDULED: ${formatTimestamp(scheduled)}`);
  if (deadline) parts.push(`DEADLINE: ${formatTimestamp(deadline)}`);
  if (closed) parts.push(`CLOSED: ${formatTimestamp(closed)}`);
  return `${indent}${parts.join(" ")}`;
}

// Re-exported but unused; kept so callers that previously imported
// `makeRow` from this module don't break.
export { makeRow };
