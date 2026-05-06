import { describe, expect, it } from "vitest";
import {
  addUnits,
  advanceRepeater,
  daysBetween,
  formatTimestamp,
  parseAllTimestamps,
  parseRangeTimestamp,
  parseTimestamp,
  withinWarning,
} from "../../src/agenda/timestamp.js";

describe("parseTimestamp", () => {
  it("parses an active date timestamp", () => {
    const ts = parseTimestamp("<2026-05-06 Wed>");
    expect(ts).toMatchObject({
      iso: "2026-05-06",
      hasTime: false,
      active: true,
    });
    expect(ts!.endIso).toBeUndefined();
    expect(ts!.repeater).toBeUndefined();
  });

  it("parses an active datetime timestamp", () => {
    const ts = parseTimestamp("<2026-05-06 Wed 10:00>");
    expect(ts).toMatchObject({
      iso: "2026-05-06T10:00",
      hasTime: true,
      active: true,
    });
  });

  it("parses a time-range datetime", () => {
    const ts = parseTimestamp("<2026-05-06 Wed 10:00-11:30>");
    expect(ts!.iso).toBe("2026-05-06T10:00");
    expect(ts!.endIso).toBe("2026-05-06T11:30");
  });

  it("parses inactive timestamps", () => {
    const ts = parseTimestamp("[2026-05-06 Wed 09:12]");
    expect(ts!.active).toBe(false);
  });

  it("parses repeater and warning", () => {
    const ts = parseTimestamp("<2026-05-15 Fri +1m -3d>");
    expect(ts!.repeater).toEqual({ kind: "+", n: 1, unit: "m" });
    expect(ts!.warn).toEqual({ n: 3, unit: "d" });
  });

  it("parses ++ repeater", () => {
    const ts = parseTimestamp("<2026-05-15 Fri ++1w>");
    expect(ts!.repeater).toEqual({ kind: "++", n: 1, unit: "w" });
  });

  it("parses .+ repeater", () => {
    const ts = parseTimestamp("<2026-05-15 Fri .+2d>");
    expect(ts!.repeater).toEqual({ kind: ".+", n: 2, unit: "d" });
  });
});

describe("parseRangeTimestamp", () => {
  it("collapses <…>--<…> into a single timestamp", () => {
    const ts = parseRangeTimestamp("<2026-05-06 Wed>--<2026-05-08 Fri>");
    expect(ts!.iso).toBe("2026-05-06");
    expect(ts!.endIso).toBe("2026-05-08");
  });
});

describe("parseAllTimestamps", () => {
  it("finds standalone timestamps and skips overlapping ranges", () => {
    const text =
      "<2026-05-06 Wed>--<2026-05-08 Fri> and later [2026-05-09 Sat] note <2026-05-10 Sun>";
    const tss = parseAllTimestamps(text);
    expect(tss).toHaveLength(3);
    expect(tss[0]!.endIso).toBe("2026-05-08");
    expect(tss[1]!.active).toBe(false);
    expect(tss[2]!.iso).toBe("2026-05-10");
  });
});

describe("formatTimestamp", () => {
  it("round-trips an active datetime with repeater + warn", () => {
    const ts = parseTimestamp("<2026-05-15 Fri 10:00 +1m -3d>")!;
    const out = formatTimestamp(ts);
    expect(out).toBe("<2026-05-15 Fri 10:00 +1m -3d>");
  });

  it("formats inactive correctly", () => {
    const ts = parseTimestamp("[2026-05-06 Wed]")!;
    expect(formatTimestamp(ts)).toBe("[2026-05-06 Wed]");
  });
});

describe("addUnits", () => {
  it("adds days across a month boundary", () => {
    expect(addUnits("2026-05-30", 5, "d")).toBe("2026-06-04");
  });
  it("adds weeks", () => {
    expect(addUnits("2026-05-06", 1, "w")).toBe("2026-05-13");
  });
  it("adds months", () => {
    expect(addUnits("2026-01-31", 1, "m")).toBe("2026-03-03");
  });
  it("adds years across a leap year", () => {
    expect(addUnits("2024-02-29", 1, "y")).toBe("2025-03-01");
  });
});

describe("daysBetween", () => {
  it("counts forward and backward correctly", () => {
    expect(daysBetween("2026-05-06", "2026-05-10")).toBe(4);
    expect(daysBetween("2026-05-10", "2026-05-06")).toBe(-4);
  });
  it("crosses a year", () => {
    expect(daysBetween("2025-12-30", "2026-01-02")).toBe(3);
  });
});

describe("advanceRepeater", () => {
  it("+ shifts by exactly n*unit from base, may still be overdue", () => {
    const ts = parseTimestamp("<2026-05-01 Fri +1w>")!;
    const next = advanceRepeater(ts, "2026-05-15");
    expect(next.iso).toBe("2026-05-08"); // still overdue vs done date
  });

  it("++ shifts in increments until strictly after doneAt", () => {
    const ts = parseTimestamp("<2026-05-01 Fri ++1w>")!;
    const next = advanceRepeater(ts, "2026-05-15");
    expect(next.iso).toBe("2026-05-22");
  });

  it(".+ shifts relative to doneAt", () => {
    const ts = parseTimestamp("<2026-05-01 Fri .+1w>")!;
    const next = advanceRepeater(ts, "2026-05-20");
    expect(next.iso).toBe("2026-05-27");
  });

  it("preserves time-of-day and repeater on advancement", () => {
    const ts = parseTimestamp("<2026-05-01 Fri 09:00 +1d>")!;
    const next = advanceRepeater(ts, "2026-05-01");
    expect(next.iso).toBe("2026-05-02T09:00");
    expect(next.repeater).toEqual(ts.repeater);
  });
});

describe("withinWarning", () => {
  it("flags on-day deadline", () => {
    const ts = parseTimestamp("<2026-05-15 Fri>")!;
    const w = withinWarning(ts, "2026-05-15", 14);
    expect(w.onDay).toBe(true);
  });
  it("flags upcoming deadline within default window", () => {
    const ts = parseTimestamp("<2026-05-15 Fri>")!;
    const w = withinWarning(ts, "2026-05-10", 14);
    expect(w.warning).toBe(5);
  });
  it("respects per-deadline warning override", () => {
    const ts = parseTimestamp("<2026-05-15 Fri -3d>")!;
    const wA = withinWarning(ts, "2026-05-12", 14);
    expect(wA.warning).toBe(3);
    const wB = withinWarning(ts, "2026-05-11", 14);
    expect(wB.warning).toBeNull();
  });
  it("flags overdue deadlines", () => {
    const ts = parseTimestamp("<2026-05-10 Sun>")!;
    const w = withinWarning(ts, "2026-05-15", 14);
    expect(w.overdue).toBe(5);
  });
});
