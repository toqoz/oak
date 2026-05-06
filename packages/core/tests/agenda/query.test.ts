import { describe, expect, it } from "vitest";
import { parseAgendaPage } from "../../src/agenda/parse.js";
import { runAgenda } from "../../src/agenda/query.js";
import { DEFAULT_AGENDA_CONFIG } from "../../src/agenda/config.js";
import type { OakPage } from "../../src/types.js";

function makePage(relPath: string, body: string): OakPage {
  return {
    type: "page",
    id: relPath,
    title: relPath,
    aliases: [],
    visibility: "private",
    slug: "",
    llm: "deny",
    filePath: `/vault/${relPath}`,
    relPath,
    basename: relPath.replace(/\.md$/, ""),
    body,
    rawFrontmatter: {},
    links: [],
    parseIssues: [],
  };
}

const NOW = new Date("2026-05-06T08:00:00Z");

describe("runAgenda — weekly", () => {
  const page = makePage(
    "Tasks.md",
    `# TODO Daily standup
SCHEDULED: <2026-05-06 Wed 09:00>

# TODO Renew passport
DEADLINE: <2026-05-15 Fri -3d>

# TODO Older scheduled
SCHEDULED: <2026-05-01 Fri>

# DONE Old completion
SCHEDULED: <2026-05-04 Mon>
CLOSED: [2026-05-04 Mon 17:00]
`,
  );
  const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);

  it("places SCHEDULED on its bucket", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-04", days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const wed = view.buckets.find((b) => b.key === "2026-05-06")!;
    const standup = wed.items.find((it) => it.entry.title === "Daily standup");
    expect(standup?.marker).toBe("scheduled");
    expect(standup?.time).toBe("09:00");
  });

  it("shows a deadline warning on today within the per-deadline -3d window", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-12", days: 7 },
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-12T08:00:00Z"),
    );
    const today = view.buckets.find((b) => b.key === "2026-05-12")!;
    const warning = today.items.find((it) => it.marker === "deadline-warning");
    expect(warning?.daysDelta).toBe(3);
  });

  it("renders overdue scheduled on today", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-04", days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const today = view.buckets.find((b) => b.key === "2026-05-06")!;
    const overdue = today.items.find(
      (it) => it.marker === "scheduled-overdue",
    );
    expect(overdue?.entry.title).toBe("Older scheduled");
    expect(overdue?.daysDelta).toBe(5);
  });

  it("excludes DONE entries from scheduled rollout", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-04", days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const mon = view.buckets.find((b) => b.key === "2026-05-04")!;
    const done = mon.items.find((it) => it.entry.title === "Old completion");
    expect(done).toBeUndefined();
  });

  it("places deadline on its day", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-12", days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const fri = view.buckets.find((b) => b.key === "2026-05-15")!;
    const dl = fri.items.find((it) => it.marker === "deadline");
    expect(dl?.entry.title).toBe("Renew passport");
  });
});

describe("runAgenda — todo", () => {
  it("flat-lists open TODOs by priority", () => {
    const page = makePage(
      "Tasks.md",
      `# TODO [#B] Mid
# TODO [#A] High
# DONE [#A] Old
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "todo" },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const titles = view.buckets[0]!.items.map((it) => it.entry.title);
    expect(titles).toEqual(["High", "Mid"]);
  });
});

describe("runAgenda — search", () => {
  it("matches title or body", () => {
    const page = makePage(
      "Tasks.md",
      `# TODO Plan trip
We are heading to Tokyo.

# TODO Buy gear`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "search", regex: "tokyo|gear" },
      DEFAULT_AGENDA_CONFIG,
      NOW,
    );
    const titles = view.buckets[0]!.items.map((it) => it.entry.title);
    expect(titles.sort()).toEqual(["Buy gear", "Plan trip"]);
  });
});
