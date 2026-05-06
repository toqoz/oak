import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_AGENDA_CONFIG } from "../../src/agenda/config.js";
import { parseAgendaPage } from "../../src/agenda/parse.js";
import { markDone } from "../../src/agenda/writeback.js";
import type { OakPage } from "../../src/types.js";

function makePage(filePath: string, body: string): OakPage {
  return {
    type: "page",
    id: filePath,
    title: filePath,
    aliases: [],
    visibility: "private",
    slug: "",
    llm: "deny",
    filePath,
    relPath: filePath,
    basename: filePath.split(/[\\/]/).pop() ?? filePath,
    body,
    rawFrontmatter: {},
    links: [],
    parseIssues: [],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oak-agenda-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("markDone", () => {
  it("rewrites keyword to DONE and inserts CLOSED for non-repeater", async () => {
    const filePath = join(dir, "task.md");
    writeFileSync(
      filePath,
      `# TODO Finish report
some body
`,
      "utf8",
    );
    const page = makePage(filePath, readFileSync(filePath, "utf8"));
    const [target] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const result = await markDone(
      filePath,
      target!.entryId,
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-06T09:30:00Z"),
    );
    expect(result.repeated).toBe(false);
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toContain("# DONE Finish report");
    expect(updated).toMatch(/CLOSED: \[2026-05-06[^\]]+\]/);
  });

  it("advances + repeater and appends LOGBOOK entry", async () => {
    const filePath = join(dir, "task.md");
    writeFileSync(
      filePath,
      `# TODO Daily standup
SCHEDULED: <2026-05-06 Wed 09:00 +1d>
`,
      "utf8",
    );
    const page = makePage(filePath, readFileSync(filePath, "utf8"));
    const [target] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const result = await markDone(
      filePath,
      target!.entryId,
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-06T10:00:00Z"),
    );
    expect(result.repeated).toBe(true);
    const updated = readFileSync(filePath, "utf8");
    // Keyword stays as TODO
    expect(updated).toContain("# TODO Daily standup");
    // Scheduled advanced by one day
    expect(updated).toMatch(/SCHEDULED: <2026-05-07[^>]+>/);
    expect(updated).toContain(":LOGBOOK:");
    expect(updated).toContain('State "DONE" from "TODO"');
  });

  it("++ advances past doneAt strictly", async () => {
    const filePath = join(dir, "task.md");
    writeFileSync(
      filePath,
      `# TODO Weekly
SCHEDULED: <2026-05-01 Fri ++1w>
`,
      "utf8",
    );
    const page = makePage(filePath, readFileSync(filePath, "utf8"));
    const [target] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await markDone(
      filePath,
      target!.entryId,
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-15T10:00:00Z"),
    );
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toMatch(/SCHEDULED: <2026-05-22[^>]+>/);
  });

  it(".+ advances relative to doneAt", async () => {
    const filePath = join(dir, "task.md");
    writeFileSync(
      filePath,
      `# TODO Recurring
SCHEDULED: <2026-05-01 Fri .+1w>
`,
      "utf8",
    );
    const page = makePage(filePath, readFileSync(filePath, "utf8"));
    const [target] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await markDone(
      filePath,
      target!.entryId,
      DEFAULT_AGENDA_CONFIG,
      new Date("2026-05-20T10:00:00Z"),
    );
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toMatch(/SCHEDULED: <2026-05-27[^>]+>/);
  });

  it("rejects when entry not found", async () => {
    const filePath = join(dir, "task.md");
    writeFileSync(filePath, `# TODO Foo\n`, "utf8");
    await expect(
      markDone(filePath, "deadbeef", DEFAULT_AGENDA_CONFIG),
    ).rejects.toMatchObject({ code: "entry-not-found" });
  });
});
