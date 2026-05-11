import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_AGENDA_CONFIG } from "../../src/agenda/config.js";
import { parseAgendaPage } from "../../src/agenda/parse.js";
import { DEFAULT_REFILE_CONFIG } from "../../src/refile/config.js";
import {
  collectRefileTargets,
  findEnclosingHeading,
  findHeadingsInRange,
  refile,
  RefileError,
} from "../../src/refile/refile.js";
import type { OakPage, Vault } from "../../src/types.js";

function makePage(filePath: string, body: string, relPath?: string): OakPage {
  return {
    type: "page",
    id: filePath,
    title: filePath,
    aliases: [],
    visibility: "private",
    slug: "",
    filePath,
    relPath: relPath ?? filePath,
    basename: filePath.split(/[\\/]/).pop() ?? filePath,
    body,
    rawFrontmatter: {},
    created: null,
    modified: null,
    links: [],
    parseIssues: [],
  };
}

function makeVault(pages: OakPage[]): Vault {
  return {
    rootPath: "/",
    pages: new Map(pages.map((p) => [p.id, p])),
    externals: new Map(),
    mounts: new Map(),
    byTitle: new Map(),
    byAlias: new Map(),
    byBasename: new Map(),
    bySlug: new Map(),
    byVaultRelPath: new Map(),
    titleConflicts: new Map(),
    aliasConflicts: new Map(),
    slugConflicts: new Map(),
    basenameConflicts: new Map(),
    issues: [],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oak-refile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("collectRefileTargets", () => {
  it("emits a top-of-file sentinel plus every heading with its ancestor chain", () => {
    const page = makePage("/v/notes.md", [
      "# Projects",
      "## Work",
      "### Refactor",
      "## Home",
      "# Inbox",
    ].join("\n"), "notes.md");
    const vault = makeVault([page]);
    const targets = collectRefileTargets(vault);
    expect(targets.map((t) => ({ path: t.headingPath, line: t.line, level: t.level })))
      .toEqual([
        { path: ["notes"], line: null, level: 0 },
        { path: ["notes", "Projects"], line: 1, level: 1 },
        { path: ["notes", "Projects", "Work"], line: 2, level: 2 },
        { path: ["notes", "Projects", "Work", "Refactor"], line: 3, level: 3 },
        { path: ["notes", "Projects", "Home"], line: 4, level: 2 },
        { path: ["notes", "Inbox"], line: 5, level: 1 },
      ]);
  });

  it("ignores `# foo` lines inside fenced code blocks", () => {
    const page = makePage("/v/n.md", [
      "# Real",
      "```",
      "# Not a heading",
      "```",
      "## Real Sub",
    ].join("\n"), "n.md");
    const vault = makeVault([page]);
    const targets = collectRefileTargets(vault);
    expect(targets.map((t) => t.headingPath.join(" ▸ "))).toEqual([
      "n",
      "n ▸ Real",
      "n ▸ Real ▸ Real Sub",
    ]);
  });
});

describe("refile (same-file)", () => {
  it("moves a TODO subtree under another heading and shifts levels", async () => {
    const fp = join(dir, "tasks.md");
    writeFileSync(
      fp,
      [
        "# Inbox",
        "## TODO buy milk",
        "SCHEDULED: <2026-05-08 Fri>",
        "note about milk",
        "",
        "# Projects",
        "ongoing",
      ].join("\n"),
      "utf8",
    );
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [todo] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);

    const result = await refile(
      fp,
      { kind: "entry", entryId: todo!.entryId },
      {
        filePath: fp,
        relPath: fp,
        line: 6, // "# Projects"
        level: 1,
      },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(result.sameFile).toBe(true);
    // The moved heading lands at body line 6 in the new file
    // (1-based): "# Inbox", "", "# Projects", "ongoing", "",
    //   "## TODO buy milk".
    expect(result.insertedBodyLine).toBe(6);

    const out = readFileSync(fp, "utf8");
    expect(out).toBe(
      [
        "# Inbox",
        "",
        "# Projects",
        "ongoing",
        "",
        "## TODO buy milk",
        "SCHEDULED: <2026-05-08 Fri>",
        "note about milk",
      ].join("\n"),
    );
  });

  it("refuses to refile a heading into its own subtree", async () => {
    const fp = join(dir, "self.md");
    writeFileSync(
      fp,
      [
        "# TODO outer",
        "## inner",
        "stuff",
      ].join("\n"),
      "utf8",
    );
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [outer] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await expect(
      refile(
        fp,
        { kind: "entry", entryId: outer!.entryId },
        { filePath: fp, relPath: fp, line: 2, level: 2 },
        DEFAULT_REFILE_CONFIG,
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toMatchObject({ code: "descendant-target" });
  });

  it("refuses self-refile", async () => {
    const fp = join(dir, "self.md");
    writeFileSync(fp, "# TODO foo\nbody\n", "utf8");
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [t] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await expect(
      refile(
        fp,
        { kind: "entry", entryId: t!.entryId },
        { filePath: fp, relPath: fp, line: 1, level: 1 },
        DEFAULT_REFILE_CONFIG,
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toMatchObject({ code: "self-refile" });
  });

  it("refuses a refile that would push a sub-heading past level 6", async () => {
    const srcFp = join(dir, "deep-src.md");
    const tgtFp = join(dir, "deep-tgt.md");
    writeFileSync(
      srcFp,
      [
        "# TODO source",
        "###### deep child",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      tgtFp,
      [
        "## target",
      ].join("\n"),
      "utf8",
    );
    const page = makePage(srcFp, readFileSync(srcFp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await expect(
      refile(
        srcFp,
        { kind: "entry", entryId: src!.entryId },
        { filePath: tgtFp, relPath: tgtFp, line: 1, level: 2 },
        DEFAULT_REFILE_CONFIG,
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toMatchObject({ code: "level-overflow" });
  });

  it("refiles to top-of-file at the default root level (2)", async () => {
    // oak's body convention starts at `##`, so the default
    // `topOfFileLevel` is 2: a top-of-file refile leaves a
    // level-2 source heading at level 2 (no shift) instead of clamping
    // to `# `.
    const fp = join(dir, "tof.md");
    writeFileSync(
      fp,
      [
        "## A",
        "### TODO move me",
        "body",
        "### B",
        "tail",
      ].join("\n"),
      "utf8",
    );
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    const result = await refile(
      fp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: fp, relPath: fp, line: null, level: 0 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(fp, "utf8")).toBe(
      [
        "## A",
        "### B",
        "tail",
        "",
        "## TODO move me",
        "body",
      ].join("\n"),
    );
    // Top-of-file landing: heading at body line 5 (1-based).
    expect(result.insertedBodyLine).toBe(5);
  });

  it("honors `topOfFileLevel: 1` for emacs org-refile parity", async () => {
    // Users on the emacs convention (top-of-file refile clamps to a
    // level-1 heading) override the default with `1`.
    const fp = join(dir, "tof-l1.md");
    writeFileSync(
      fp,
      [
        "# A",
        "## TODO move me",
        "body",
        "## B",
        "tail",
      ].join("\n"),
      "utf8",
    );
    const refileConfig = {
      ...DEFAULT_REFILE_CONFIG,
      topOfFileLevel: 1,
    };
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      fp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: fp, relPath: fp, line: null, level: 0 },
      refileConfig,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(fp, "utf8")).toBe(
      [
        "# A",
        "## B",
        "tail",
        "",
        "# TODO move me",
        "body",
      ].join("\n"),
    );
  });

  it("top-of-file refile into an empty target file leaves no leading blank", async () => {
    // Regression for the empty-body splice path: split("\n") on `""`
    // yields `[""]`, so the naive insertion would land *after* that
    // sentinel and emit a leading blank line in the output.
    const srcFp = join(dir, "src-empty-tgt.md");
    const tgtFp = join(dir, "tgt-empty.md");
    writeFileSync(
      srcFp,
      ["## TODO move me", "body"].join("\n"),
      "utf8",
    );
    writeFileSync(tgtFp, "", "utf8");
    const page = makePage(srcFp, readFileSync(srcFp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      srcFp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: tgtFp, relPath: "tgt-empty.md", line: null, level: 0 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(tgtFp, "utf8")).toBe(
      ["## TODO move me", "body"].join("\n"),
    );
  });

  it("top-of-file refile into a frontmatter-only target keeps a single blank between fences and heading", async () => {
    // The body after frontmatter is empty here; the moved subtree
    // must land directly after the frontmatter fence with one
    // separating blank — not two — and no leading whitespace.
    const srcFp = join(dir, "src-fm-only.md");
    const tgtFp = join(dir, "tgt-fm-only.md");
    writeFileSync(
      srcFp,
      ["## TODO move me", "body"].join("\n"),
      "utf8",
    );
    writeFileSync(
      tgtFp,
      ["---", "title: Target", "---", ""].join("\n"),
      "utf8",
    );
    const page = makePage(srcFp, readFileSync(srcFp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      srcFp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: tgtFp, relPath: "tgt-fm-only.md", line: null, level: 0 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(tgtFp, "utf8")).toBe(
      [
        "---",
        "title: Target",
        "---",
        "## TODO move me",
        "body",
      ].join("\n"),
    );
  });

  it("top-of-file refile into a body with trailing newlines collapses to one separator", async () => {
    // Real-world files routinely end with a trailing newline (or
    // several). Without folding the trailing blanks of `head`, we'd
    // emit `"# Existing\n\n\n## TODO …"` — a stray paragraph break.
    const srcFp = join(dir, "src-trailing.md");
    const tgtFp = join(dir, "tgt-trailing.md");
    writeFileSync(
      srcFp,
      ["## TODO move me", "body"].join("\n"),
      "utf8",
    );
    writeFileSync(tgtFp, "# Existing\n\n", "utf8");
    const page = makePage(srcFp, readFileSync(srcFp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      srcFp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: tgtFp, relPath: "tgt-trailing.md", line: null, level: 0 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(tgtFp, "utf8")).toBe(
      [
        "# Existing",
        "",
        "## TODO move me",
        "body",
      ].join("\n"),
    );
  });
});

describe("refile (cross-file)", () => {
  it("moves a subtree to a different file with frontmatter intact on both sides", async () => {
    const srcFp = join(dir, "src.md");
    const tgtFp = join(dir, "tgt.md");
    writeFileSync(
      srcFp,
      [
        "---",
        "title: Source",
        "---",
        "# Inbox",
        "## TODO write report",
        "DEADLINE: <2026-05-10 Sun>",
        "intro",
        "## Other",
        "kept",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      tgtFp,
      [
        "---",
        "title: Target",
        "---",
        "# Projects",
        "ongoing",
      ].join("\n"),
      "utf8",
    );
    const srcPage = makePage(srcFp, readFileSync(srcFp, "utf8").split("---\n").slice(2).join("---\n"));
    // Body of source body lines (post-frontmatter): line 1 = "# Inbox" etc.
    // Easier: parse via parseAgendaPage helper using a body that matches.
    const srcBody = [
      "# Inbox",
      "## TODO write report",
      "DEADLINE: <2026-05-10 Sun>",
      "intro",
      "## Other",
      "kept",
    ].join("\n");
    const parsedPage = makePage(srcFp, srcBody);
    const [todo] = parseAgendaPage(parsedPage, DEFAULT_AGENDA_CONFIG);

    void srcPage;

    await refile(
      srcFp,
      { kind: "entry", entryId: todo!.entryId },
      { filePath: tgtFp, relPath: "tgt.md", line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );

    expect(readFileSync(srcFp, "utf8")).toBe(
      [
        "---",
        "title: Source",
        "---",
        "# Inbox",
        "## Other",
        "kept",
      ].join("\n"),
    );
    expect(readFileSync(tgtFp, "utf8")).toBe(
      [
        "---",
        "title: Target",
        "---",
        "# Projects",
        "ongoing",
        "",
        "## TODO write report",
        "DEADLINE: <2026-05-10 Sun>",
        "intro",
      ].join("\n"),
    );
  });

  it("does not mistake a heading inside a fenced code block for the subtree boundary", async () => {
    const srcFp = join(dir, "fenced.md");
    const tgtFp = join(dir, "dest.md");
    writeFileSync(
      srcFp,
      [
        "## TODO move me",
        "intro",
        "```",
        "# pretend heading",
        "```",
        "after",
        "## other",
        "kept",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(tgtFp, "# Dest\n", "utf8");
    const page = makePage(srcFp, readFileSync(srcFp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      srcFp,
      { kind: "entry", entryId: src!.entryId },
      { filePath: tgtFp, relPath: "dest.md", line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    const tgt = readFileSync(tgtFp, "utf8");
    expect(tgt).toContain("intro");
    expect(tgt).toContain("# pretend heading");
    expect(tgt).toContain("after");
    expect(tgt).not.toContain("kept");
    const out = readFileSync(srcFp, "utf8");
    expect(out).toContain("## other");
    expect(out).not.toContain("intro");
  });
});

describe("refile error surface", () => {
  it("rejects an entry id that is not in the source file", async () => {
    const fp = join(dir, "missing.md");
    writeFileSync(fp, "# TODO present\nbody\n", "utf8");
    await expect(
      refile(
        fp,
        { kind: "entry", entryId: "deadbeefdeadbeef" },
        { filePath: fp, relPath: fp, line: null, level: 0 },
        DEFAULT_REFILE_CONFIG,
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toBeInstanceOf(RefileError);
  });

  it("rejects a heading source whose (line, level) does not match disk", async () => {
    const fp = join(dir, "stale.md");
    writeFileSync(fp, "# Real\nbody\n", "utf8");
    await expect(
      refile(
        fp,
        { kind: "heading", line: 1, level: 2 }, // wrong level
        { filePath: fp, relPath: fp, line: null, level: 0 },
        DEFAULT_REFILE_CONFIG,
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toMatchObject({ code: "heading-not-found" });
  });
});

describe("refile (heading source — non-agenda)", () => {
  it("moves a plain prose heading (no TODO / planning / timestamp) under another heading", async () => {
    const fp = join(dir, "prose.md");
    writeFileSync(
      fp,
      [
        "# Inbox",
        "## random thought",
        "some text",
        "",
        "# Projects",
        "ongoing",
      ].join("\n"),
      "utf8",
    );
    const result = await refile(
      fp,
      { kind: "heading", line: 2, level: 2 },
      { filePath: fp, relPath: "prose.md", line: 5, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(result.sameFile).toBe(true);
    expect(result.sourceEntryId).toBeNull();
    expect(readFileSync(fp, "utf8")).toBe(
      [
        "# Inbox",
        "",
        "# Projects",
        "ongoing",
        "",
        "## random thought",
        "some text",
      ].join("\n"),
    );
  });

  it("moves a non-agenda heading across files", async () => {
    const srcFp = join(dir, "src.md");
    const tgtFp = join(dir, "tgt.md");
    writeFileSync(srcFp, ["# A", "## quiet", "details", "## keep me"].join("\n"), "utf8");
    writeFileSync(tgtFp, "# Dest\n", "utf8");
    await refile(
      srcFp,
      { kind: "heading", line: 2, level: 2 },
      { filePath: tgtFp, relPath: "tgt.md", line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(srcFp, "utf8")).toBe(["# A", "## keep me"].join("\n"));
    expect(readFileSync(tgtFp, "utf8")).toBe(
      ["# Dest", "", "## quiet", "details"].join("\n") + "\n",
    );
  });
});

describe("findEnclosingHeading", () => {
  it("returns the largest heading line at or before the cursor body line", () => {
    const body = [
      "# Inbox",
      "## random thought",
      "text",
      "# Projects",
      "more",
    ].join("\n");
    expect(findEnclosingHeading(body, 1)).toMatchObject({ line: 1, level: 1 });
    expect(findEnclosingHeading(body, 2)).toMatchObject({ line: 2, level: 2 });
    expect(findEnclosingHeading(body, 3)).toMatchObject({ line: 2, level: 2 });
    expect(findEnclosingHeading(body, 4)).toMatchObject({ line: 4, level: 1 });
    expect(findEnclosingHeading(body, 5)).toMatchObject({ line: 4, level: 1 });
  });

  it("returns null when no heading exists at or before the cursor", () => {
    const body = ["preamble", "more preamble", "# First"].join("\n");
    expect(findEnclosingHeading(body, 1)).toBeNull();
    expect(findEnclosingHeading(body, 2)).toBeNull();
    expect(findEnclosingHeading(body, 0)).toBeNull();
  });

  it("ignores `# x` inside fenced code blocks", () => {
    const body = [
      "# Real",
      "```",
      "# Not a heading",
      "```",
      "after",
    ].join("\n");
    expect(findEnclosingHeading(body, 3)).toMatchObject({ line: 1, level: 1 });
    expect(findEnclosingHeading(body, 5)).toMatchObject({ line: 1, level: 1 });
  });
});

describe("findHeadingsInRange", () => {
  const body = [
    "## A",      // 1
    "a body",    // 2
    "### A1",    // 3
    "### A2",    // 4
    "## B",      // 5
    "b body",    // 6
    "## C",      // 7
  ].join("\n");

  it("returns top-level headings in range, dropping descendants", () => {
    // Range [1, 5] covers A, A1, A2, B. A1/A2 are descendants of A
    // and drop out — refiling A already takes them along.
    expect(findHeadingsInRange(body, 1, 5).map((h) => h.line)).toEqual([1, 5]);
  });

  it("includes a heading whose subtree merely intersects the range", () => {
    // Range [2, 2] (only A's body line). A's subtree intersects, A
    // counts as in-range even though its heading line is at 1.
    expect(findHeadingsInRange(body, 2, 2).map((h) => h.line)).toEqual([1]);
  });

  it("returns nothing when the range sits before the first heading", () => {
    expect(findHeadingsInRange("preamble\nmore\n# H", 1, 2)).toEqual([]);
  });

  it("treats sibling headings of the same level as separate top-levels", () => {
    expect(findHeadingsInRange(body, 5, 7).map((h) => h.line)).toEqual([5, 7]);
  });
});

describe("refile (multi-source target line tracking)", () => {
  it("targetLineAfter tracks shifts across a top-down multi-refile", async () => {
    const fp = join(dir, "multi.md");
    writeFileSync(
      fp,
      [
        "## TODO foo", // 1
        "foo body",    // 2
        "## TODO bar", // 3
        "bar body",    // 4
        "# Dest",      // 5
        "dest body",   // 6
      ].join("\n"),
      "utf8",
    );
    // Top-down: process the smaller-line source first. Each cut
    // shifts the destination up by movedLines, and the next source's
    // line drops by the cumulative cut so far.
    const r1 = await refile(
      fp,
      { kind: "heading", line: 1, level: 2 }, // foo
      { filePath: fp, relPath: fp, line: 5, level: 1 }, // # Dest
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(r1.targetLineAfter).toBe(3); // 5 - movedLines(2)
    expect(r1.movedLines).toBe(2);

    // bar was at body line 3; after foo's cut (size 2) it has slid to
    // line 1. Pass that to the second refile, with the updated
    // destination line.
    const r2 = await refile(
      fp,
      { kind: "heading", line: 3 - r1.movedLines, level: 2 },
      { filePath: fp, relPath: fp, line: r1.targetLineAfter!, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(r2.targetLineAfter).toBe(1); // 3 - movedLines(2)
    expect(r2.movedLines).toBe(2);

    // Document-order preservation: foo lands first, bar second.
    expect(readFileSync(fp, "utf8")).toBe(
      [
        "# Dest",
        "dest body",
        "",
        "## TODO foo",
        "foo body",
        "",
        "## TODO bar",
        "bar body",
      ].join("\n"),
    );
  });

  it("strips the orphan leading blank when refiling the first heading of a file", async () => {
    // Reported case: cutting the top heading left the separator
    // blank line behind as a leading blank in the source.
    const srcFp = join(dir, "topcut-src.md");
    const tgtFp = join(dir, "topcut-tgt.md");
    writeFileSync(
      srcFp,
      [
        "## t1",
        "",
        "body1",
        "",
        "## t2",
        "",
        "body2",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(tgtFp, "# Dest\n", "utf8");
    await refile(
      srcFp,
      { kind: "heading", line: 1, level: 2 },
      { filePath: tgtFp, relPath: "tgt.md", line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(srcFp, "utf8")).toBe(
      ["## t2", "", "body2"].join("\n"),
    );
  });

  it("collapses the boundary so cutting a middle heading leaves one blank, not two", async () => {
    // Reported case: "text\n\n## TODO s1\n\n## TODO s2" → after
    // refiling s1, the blank that sat before s1 *and* the blank that
    // sat after it both survived in the cut body, leaving a double
    // blank before s2.
    const srcFp = join(dir, "midcut-src.md");
    const tgtFp = join(dir, "midcut-tgt.md");
    writeFileSync(
      srcFp,
      [
        "text",
        "",
        "## TODO s1",
        "",
        "## TODO s2",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(tgtFp, "# Dest\n", "utf8");
    await refile(
      srcFp,
      { kind: "heading", line: 3, level: 2 },
      { filePath: tgtFp, relPath: "tgt.md", line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(readFileSync(srcFp, "utf8")).toBe(
      ["text", "", "## TODO s2"].join("\n"),
    );
  });

  it("strips the orphan leading blank for a same-file top-heading refile", async () => {
    const fp = join(dir, "topcut-same.md");
    writeFileSync(
      fp,
      [
        "## t1",
        "body1",
        "",
        "# Dest",
        "dest body",
      ].join("\n"),
      "utf8",
    );
    await refile(
      fp,
      { kind: "heading", line: 1, level: 2 },
      { filePath: fp, relPath: fp, line: 4, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    // Pre-fix the source kept the orphan blank that previously sat
    // between t1 and # Dest. The blank now drops; t1's subtree lands
    // under # Dest.
    expect(readFileSync(fp, "utf8")).toBe(
      [
        "# Dest",
        "dest body",
        "",
        "## t1",
        "body1",
      ].join("\n"),
    );
  });

  it("targetLineAfter equals targetLine when the target sits above the cut", async () => {
    const fp = join(dir, "above.md");
    writeFileSync(
      fp,
      [
        "# Dest",       // 1
        "dest body",    // 2
        "## TODO foo",  // 3
        "foo body",     // 4
      ].join("\n"),
      "utf8",
    );
    const r = await refile(
      fp,
      { kind: "heading", line: 3, level: 2 },
      { filePath: fp, relPath: fp, line: 1, level: 1 },
      DEFAULT_REFILE_CONFIG,
      DEFAULT_AGENDA_CONFIG,
    );
    expect(r.targetLine).toBe(1);
    expect(r.targetLineAfter).toBe(1);
  });
});
