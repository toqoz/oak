import { defineConfig } from "astro/config";
import { parseVault } from "@oak/core";
import { remarkOakLinks } from "@oak/core/remark";

// Boilerplate Astro config consumed by `oak publish`. Users are
// expected to fork this and customize freely.
//
// The vault is parsed once at config-load time so the remark plugin
// can resolve `[[wiki]]` links. The Content Layer loader (see
// src/content.config.ts) parses again — that's wasteful but
// build-time only; revisit with a shared cache later.
const vault = await parseVault("./content");

export default defineConfig({
  output: "static",
  site: process.env.OAK_SITE_URL,
  build: {
    format: "directory",
  },
  markdown: {
    remarkPlugins: [
      remarkOakLinks({
        vault,
        // Keep URLs aligned with the [...slug].astro routing. Override
        // here if you change the route shape.
        pageUrl: (page) => `/${page.slug}/`,
      }),
    ],
  },
});
