import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildGraph,
  parseVault,
} from "@oak/core";
import {
  describeBacklinks,
  describeOutbound,
  describeTwoHop,
  summarizePage,
} from "../src/format.js";
import { findWikiTargetInLine } from "../src/wiki-cursor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => resolve(__dirname, "../../core/tests/fixtures", name);

describe("findWikiTargetInLine", () => {
  it("returns the target when cursor is inside a wiki link", () => {
    const line = "Read [[Local File First|the file note]] today.";
    expect(findWikiTargetInLine(line, 10)).toBe("Local File First");
  });
  it("strips heading anchor", () => {
    const line = "See [[Page#Intro]].";
    expect(findWikiTargetInLine(line, 10)).toBe("Page");
  });
  it("returns null when cursor is outside any wiki link", () => {
    expect(findWikiTargetInLine("plain text", 4)).toBeNull();
  });
  it("returns null when wiki link is malformed", () => {
    expect(findWikiTargetInLine("[[unclosed", 4)).toBeNull();
  });
});

describe("describe* helpers", () => {
  it("summarizes outbound, backlinks, and 2-hop against the basic fixture", async () => {
    const vault = await parseVault(fx("basic"));
    const graph = buildGraph(vault);

    const projectAlpha = [...vault.pages.values()].find((p) => p.title === "Project Alpha")!;
    const lff = [...vault.pages.values()].find(
      (p) => p.title === "Local File First",
    )!;

    const outbound = (graph.outgoing.get(lff.id) ?? []).map((l) =>
      describeOutbound(l, vault),
    );
    expect(outbound.some((e) => e.kind === "page" && e.label === "Project Alpha")).toBe(
      true,
    );

    const back = describeBacklinks(graph, vault, projectAlpha.id);
    expect(back.length).toBeGreaterThan(0);

    const two = describeTwoHop(graph, vault, lff.id);
    expect(Array.isArray(two)).toBe(true);

    const sum = summarizePage(lff);
    expect(sum.publishable).toBe(true);
    expect(sum.visibility).toBe("public");
  });
});
