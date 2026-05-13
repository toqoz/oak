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
    filePath: `/vault/${relPath}`,
    relPath,
    basename: relPath.replace(/\.md$/, ""),
    body,
    rawFrontmatter: {},
    created: null,
    modified: null,
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

describe("runAgenda — deadline prewarning vs SCHEDULED", () => {
  // Mirrors a real-world layout that surfaced confusing output:
  // a TODO with both SCHEDULED (tomorrow) and DEADLINE (within the
  // 14d default warning window). With the emacs default policy
  // (`false`) the deadline-warning fires on today even though the
  // user has already declared they'll start tomorrow. The oak default
  // is `"pre-scheduled"` — suppress prewarning until SCHEDULED day.
  const TODAY = "2026-05-07";
  const NOW_TODAY = new Date(`${TODAY}T08:00:00Z`);

  function buildPage(): OakPage {
    return makePage(
      "tasks.md",
      `## TODO Test entry alpha
SCHEDULED: <2026-05-09 Sat>
## TODO Refactor build configuration
SCHEDULED: <2026-05-07 Thu>

## TODO Update documentation
SCHEDULED: <2026-05-08 Fri>

## TODO Continue prior investigation

## TODO Investigate intermittent failure
SCHEDULED: <2026-05-08 Fri> DEADLINE: <2026-05-11 Mon>

## TODO Review monthly cron timing

## TODO Mobile responsiveness pass
`,
    );
  }
  const entries = parseAgendaPage(buildPage(), DEFAULT_AGENDA_CONFIG);

  it("default policy ('pre-scheduled') hides the prewarning while today is before SCHEDULED", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      NOW_TODAY,
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const titles = today.items.map((it) => it.entry.title);
    expect(titles).toContain("Refactor build configuration");
    expect(titles).not.toContain("Investigate intermittent failure");
  });

  it("default policy still shows the entry on its SCHEDULED day", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW_TODAY,
    );
    const fri = view.buckets.find((b) => b.key === "2026-05-08")!;
    const item = fri.items.find(
      (it) => it.entry.title === "Investigate intermittent failure",
    );
    expect(item?.marker).toBe("scheduled");
  });

  it("default policy still shows the deadline on its own day", () => {
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 7 },
      DEFAULT_AGENDA_CONFIG,
      NOW_TODAY,
    );
    const mon = view.buckets.find((b) => b.key === "2026-05-11")!;
    const item = mon.items.find(
      (it) => it.entry.title === "Investigate intermittent failure",
    );
    expect(item?.marker).toBe("deadline");
  });

  it("default policy resumes prewarning once today reaches the SCHEDULED date", () => {
    // Pretend today is 2026-05-08 (= SCHEDULED). DEADLINE is 3d out,
    // within the 14d warning window. Now the prewarning should fire
    // (the entry is already on its scheduled-day bucket too).
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-08", days: 1 },
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-08T08:00:00Z"),
    );
    const fri = view.buckets.find((b) => b.key === "2026-05-08")!;
    const titles = fri.items.map((it) => it.entry.title);
    // The entry shows up as "scheduled" (on-day) — the prewarning is
    // additionally allowed but the on-day bucket dedupes on marker.
    expect(titles).toContain("Investigate intermittent failure");
  });

  it("policy=false reproduces emacs default behavior (prewarning fires on today)", () => {
    const config = {
      ...DEFAULT_AGENDA_CONFIG,
      skipDeadlinePrewarningIfScheduled: false as const,
    };
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      config,
      NOW_TODAY,
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const item = today.items.find(
      (it) => it.entry.title === "Investigate intermittent failure",
    );
    expect(item?.marker).toBe("deadline-warning");
    expect(item?.daysDelta).toBe(4);
  });

  it("policy=true suppresses prewarning whenever SCHEDULED is set, regardless of date", () => {
    const config = {
      ...DEFAULT_AGENDA_CONFIG,
      skipDeadlinePrewarningIfScheduled: true as const,
    };
    const view = runAgenda(
      entries,
      { kind: "weekly", from: "2026-05-08", days: 1 },
      config,
      new Date("2026-05-08T08:00:00Z"),
    );
    const fri = view.buckets.find((b) => b.key === "2026-05-08")!;
    const warning = fri.items.find(
      (it) => it.marker === "deadline-warning",
    );
    expect(warning).toBeUndefined();
  });

  it("DEADLINE-only entries (no SCHEDULED) still show the prewarning", () => {
    const page = makePage(
      "deadline-only.md",
      `## TODO Submit report
DEADLINE: <2026-05-11 Mon>
`,
    );
    const localEntries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      localEntries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      NOW_TODAY,
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const item = today.items.find((it) => it.marker === "deadline-warning");
    expect(item?.daysDelta).toBe(4);
  });
});

