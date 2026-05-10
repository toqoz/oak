// Astro Content Layer integration for @oak/core.
//
// Status: skeleton. The real loader will:
//   - call parseVault() on the configured vault path
//   - emit one entry per OakPage with frontmatter, body, slug, graph
//     metadata (inbound/outbound links)
//   - watch the vault for changes during `astro dev`
//
// Public API target:
//   import { oakLoader } from '@oak/core/astro';
//   defineCollection({ loader: oakLoader({ vault: './content' }) })
//
// `astro` is an optional peer dependency (see package.json). Only
// import this subpath when Astro is installed in the consumer.

export type OakLoaderOptions = {
  vault: string;
  visibilityFilter?: ("public" | "unlisted" | "private")[];
};

// Placeholder — real impl returns an Astro Loader. Typing it as `unknown`
// for now keeps `@oak/core` runnable without astro types installed.
export function oakLoader(_options: OakLoaderOptions): unknown {
  throw new Error("oakLoader: not yet implemented");
}
