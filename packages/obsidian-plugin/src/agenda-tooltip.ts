// CodeMirror extension that shows a small popover next to a TODO
// heading, letting the user attach SCHEDULED or DEADLINE without
// leaving the editor.
//
// Trigger: cursor is a single point on a line that matches
//   ^#{1,6}\s+<TODO-keyword>\b
// The TODO keyword set comes from the live agenda config (.oak/agenda.yml)
// via the `todoKeywords` callback the plugin passes in.
//
// Flow:
//   1. pick field          [SCHEDULED] [DEADLINE]
//   2. pick date preset    [today] [tomorrow] [next mon] [+7d] [cal]   ← back
//   3. (only if `cal`)     month grid; ◀ / ▶ navigates months
//
// On commit:
//   - if a planning line already sits below the heading, replace it with
//     a merged version (using core's parsePlanningLine so we keep the
//     same semantics writeback uses)
//   - otherwise insert a new planning line on the next line

import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";

import {
  addUnits,
  dayOfWeek,
  formatTimestamp,
  parsePlanningLine,
  todayIso,
  type AgendaTimestamp,
} from "@oak/core";

const HEADING_RE = /^(#{1,6})\s+(\S+)/;
const MS_PER_DAY = 86_400_000;

type PlanningField = "SCHEDULED" | "DEADLINE";

type FieldVal = {
  tooltips: readonly Tooltip[];
  // Stable key for the current heading position. When unchanged across
  // updates we keep the same Tooltip object so CM6 doesn't tear down
  // and recreate the DOM (which would reset the step state mid-flow).
  key: string | null;
  // The key the user last explicitly dismissed (Esc / × button). While
  // this matches `key` we suppress the tooltip; moving the cursor to a
  // different heading line clears it.
  dismissedKey: string | null;
};

// Dispatched by the tooltip's close button / Escape handler.
const dismissAgendaTooltip = StateEffect.define<void>();

export type AgendaTooltipOpts = {
  todoKeywords: () => readonly string[];
  // 0 = Sunday-first column, 1 = Monday-first.
  weekStartsOn: () => 0 | 1;
};

export function agendaTooltipExtension(opts: AgendaTooltipOpts) {
  const field = StateField.define<FieldVal>({
    create(state) {
      return computeFV(state, opts, null);
    },
    update(prev, tr) {
      let next = prev;
      for (const e of tr.effects) {
        if (e.is(dismissAgendaTooltip) && prev.key) {
          next = { ...next, dismissedKey: prev.key };
        }
      }
      if (!tr.docChanged && !tr.selection && next === prev) return prev;
      return computeFV(tr.state, opts, next);
    },
    provide: (f) => showTooltip.computeN([f], (s) => s.field(f).tooltips),
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
          view.dispatch({ effects: dismissAgendaTooltip.of(undefined) });
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
  prev: FieldVal | null,
): FieldVal {
  const dismissedKey = prev?.dismissedKey ?? null;
  const empty = (key: string | null): FieldVal => ({
    tooltips: [],
    key,
    // Forget the dismissal as soon as the cursor leaves the dismissed
    // heading — moving back to it should re-open the tooltip.
    dismissedKey: dismissedKey === key ? key : null,
  });

  const sel = state.selection.main;
  if (!sel.empty) return empty(null);
  const line = state.doc.lineAt(sel.head);
  const m = line.text.match(HEADING_RE);
  if (!m) return empty(null);
  const firstWord = m[2]!;
  if (!opts.todoKeywords().includes(firstWord)) return empty(null);

  const key = `${line.number} ${line.text}`;
  if (dismissedKey === key) {
    return { tooltips: [], key, dismissedKey: key };
  }
  // Same key as before and not dismissed: hand back the previous value
  // so the Tooltip identity is preserved and CM6 keeps the existing
  // DOM (and the step state inside it).
  if (prev && prev.key === key && prev.tooltips.length > 0) return prev;

  const headingFrom = line.from;
  const tooltip: Tooltip = {
    pos: headingFrom,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view) => makeTooltipDom(view, headingFrom, opts),
  };
  return { tooltips: [tooltip], key, dismissedKey: null };
}

type Step =
  | { kind: "field" }
  | { kind: "date"; field: PlanningField }
  | { kind: "cal"; field: PlanningField; year: number; month: number };

function makeTooltipDom(
  view: EditorView,
  headingFrom: number,
  opts: AgendaTooltipOpts,
): { dom: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "oak-agenda-tooltip";

  let step: Step = { kind: "field" };

  const dismiss = () => {
    view.dispatch({ effects: dismissAgendaTooltip.of(undefined) });
    view.focus();
  };

  const close = document.createElement("button");
  close.type = "button";
  close.className = "oak-agenda-tooltip-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", (ev) => {
    ev.preventDefault();
    dismiss();
  });

  const body = document.createElement("div");
  body.className = "oak-agenda-tooltip-body";

  wrapper.append(body, close);

  const render = () => {
    body.replaceChildren();
    if (step.kind === "field") renderField();
    else if (step.kind === "date") renderDate(step.field);
    else renderCal(step.field, step.year, step.month);
  };

  const renderField = () => {
    const row = makeRow();
    for (const f of ["SCHEDULED", "DEADLINE"] as PlanningField[]) {
      row.appendChild(
        makeBtn(f, () => {
          step = { kind: "date", field: f };
          render();
        }),
      );
    }
    body.appendChild(row);
  };

  const renderDate = (field: PlanningField) => {
    const today = todayIso(new Date());
    const presets: { label: string; iso: string }[] = [
      { label: "today", iso: today },
      { label: "tomorrow", iso: addUnits(today, 1, "d") },
      { label: "next mon", iso: nextMonday(today) },
      { label: "+7d", iso: addUnits(today, 7, "d") },
    ];
    const row = makeRow();
    for (const p of presets) {
      row.appendChild(
        makeBtn(p.label, () => {
          commit(field, { iso: p.iso, hasTime: false, active: true });
        }),
      );
    }
    row.appendChild(
      makeBtn("cal", () => {
        const t = splitYearMonth(today);
        step = { kind: "cal", field, year: t.year, month: t.month };
        render();
      }),
    );
    const back = makeBtn("←", () => {
      step = { kind: "field" };
      render();
    });
    back.classList.add("oak-agenda-tooltip-back");
    row.appendChild(back);
    body.appendChild(row);
  };

  const renderCal = (field: PlanningField, year: number, month: number) => {
    const header = document.createElement("div");
    header.className = "oak-agenda-tooltip-cal-header";
    header.appendChild(
      makeBtn("◀", () => {
        const next = shiftMonth(year, month, -1);
        step = { kind: "cal", field, year: next.year, month: next.month };
        render();
      }),
    );
    const label = document.createElement("span");
    label.className = "oak-agenda-tooltip-cal-label";
    label.textContent = `${year}-${pad2(month)}`;
    header.appendChild(label);
    header.appendChild(
      makeBtn("▶", () => {
        const next = shiftMonth(year, month, 1);
        step = { kind: "cal", field, year: next.year, month: next.month };
        render();
      }),
    );
    const back = makeBtn("←", () => {
      step = { kind: "date", field };
      render();
    });
    back.classList.add("oak-agenda-tooltip-back");
    header.appendChild(back);
    body.appendChild(header);

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
    const today = todayIso(new Date());
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
    body.appendChild(grid);
  };

  const commit = (field: PlanningField, ts: AgendaTimestamp) => {
    insertPlanningField(view, headingFrom, field, ts);
    step = { kind: "field" };
    render();
    view.focus();
  };

  wrapper.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    dismiss();
  });

  render();
  return { dom: wrapper };
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

export function insertPlanningField(
  view: EditorView,
  headingFrom: number,
  field: PlanningField,
  ts: AgendaTimestamp,
): void {
  const state = view.state;
  const headingLine = state.doc.lineAt(headingFrom);

  // Find an existing planning line directly below the heading. We
  // skip blank lines but stop at the first non-blank that isn't a
  // pure planning line — that one is body content and shouldn't be
  // touched.
  let probeNum = headingLine.number + 1;
  let planningLine: { from: number; to: number; text: string } | null = null;
  while (probeNum <= state.doc.lines) {
    const l = state.doc.line(probeNum);
    if (l.text.trim().length === 0) {
      probeNum++;
      continue;
    }
    const parsed = parsePlanningLine(l.text);
    if (parsed.matched) {
      planningLine = { from: l.from, to: l.to, text: l.text };
    }
    break;
  }

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

  const parts: string[] = [];
  if (scheduled) parts.push(`SCHEDULED: ${formatTimestamp(scheduled)}`);
  if (deadline) parts.push(`DEADLINE: ${formatTimestamp(deadline)}`);
  if (closed) parts.push(`CLOSED: ${formatTimestamp(closed)}`);
  const newLine = `${indent}${parts.join(" ")}`;

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
