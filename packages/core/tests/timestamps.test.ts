import { describe, expect, it } from "vitest";

import {
  isOakManaged,
  nowIsoSecond,
  setCreatedAndModified,
  setModified,
  shouldBumpModified,
  withTimestampUpdate,
} from "../src/timestamps.js";

const oakFile = (extraFm: string, body: string): string =>
  `---\nid: 01HX0000000000000000000001\ntitle: T${extraFm ? `\n${extraFm}` : ""}\n---\n\n${body}`;

describe("nowIsoSecond", () => {
  it("formats UTC second-precision Z", () => {
    expect(nowIsoSecond(new Date("2026-05-10T12:34:56.789Z"))).toBe(
      "2026-05-10T12:34:56Z",
    );
  });
});

describe("shouldBumpModified", () => {
  it("returns false when the file is unchanged", () => {
    const r = oakFile("", "hello");
    expect(shouldBumpModified(r, r)).toBe(false);
  });

  it("returns true when the body changed", () => {
    expect(
      shouldBumpModified(oakFile("", "hello"), oakFile("", "hello world")),
    ).toBe(true);
  });

  it("returns true when only the title changed (frontmatter-only)", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: Old\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: New\n---\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(true);
  });

  it("returns false when only frontmatter (non-title) changed", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: private\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: public\n---\n\nbody\n`;
    expect(shouldBumpModified(before, after)).toBe(false);
  });

  it("never bumps a file without an oak `id:` (plain markdown)", () => {
    expect(shouldBumpModified("hello", "hello world")).toBe(false);
  });
});

describe("setModified / setCreatedAndModified", () => {
  it("setModified inserts when missing, replaces when present", () => {
    const noFm = oakFile("", "body\n");
    const stamped = setModified(noFm, "2026-05-10T00:00:00Z");
    expect(stamped).toContain("modified: '2026-05-10T00:00:00Z'");
    const restamped = setModified(stamped, "2026-05-11T00:00:00Z");
    expect(restamped).toContain("modified: '2026-05-11T00:00:00Z'");
    expect(restamped.match(/modified:/g)?.length).toBe(1);
  });

  it("setCreatedAndModified writes both fields", () => {
    const out = setCreatedAndModified(
      oakFile("", "body\n"),
      "2026-05-10T00:00:00Z",
    );
    expect(out).toContain("created: '2026-05-10T00:00:00Z'");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
  });
});

describe("withTimestampUpdate", () => {
  it("bumps when body changes", () => {
    const before = oakFile("", "body\n");
    const after = oakFile("", "body changed\n");
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
    expect(out).toContain("body changed");
  });

  it("does not bump when only non-title frontmatter changes", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: private\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\nvisibility: public\n---\n\nbody\n`;
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toBe(after);
  });

  it("preserves an existing `created`", () => {
    const before = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\n---\n\nbody\n`;
    const after = `---\nid: 01HX0000000000000000000001\ntitle: T\ncreated: '2024-01-01T00:00:00Z'\n---\n\nbody changed\n`;
    const out = withTimestampUpdate(before, after, "2026-05-10T00:00:00Z");
    expect(out).toContain("created: '2024-01-01T00:00:00Z'");
    expect(out).toContain("modified: '2026-05-10T00:00:00Z'");
  });

  it("leaves plain markdown alone", () => {
    const before = "hello\n";
    const after = "hello world\n";
    expect(withTimestampUpdate(before, after, "2026-05-10T00:00:00Z")).toBe(
      after,
    );
  });
});

describe("isOakManaged", () => {
  it("requires a non-empty `id:` field", () => {
    expect(isOakManaged(oakFile("", "x"))).toBe(true);
    expect(isOakManaged("---\ntitle: x\n---\n\nbody\n")).toBe(false);
    expect(isOakManaged("plain markdown\n")).toBe(false);
  });
});
