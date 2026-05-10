import { defineConfig } from "astro/config";

// Boilerplate Astro config consumed by `oak publish`.
// Users are expected to fork this and customize freely.
//
// TODO (post-skeleton):
//   - register @oak/core/remark plugins on `markdown.remarkPlugins`
//     once they are implemented.
//   - wire @oak/core/astro `oakLoader` into a content collection.
export default defineConfig({
  output: "static",
  site: process.env.OAK_SITE_URL,
  build: {
    format: "directory",
  },
});