describe("runAgenda — skipScheduledIfDeadlineIsShown", () => {
  // Default (true) — when SCHEDULED and DEADLINE both surface on the
  // same day for the same entry, only the deadline-side marker remains.

  it("drops SCHEDULED today when DEADLINE warning fires on today", () => {
    // scheduled = today, deadline = tomorrow → warning emits on today.
    const TODAY = "2026-05-13";
    const page = makePage(
      "tasks.md",
      `## TODO Campaign draw
SCHEDULED: <2026-05-13 Wed> DEADLINE: <2026-05-14 Thu>
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      new Date(`${TODAY}T08:00:00Z`),
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const ours = today.items.filter(
      (it) => it.entry.title === "Campaign draw",
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.marker).toBe("deadline-warning");
  });

  it("drops overdue SCHEDULED when DEADLINE is also overdue on today", () => {
    // scheduled and deadline both -4d → both bubble onto today.
    const TODAY = "2026-05-13";
    const page = makePage(
      "tasks.md",
      `## TODO Confirm multi-order support
SCHEDULED: <2026-05-09 Sat> DEADLINE: <2026-05-09 Sat>
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      new Date(`${TODAY}T08:00:00Z`),
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const ours = today.items.filter(
      (it) => it.entry.title === "Confirm multi-order support",
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.marker).toBe("deadline-overdue");
    expect(ours[0]!.daysDelta).toBe(4);
  });

  it("drops on-day SCHEDULED when DEADLINE is also on the same day", () => {
    const TODAY = "2026-05-13";
    const page = makePage(
      "tasks.md",
      `## TODO Same-day both
SCHEDULED: <2026-05-13 Wed> DEADLINE: <2026-05-13 Wed>
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      new Date(`${TODAY}T08:00:00Z`),
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const ours = today.items.filter(
      (it) => it.entry.title === "Same-day both",
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.marker).toBe("deadline");
  });

  it("keeps SCHEDULED on its own day when DEADLINE is on a different day", () => {
    // scheduled today, deadline far away (outside warning) → today
    // shows Sched only, deadline day shows Due only — no collision.
    const TODAY = "2026-05-13";
    const page = makePage(
      "tasks.md",
      `## TODO Separate days
SCHEDULED: <2026-05-13 Wed> DEADLINE: <2026-06-30 Tue>
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      DEFAULT_AGENDA_CONFIG,
      new Date(`${TODAY}T08:00:00Z`),
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const ours = today.items.filter(
      (it) => it.entry.title === "Separate days",
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.marker).toBe("scheduled");
  });

  it("policy=false preserves both markers (emacs default behavior)", () => {
    const TODAY = "2026-05-13";
    const page = makePage(
      "tasks.md",
      `## TODO Campaign draw
SCHEDULED: <2026-05-13 Wed> DEADLINE: <2026-05-14 Thu>
`,
    );
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const view = runAgenda(
      entries,
      { kind: "weekly", from: TODAY, days: 1 },
      {
        ...DEFAULT_AGENDA_CONFIG,
        skipScheduledIfDeadlineIsShown: false,
        // Disable the prewarning gate so the deadline-warning actually
        // fires on today even though SCHEDULED is set.
        skipDeadlinePrewarningIfScheduled: false,
      },
      new Date(`${TODAY}T08:00:00Z`),
    );
    const today = view.buckets.find((b) => b.key === TODAY)!;
    const ours = today.items.filter(
      (it) => it.entry.title === "Campaign draw",
    );
    expect(ours).toHaveLength(2);
    const markers = ours.map((it) => it.marker).sort();
    expect(markers).toEqual(["deadline-warning", "scheduled"]);
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

  it("uses config.priorities.default for entries with no explicit priority", () => {
    // With default 'B', an unprioritized entry sorts level with [#B]
    // entries — i.e. between [#A] and [#C].
    const page = makePage(
      "Tasks.md",
      `# TODO [#A] High
# TODO Plain
# TODO [#C] Low
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
    // High < Plain (treated as B) < Low
    expect(titles).toEqual(["High", "Plain", "Low"]);
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
