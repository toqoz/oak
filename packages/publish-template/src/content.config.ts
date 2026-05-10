import { defineCollection } from "astro:content";
import { oakLoader } from "@oak/core/astro";

// `vault` is the directory containing the markdown source. Adjust to
// taste — many oak setups mount the whole repo here.
export const collections = {
  docs: defineCollection({
    loader: oakLoader({ vault: "./content" }),
  }),
};
