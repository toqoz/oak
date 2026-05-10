import { defineCollection } from "astro:content";
import { oakLoader } from "@oak/core/astro";

// `vault` is the directory containing the markdown source. Adjust to
// taste — many oak setups mount the whole repo here.
//
// `optimizeImages: true` runs each png/jpg/jpeg through sharp at load
// time, generating responsive WebP variants (default widths: 400, 800,
// + the original) and emitting `<img srcset>` in the rendered body.
// Set to false to skip optimization (assets are still copied + hashed).
export const collections = {
  docs: defineCollection({
    loader: oakLoader({
      vault: "./content",
      optimizeImages: true,
    }),
  }),
};
