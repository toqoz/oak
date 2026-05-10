import { defineCollection } from "astro:content";

// TODO: switch to oakLoader once @oak/core/astro is implemented.
// import { oakLoader } from "@oak/core/astro";
//
// export const collections = {
//   docs: defineCollection({
//     loader: oakLoader({ vault: "./content" }),
//   }),
// };

export const collections = {
  docs: defineCollection({
    type: "content",
  }),
};
