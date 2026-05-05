import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/links.js";

describe("extractLinks", () => {
  it("extracts wiki links with label and heading", () => {
    const links = extractLinks(
      "See [[Page A|the A page]] and [[Page B#Intro]] today.",
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      syntax: "wiki",
      target: "Page A",
      label: "the A page",
      isEmbed: false,
    });
    expect(links[1]).toMatchObject({
      syntax: "wiki",
      target: "Page B",
      heading: "Intro",
    });
  });

  it("recognises embeds", () => {
    const links = extractLinks("![[Diagram]]");
    expect(links).toHaveLength(1);
    expect(links[0]!.isEmbed).toBe(true);
  });

  it("skips links inside fenced code blocks", () => {
    const body = [
      "Real [[A]] link.",
      "```",
      "fake [[B]] inside fence",
      "```",
      "Another [[C]].",
    ].join("\n");
    const targets = extractLinks(body).map((l) => l.target);
    expect(targets).toEqual(["A", "C"]);
  });

  it("skips links inside inline code spans", () => {
    const body = "Real [[A]], code `[[B]]`, real [[C]].";
    const targets = extractLinks(body).map((l) => l.target);
    expect(targets).toEqual(["A", "C"]);
  });

  it("recognises markdown links to .md files only", () => {
    const body =
      "Local [Page](./Page.md) and external [Site](https://example.com).";
    const links = extractLinks(body);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      syntax: "markdown",
      target: "./Page.md",
      label: "Page",
    });
  });

  it("preserves line numbers", () => {
    const body = "line 1\nline 2 [[Target]]";
    const links = extractLinks(body);
    expect(links[0]!.line).toBe(2);
  });
});
