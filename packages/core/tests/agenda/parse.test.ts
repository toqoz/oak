import { describe, expect, it } from "vitest";
import { parseAgendaPage } from "../../src/agenda/parse.js";
import { DEFAULT_AGENDA_CONFIG } from "../../src/agenda/config.js";
import type { OakPage } from "../../src/types.js";

function makePage(body: string, frontmatter: Record<string, unknown> = {}): OakPage {
  return {
    type: "page",
    id: "test-page",
    title: "Test",
    aliases: [],
    visibility: "private",
    slug: "test",
    llm: "deny",
    filePath: "/vault/Test.md",
    relPath: "Test.md",
    basename: "Test",
    body,
    rawFrontmatter: frontmatter,
    links: [],
    parseIssues: [],
  };
}

describe("parseAgendaPage", () => {
  it("extracts a basic TODO heading", () => {
    const page = makePage("# TODO Buy milk");
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      todoState: "TODO",
      title: "Buy milk",
      level: 1,
    });
  });

  it("extracts priority and trailing tags", () => {
    const page = makePage("## TODO [#A] Write Q2 review :work:writeup:");
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    expect(entries[0]).toMatchObject({
      todoState: "TODO",
      priority: "A",
      title: "Write Q2 review",
      ownTags: ["work", "writeup"],
      level: 2,
    });
  });

  it("requires same-char same-or-longer fence to close, not a simple toggle", () => {
    // The leading ``` opens; the inner ~~~ inside the fenced block
    // must NOT be treated as a close. The final ``` ends the fence.
    // The `## TODO Outside` heading after the fence must still be
    // picked up — under the old toggle implementation it would be
    // suppressed because the inner ~~~ flipped the flag back off
    // and the closing ``` flipped it on, leaving everything after
    // inside a phantom fence.
    const body = `# TODO Above
\`\`\`
~~~
not a close
\`\`\`

## TODO Outside`;
    const entries = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entries.map((e) => e.title)).toEqual(["Above", "Outside"]);
  });

  it("excludes tags from inheritance but keeps them on the owning heading", () => {
    // Org semantics: a tag in `tagsExcludeFromInheritance` stays on
    // the heading that wrote it, but does NOT propagate to descendants.
    // Earlier the exclude list filtered both sides and the parent
    // lost the tag too.
    const body = `# TODO Parent :work:someday:
## TODO Child`;
    const config = {
      ...DEFAULT_AGENDA_CONFIG,
      tagsExcludeFromInheritance: ["someday"],
    };
    const entries = parseAgendaPage(makePage(body), config);
    const parent = entries.find((e) => e.title === "Parent")!;
    const child = entries.find((e) => e.title === "Child")!;
    expect(parent.tags).toEqual(["work", "someday"]);
    expect(child.tags).toEqual(["work"]);
  });

  it("accepts Unicode and emoji tags", () => {
    const page = makePage("# TODO Plan trip :日本語:🚀:work:");
    const entries = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    expect(entries[0]!.ownTags).toEqual(["日本語", "🚀", "work"]);
    expect(entries[0]!.title).toBe("Plan trip");
  });

  it("parses combined planning line", () => {
    const body = `# TODO Renew passport
SCHEDULED: <2026-05-10 Sun> DEADLINE: <2026-05-15 Fri -3d>`;
    const entries = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entries[0]!.scheduled?.iso).toBe("2026-05-10");
    expect(entries[0]!.deadline?.iso).toBe("2026-05-15");
    expect(entries[0]!.deadline?.warn).toEqual({ n: 3, unit: "d" });
  });

  it("captures :PROPERTIES: drawer entries", () => {
    const body = `# TODO Foo
:PROPERTIES:
:CATEGORY: work
:Effort:   1:30
:END:
some text`;
    const [entry] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entry!.properties["CATEGORY"]).toBe("work");
    expect(entry!.properties["EFFORT"]).toBe("1:30");
    expect(entry!.category).toBe("work");
  });

  it("skips :LOGBOOK: drawer body in entry body field", () => {
    const body = `# TODO Foo
:LOGBOOK:
- State "DONE" from "TODO" [2026-05-06 Wed 09:12]
:END:
real body`;
    const [entry] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entry!.body).toContain("real body");
    expect(entry!.body).not.toContain("State \"DONE\"");
  });

  it("ignores TODO inside fenced code blocks", () => {
    const body = ["# Real prose", "```", "# TODO not a task", "```", "# TODO Real"].join(
      "\n",
    );
    const entries = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    const titles = entries.map((e) => e.title);
    expect(titles).toEqual(["Real"]);
  });

  it("ignores frontmatter tags and category", () => {
    // Per design, file-level defaults are not honored; tags must come
    // from heading inheritance and category falls back to filename.
    const page = makePage("# TODO Foo :own:", {
      tags: ["personal"],
      category: "home",
    });
    const [entry] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    expect(entry!.tags).toEqual(["own"]);
    expect(entry!.category).toBe("Test");
  });

  it("inherits ancestor heading tags", () => {
    const body = `# Project :work:
## TODO Subtask :urgent:`;
    const [entry] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entry!.tags).toEqual(["work", "urgent"]);
  });

  it("skips prose headings without TODO/timestamp", () => {
    const page = makePage(`# Heading without TODO\nlorem ipsum`);
    expect(parseAgendaPage(page, DEFAULT_AGENDA_CONFIG)).toHaveLength(0);
  });

  it("includes prose heading when it has an active body timestamp", () => {
    const page = makePage(`# Meeting\nDate: <2026-05-06 Wed 14:00>`);
    const [entry] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    expect(entry!.bodyTimestamps).toHaveLength(1);
  });

  it("derives stable entryId for same heading path", () => {
    const a = parseAgendaPage(makePage("# TODO Foo"), DEFAULT_AGENDA_CONFIG)[0]!;
    const b = parseAgendaPage(
      makePage("# TODO Foo\nbody"),
      DEFAULT_AGENDA_CONFIG,
    )[0]!;
    expect(a.entryId).toBe(b.entryId);
  });

  it("disambiguates duplicate sibling headings via line suffix", () => {
    const body = `# TODO Foo\n# TODO Foo\n`;
    const [a, b] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(a!.entryId).not.toBe(b!.entryId);
    expect(a!.entryId.endsWith(`:${a!.line}`)).toBe(true);
    expect(b!.entryId.endsWith(`:${b!.line}`)).toBe(true);
  });

  it("honors explicit :ID: from PROPERTIES drawer", () => {
    const body = `# TODO Foo
:PROPERTIES:
:ID: stable-handle-123
:END:`;
    const [entry] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(entry!.entryId).toBe("stable-handle-123");
  });

  it("rejects priority letters outside priorities.highest..lowest", () => {
    // Default config: highest=A, lowest=C. `[#D]` should be left in
    // the title rather than adopted as a priority.
    const [entry] = parseAgendaPage(
      makePage("# TODO [#D] Foo"),
      DEFAULT_AGENDA_CONFIG,
    );
    expect(entry!.priority).toBeNull();
    expect(entry!.title).toBe("[#D] Foo");
  });

  it("accepts priorities up to a wider configured range", () => {
    const [entry] = parseAgendaPage(
      makePage("# TODO [#D] Foo"),
      {
        ...DEFAULT_AGENDA_CONFIG,
        priorities: { highest: "A", lowest: "F", default: "B" },
      },
    );
    expect(entry!.priority).toBe("D");
    expect(entry!.title).toBe("Foo");
  });

  it("does not inherit :ID: from an ancestor heading", () => {
    const body = `# Section
:PROPERTIES:
:ID: parent-id
:CATEGORY: ops
:END:
## TODO Child
some text`;
    const [entry] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    // CATEGORY is inherited as before…
    expect(entry!.properties["CATEGORY"]).toBe("ops");
    // …but ID is not.
    expect(entry!.properties["ID"]).toBeUndefined();
    // The child therefore falls back to a derived entryId (not parent-id).
    expect(entry!.entryId).not.toBe("parent-id");
  });

  it("explicit :ID: skips sibling disambiguation", () => {
    const body = `# TODO Foo
:PROPERTIES:
:ID: pinned-a
:END:
# TODO Foo
:PROPERTIES:
:ID: pinned-b
:END:`;
    const [a, b] = parseAgendaPage(makePage(body), DEFAULT_AGENDA_CONFIG);
    expect(a!.entryId).toBe("pinned-a");
    expect(b!.entryId).toBe("pinned-b");
  });
});
