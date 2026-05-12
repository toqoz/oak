import { defineCollection } from "astro:content";
import { oakLoader, oakRedlinkLoader } from "@oak/core/astro";

// `./vault` is the publishable subset of the vault, sync'd into the
// publish worktree by `oak pub build`. Pages with visibility `private`
// are never present here.
//
// `optimizeImages: true` runs each png/jpg/jpeg through sharp at load
// time, generating responsive WebP variants (default widths: 400, 800,
// + the original) and emitting `<img srcset>` in the rendered body.
// Set to false to skip optimization (assets are still copied + hashed).
export const collections = {
  docs: defineCollection({
    loader: oakLoader({
      vault: "./vault",
      optimizeImages: true,
    }),
  }),
  // One entry per unresolved `[[target]]` referenced from publishable
  // pages. Consumed by `src/pages/redlink/[slug].astro` to render
  // placeholder pages listing the pages that reference the concept.
  redlinks: defineCollection({
    loader: oakRedlinkLoader({ vault: "./vault" }),
  }),
};
