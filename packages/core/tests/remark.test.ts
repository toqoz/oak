import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildGraph, parseVault } from "../src/index.js";
import { remarkOakAssets, remarkOakLinks } from "../src/remark/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

async function loadFixture(name: string) {
  const vault = await parseVault(fxRoot(name));
  const graph = buildGraph(vault);
  return { vault, graph };
}

async function render(
  body: string,
  vault: Awaited<ReturnType<typeof loadFixture>>["vault"],
  extras: {
    assetUrl?: (target: string) => string | null;
    redlinkUrl?: (target: string) => string | null;
  } = {},
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(
      remarkOakLinks({
        vault,
        ...(extras.assetUrl ? { assetUrl: extras.assetUrl } : {}),
        ...(extras.redlinkUrl ? { redlinkUrl: extras.redlinkUrl } : {}),
      }),
    )
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true });
  const file = await processor.process(body);
  return String(file);
}

describe("remarkOakLinks", () => {
  it("turns a resolved [[wiki]] into an <a> with the page URL", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("See [[About]] for more.", vault);
    expect(html).toContain('<a href="/about/">About</a>');
  });

  it("uses the alias when present: [[About|the about page]]", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Visit [[About|the about page]].", vault);
    expect(html).toContain('<a href="/about/">the about page</a>');
  });

  it("appends a slugified anchor for [[Page#Heading]]", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Jump to [[About#Some Section]].", vault);
    expect(html).toContain('<a href="/about/#some-section">About</a>');
  });

  it("renders unresolved targets as a redlink span", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Where is [[Nonexistent Page]]?", vault);
    expect(html).toContain(
      '<span class="oak-redlink" data-target="Nonexistent Page">Nonexistent Page</span>',
    );
    expect(html).not.toContain("[[Nonexistent Page]]");
  });

  it("emits an anchor for unresolved targets when redlinkUrl is set", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Where is [[Nonexistent Page]]?", vault, {
      redlinkUrl: (target) =>
        `/redlink/${target.toLowerCase().replace(/\s+/g, "-")}/`,
    });
    expect(html).toContain(
      '<a class="oak-redlink" href="/redlink/nonexistent-page/" data-target="Nonexistent Page">Nonexistent Page</a>',
    );
  });

  it("does not touch text inside fenced code blocks", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render(
      "```\n[[About]] is just text here\n```",
      vault,
    );
    // Fenced contents should appear verbatim, no <a> emitted from it.
    expect(html).toContain("[[About]] is just text here");
    expect(html).not.toContain('href="/about/"');
  });

  it("does not touch text inside inline code spans", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Use `[[About]]` for the syntax.", vault);
    expect(html).toContain("<code>[[About]]</code>");
    expect(html).not.toContain('href="/about/"');
  });

  it("respects a custom pageUrl resolver", async () => {
    const { vault } = await loadFixture("publish-basic");
    const processor = unified()
      .use(remarkParse)
      .use(
        remarkOakLinks({
          vault,
          pageUrl: (page) => `https://example.com/notes/${page.slug}`,
        }),
      )
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true });
    const html = String(await processor.process("Read [[About]]."));
    expect(html).toContain('<a href="https://example.com/notes/about">About</a>');
  });

  it("turns a wiki asset embed `![[diagram.png]]` into an <img>", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Inline: ![[diagram.png]]", vault, {
      assetUrl: (t) => `/_oak/${t}`,
    });
    expect(html).toContain('<img src="/_oak/diagram.png"');
  });

  it("strips an asset embed to alt text when no assetUrl is given", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Inline: ![[diagram.png|fig 1]]", vault);
    expect(html).toContain("Inline: fig 1");
    expect(html).not.toContain("<img");
  });

  it("preserves text on either side of a wiki link", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render(
      "before [[About]] middle [[Hello]] after",
      vault,
    );
    expect(html).toContain('before <a href="/about/">About</a> middle');
    expect(html).toContain('<a href="/hello/">Hello</a> after');
  });

  it("renders a page embed `![[About]]` as a marked-up link", async () => {
    const { vault } = await loadFixture("publish-basic");
    const html = await render("Embed: ![[About]]", vault);
    // remark-rehype maps `data.hProperties.className` to a class
    // attribute on the <a>.
    expect(html).toMatch(/<a[^>]*href="\/about\/"[^>]*class="oak-embed"/);
  });
});

describe("remarkOakAssets", () => {
  it("rewrites a markdown image URL through the resolver", async () => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkOakAssets({ assetUrl: (t) => `/_oak/${t}` }))
      .use(remarkRehype)
      .use(rehypeStringify);
    const html = String(
      await processor.process("![diagram](_assets/diagram.png)"),
    );
    expect(html).toContain('<img src="/_oak/_assets/diagram.png"');
  });

  it("leaves external image URLs alone", async () => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkOakAssets({ assetUrl: () => "/oops" }))
      .use(remarkRehype)
      .use(rehypeStringify);
    const html = String(
      await processor.process(
        "![remote](https://example.com/img.png)",
      ),
    );
    expect(html).toContain('src="https://example.com/img.png"');
  });
});
