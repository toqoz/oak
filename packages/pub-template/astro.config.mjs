import { defineConfig } from "astro/config";
import { parseVault, redlinkSlug } from "@oak/core";
import { remarkOakLinks } from "@oak/core/remark";

// Boilerplate Astro config for the publish template. Users are
// expected to fork this and customize freely.
//
// The `./vault` directory is a snapshot of the publishable subset of
// the vault, refreshed by `oak pub build`. It contains only pages
// whose visibility is in {public, unlisted} plus any assets those
// pages reference. Private pages are physically absent.
//
// The vault is parsed once at config-load time so the remark plugin
// can resolve `[[wiki]]` links. The Content Layer loader (see
// src/content.config.ts) parses again — that's wasteful but
// build-time only.
const vault = await parseVault("./vault");

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
        // Unresolved `[[target]]` becomes a clickable anchor going to
        // the auto-generated /redlink/<slug>/ placeholder page.
        redlinkUrl: (target) => `/redlink/${redlinkSlug(target)}/`,
      }),
    ],
  },
});
