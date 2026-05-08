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
import {
  collectRefileTargets,
  refile,
  RefileError,
} from "../../src/agenda/refile.js";
import type { OakPage, Vault } from "../../src/types.js";

function makePage(filePath: string, body: string, relPath?: string): OakPage {
  return {
    type: "page",
    id: filePath,
    title: filePath,
    aliases: [],
    visibility: "private",
    slug: "",
    llm: "deny",
    filePath,
    relPath: relPath ?? filePath,
    basename: filePath.split(/[\\/]/).pop() ?? filePath,
    body,
    rawFrontmatter: {},
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
      todo!.entryId,
      {
        filePath: fp,
        relPath: fp,
        line: 6, // "# Projects"
        level: 1,
      },
      DEFAULT_AGENDA_CONFIG,
    );
    expect(result.sameFile).toBe(true);

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
        outer!.entryId,
        { filePath: fp, relPath: fp, line: 2, level: 2 },
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
        t!.entryId,
        { filePath: fp, relPath: fp, line: 1, level: 1 },
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
        src!.entryId,
        { filePath: tgtFp, relPath: tgtFp, line: 1, level: 2 },
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toMatchObject({ code: "level-overflow" });
  });

  it("refiles to top-of-file by appending and clamping to level 1", async () => {
    const fp = join(dir, "tof.md");
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
    const page = makePage(fp, readFileSync(fp, "utf8"));
    const [src] = parseAgendaPage(page, DEFAULT_AGENDA_CONFIG);
    await refile(
      fp,
      src!.entryId,
      { filePath: fp, relPath: fp, line: null, level: 0 },
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
      todo!.entryId,
      { filePath: tgtFp, relPath: "tgt.md", line: 1, level: 1 },
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
      src!.entryId,
      { filePath: tgtFp, relPath: "dest.md", line: 1, level: 1 },
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
        "deadbeefdeadbeef",
        { filePath: fp, relPath: fp, line: null, level: 0 },
        DEFAULT_AGENDA_CONFIG,
      ),
    ).rejects.toBeInstanceOf(RefileError);
  });
});
