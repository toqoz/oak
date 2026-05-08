import { describe, expect, it } from "vitest";
import { DEFAULT_AGENDA_CONFIG } from "../../src/agenda/config.js";
import { isPageInAgendaScope } from "../../src/agenda/index.js";
import type { AgendaConfig } from "../../src/agenda/types.js";

function withConfig(overrides: Partial<AgendaConfig>): AgendaConfig {
  return { ...DEFAULT_AGENDA_CONFIG, ...overrides };
}

describe("isPageInAgendaScope", () => {
  it("includes everything by default", () => {
    expect(isPageInAgendaScope("anywhere/Foo.md", DEFAULT_AGENDA_CONFIG)).toBe(true);
  });

  it("respects an inclusive agendaFiles list", () => {
    const cfg = withConfig({ agendaFiles: ["projects", "tasks.md"] });
    expect(isPageInAgendaScope("projects/web.md", cfg)).toBe(true);
    expect(isPageInAgendaScope("tasks.md", cfg)).toBe(true);
    expect(isPageInAgendaScope("notes/journal.md", cfg)).toBe(false);
  });

  it("treats a trailing slash the same as a bare directory", () => {
    const cfg = withConfig({ agendaFiles: ["projects/"] });
    expect(isPageInAgendaScope("projects/web.md", cfg)).toBe(true);
    expect(isPageInAgendaScope("projects-archive/old.md", cfg)).toBe(false);
  });

  it("applies agendaFilesExclude after the include filter", () => {
    const cfg = withConfig({
      agendaFiles: ["projects"],
      agendaFilesExclude: ["projects/archive"],
    });
    expect(isPageInAgendaScope("projects/web.md", cfg)).toBe(true);
    expect(isPageInAgendaScope("projects/archive/old.md", cfg)).toBe(false);
  });

  it("applies agendaFilesExclude even when the include filter is null", () => {
    const cfg = withConfig({ agendaFilesExclude: ["templates"] });
    expect(isPageInAgendaScope("templates/task.md", cfg)).toBe(false);
    expect(isPageInAgendaScope("inbox/task.md", cfg)).toBe(true);
  });
});
