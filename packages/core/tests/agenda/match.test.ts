import { describe, expect, it } from "vitest";
import { compileMatch } from "../../src/agenda/match.js";
import type { AgendaEntry } from "../../src/agenda/types.js";

function makeEntry(over: Partial<AgendaEntry>): AgendaEntry {
  return {
    entryId: "x",
    pageId: "p",
    filePath: "/vault/Foo.md",
    relPath: "Foo.md",
    line: 1,
    level: 1,
    title: "Foo",
    todoState: null,
    priority: null,
    tags: [],
    ownTags: [],
    properties: {},
    category: "Foo",
    bodyTimestamps: [],
    body: "",
    ...over,
  };
}

describe("compileMatch", () => {
  it("matches a simple required tag", () => {
    const f = compileMatch("work");
    expect(f(makeEntry({ tags: ["work"] }))).toBe(true);
    expect(f(makeEntry({ tags: ["home"] }))).toBe(false);
  });

  it("supports negated tags", () => {
    const f = compileMatch("work-someday");
    expect(f(makeEntry({ tags: ["work"] }))).toBe(true);
    expect(f(makeEntry({ tags: ["work", "someday"] }))).toBe(false);
  });

  it("supports & connector", () => {
    const f = compileMatch("work&urgent");
    expect(f(makeEntry({ tags: ["work", "urgent"] }))).toBe(true);
    expect(f(makeEntry({ tags: ["work"] }))).toBe(false);
  });

  it("supports property = match", () => {
    const f = compileMatch('PRIORITY="A"');
    expect(f(makeEntry({ properties: { PRIORITY: "A" } }))).toBe(true);
    expect(f(makeEntry({ properties: { PRIORITY: "B" } }))).toBe(false);
  });

  it("filters by /STATE", () => {
    const f = compileMatch("work/NEXT");
    expect(
      f(makeEntry({ tags: ["work"], todoState: "NEXT" })),
    ).toBe(true);
    expect(
      f(makeEntry({ tags: ["work"], todoState: "TODO" })),
    ).toBe(false);
  });

  it("filters by /!STATE", () => {
    const f = compileMatch("work/!DONE");
    expect(
      f(makeEntry({ tags: ["work"], todoState: "TODO" })),
    ).toBe(true);
    expect(
      f(makeEntry({ tags: ["work"], todoState: "DONE" })),
    ).toBe(false);
  });

  it("matches everything on empty expression", () => {
    const f = compileMatch("");
    expect(f(makeEntry({}))).toBe(true);
  });
});
